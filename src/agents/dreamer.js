'use strict';
/**
 * Background cognitive agent. Runs on a timer.
 * Five phases per dream cycle:
 *   1. Consolidate memories (merge duplicates, resolve contradictions)
 *   2. Pattern discovery (scan codebase for architectural patterns)
 *   3. Proactive suggestions (surface improvements nobody asked for)
 *   4. Knowledge graph building (connect related facts)
 *   5. Pruning (remove stale/low-quality memories)
 */

const llm = require('../utils/llmClient');
const fs = require('fs');
const path = require('path');
const { MemoryManager, MEMORY_TYPES } = require('../memory/memoryManager');
const store = require('../storage/store');
const costTracker = require('../utils/costTracker');
const logger = require('../utils/logger');

const LOG_FILE = path.join(process.cwd(), 'data', 'dream-log.json');

class Dreamer {
    constructor() {
        this._running = false;
        this._handle = null;
        this._count = 0;
        this._log = this._loadLog();
    }

    _loadLog() {
        try { if (fs.existsSync(LOG_FILE)) return JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8')); } catch { }
        return { dreams: [], lastDream: null };
    }
    _saveLog() { fs.writeFileSync(LOG_FILE, JSON.stringify(this._log, null, 2)); }

    start(intervalMinutes = 30) {
        if (this._running) return;
        this._running = true;
        logger.info(`[Dreamer] 💤 Started (every ${intervalMinutes}min)`);
        setTimeout(() => this.dream(), 15000);
        this._handle = setInterval(() => this.dream(), intervalMinutes * 60000);
    }

    stop() {
        if (this._handle) clearInterval(this._handle);
        this._running = false;
    }

    async dream() {
        const t0 = Date.now();
        this._count++;
        logger.info(`[Dreamer] 💭 Dream #${this._count} starting...`);

        const phases = {};
        try { phases.consolidate = await this._consolidate(); } catch (e) { logger.warn(`[Dreamer] consolidate: ${e.message}`); }
        try { phases.patterns = await this._discoverPatterns(); } catch (e) { logger.warn(`[Dreamer] patterns: ${e.message}`); }
        try { phases.suggestions = await this._proactiveSuggestions(); } catch (e) { logger.warn(`[Dreamer] suggestions: ${e.message}`); }
        try { phases.graph = await this._buildKnowledgeGraph(); } catch (e) { logger.warn(`[Dreamer] graph: ${e.message}`); }
        phases.pruned = this._prune();

        const record = {
            id: this._count, ts: new Date().toISOString(),
            ms: Date.now() - t0,
            insights: (phases.patterns?.length || 0) + (phases.suggestions?.length || 0) + (phases.consolidate?.length || 0),
            pruned: phases.pruned, phases: Object.keys(phases),
        };
        this._log.dreams.push(record);
        this._log.lastDream = record.ts;
        if (this._log.dreams.length > 50) this._log.dreams = this._log.dreams.slice(-50);
        this._saveLog();
        logger.info(`[Dreamer] ✨ Dream #${this._count} done: ${record.insights} insights, ${record.pruned} pruned in ${record.ms}ms`);
        return record;
    }

    // Phase 1 — consolidate duplicate / contradicting memories
    async _consolidate() {
        const mems = MemoryManager.list();
        if (mems.length < 6) return [];
        const byType = {};
        for (const m of mems) (byType[m.type] = byType[m.type] || []).push(m);
        const merged = [];
        for (const [type, group] of Object.entries(byType)) {
            if (group.length < 3) continue;
            const snippet = group.slice(0, 8).map((m, i) => `[${i}] ${m.content}`).join('\n');
            const r = await this._ask(`These are "${type}" memories. Find duplicates or contradictions worth merging/removing.\nReturn JSON: [{"action":"merge|remove","indices":[0,1],"merged":"new text if merging"}]. Return [] if nothing to do.\n${snippet}`);
            const actions = this._parseJSON(r, []);
            for (const a of actions) {
                if (a.action === 'merge' && a.merged) {
                    for (const i of a.indices) { if (group[i]) MemoryManager.delete(group[i].id); }
                    merged.push(MemoryManager.add(a.merged, type, ['dream-consolidated']));
                } else if (a.action === 'remove') {
                    for (const i of a.indices) { if (group[i]) MemoryManager.delete(group[i].id); }
                }
            }
        }
        return merged;
    }

    // Phase 2 — discover architectural / code patterns
    async _discoverPatterns() {
        const docs = store.getAll().filter(d => d.kind === 'code').slice(0, 20);
        if (docs.length < 3) return [];
        const sample = docs.map(d => `// ${d.filename}\n${d.content.slice(0, 250)}`).join('\n\n---\n\n');
        const r = await this._ask(`Analyse these code samples. Find 2-3 important patterns (conventions, risks, anti-patterns).\nReturn JSON: [{"pattern":"...","type":"pattern|fact|decision","importance":"high|med|low"}]\nReturn [] if nothing notable.\n${sample}`);
        const patterns = this._parseJSON(r, []);
        const added = [];
        for (const p of patterns.filter(p => p.pattern && p.importance !== 'low')) {
            const exists = MemoryManager.getRelevant(p.pattern, 1);
            if (!exists.length) added.push(MemoryManager.add(p.pattern, p.type || 'pattern', ['dream-pattern']));
        }
        return added;
    }

    // Phase 3 — proactive suggestions nobody asked for
    async _proactiveSuggestions() {
        const recent = MemoryManager.list().filter(m => !m.tags?.includes('dream-')).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 12);
        if (recent.length < 4) return [];
        const summary = recent.map(m => m.content.slice(0, 80)).join('\n');
        const r = await this._ask(`Based on recent developer activity, generate 1-2 proactive improvements NOT yet mentioned.\nReturn JSON: [{"suggestion":"...","rationale":"...","priority":"high|med"}]\nReturn [] if nothing to add.\nRecent activity:\n${summary}`);
        const sug = this._parseJSON(r, []);
        return sug.filter(s => s.suggestion && s.priority !== 'low')
            .map(s => MemoryManager.add(`[Proactive] ${s.suggestion} — ${s.rationale}`, MEMORY_TYPES.DECISION, ['dream-suggestion', s.priority]));
    }

