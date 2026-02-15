import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fetch from 'node-fetch';

dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') });

const config = {
  source: {
    shop: process.env.SOURCE_SHOP,
    accessToken: process.env.SOURCE_ACCESS_TOKEN || null,
    clientId: process.env.SOURCE_CLIENT_ID || null,
    clientSecret: process.env.SOURCE_CLIENT_SECRET || null,
    get baseUrl() {
      return `https://${this.shop}/admin/api/${config.apiVersion}`;
    },
    get graphqlUrl() {
      return `${this.baseUrl}/graphql.json`;
    },
  },
  target: {
    shop: process.env.TARGET_SHOP,
    accessToken: process.env.TARGET_ACCESS_TOKEN || null,
    clientId: process.env.TARGET_CLIENT_ID || null,
    clientSecret: process.env.TARGET_CLIENT_SECRET || null,
    get baseUrl() {
      return `https://${this.shop}/admin/api/${config.apiVersion}`;
    },
    get graphqlUrl() {
      return `${this.baseUrl}/graphql.json`;
    },
  },
  apiVersion: process.env.API_VERSION || '2025-01',
  dataDir: process.env.DATA_DIR || './data',
  rateLimit: parseInt(process.env.RATE_LIMIT || '2', 10),
  logLevel: process.env.LOG_LEVEL || 'info',
};

/**
 * Get access token via Client Credentials Grant (new 2025 method)
 */
async function getTokenViaClientCredentials(storeConfig) {
  const url = `https://${storeConfig.shop}/admin/oauth/access_token`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: storeConfig.clientId,
      client_secret: storeConfig.clientSecret,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to get access token for ${storeConfig.shop}: ${res.status} ${text}`);
  }

  const data = await res.json();
  return data.access_token;
}

/**
 * Ensures both stores have access tokens (fetches via client credentials if needed)
 */
export async function resolveTokens() {
  // Source store
  if (!config.source.accessToken && config.source.clientId && config.source.clientSecret) {
    console.log(`  🔑 Getting access token for source store (${config.source.shop})...`);
    config.source.accessToken = await getTokenViaClientCredentials(config.source);
    console.log(`  ✓ Source token obtained`);
  }

  // Target store
  if (!config.target.accessToken && config.target.clientId && config.target.clientSecret) {
    console.log(`  🔑 Getting access token for target store (${config.target.shop})...`);
    config.target.accessToken = await getTokenViaClientCredentials(config.target);
    console.log(`  ✓ Target token obtained`);
  }
}

export function validateConfig() {
  // Check source store
  const hasSourceToken = !!config.source.accessToken;
  const hasSourceCreds = !!(config.source.clientId && config.source.clientSecret);
  if (!config.source.shop || (!hasSourceToken && !hasSourceCreds)) {
    throw new Error(
      'Missing source store config. Set either:\n' +
      '  - SOURCE_SHOP + SOURCE_ACCESS_TOKEN, or\n' +
      '  - SOURCE_SHOP + SOURCE_CLIENT_ID + SOURCE_CLIENT_SECRET\n' +
      'Copy .env.example to .env and fill in the values.'
    );
  }

  // Check target store
  const hasTargetToken = !!config.target.accessToken;
  const hasTargetCreds = !!(config.target.clientId && config.target.clientSecret);
  if (!config.target.shop || (!hasTargetToken && !hasTargetCreds)) {
    throw new Error(
      'Missing target store config. Set either:\n' +
      '  - TARGET_SHOP + TARGET_ACCESS_TOKEN, or\n' +
      '  - TARGET_SHOP + TARGET_CLIENT_ID + TARGET_CLIENT_SECRET\n' +
      'Copy .env.example to .env and fill in the values.'
    );
  }
}

export function validateSourceConfig() {
  const hasSourceToken = !!config.source.accessToken;
  const hasSourceCreds = !!(config.source.clientId && config.source.clientSecret);
  if (!config.source.shop || (!hasSourceToken && !hasSourceCreds)) {
    throw new Error(
      'Missing source store config. Set either:\n' +
      '  - SOURCE_SHOP + SOURCE_ACCESS_TOKEN, or\n' +
      '  - SOURCE_SHOP + SOURCE_CLIENT_ID + SOURCE_CLIENT_SECRET'
    );
  }
}

export function validateTargetConfig() {
  const hasTargetToken = !!config.target.accessToken;
  const hasTargetCreds = !!(config.target.clientId && config.target.clientSecret);
  if (!config.target.shop || (!hasTargetToken && !hasTargetCreds)) {
    throw new Error(
      'Missing target store config. Set either:\n' +
      '  - TARGET_SHOP + TARGET_ACCESS_TOKEN, or\n' +
      '  - TARGET_SHOP + TARGET_CLIENT_ID + TARGET_CLIENT_SECRET'
    );
  }
}

export default config;
