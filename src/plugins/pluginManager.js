'use strict';
/**
 * A plugin is a plain Node module that exports:
 *   { name, version, description, register(app, registry) }
 *
 * register() receives:
 *   - app           : Express app (add routes)
 *   - toolRegistry  : add custom tools
 *   - app._mcpCtx   : shared context (store, indexer, memory, etc.)
 *
 * Built-in plugins ship in src/plugins/builtin/.
 * User plugins drop into <cwd>/plugins/.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const BUILTIN_DIR = path.join(__dirname, 'builtin');
const USER_DIR = path.join(process.cwd(), 'plugins');
const STATE_FILE = path.join(process.cwd(), 'data', 'plugins-state.json');

class PluginManager {
    constructor() {
        this._plugins = new Map();   // name → { meta, enabled, instance }
        this._state = this._loadState();
        this._app = null;
        this._ctx = null;
    }

    _loadState() {
        try { if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); } catch { }
        return { disabled: [] };
    }
    _saveState() { fs.writeFileSync(STATE_FILE, JSON.stringify(this._state, null, 2)); }

    /**
     * Load and register all plugins. Called once during server boot.
     * @param {Express} app
     * @param {object}  ctx  — { toolRegistry, store, indexer, memoryManager, ... }
     */
    async loadAll(app, ctx = {}) {
        this._app = app;
        this._ctx = ctx;

        // Load built-in plugins first
        if (fs.existsSync(BUILTIN_DIR)) {
            for (const file of fs.readdirSync(BUILTIN_DIR).filter(f => f.endsWith('.js'))) {
                await this._load(path.join(BUILTIN_DIR, file), true);
            }
        }

        // Load user plugins
        if (fs.existsSync(USER_DIR)) {
            for (const file of fs.readdirSync(USER_DIR).filter(f => f.endsWith('.js'))) {
                await this._load(path.join(USER_DIR, file), false);
            }
        }

        logger.info(`[Plugins] Loaded ${this._plugins.size} plugin(s): ${[...this._plugins.keys()].join(', ') || 'none'}`);
    }

    async _load(filePath, builtIn = false) {
        try {
            const mod = require(filePath);
            const name = mod.name || path.basename(filePath, '.js');
            const enabled = !this._state.disabled.includes(name);

            const entry = {
                name,
                version: mod.version || '1.0.0',
                description: mod.description || '',
                filePath,
                builtIn,
                enabled,
                loadedAt: new Date().toISOString(),
                error: null,
            };

            if (enabled && typeof mod.register === 'function') {
                try {
                    await mod.register(this._app, {
                        toolRegistry: this._ctx.toolRegistry,
                        ...this._ctx,
                    });
                    logger.info(`[Plugins] ✓ ${name}${builtIn ? ' (built-in)' : ''}`);
                } catch (err) {
                    entry.error = err.message;
                    logger.error(`[Plugins] ✗ ${name}: ${err.message}`);
                }
            }

            this._plugins.set(name, entry);
        } catch (err) {
            logger.warn(`[Plugins] Could not load ${filePath}: ${err.message}`);
        }
    }

    /**
     * Load a single plugin by file path (hot-load at runtime)
     */
    async loadPlugin(filePath) {
        delete require.cache[require.resolve(filePath)];
        await this._load(filePath);
        return this.get(path.basename(filePath, '.js'));
    }

    enable(name) {
        const p = this._plugins.get(name);
        if (!p) throw new Error(`Plugin not found: ${name}`);
        this._state.disabled = this._state.disabled.filter(n => n !== name);
        p.enabled = true;
        this._saveState();
        return p;
    }

    disable(name) {
        const p = this._plugins.get(name);
        if (!p) throw new Error(`Plugin not found: ${name}`);
        if (!this._state.disabled.includes(name)) this._state.disabled.push(name);
        p.enabled = false;
        this._saveState();
        logger.info(`[Plugins] Disabled: ${name} (restart to fully unload)`);
        return p;
    }

    list() {
        return [...this._plugins.values()].map(({ filePath, ...rest }) => rest);
    }

    get(name) {
        const p = this._plugins.get(name);
        if (!p) return null;
        const { filePath, ...rest } = p;
        return rest;
    }

    getStats() {
        const all = this.list();
        return { total: all.length, enabled: all.filter(p => p.enabled).length, disabled: all.filter(p => !p.enabled).length, errors: all.filter(p => p.error).length };
    }
}

module.exports = new PluginManager();
