import fs from 'fs/promises';
import { join } from 'path';
import config from '../config.js';

export async function saveData(moduleName, data) {
    const dir = join(config.dataDir, moduleName);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'data.json'), JSON.stringify(data, null, 2));
    return data;
}

export async function loadData(moduleName) {
    try {
        const raw = await fs.readFile(join(config.dataDir, moduleName, 'data.json'), 'utf-8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

export function extractId(gid) {
    if (!gid) return null;
    const match = String(gid).match(/\/(\d+)$/);
    return match ? match[1] : gid;
}

export function buildGid(resourceType, id) {
    return `gid://shopify/${resourceType}/${id}`;
}

export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
