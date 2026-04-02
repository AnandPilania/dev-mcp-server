const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const DATA_DIR = path.join(process.cwd(), 'data');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');
const META_FILE = path.join(DATA_DIR, 'meta.json');

class Store {
    constructor() {
        this._ensureDataDir();
        this.index = this._load(INDEX_FILE, []);
        this.meta = this._load(META_FILE, {
            totalDocs: 0,
            totalFiles: 0,
            lastIngested: null,
            fileTypes: {},
            tags: [],
        });
    }

    _ensureDataDir() {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        const logsDir = path.join(process.cwd(), 'logs');
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }
    }

    _load(file, defaultVal) {
        try {
            if (fs.existsSync(file)) {
                return JSON.parse(fs.readFileSync(file, 'utf-8'));
            }
        } catch (e) {
            logger.warn(`Could not load ${file}: ${e.message}`);
        }
        return defaultVal;
    }

    _save() {
        fs.writeFileSync(INDEX_FILE, JSON.stringify(this.index, null, 2));
        fs.writeFileSync(META_FILE, JSON.stringify(this.meta, null, 2));
    }

    upsertDocs(docs) {
        let added = 0;
        let updated = 0;

        for (const doc of docs) {
            const existingIdx = this.index.findIndex(d => d.id === doc.id);
            if (existingIdx >= 0) {
                this.index[existingIdx] = doc;
                updated++;
            } else {
                this.index.push(doc);
                added++;
            }
        }

        this._rebuildMeta();
        this._save();
        return { added, updated };
    }

    removeByPath(filePath) {
        const before = this.index.length;
        this.index = this.index.filter(d => d.filePath !== filePath);
        const removed = before - this.index.length;
        this._rebuildMeta();
        this._save();
        return removed;
    }

    getAll() {
        return this.index;
    }

    getByKind(kind) {
        return this.index.filter(d => d.kind === kind);
    }

    getIngestedFiles() {
        return [...new Set(this.index.map(d => d.filePath))];
    }

    clear() {
        this.index = [];
        this.meta = {
            totalDocs: 0,
            totalFiles: 0,
            lastIngested: null,
            fileTypes: {},
            tags: [],
        };
        this._save();
    }

    getStats() {
        return {
            ...this.meta,
            indexSize: this.index.length,
        };
    }

    _rebuildMeta() {
        const files = new Set(this.index.map(d => d.filePath));
        const fileTypes = {};
        for (const doc of this.index) {
            fileTypes[doc.kind] = (fileTypes[doc.kind] || 0) + 1;
        }

        this.meta = {
            totalDocs: this.index.length,
            totalFiles: files.size,
            lastIngested: new Date().toISOString(),
            fileTypes,
        };
    }
}

const store = new Store();
module.exports = store;
