'use strict';
/**
 * A shared memory store that persists across all sessions and is visible
 * to all agents. Unlike personal MemoryManager (per-session), team memory
 * is a shared knowledge base that every agent reads from automatically.
 *
 * Use cases:
 *  - Codebase-wide conventions that all agents should know
 *  - Known bugs and their fixes
 *  - Architecture decisions
 *  - Onboarding facts for new developers
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const TEAM_MEM_FILE = path.join(process.cwd(), 'data', 'team-memory.json');

class TeamMemory {
    constructor() {
        this._store = this._load();
    }

    _load() {
        try { if (fs.existsSync(TEAM_MEM_FILE)) return JSON.parse(fs.readFileSync(TEAM_MEM_FILE, 'utf-8')); } catch { }
        return { entries: {}, nextId: 1 };
    }
    _save() { fs.writeFileSync(TEAM_MEM_FILE, JSON.stringify(this._store, null, 2)); }

    /**
     * Add a team-wide memory entry
     */
    add({ team = 'global', content, type = 'fact', tags = [], author = 'system' }) {
        if (!content) throw new Error('content required');
        const id = `tmem_${this._store.nextId++}`;
        const entry = { id, team, content, type, tags, author, createdAt: new Date().toISOString(), useCount: 0 };
        if (!this._store.entries[team]) this._store.entries[team] = [];
        this._store.entries[team].push(entry);
        this._save();
        logger.info(`[TeamMemory] Added to "${team}": ${content.slice(0, 60)}`);
        return entry;
    }

    /**
     * Get all entries for a team (or global if no team)
     */
    get(team = 'global', opts = {}) {
        const { type, limit = 50 } = opts;
        const entries = [
            ...(this._store.entries['global'] || []),
            ...(team !== 'global' ? (this._store.entries[team] || []) : []),
        ];
        const filtered = type ? entries.filter(e => e.type === type) : entries;
        return filtered
            .sort((a, b) => b.useCount - a.useCount || new Date(b.createdAt) - new Date(a.createdAt))
            .slice(0, limit);
    }

    /**
     * Search team memory by keyword
     */
    search(query, team = 'global') {
        const entries = this.get(team, { limit: 200 });
        const q = query.toLowerCase();
        return entries
            .filter(e => e.content.toLowerCase().includes(q) || e.tags.some(t => t.includes(q)))
            .map(e => { e.useCount++; return e; });
    }

    /**
     * Format team memory as a system context block for injection into agents
     */
    formatForAgent(team = 'global') {
        const entries = this.get(team, { limit: 20 });
        if (!entries.length) return '';
        return `## Team Knowledge Base (${team})\n` +
            entries.map(e => `- [${e.type}] ${e.content}`).join('\n');
    }

    /**
     * List all teams
     */
    listTeams() {
        return Object.keys(this._store.entries).map(team => ({
            team,
            count: this._store.entries[team].length,
        }));
    }

    delete(id) {
        for (const team of Object.keys(this._store.entries)) {
            const before = this._store.entries[team].length;
            this._store.entries[team] = this._store.entries[team].filter(e => e.id !== id);
            if (this._store.entries[team].length !== before) { this._save(); return true; }
        }
        return false;
    }

    clearTeam(team) {
        delete this._store.entries[team];
        this._save();
    }

    getStats() {
        const total = Object.values(this._store.entries).reduce((s, a) => s + a.length, 0);
        return { total, teams: this.listTeams() };
    }
}

module.exports = new TeamMemory();
