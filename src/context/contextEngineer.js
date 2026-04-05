/**
 * Intelligent context window management.
 * Decides WHAT to include, HOW MUCH of it, in WHAT ORDER, and WHAT to cut.
 *
 * Core idea: context is a budget. Every token costs. Spend it wisely.
 */

const logger = require('../utils/logger');

// Rough token estimator (4 chars ≈ 1 token)
const estimateTokens = (text) => Math.ceil((text || '').length / 4);

// How much of the context window to spend on retrieval context (the rest goes to answer)
const CONTEXT_BUDGET_TOKENS = 6000;

// Signal weights for scoring importance of a context chunk
const SIGNAL_WEIGHTS = {
    relevanceScore: 3.0,   // TF-IDF relevance from indexer
    isErrorLog: 2.5,   // Error logs are gold for debugging
    isBugFix: 2.0,   // Bug-fix files are highly relevant
    isRecent: 1.5,   // Recently ingested files
    hasExports: 1.2,   // Files that export things = likely central
    hasErrors: 1.8,   // Files with known error types
    isConfig: 0.6,   // Config is often less relevant
    isTestFile: 0.5,   // Test files lower priority unless debug
    chunkIsFirst: 1.3,   // First chunk of a file has more context
    metadataRich: 1.2,   // Rich metadata = better indexed
};

class ContextEngineer {
    /**
     * Given raw retrieved docs + query intent, build the optimal context bundle.
     * Returns ranked, trimmed, budget-aware context ready for the prompt.
     */
    engineer(docs, query, mode = 'general') {
        if (!docs || docs.length === 0) return { chunks: [], budgetUsed: 0, dropped: 0 };

        // 1. Score every chunk using multiple signals
        const scored = docs.map(doc => ({
            doc,
            score: this._scoreChunk(doc, query, mode),
        }));

        // 2. Sort by composite score
        scored.sort((a, b) => b.score - a.score);

        // 3. Fill budget greedily, highest-score first
        const selected = [];
        let budgetUsed = 0;
        let dropped = 0;

        for (const { doc, score } of scored) {
            const tokens = estimateTokens(doc.content);
            if (budgetUsed + tokens <= CONTEXT_BUDGET_TOKENS) {
                selected.push({ ...doc, engineeredScore: parseFloat(score.toFixed(3)) });
                budgetUsed += tokens;
            } else {
                // Try to include a trimmed version if the chunk is large
                const remaining = CONTEXT_BUDGET_TOKENS - budgetUsed;
                if (remaining > 300) {
                    const trimmedContent = this._trimToTokens(doc.content, remaining);
                    selected.push({ ...doc, content: trimmedContent, engineeredScore: parseFloat(score.toFixed(3)), trimmed: true });
                    budgetUsed += remaining;
                } else {
                    dropped++;
                }
            }
        }

        // 4. Re-order for readability: put config/schema first, then code, then logs
        const ordered = this._readabilityOrder(selected, mode);

        logger.info(`[ContextEngineer] ${docs.length} docs → ${selected.length} selected, ${dropped} dropped, ~${budgetUsed} tokens`);

        return {
            chunks: ordered,
            budgetUsed,
            dropped,
            totalCandidates: docs.length,
        };
    }

    /**
     * Compute a composite importance score for a chunk
     */
    _scoreChunk(doc, query, mode) {
        let score = (doc.relevanceScore || 0) * SIGNAL_WEIGHTS.relevanceScore;
        const meta = doc.metadata || {};
        const content = doc.content || '';

        // Mode-specific boosts
        if (mode === 'debug') {
            if (doc.kind === 'log') score += SIGNAL_WEIGHTS.isErrorLog * 3;
            if (meta.isBugFix) score += SIGNAL_WEIGHTS.isBugFix * 2;
            if (meta.errors?.length > 0) score += SIGNAL_WEIGHTS.hasErrors;
        }
        if (mode === 'impact') {
            if (meta.exports?.length > 0) score += SIGNAL_WEIGHTS.hasExports;
            if (meta.imports?.length > 0) score += 0.5;
        }
        if (mode === 'usage') {
            if (meta.functions?.length > 0) score += 0.8;
        }

        // Universal signals
        if (meta.isBugFix) score += SIGNAL_WEIGHTS.isBugFix;
        if (meta.errors?.length > 0) score += SIGNAL_WEIGHTS.hasErrors * 0.5;
        if (doc.kind === 'config') score *= SIGNAL_WEIGHTS.isConfig;
        if (doc.filename?.includes('test') || doc.filename?.includes('spec')) score *= SIGNAL_WEIGHTS.isTestFile;
        if (doc.chunkIndex === 0) score *= SIGNAL_WEIGHTS.chunkIsFirst;

        // Metadata richness bonus
        const metaFields = ['functions', 'classes', 'imports', 'exports', 'errors', 'patterns'];
        const richness = metaFields.filter(f => meta[f]?.length > 0).length;
        if (richness >= 3) score *= SIGNAL_WEIGHTS.metadataRich;

        // Recency bonus (ingested within last 24h)
        if (doc.ingestedAt) {
            const ageHours = (Date.now() - new Date(doc.ingestedAt).getTime()) / 3600000;
            if (ageHours < 24) score *= SIGNAL_WEIGHTS.isRecent;
        }

        return score;
    }

    /**
     * Re-order chunks for maximum readability in the prompt
     */
    _readabilityOrder(chunks, mode) {
        const order = { schema: 0, config: 1, code: 2, documentation: 3, log: 4, script: 5, unknown: 6 };
        if (mode === 'debug') {
            // Logs first for debugging
            order.log = 0; order.code = 1; order.documentation = 2;
        }
        return [...chunks].sort((a, b) => (order[a.kind] ?? 6) - (order[b.kind] ?? 6));
    }

    /**
     * Trim text to approximately N tokens
     */
    _trimToTokens(text, maxTokens) {
        const maxChars = maxTokens * 4;
        if (text.length <= maxChars) return text;
        return text.slice(0, maxChars) + '\n... [truncated for context budget]';
    }

    /**
     * Compress a context bundle by summarizing less-important chunks
     * Used when context must be even further reduced
     */
    summarizeChunk(doc) {
        const meta = doc.metadata || {};
        const lines = [
            `[${doc.kind}] ${doc.filename}`,
            meta.functions?.length ? `Functions: ${meta.functions.join(', ')}` : null,
            meta.classes?.length ? `Classes: ${meta.classes.join(', ')}` : null,
            meta.errors?.length ? `Known errors: ${meta.errors.join(', ')}` : null,
            `Snippet: ${doc.content.slice(0, 200)}...`,
        ].filter(Boolean);
        return lines.join('\n');
    }

    /**
     * Prioritize a list of plain text messages by estimated importance
     * Used for memory/conversation injection
     */
    prioritizeMessages(messages, budgetTokens = 2000) {
        let used = 0;
        const result = [];
        for (const msg of messages) {
            const t = estimateTokens(msg.content || msg);
            if (used + t <= budgetTokens) {
                result.push(msg);
                used += t;
            }
        }
        return result;
    }
}

module.exports = new ContextEngineer();
