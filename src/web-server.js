import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import open from 'open';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env
dotenv.config({ path: join(__dirname, '..', '.env') });

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, '..', 'web')));

// ─── In-memory state ──────────────────────────────────────

const jobs = new Map();
const sseClients = new Map(); // jobId → Set<res>

function createJob(config) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const job = {
        id,
        ...config,
        status: 'pending',
        progress: 0,
        currentModule: null,
        totalModules: 0,
        doneModules: 0,
        logs: [],
        createdAt: new Date().toISOString(),
    };
    jobs.set(id, job);
    return job;
}

function appendLog(jobId, level, message) {
    const job = jobs.get(jobId);
    if (!job) return;
    const entry = { time: new Date().toISOString(), level, message };
    job.logs.push(entry);
    if (job.logs.length > 500) job.logs = job.logs.slice(-500);

    // Push to SSE clients
    const clients = sseClients.get(jobId);
    if (clients) {
        const data = JSON.stringify({
            type: 'log',
            ...entry,
            progress: job.progress,
            status: job.status,
            currentModule: job.currentModule,
            doneModules: job.doneModules,
            totalModules: job.totalModules,
        });
        for (const res of clients) {
            res.write(`data: ${data}\n\n`);
        }
    }
}

function updateJob(jobId, updates) {
    const job = jobs.get(jobId);
    if (!job) return;
    Object.assign(job, updates);

    const clients = sseClients.get(jobId);
    if (clients) {
        const data = JSON.stringify({
            type: 'status',
            status: job.status,
            progress: job.progress,
            currentModule: job.currentModule,
            doneModules: job.doneModules,
            totalModules: job.totalModules,
        });
        for (const res of clients) {
            res.write(`data: ${data}\n\n`);
        }
    }
}

// ─── API Client (embedded) ────────────────────────────────

import PQueue from 'p-queue';

class ApiClient {
    constructor(shop, accessToken) {
        this.shop = shop.replace(/^https?:\/\//, '').replace(/\/$/, '');
        this.accessToken = accessToken;
        this.baseUrl = `https://${this.shop}/admin/api/2026-01`;
        this.graphqlUrl = `https://${this.shop}/admin/api/2026-01/graphql.json`;
        this.queue = new PQueue({ intervalCap: 2, interval: 1000, carryoverConcurrencyCount: true });
    }

    get headers() {
        return { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': this.accessToken };
    }

    sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    async graphql(query, variables = {}) {
        return this.queue.add(async () => {
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    const res = await fetch(this.graphqlUrl, {
                        method: 'POST', headers: this.headers,
                        body: JSON.stringify({ query, variables }),
                    });
                    if (res.status === 429) { await this.sleep(parseFloat(res.headers.get('Retry-After') || '2') * 1000); continue; }
                    if (!res.ok) throw new Error(`GraphQL ${res.status}: ${(await res.text()).slice(0, 300)}`);
                    const json = await res.json();
                    if (json.errors?.length) {
                        if (json.errors.find(e => e.message?.includes('Throttled')) && attempt < 3) { await this.sleep(2000); continue; }
                        throw new Error(`GraphQL: ${JSON.stringify(json.errors).slice(0, 300)}`);
                    }
                    return json.data;
                } catch (err) { if (attempt === 3) throw err; await this.sleep(1000 * attempt); }
            }
        });
    }

    async graphqlAll(query, variables, connectionPath) {
        const results = []; let cursor = null; let hasNext = true;
        while (hasNext) {
            const data = await this.graphql(query, { ...variables, cursor });
            let conn = data; for (const k of connectionPath.split('.')) conn = conn?.[k];
            if (!conn) break;
            for (const edge of conn.edges || []) results.push(edge.node);
            hasNext = conn.pageInfo?.hasNextPage || false;
            if (hasNext && conn.edges?.length) cursor = conn.edges[conn.edges.length - 1].cursor;
        }
        return results;
    }

