/**
 * Watches the filesystem for changes and automatically re-ingests
 * modified files into the knowledge base, keeping the index fresh.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const ingester = require('../core/ingester');
const indexer = require('../core/indexer');
const { FILE_TYPE_MAP } = require('../utils/fileParser');

const SUPPORTED_EXTS = new Set(Object.keys(FILE_TYPE_MAP));

// Debounce time — wait this long after last change before re-ingesting
const DEBOUNCE_MS = 1500;

class FileWatcher {
    constructor() {
        this._watchers = new Map();    // dirPath → fs.FSWatcher
        this._pending = new Map();     // filePath → timeout handle
        this._stats = { ingested: 0, errors: 0, events: 0 };
        this._isActive = false;
    }

    /**
     * Watch a directory for changes
     */
    watch(dirPath, opts = {}) {
        const abs = path.resolve(dirPath);
        if (!fs.existsSync(abs)) throw new Error(`Directory not found: ${abs}`);
        if (this._watchers.has(abs)) return { alreadyWatching: true, path: abs };

        logger.info(`[Watcher] 👁️  Watching: ${abs}`);

        const watcher = fs.watch(abs, { recursive: true }, (event, filename) => {
            if (!filename) return;
            const filePath = path.join(abs, filename);
            const ext = path.extname(filename).toLowerCase();

            // Skip unsupported files and build artifacts
            if (!SUPPORTED_EXTS.has(ext)) return;
            if (/node_modules|\.git|dist|build|\.bak/.test(filePath)) return;

            this._stats.events++;
            this._scheduleIngest(filePath);
        });

        watcher.on('error', (err) => {
            logger.error(`[Watcher] Error watching ${abs}: ${err.message}`);
        });

        this._watchers.set(abs, watcher);
        this._isActive = true;

        return { watching: true, path: abs };
    }

    /**
     * Stop watching a directory
     */
    unwatch(dirPath) {
        const abs = path.resolve(dirPath);
        const watcher = this._watchers.get(abs);
        if (!watcher) return false;
        watcher.close();
        this._watchers.delete(abs);
        logger.info(`[Watcher] Stopped watching: ${abs}`);
        if (this._watchers.size === 0) this._isActive = false;
        return true;
    }

    /**
     * Stop all watchers
     */
    stopAll() {
        for (const [dir, watcher] of this._watchers.entries()) {
            watcher.close();
            logger.info(`[Watcher] Stopped: ${dir}`);
        }
        this._watchers.clear();
        for (const handle of this._pending.values()) clearTimeout(handle);
        this._pending.clear();
        this._isActive = false;
    }

    /**
     * Schedule a debounced ingest for a file
     */
    _scheduleIngest(filePath) {
        // Clear any pending ingest for this file
        if (this._pending.has(filePath)) {
            clearTimeout(this._pending.get(filePath));
        }

        const handle = setTimeout(async () => {
            this._pending.delete(filePath);
            await this._ingestFile(filePath);
        }, DEBOUNCE_MS);

        this._pending.set(filePath, handle);
    }

    async _ingestFile(filePath) {
        if (!fs.existsSync(filePath)) {
            // File deleted — remove from index
            const store = require('../storage/store');
            const removed = store.removeByPath(filePath);
            if (removed > 0) {
                indexer.invalidate();
                logger.info(`[Watcher] Removed from index (deleted): ${path.basename(filePath)}`);
            }
            return;
        }

        try {
            await ingester.ingestFile(filePath);
            indexer.build();
            this._stats.ingested++;
            logger.info(`[Watcher] ♻️  Re-ingested: ${path.basename(filePath)}`);
        } catch (err) {
            this._stats.errors++;
            logger.warn(`[Watcher] Failed to re-ingest ${path.basename(filePath)}: ${err.message}`);
        }
    }

    getStatus() {
        return {
            isActive: this._isActive,
            watchedDirs: [...this._watchers.keys()],
            pendingIngests: this._pending.size,
            stats: { ...this._stats },
        };
    }
}

module.exports = new FileWatcher();
