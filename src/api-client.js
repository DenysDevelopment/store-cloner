import fetch from 'node-fetch';
import PQueue from 'p-queue';
import config from './config.js';

class ApiClient {
    constructor(storeConfig, logger) {
        this.config = storeConfig;
        this.logger = logger;
        this.queue = new PQueue({
            intervalCap: config.rateLimit,
            interval: 1000,
            carryoverConcurrencyCount: true,
        });
    }

    get headers() {
        return {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': this.config.accessToken,
        };
    }

    // ─── GraphQL ──────────────────────────────────────────────
    async graphql(query, variables = {}) {
        return this.queue.add(async () => {
            const maxRetries = 3;
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    const res = await fetch(this.config.graphqlUrl, {
                        method: 'POST',
                        headers: this.headers,
                        body: JSON.stringify({ query, variables }),
                    });

                    if (res.status === 429) {
                        const retryAfter = parseFloat(res.headers.get('Retry-After') || '2');
                        this.logger.warn(`Rate limited, retrying in ${retryAfter}s...`);
                        await this.sleep(retryAfter * 1000);
                        continue;
                    }

                    if (!res.ok) {
                        const body = await res.text();
                        throw new Error(`GraphQL HTTP ${res.status}: ${body}`);
                    }

                    const json = await res.json();

                    if (json.errors && json.errors.length > 0) {
                        const throttled = json.errors.find(e =>
                            e.message?.includes('Throttled')
                        );
                        if (throttled && attempt < maxRetries) {
                            this.logger.warn('GraphQL throttled, waiting 2s...');
                            await this.sleep(2000);
                            continue;
                        }
                        throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
                    }

                    return json.data;
                } catch (err) {
                    if (attempt === maxRetries) throw err;
                    this.logger.warn(`Attempt ${attempt} failed: ${err.message}, retrying...`);
                    await this.sleep(1000 * attempt);
                }
            }
        });
    }

    async graphqlAll(query, variables, connectionPath, nodeTransform = null) {
        const results = [];
        let cursor = null;
        let hasNext = true;

        while (hasNext) {
            const vars = { ...variables, cursor };
            const data = await this.graphql(query, vars);

            let connection = data;
            for (const key of connectionPath.split('.')) {
                connection = connection?.[key];
            }

            if (!connection) break;

            for (const edge of connection.edges || []) {
                const node = nodeTransform ? nodeTransform(edge.node) : edge.node;
                results.push(node);
            }

            hasNext = connection.pageInfo?.hasNextPage || false;
            if (hasNext && connection.edges?.length > 0) {
                cursor = connection.edges[connection.edges.length - 1].cursor;
            }
        }

        return results;
    }

    // ─── REST ─────────────────────────────────────────────────
    async rest(method, endpoint, body = null) {
        return this.queue.add(async () => {
            const maxRetries = 3;
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    const url = `${this.config.baseUrl}${endpoint}`;
                    const opts = { method, headers: this.headers };
                    if (body) opts.body = JSON.stringify(body);

                    const res = await fetch(url, opts);

                    if (res.status === 429) {
                        const retryAfter = parseFloat(res.headers.get('Retry-After') || '2');
                        this.logger.warn(`REST rate limited, retrying in ${retryAfter}s...`);
                        await this.sleep(retryAfter * 1000);
                        continue;
                    }

                    if (res.status === 404) return null;

                    if (!res.ok) {
                        const text = await res.text();
                        throw new Error(`REST ${method} ${endpoint} → ${res.status}: ${text}`);
                    }

                    if (res.status === 204) return {};
                    return await res.json();
                } catch (err) {
                    if (attempt === maxRetries) throw err;
                    this.logger.warn(`REST attempt ${attempt} failed: ${err.message}`);
                    await this.sleep(1000 * attempt);
                }
            }
        });
    }

    async restGetAll(endpoint, resourceKey) {
        const results = [];
        let url = `${endpoint}?limit=250`;

        while (url) {
            const res = await this.queue.add(async () => {
                const fullUrl = `${this.config.baseUrl}${url}`;
                const response = await fetch(fullUrl, { headers: this.headers });

                if (response.status === 429) {
                    const retryAfter = parseFloat(response.headers.get('Retry-After') || '2');
                    this.logger.warn(`REST rate limited, retrying in ${retryAfter}s...`);
                    await this.sleep(retryAfter * 1000);
                    return this.restGetAll(url, resourceKey);
                }

                if (!response.ok) {
                    throw new Error(`REST GET ${url} → ${response.status}`);
                }

                const data = await response.json();
                const linkHeader = response.headers.get('Link');
                let nextUrl = null;

                if (linkHeader) {
                    const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
                    if (nextMatch) {
                        const nextFullUrl = new URL(nextMatch[1]);
                        nextUrl = nextFullUrl.pathname.replace(`/admin/api/${config.apiVersion}`, '') +
                            nextFullUrl.search;
                    }
                }

                return { data, nextUrl };
            });

            if (Array.isArray(res)) {
                results.push(...res);
                break;
            }

            results.push(...(res.data[resourceKey] || []));
            url = res.nextUrl;
        }

        return results;
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

export default ApiClient;