    async rest(method, endpoint, body = null) {
        return this.queue.add(async () => {
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    const opts = { method, headers: this.headers };
                    if (body) opts.body = JSON.stringify(body);
                    const res = await fetch(`${this.baseUrl}${endpoint}`, opts);
                    if (res.status === 429) { await this.sleep(parseFloat(res.headers.get('Retry-After') || '2') * 1000); continue; }
                    if (res.status === 404) return null;
                    if (!res.ok) throw new Error(`REST ${method} ${endpoint} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
                    if (res.status === 204) return {};
                    return await res.json();
                } catch (err) { if (attempt === 3) throw err; await this.sleep(1000 * attempt); }
            }
        });
    }

    async restGetAll(endpoint, resourceKey) {
        const results = []; let url = `${endpoint}?limit=250`;
        while (url) {
            const res = await this.queue.add(async () => {
                const response = await fetch(`${this.baseUrl}${url}`, { headers: this.headers });
                if (response.status === 429) { await this.sleep(2000); return { data: { [resourceKey]: [] }, nextUrl: url }; }
                if (!response.ok) throw new Error(`REST GET ${url} → ${response.status}`);
                const data = await response.json();
                const link = response.headers.get('Link');
                let nextUrl = null;
                if (link) { const m = link.match(/<([^>]+)>;\s*rel="next"/); if (m) { const u = new URL(m[1]); nextUrl = u.pathname.replace('/admin/api/2026-01', '') + u.search; } }
                return { data, nextUrl };
            });
            results.push(...(res.data[resourceKey] || []));
            url = res.nextUrl;
        }
        return results;
    }
}

// ─── ID Mapper ────────────────────────────────────────────

class IdMapper {
    constructor() { this.map = {}; this.handleMap = {}; }
    set(type, src, tgt) { if (!this.map[type]) this.map[type] = {}; this.map[type][String(src)] = String(tgt); }
    get(type, src) { return this.map[type]?.[String(src)] || null; }
    setHandleMap(type, handle, src, tgt) { if (!this.handleMap[type]) this.handleMap[type] = {}; this.handleMap[type][handle] = { sourceId: String(src), targetId: String(tgt) }; }
}

function extractId(gid) { if (!gid) return null; const m = String(gid).match(/\/(\d+)$/); return m ? m[1] : gid; }
function buildGid(type, id) { return `gid://shopify/${type}/${id}`; }

// ─── Module List ──────────────────────────────────────────

const ALL_MODULES = [
    { name: 'theme', label: 'Theme (sections, templates, assets, locales)' },
    { name: 'products', label: 'Products (variants, images, metafields)' },
    { name: 'collections', label: 'Collections (smart + custom)' },
    { name: 'pages', label: 'Pages' },
    { name: 'blogs', label: 'Blogs & Articles' },
    { name: 'menus', label: 'Navigation menus' },
    { name: 'metafields', label: 'Metafield definitions & values' },
    { name: 'metaobjects', label: 'Metaobject definitions & entries' },
    { name: 'customers', label: 'Customers' },
    { name: 'files', label: 'Media files (images, videos)' },
    { name: 'redirects', label: 'URL redirects' },
    { name: 'discounts', label: 'Price rules & discount codes' },
    { name: 'shop-settings', label: 'Settings (policies, locales, markets, currencies)' },
    { name: 'translations', label: 'Translations' },
];

// ─── Migration runner ─────────────────────────────────────

async function runMigration(jobId) {
    const job = jobs.get(jobId);
    if (!job) return;

    const src = new ApiClient(job.sourceShop, job.sourceToken);
    const tgt = new ApiClient(job.targetShop, job.targetToken);
    const idMap = new IdMapper();

    const selectedModules = job.modules === 'all'
        ? ALL_MODULES.map(m => m.name)
        : job.modules.split(',').map(s => s.trim());
    const modules = ALL_MODULES.filter(m => selectedModules.includes(m.name));

    updateJob(jobId, { status: 'running', totalModules: modules.length });
    appendLog(jobId, 'info', `Starting: ${modules.map(m => m.name).join(', ')}`);
    appendLog(jobId, 'info', `${job.sourceShop} → ${job.targetShop}`);

    let done = 0;
    for (const mod of modules) {
        // check cancellation
        if (jobs.get(jobId)?.status === 'cancelled') { appendLog(jobId, 'warn', 'Cancelled'); return; }

        updateJob(jobId, { currentModule: mod.name, progress: Math.round((done / modules.length) * 100) });
        appendLog(jobId, 'info', `━━━ ${mod.name.toUpperCase()} ━━━`);

        try {
            const data = await exportModule(mod.name, src, jobId);
            await importModule(mod.name, tgt, idMap, data, jobId);
            done++;
            updateJob(jobId, { doneModules: done, progress: Math.round((done / modules.length) * 100) });
            appendLog(jobId, 'success', `✓ ${mod.name} done`);
        } catch (err) {
            appendLog(jobId, 'error', `✗ ${mod.name}: ${err.message}`);
            done++;
        }
    }

    updateJob(jobId, { status: 'completed', progress: 100, currentModule: null });
    appendLog(jobId, 'success', '🎉 Migration complete!');
}

// ════════════════════════════════════════════════════════════
// MODULE IMPLEMENTATIONS
// ════════════════════════════════════════════════════════════

async function exportModule(name, client, jobId) {
    const fn = EXPORT_FNS[name]; if (!fn) throw new Error(`Unknown: ${name}`); return fn(client, jobId);
}
async function importModule(name, client, idMap, data, jobId) {
    const fn = IMPORT_FNS[name]; if (!fn) throw new Error(`Unknown: ${name}`); return fn(client, idMap, data, jobId);
}

// Theme
async function expTheme(c, j) {
    const res = await c.rest('GET', '/themes.json');
    const main = res?.themes?.find(t => t.role === 'main');
    if (!main) throw new Error('No main theme');
    appendLog(j, 'info', `Theme: "${main.name}"`);
    const assets = [];
    const list = (await c.rest('GET', `/themes/${main.id}/assets.json`))?.assets || [];
    for (const a of list) {
        try {
            const d = (await c.rest('GET', `/themes/${main.id}/assets.json?asset[key]=${encodeURIComponent(a.key)}`))?.asset;
            if (d) assets.push({ key: d.key, value: d.value || null, attachment: d.attachment || null });
        } catch { /* skip */ }
    }
    appendLog(j, 'info', `${assets.length} theme assets exported`);
    return { theme: main, assets };
}
async function impTheme(c, _, data, j) {
    if (!data?.assets) return;
    const tgt = (await c.rest('GET', '/themes.json'))?.themes?.find(t => t.role === 'main');
    if (!tgt) throw new Error('No main theme on target');
    const order = ['config/', 'layout/', 'sections/', 'snippets/', 'templates/', 'locales/', 'assets/'];
    const sorted = [...data.assets].sort((a, b) => { const ai = order.findIndex(p => a.key.startsWith(p)); const bi = order.findIndex(p => b.key.startsWith(p)); return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi); });
    let ok = 0;
    for (const a of sorted) {
        try {
            const p = { asset: { key: a.key } };
            if (a.value) p.asset.value = a.value; else if (a.attachment) p.asset.attachment = a.attachment; else continue;
            await c.rest('PUT', `/themes/${tgt.id}/assets.json`, p); ok++;
        } catch { /* skip */ }
    }
    appendLog(j, 'info', `${ok}/${data.assets.length} theme assets uploaded`);
}

// Products
const PRODUCTS_QUERY = `query P($cursor:String){products(first:50,after:$cursor){pageInfo{hasNextPage}edges{cursor node{id title descriptionHtml handle productType vendor tags status templateSuffix seo{title description} options{name values} variants(first:100){edges{node{id title sku price compareAtPrice barcode inventoryQuantity inventoryPolicy taxable selectedOptions{name value} image{url altText} inventoryItem{measurement{weight{unit value}}requiresShipping}}}} images(first:250){edges{node{id url altText}}} metafields(first:100){edges{node{namespace key value type}}}}}}}`;

async function expProducts(c, j) {
    const products = await c.graphqlAll(PRODUCTS_QUERY, {}, 'products');
    appendLog(j, 'info', `${products.length} products`);
    return products;
}
async function impProducts(c, idMap, data, j) {
    if (!data) return; let ok = 0;
    for (const product of data) {
        try {
            const variants = (product.variants?.edges || []).map(e => e.node);
            const images = (product.images?.edges || []).map(e => e.node);
            const metafields = (product.metafields?.edges || []).map(e => e.node);
            const res = await c.rest('POST', '/products.json', { product: {
                title: product.title, body_html: product.descriptionHtml, handle: product.handle,
                product_type: product.productType, vendor: product.vendor,
                tags: (product.tags || []).join(', '), status: product.status?.toLowerCase() || 'active',
                template_suffix: product.templateSuffix || '',
                metafields_global_title_tag: product.seo?.title || '',
                metafields_global_description_tag: product.seo?.description || '',
                options: (product.options || []).map(o => ({ name: o.name, values: o.values })),
                variants: variants.map(v => ({
                    title: v.title, sku: v.sku || '', price: v.price, compare_at_price: v.compareAtPrice,
                    barcode: v.barcode || '',
                    weight: v.inventoryItem?.measurement?.weight?.value || 0,
                    weight_unit: (v.inventoryItem?.measurement?.weight?.unit || 'KILOGRAMS').toLowerCase().replace('kilograms','kg').replace('grams','g').replace('pounds','lb').replace('ounces','oz'),
                    inventory_policy: v.inventoryPolicy?.toLowerCase() || 'deny',
                    taxable: v.taxable, requires_shipping: v.inventoryItem?.requiresShipping ?? true,
                    option1: v.selectedOptions?.[0]?.value, option2: v.selectedOptions?.[1]?.value, option3: v.selectedOptions?.[2]?.value,
                })),
                images: images.map(img => ({ src: img.url, alt: img.altText || '' })),
                metafields: metafields.map(mf => ({ namespace: mf.namespace, key: mf.key, value: mf.value, type: mf.type })),
            }});
            if (res?.product) {
                const sourceId = extractId(product.id);
                idMap.set('products', sourceId, String(res.product.id));
                idMap.setHandleMap('products', product.handle, sourceId, String(res.product.id));
                // Map variant IDs
                const tgtVariants = res.product.variants || [];
                for (let i = 0; i < Math.min(variants.length, tgtVariants.length); i++) {
                    idMap.set('variants', extractId(variants[i].id), String(tgtVariants[i].id));
                }
                // Map image IDs
                const tgtImages = res.product.images || [];
                for (let i = 0; i < Math.min(images.length, tgtImages.length); i++) {
                    idMap.set('images', extractId(images[i].id), String(tgtImages[i].id));
                }
                ok++;
            }
        } catch (err) { appendLog(j, 'warn', `Product "${product.title}": ${err.message}`); }
    }
    appendLog(j, 'info', `${ok}/${data.length} products`);
}

// Collections
async function expCollections(c, j) {
    const custom = await c.restGetAll('/custom_collections.json', 'custom_collections');
    const smart = await c.restGetAll('/smart_collections.json', 'smart_collections');
    appendLog(j, 'info', `${custom.length} custom + ${smart.length} smart collections`);
    return { custom, smart };
}
async function impCollections(c, idMap, data, j) {
    if (!data) return; let ok = 0;
    for (const col of data.custom || []) {
        try {
            const r = await c.rest('POST', '/custom_collections.json', { custom_collection: { title: col.title, handle: col.handle, body_html: col.body_html, published: col.published, sort_order: col.sort_order, template_suffix: col.template_suffix, image: col.image?.src ? { src: col.image.src, alt: col.image.alt } : undefined } });
            if (r?.custom_collection) { idMap.set('collections', String(col.id), String(r.custom_collection.id)); idMap.setHandleMap('collections', col.handle, String(col.id), String(r.custom_collection.id)); ok++; }
        } catch { /* skip */ }
    }
    for (const col of data.smart || []) {
        try {
            const r = await c.rest('POST', '/smart_collections.json', { smart_collection: { title: col.title, handle: col.handle, body_html: col.body_html, published: col.published, sort_order: col.sort_order, template_suffix: col.template_suffix, rules: col.rules, disjunctive: col.disjunctive, image: col.image?.src ? { src: col.image.src, alt: col.image.alt } : undefined } });
            if (r?.smart_collection) { idMap.set('collections', String(col.id), String(r.smart_collection.id)); idMap.setHandleMap('collections', col.handle, String(col.id), String(r.smart_collection.id)); ok++; }
        } catch { /* skip */ }
    }
    appendLog(j, 'info', `${ok} collections imported`);
}

// Pages
async function expPages(c, j) { const p = await c.restGetAll('/pages.json', 'pages'); appendLog(j, 'info', `${p.length} pages`); return p; }
async function impPages(c, idMap, data, j) {
    if (!data) return; let ok = 0;
    for (const p of data) { try { const r = await c.rest('POST', '/pages.json', { page: { title: p.title, handle: p.handle, body_html: p.body_html, author: p.author, template_suffix: p.template_suffix, published: !!p.published_at } }); if (r?.page) { idMap.set('pages', String(p.id), String(r.page.id)); ok++; } } catch { /* skip */ } }
    appendLog(j, 'info', `${ok}/${data.length} pages`);
}

// Blogs
async function expBlogs(c, j) {
    const blogs = await c.restGetAll('/blogs.json', 'blogs');
    for (const b of blogs) { try { b._articles = await c.restGetAll(`/blogs/${b.id}/articles.json`, 'articles'); } catch { b._articles = []; } }
    appendLog(j, 'info', `${blogs.length} blogs, ${blogs.reduce((s, b) => s + (b._articles?.length || 0), 0)} articles`);
    return blogs;
}
async function impBlogs(c, idMap, data, j) {
    if (!data) return; let ok = 0;
    for (const b of data) {
        try {
            const r = await c.rest('POST', '/blogs.json', { blog: { title: b.title, handle: b.handle } });
            if (r?.blog) {
                idMap.set('blogs', String(b.id), String(r.blog.id)); ok++;
                for (const a of b._articles || []) { try { const ar = await c.rest('POST', `/blogs/${r.blog.id}/articles.json`, { article: { title: a.title, handle: a.handle, author: a.author, body_html: a.body_html, summary_html: a.summary_html, tags: a.tags, published: !!a.published_at, image: a.image?.src ? { src: a.image.src, alt: a.image.alt } : undefined } }); if (ar?.article) { idMap.set('articles', String(a.id), String(ar.article.id)); ok++; } } catch { /* skip */ } }
            }
        } catch { /* skip */ }
    }
    appendLog(j, 'info', `${ok} blog resources`);
}

// Menus
async function expMenus(c, j) {
    const menus = await c.graphqlAll(`query M($cursor:String){menus(first:50,after:$cursor){pageInfo{hasNextPage}edges{cursor node{id title handle items{id title type url resourceId items{id title type url resourceId items{id title type url resourceId}}}}}}}`, {}, 'menus');
    appendLog(j, 'info', `${menus.length} menus`); return menus;
}
function remapItems(items, idMap) {
    return (items || []).map(i => {
        const m = { title: i.title, type: i.type, url: i.url || '' };
        if (i.resourceId) {
            const sid = extractId(i.resourceId);
            if (i.resourceId.includes('Product')) { const t = idMap.get('products', sid); if (t) m.resourceId = `gid://shopify/Product/${t}`; }
            else if (i.resourceId.includes('Collection')) { const t = idMap.get('collections', sid); if (t) m.resourceId = `gid://shopify/Collection/${t}`; }
            else if (i.resourceId.includes('Page')) { const t = idMap.get('pages', sid); if (t) m.resourceId = `gid://shopify/Page/${t}`; }
            else if (i.resourceId.includes('Blog')) { const t = idMap.get('blogs', sid); if (t) m.resourceId = `gid://shopify/Blog/${t}`; }
        }
        // If no resourceId mapped but we have a URL, keep the URL — it will still work for /products/handle, /collections/handle etc.
        if (i.items?.length) m.items = remapItems(i.items, idMap);
        return m;
    });
}
async function impMenus(c, idMap, data, j) {
    if (!data) return; let ok = 0;
    for (const menu of data) { try { const items = remapItems(menu.items, idMap); const r = await c.graphql(`mutation($title:String!,$handle:String!,$items:[MenuItemCreateInput!]!){menuCreate(title:$title,handle:$handle,items:$items){menu{id}userErrors{message}}}`, { title: menu.title, handle: menu.handle, items }); if (r?.menuCreate?.menu) { idMap.set('menus', extractId(menu.id), extractId(r.menuCreate.menu.id)); ok++; } } catch { /* skip */ } }
    appendLog(j, 'info', `${ok}/${data.length} menus`);
}

// Metafields
const MF_OWNERS = ['PRODUCT', 'VARIANT', 'COLLECTION', 'CUSTOMER', 'ORDER', 'PAGE', 'ARTICLE', 'BLOG', 'SHOP'];
async function expMetafields(c, j) {
    const defs = [];
    for (const ot of MF_OWNERS) { try { const d = await c.graphqlAll(`query($cursor:String,$ownerType:MetafieldOwnerType!){metafieldDefinitions(first:50,after:$cursor,ownerType:$ownerType){pageInfo{hasNextPage}edges{cursor node{id name namespace key type{name}description ownerType validations{name value}}}}}`, { ownerType: ot }, 'metafieldDefinitions'); defs.push(...d); } catch { /* skip */ } }
    let shopMf = []; try { shopMf = (await c.rest('GET', '/metafields.json'))?.metafields || []; } catch { /* skip */ }
    appendLog(j, 'info', `${defs.length} defs + ${shopMf.length} shop metafields`);
    return { definitions: defs, shopMetafields: shopMf };
}
async function impMetafields(c, idMap, data, j) {
    if (!data) return; let ok = 0;
    for (const d of data.definitions || []) { try { const r = await c.graphql(`mutation($def:MetafieldDefinitionInput!){metafieldDefinitionCreate(definition:$def){createdDefinition{id}userErrors{message}}}`, { def: { name: d.name, namespace: d.namespace, key: d.key, type: d.type?.name, description: d.description || '', ownerType: d.ownerType, validations: (d.validations || []).map(v => ({ name: v.name, value: v.value })) } }); if (r?.metafieldDefinitionCreate?.createdDefinition) ok++; } catch { /* skip */ } }
    for (const mf of data.shopMetafields || []) { try { await c.rest('POST', '/metafields.json', { metafield: { namespace: mf.namespace, key: mf.key, value: mf.value, type: mf.type } }); ok++; } catch { /* skip */ } }
    appendLog(j, 'info', `${ok} metafield resources`);
}

// Metaobjects
async function expMetaobjects(c, j) {
    const defs = await c.graphqlAll(`query($cursor:String){metaobjectDefinitions(first:50,after:$cursor){pageInfo{hasNextPage}edges{cursor node{id name type fieldDefinitions{name key type{name}description required validations{name value}}access{storefront}capabilities{publishable{enabled}translatable{enabled}}}}}}`, {}, 'metaobjectDefinitions');
    for (const d of defs) { try { d._entries = await c.graphqlAll(`query($type:String!,$cursor:String){metaobjects(type:$type,first:50,after:$cursor){pageInfo{hasNextPage}edges{cursor node{id handle type fields{key value type}}}}}`, { type: d.type }, 'metaobjects'); } catch { d._entries = []; } }
    appendLog(j, 'info', `${defs.length} defs, ${defs.reduce((s, d) => s + (d._entries?.length || 0), 0)} entries`);
    return defs;
}
async function impMetaobjects(c, idMap, data, j) {
    if (!data) return; let ok = 0;
    for (const d of data) { try { await c.graphql(`mutation($def:MetaobjectDefinitionCreateInput!){metaobjectDefinitionCreate(definition:$def){metaobjectDefinition{id}userErrors{message}}}`, { def: { name: d.name, type: d.type, fieldDefinitions: d.fieldDefinitions.map(f => ({ name: f.name, key: f.key, type: f.type?.name, description: f.description || '', required: f.required || false, validations: (f.validations || []).map(v => ({ name: v.name, value: v.value })) })), access: d.access || {}, capabilities: d.capabilities || {} } });
    for (const e of d._entries || []) { try { const r = await c.graphql(`mutation($mo:MetaobjectCreateInput!){metaobjectCreate(metaobject:$mo){metaobject{id}userErrors{message}}}`, { mo: { type: d.type, handle: e.handle, fields: (e.fields || []).map(f => ({ key: f.key, value: f.value })) } }); if (r?.metaobjectCreate?.metaobject) { idMap.set('metaobjects', extractId(e.id), extractId(r.metaobjectCreate.metaobject.id)); ok++; } } catch { /* skip */ } } } catch { /* skip */ } }
    appendLog(j, 'info', `${ok} metaobject resources`);
}

// Customers
async function expCustomers(c, j) { const d = await c.restGetAll('/customers.json', 'customers'); appendLog(j, 'info', `${d.length} customers`); return d; }
async function impCustomers(c, idMap, data, j) {
    if (!data) return; let ok = 0;
    for (const cu of data) { try { const r = await c.rest('POST', '/customers.json', { customer: { first_name: cu.first_name, last_name: cu.last_name, email: cu.email, phone: cu.phone, tags: cu.tags, note: cu.note, accepts_marketing: cu.accepts_marketing, addresses: (cu.addresses || []).map(a => ({ address1: a.address1, address2: a.address2, city: a.city, province: a.province, zip: a.zip, country: a.country, phone: a.phone, first_name: a.first_name, last_name: a.last_name, company: a.company, default: a.default })), send_email_welcome: false } }); if (r?.customer) { idMap.set('customers', String(cu.id), String(r.customer.id)); ok++; } } catch { /* skip */ } }
    appendLog(j, 'info', `${ok}/${data.length} customers`);
}

// Files
async function expFiles(c, j) { const f = await c.graphqlAll(`query($cursor:String){files(first:50,after:$cursor){pageInfo{hasNextPage}edges{cursor node{...on MediaImage{id alt image{url}mimeType}...on Video{id alt sources{url mimeType}}...on GenericFile{id alt url mimeType}}}}}`, {}, 'files'); appendLog(j, 'info', `${f.length} files`); return f; }
async function impFiles(c, idMap, data, j) {
    if (!data) return; let ok = 0;
    for (const f of data) { try { const url = f.image?.url || f.sources?.[0]?.url || f.url; if (!url) continue; const r = await c.graphql(`mutation($files:[FileCreateInput!]!){fileCreate(files:$files){files{id}userErrors{message}}}`, { files: [{ originalSource: url, alt: f.alt || '', contentType: f.mimeType?.startsWith('image') ? 'IMAGE' : f.mimeType?.startsWith('video') ? 'VIDEO' : 'FILE' }] }); if (r?.fileCreate?.files?.[0]) { idMap.set('files', extractId(f.id), extractId(r.fileCreate.files[0].id)); ok++; } } catch { /* skip */ } }
    appendLog(j, 'info', `${ok}/${data.length} files`);
}

// Redirects
async function expRedirects(c, j) { const r = await c.restGetAll('/redirects.json', 'redirects'); appendLog(j, 'info', `${r.length} redirects`); return r; }
async function impRedirects(c, _, data, j) { if (!data) return; let ok = 0; for (const r of data) { try { await c.rest('POST', '/redirects.json', { redirect: { path: r.path, target: r.target } }); ok++; } catch { /* skip */ } } appendLog(j, 'info', `${ok}/${data.length} redirects`); }

// Discounts
async function expDiscounts(c, j) { const pr = await c.restGetAll('/price_rules.json', 'price_rules'); for (const r of pr) { try { r._codes = await c.restGetAll(`/price_rules/${r.id}/discount_codes.json`, 'discount_codes'); } catch { r._codes = []; } } appendLog(j, 'info', `${pr.length} price rules`); return pr; }
async function impDiscounts(c, idMap, data, j) {
    if (!data) return; let ok = 0;
    for (const r of data) { try { const res = await c.rest('POST', '/price_rules.json', { price_rule: { title: r.title, target_type: r.target_type, target_selection: r.target_selection, allocation_method: r.allocation_method, value_type: r.value_type, value: r.value, customer_selection: r.customer_selection, starts_at: r.starts_at, ends_at: r.ends_at, usage_limit: r.usage_limit, once_per_customer: r.once_per_customer } }); if (res?.price_rule) { idMap.set('price_rules', String(r.id), String(res.price_rule.id)); ok++; for (const cd of r._codes || []) { try { await c.rest('POST', `/price_rules/${res.price_rule.id}/discount_codes.json`, { discount_code: { code: cd.code } }); } catch { /* skip */ } } } } catch { /* skip */ } }
    appendLog(j, 'info', `${ok}/${data.length} price rules`);
}

// Shop Settings
async function expShopSettings(c, j) {
    const data = {};
    try { data.locales = (await c.graphql('{ shopLocales { locale primary published } }'))?.shopLocales || []; } catch { data.locales = []; }
    try { const p = (await c.graphql('{ shop { privacyPolicy{title body} refundPolicy{title body} termsOfService{title body} shippingPolicy{title body} subscriptionPolicy{title body} } }'))?.shop || {}; data.policies = { privacyPolicy: p.privacyPolicy, refundPolicy: p.refundPolicy, termsOfService: p.termsOfService, shippingPolicy: p.shippingPolicy, subscriptionPolicy: p.subscriptionPolicy }; } catch { data.policies = {}; }
    try { data.scriptTags = await c.restGetAll('/script_tags.json', 'script_tags'); } catch { data.scriptTags = []; }
    try { data.currencies = (await c.graphql('{ shop { enabledPresentmentCurrencies } }'))?.shop?.enabledPresentmentCurrencies || []; } catch { data.currencies = []; }
    appendLog(j, 'info', `${data.locales.length} locales, ${Object.values(data.policies).filter(p => p?.body).length} policies`);
    return data;
}
async function impShopSettings(c, _, data, j) {
    if (!data) return; let ok = 0;
    for (const l of (data.locales || []).filter(l => !l.primary)) { try { await c.graphql(`mutation($l:String!){shopLocaleEnable(locale:$l){shopLocale{locale}userErrors{message}}}`, { l: l.locale }); if (l.published) await c.graphql(`mutation($l:String!){shopLocaleUpdate(locale:$l,shopLocale:{published:true}){shopLocale{locale}userErrors{message}}}`, { l: l.locale }); ok++; } catch { /* skip */ } }
    for (const [k, t] of [['refundPolicy', 'REFUND_POLICY'], ['privacyPolicy', 'PRIVACY_POLICY'], ['termsOfService', 'TERMS_OF_SERVICE'], ['shippingPolicy', 'SHIPPING_POLICY'], ['subscriptionPolicy', 'SUBSCRIPTION_POLICY']]) { const p = data.policies?.[k]; if (!p?.body) continue; try { await c.graphql(`mutation($p:ShopPolicyInput!){shopPolicyUpdate(shopPolicy:$p){shopPolicy{body}userErrors{message}}}`, { p: { type: t, body: p.body } }); ok++; } catch { /* skip */ } }
    for (const tag of data.scriptTags || []) { try { await c.rest('POST', '/script_tags.json', { script_tag: { event: tag.event, src: tag.src, display_scope: tag.display_scope } }); ok++; } catch { /* skip */ } }
    appendLog(j, 'info', `${ok} settings resources`);
}

// Translations
const TR_TYPES = ['PRODUCT', 'COLLECTION', 'PAGE', 'BLOG', 'ARTICLE', 'LINK', 'SHOP', 'SHOP_POLICY', 'METAOBJECT', 'METAFIELD', 'MENU', 'ONLINE_STORE_THEME', 'EMAIL_TEMPLATE', 'DELIVERY_METHOD_DEFINITION', 'PAYMENT_GATEWAY', 'FILTER'];
const TR_MAP = { PRODUCT: { g: 'Product', k: 'products' }, COLLECTION: { g: 'Collection', k: 'collections' }, PAGE: { g: 'Page', k: 'pages' }, BLOG: { g: 'Blog', k: 'blogs' }, ARTICLE: { g: 'Article', k: 'articles' }, METAOBJECT: { g: 'Metaobject', k: 'metaobjects' }, MENU: { g: 'Menu', k: 'menus' } };
const TR_CONTENT = new Set(['SHOP', 'LINK', 'ONLINE_STORE_THEME', 'EMAIL_TEMPLATE', 'DELIVERY_METHOD_DEFINITION', 'PAYMENT_GATEWAY', 'SHOP_POLICY', 'FILTER']);

async function expTranslations(c, j) {
    const locales = ((await c.graphql('{ shopLocales { locale primary published } }'))?.shopLocales || []).filter(l => !l.primary && l.published);
    if (!locales.length) { appendLog(j, 'info', 'No secondary locales'); return { locales: [], translations: {} }; }
    appendLog(j, 'info', `${locales.length} locales: ${locales.map(l => l.locale).join(', ')}`);
    const all = {}; let total = 0;
    for (const rt of TR_TYPES) { all[rt] = []; try { const res = await c.graphqlAll(`query($rt:TranslatableResourceType!,$cursor:String){translatableResources(first:50,after:$cursor,resourceType:$rt){pageInfo{hasNextPage}edges{cursor node{resourceId translatableContent{key value digest locale}}}}}`, { rt }, 'translatableResources'); for (const r of res) { const t = { resourceId: r.resourceId, translatableContent: r.translatableContent, translations: {} }; for (const l of locales) { try { const td = await c.graphql(`query($id:ID!,$l:String!){translatableResource(resourceId:$id){translations(locale:$l){key value locale}}}`, { id: r.resourceId, l: l.locale }); const tr = td?.translatableResource?.translations || []; if (tr.length) t.translations[l.locale] = tr; } catch { /* skip */ } } if (Object.keys(t.translations).length) { all[rt].push(t); total++; } } } catch { /* skip */ } }
    appendLog(j, 'info', `${total} resources with translations`); return { locales, translations: all };
}
async function impTranslations(c, idMap, data, j) {
    if (!data?.locales?.length) return;
    for (const l of data.locales) { try { await c.graphql(`mutation($l:String!){shopLocaleEnable(locale:$l){shopLocale{locale}userErrors{message}}}`, { l: l.locale }); if (l.published) await c.graphql(`mutation($l:String!){shopLocaleUpdate(locale:$l,shopLocale:{published:true}){shopLocale{locale}userErrors{message}}}`, { l: l.locale }); } catch { /* skip */ } }
    let shopId = null; try { shopId = (await c.graphql('{ shop { id } }'))?.shop?.id; } catch { /* skip */ }
    let ok = 0;
    for (const [rt, resources] of Object.entries(data.translations || {})) {
        if (!resources?.length) continue;
        const m = TR_MAP[rt]; const isCM = TR_CONTENT.has(rt);
        let tgtRes = null; if (isCM) { try { tgtRes = await c.graphqlAll(`query($rt:TranslatableResourceType!,$cursor:String){translatableResources(first:50,after:$cursor,resourceType:$rt){pageInfo{hasNextPage}edges{cursor node{resourceId translatableContent{key value digest}}}}}`, { rt }, 'translatableResources'); } catch { tgtRes = []; } }
        for (const r of resources) {
            const sid = extractId(r.resourceId); let tid = null;
            if (rt === 'SHOP') tid = shopId;
            else if (isCM) { if (m) { const t = idMap.get(m.k, sid); if (t) tid = buildGid(m.g, t); } if (!tid && tgtRes) { const st = (r.translatableContent || []).find(c => c.key === 'title')?.value; for (const tr of tgtRes) { const tt = (tr.translatableContent || []).find(c => c.key === 'title')?.value; if (st && tt && st === tt) { tid = tr.resourceId; break; } } } }
            else if (m) { const t = idMap.get(m.k, sid); if (t) tid = buildGid(m.g, t); }
            if (!tid) continue;
            let digests = {}; try { const dd = await c.graphql(`query($id:ID!){translatableResource(resourceId:$id){translatableContent{key digest}}}`, { id: tid }); for (const x of dd?.translatableResource?.translatableContent || []) digests[x.key] = x.digest; } catch { continue; }
            for (const [locale, trans] of Object.entries(r.translations)) {
                const inputs = trans.filter(t => t.value && digests[t.key]).map(t => ({ key: t.key, value: t.value, locale, translatableContentDigest: digests[t.key] }));
                if (!inputs.length) continue;
                try { await c.graphql(`mutation($id:ID!,$t:[TranslationInput!]!){translationsRegister(resourceId:$id,translations:$t){translations{key}userErrors{message}}}`, { id: tid, t: inputs }); ok++; } catch { /* skip */ }
            }
        }
    }
    appendLog(j, 'info', `${ok} translation resources`);
}

const EXPORT_FNS = { theme: expTheme, products: expProducts, collections: expCollections, pages: expPages, blogs: expBlogs, menus: expMenus, metafields: expMetafields, metaobjects: expMetaobjects, customers: expCustomers, files: expFiles, redirects: expRedirects, discounts: expDiscounts, 'shop-settings': expShopSettings, translations: expTranslations };
const IMPORT_FNS = { theme: impTheme, products: impProducts, collections: impCollections, pages: impPages, blogs: impBlogs, menus: impMenus, metafields: impMetafields, metaobjects: impMetaobjects, customers: impCustomers, files: impFiles, redirects: impRedirects, discounts: impDiscounts, 'shop-settings': impShopSettings, translations: impTranslations };

// ─── Client Credentials OAuth ─────────────────────────────

async function resolveToken(shop, token, clientId, clientSecret) {
    // If access token is provided, use it directly
    if (token) return token;

    // Otherwise, get token via Client Credentials Grant
    if (!clientId || !clientSecret) throw new Error('Provide either access token OR client_id + client_secret');

    const cleanShop = shop.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const url = `https://${cleanShop}/admin/oauth/access_token`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            grant_type: 'client_credentials',
            client_id: clientId,
            client_secret: clientSecret,
        }),
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`OAuth failed for ${cleanShop}: ${res.status} ${text}`);
    }

