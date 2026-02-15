import fs from 'fs/promises';
import { join } from 'path';
import config from './config.js';

class IdMapper {
    constructor() {
        this.maps = {};
        this.filePath = join(config.dataDir, 'id-mapping.json');
    }

    set(resourceType, sourceId, targetId) {
        if (!this.maps[resourceType]) this.maps[resourceType] = {};
        this.maps[resourceType][String(sourceId)] = String(targetId);
    }

    get(resourceType, sourceId) {
        return this.maps[resourceType]?.[String(sourceId)] || null;
    }

    getAll(resourceType) {
        return this.maps[resourceType] || {};
    }

    setHandleMap(resourceType, handle, sourceId, targetId) {
        const key = `${resourceType}_handles`;
        if (!this.maps[key]) this.maps[key] = {};
        this.maps[key][handle] = { sourceId: String(sourceId), targetId: String(targetId) };
    }

    getByHandle(resourceType, handle) {
        const key = `${resourceType}_handles`;
        return this.maps[key]?.[handle] || null;
    }

    async save() {
        await fs.mkdir(config.dataDir, { recursive: true });
        await fs.writeFile(this.filePath, JSON.stringify(this.maps, null, 2));
    }

    async load() {
        try {
            const data = await fs.readFile(this.filePath, 'utf-8');
            this.maps = JSON.parse(data);
            return true;
        } catch {
            return false;
        }
    }

    count(resourceType) {
        return Object.keys(this.maps[resourceType] || {}).length;
    }
}

export default IdMapper;
