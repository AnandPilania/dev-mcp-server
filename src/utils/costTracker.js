'use strict';
/**
 * Provider-agnostic cost tracking. Uses llmClient for price lookup.
 */

const fs = require('fs');
const path = require('path');

const COST_FILE = path.join(process.cwd(), 'data', 'cost-tracker.json');

class CostTracker {
    constructor() {
        this._data = this._load();
    }

    _load() {
        try { if (fs.existsSync(COST_FILE)) return JSON.parse(fs.readFileSync(COST_FILE, 'utf-8')); } catch { }
        return { sessions: {}, allTime: { inputTokens: 0, outputTokens: 0, totalCostUsd: 0, calls: 0 } };
    }
    _save() { fs.writeFileSync(COST_FILE, JSON.stringify(this._data, null, 2)); }

    record({ model, inputTokens, outputTokens, sessionId = 'default', queryType = 'general' }) {
        // Lazy-load llmClient to avoid circular dep at startup
        let costUsd = 0;
        try {
            const llm = require('./llmClient');
            costUsd = llm.costUsd(model, inputTokens, outputTokens);
        } catch { }

        this._data.allTime.inputTokens += inputTokens;
        this._data.allTime.outputTokens += outputTokens;
        this._data.allTime.totalCostUsd += costUsd;
        this._data.allTime.calls += 1;

        if (!this._data.sessions[sessionId]) {
            this._data.sessions[sessionId] = { startedAt: new Date().toISOString(), inputTokens: 0, outputTokens: 0, totalCostUsd: 0, calls: 0, byQueryType: {} };
        }
        const sess = this._data.sessions[sessionId];
        sess.inputTokens += inputTokens;
        sess.outputTokens += outputTokens;
        sess.totalCostUsd += costUsd;
        sess.calls += 1;
        sess.lastUsedAt = new Date().toISOString();
        sess.byQueryType[queryType] = (sess.byQueryType[queryType] || 0) + 1;

        this._save();
        return { costUsd, inputTokens, outputTokens };
    }

    getSession(id = 'default') { return this._data.sessions[id] || null; }
    getAllTime() { return this._data.allTime; }

    getSummary(sessionId = 'default') {
        const sess = this.getSession(sessionId);
        const all = this.getAllTime();
        return {
            session: sess ? { calls: sess.calls, inputTokens: sess.inputTokens, outputTokens: sess.outputTokens, costUsd: parseFloat(sess.totalCostUsd.toFixed(6)), startedAt: sess.startedAt } : null,
            allTime: { calls: all.calls, inputTokens: all.inputTokens, outputTokens: all.outputTokens, costUsd: parseFloat(all.totalCostUsd.toFixed(6)) },
        };
    }

    formatCost(usd) {
        if (usd === 0) return '$0.0000 (local)';
        if (usd < 0.001) return `$${(usd * 1000).toFixed(4)}m`;
        return `$${usd.toFixed(4)}`;
    }
}

module.exports = new CostTracker();