    const data = await res.json();
    if (!data.access_token) throw new Error('No access_token in OAuth response');
    return data.access_token;
}

// ─── HTTP Routes ──────────────────────────────────────────

app.get('/api/modules', (req, res) => res.json(ALL_MODULES));

// Prefill from .env
app.get('/api/prefill', (req, res) => {
    res.json({
        sourceShop: process.env.SOURCE_SHOP || '',
        sourceToken: process.env.SOURCE_ACCESS_TOKEN || '',
        sourceClientId: process.env.SOURCE_CLIENT_ID || '',
        sourceClientSecret: process.env.SOURCE_CLIENT_SECRET || '',
        targetShop: process.env.TARGET_SHOP || '',
        targetToken: process.env.TARGET_ACCESS_TOKEN || '',
        targetClientId: process.env.TARGET_CLIENT_ID || '',
        targetClientSecret: process.env.TARGET_CLIENT_SECRET || '',
    });
});

app.post('/api/test-connection', async (req, res) => {
    const { shop, token, clientId, clientSecret } = req.body;
    if (!shop) return res.status(400).json({ error: 'Missing shop domain' });
    if (!token && (!clientId || !clientSecret)) return res.status(400).json({ error: 'Provide access token or client_id + client_secret' });
    try {
        const accessToken = await resolveToken(shop, token, clientId, clientSecret);
        const client = new ApiClient(shop, accessToken);
        const data = await client.rest('GET', '/shop.json');
        res.json({ ok: true, name: data?.shop?.name, domain: data?.shop?.domain, tokenResolved: !token });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

app.post('/api/start', async (req, res) => {
    const { sourceShop, sourceToken, sourceClientId, sourceClientSecret, targetShop, targetToken, targetClientId, targetClientSecret, modules } = req.body;
    if (!sourceShop || !targetShop) return res.status(400).json({ error: 'Both store domains required' });

    let srcToken, tgtToken;
    try {
        srcToken = await resolveToken(sourceShop, sourceToken, sourceClientId, sourceClientSecret);
    } catch (err) {
        return res.status(400).json({ error: `Source auth failed: ${err.message}` });
    }
    try {
        tgtToken = await resolveToken(targetShop, targetToken, targetClientId, targetClientSecret);
    } catch (err) {
        return res.status(400).json({ error: `Target auth failed: ${err.message}` });
    }

    const job = createJob({ sourceShop, sourceToken: srcToken, targetShop, targetToken: tgtToken, modules: modules || 'all' });
    // run in background
    runMigration(job.id).catch(err => {
        updateJob(job.id, { status: 'failed' });
        appendLog(job.id, 'error', `Fatal: ${err.message}`);
    });
    res.json({ jobId: job.id });
});

app.post('/api/cancel/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (job) { job.status = 'cancelled'; updateJob(req.params.id, { status: 'cancelled' }); }
    res.json({ ok: true });
});

app.get('/api/job/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Not found' });
    res.json(job);
});