    // Phase 4 — build connections between related memories
    async _buildKnowledgeGraph() {
        const mems = MemoryManager.list().slice(0, 20);
        if (mems.length < 5) return [];
        const list = mems.map((m, i) => `[${i}] (${m.type}) ${m.content.slice(0, 70)}`).join('\n');
        const r = await this._ask(`Find 2-3 non-obvious connections between these facts that would help a developer.\nReturn JSON: [{"connection":"...","indices":[0,1]}]\nReturn [].\n${list}`);
        const links = this._parseJSON(r, []);
        return links.filter(l => l.connection)
            .map(l => MemoryManager.add(`[Connection] ${l.connection}`, MEMORY_TYPES.PATTERN, ['dream-graph']));
    }

    // Phase 5 — prune stale/low-quality memories
    _prune() {
        const mems = MemoryManager.list();
        let pruned = 0;
        for (const m of mems) {
            const ageDays = (Date.now() - new Date(m.createdAt).getTime()) / 86400000;
            const stale = ageDays > 30 && m.useCount === 0;
            const short = m.content.length < 12;
            const oldAuto = m.tags?.includes('dream-') && ageDays > 14 && m.useCount === 0;
            if (stale || short || oldAuto) { MemoryManager.delete(m.id); pruned++; }
        }
        if (pruned) logger.info(`[Dreamer] Pruned ${pruned} stale memories`);
        return pruned;
    }

    async _ask(prompt) {
        const r = await llm.chat({ model: llm.model('fast'), max_tokens: 400, messages: [{ role: 'user', content: prompt }] });
        costTracker.record({ model: llm.model('fast'), inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens, sessionId: 'dreamer', queryType: 'dream' });
        return r.content[0].text;
    }

    _parseJSON(text, fallback) {
        try { return JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim()); } catch { return fallback; }
    }

    async dreamNow() { return this.dream(); }
    getStatus() { return { running: this._running, count: this._count, lastDream: this._log.lastDream, recent: this._log.dreams.slice(-5) }; }
}

module.exports = new Dreamer();
