/**
 * Auto-extracts important facts from conversations and persists them.
 * Memory is injected into future queries as additional context.
 */

const fs = require('fs');
const path = require('path');
const llm = require('../utils/llmClient');
const logger = require('../utils/logger');
const costTracker = require('../utils/costTracker');

const MEMORY_FILE = path.join(process.cwd(), 'data', 'memories.json');

// Memory categories
const MEMORY_TYPES = {
    FACT: 'fact',           // Static facts about the codebase
    PATTERN: 'pattern',    // Recurring patterns or conventions
    BUG: 'bug',            // Known bugs and their fixes
    DECISION: 'decision',  // Architecture/design decisions
    PERSON: 'person',      // Who owns/knows what
    PREFERENCE: 'preference', // Team preferences and conventions
};

class MemoryManager {
    constructor() {
        this._memories = this._load();
    }

    _load() {
        try {
            if (fs.existsSync(MEMORY_FILE)) {
                return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
            }
        } catch { }
        return { entries: [], version: 1 };
    }

    _save() {
        fs.writeFileSync(MEMORY_FILE, JSON.stringify(this._memories, null, 2));
    }

    /**
     * Add a memory entry manually
     */
    add(content, type = MEMORY_TYPES.FACT, tags = []) {
        const entry = {
            id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            content: content.trim(),
            type,
            tags,
            createdAt: new Date().toISOString(),
            useCount: 0,
            lastUsedAt: null,
        };
        this._memories.entries.push(entry);
        this._save();
        logger.info(`[Memory] Added: "${content.slice(0, 80)}"`);
        return entry;
    }

    /**
     * Auto-extract memories from a Q&A exchange
     */
    async extractFromExchange(question, answer, sessionId = 'default') {
        try {
            const response = await llm.chat({
                model: llm.model('fast'),
                max_tokens: 400,
                system: `Extract important, reusable facts from this developer Q&A exchange.
Only extract things that would be useful context for FUTURE questions about this codebase.
Return a JSON array of objects: [{"content": "...", "type": "fact|pattern|bug|decision|person|preference", "tags": ["tag1"]}]
Return [] if nothing worth remembering. Be selective — only extract genuinely useful facts.
Return ONLY the JSON array, no other text.`,
                messages: [{
                    role: 'user',
                    content: `Question: ${question}\n\nAnswer: ${answer.slice(0, 1500)}`,
                }],
            });

            costTracker.record({
                model: llm.model('fast'),
                inputTokens: response.usage.input_tokens,
                outputTokens: response.usage.output_tokens,
                sessionId,
                queryType: 'memory-extract',
            });

            const text = response.content[0].text.trim();
            const extracted = JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim());

            if (!Array.isArray(extracted)) return [];

            const added = [];
            for (const item of extracted) {
                if (item.content && item.content.length > 10) {
                    const entry = this.add(item.content, item.type || MEMORY_TYPES.FACT, item.tags || []);
                    added.push(entry);
                }
            }
            return added;
        } catch (err) {
            logger.warn(`[Memory] Extraction failed: ${err.message}`);
            return [];
        }
    }

    /**
     * Get memories relevant to a query (simple keyword match)
     */
    getRelevant(query, limit = 5) {
        const q = query.toLowerCase();
        const words = q.split(/\W+/).filter(w => w.length > 3);

        const scored = this._memories.entries.map(mem => {
            const text = (mem.content + ' ' + mem.tags.join(' ')).toLowerCase();
            let score = 0;
            for (const word of words) {
                if (text.includes(word)) score += 1;
            }
            // Boost recent memories
            const age = Date.now() - new Date(mem.createdAt).getTime();
            const ageDays = age / (1000 * 60 * 60 * 24);
            if (ageDays < 7) score += 0.5;
            // Boost frequently used
            score += mem.useCount * 0.1;
            return { mem, score };
        });

        return scored
            .filter(s => s.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(s => {
                s.mem.useCount++;
                s.mem.lastUsedAt = new Date().toISOString();
                return s.mem;
            });
    }

    /**
     * Format memories as context string for injection into prompts
     */
    formatAsContext(memories) {
        if (!memories || memories.length === 0) return '';
        return `## Persistent Memory (what I know about this codebase)\n` +
            memories.map(m => `- [${m.type}] ${m.content}`).join('\n');
    }

    /**
     * List all memories
     */
    list(type = null) {
        const entries = type
            ? this._memories.entries.filter(m => m.type === type)
            : this._memories.entries;
        return entries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    /**
     * Delete a memory by ID
     */
    delete(id) {
        const before = this._memories.entries.length;
        this._memories.entries = this._memories.entries.filter(m => m.id !== id);
        this._save();
        return before !== this._memories.entries.length;
    }

    /**
     * Clear all memories
     */
    clear() {
        this._memories.entries = [];
        this._save();
    }

    getStats() {
        const byType = {};
        for (const entry of this._memories.entries) {
            byType[entry.type] = (byType[entry.type] || 0) + 1;
        }
        return { total: this._memories.entries.length, byType };
    }
}

module.exports = { MemoryManager: new MemoryManager(), MEMORY_TYPES };