// SSE endpoint for real-time updates
app.get('/api/stream/:id', (req, res) => {
    const jobId = req.params.id;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    if (!sseClients.has(jobId)) sseClients.set(jobId, new Set());
    sseClients.get(jobId).add(res);

    // Send current state
    const job = jobs.get(jobId);
    if (job) {
        for (const log of job.logs.slice(-50)) {
            res.write(`data: ${JSON.stringify({ type: 'log', ...log, progress: job.progress, status: job.status, currentModule: job.currentModule, doneModules: job.doneModules, totalModules: job.totalModules })}\n\n`);
        }
    }

    req.on('close', () => {
        sseClients.get(jobId)?.delete(res);
    });
});

// Serve UI
app.get('/', (req, res) => {
    res.sendFile(join(__dirname, '..', 'web', 'index.html'));
});

const PORT = process.env.PORT || 3456;
app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log(`  ╔══════════════════════════════════════╗`);
    console.log(`  ║  🛒 Store Cloner                     ║`);
    console.log(`  ║  http://localhost:${PORT}               ║`);
    console.log(`  ╚══════════════════════════════════════╝`);
    console.log('');
    if (!process.env.RAILWAY_ENVIRONMENT) {
        open(`http://localhost:${PORT}`).catch(() => {});
    }
});
