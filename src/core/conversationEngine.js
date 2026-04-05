/**
 * Multi-turn conversational Q&A — stateful, context-aware, memory-injecting.
 *
 * Unlike QueryEngine (single-shot), ConversationEngine maintains a rolling
 * conversation window. Each turn injects:
 *  - Prior conversation (compressed if too long)
 *  - Fresh retrieved context
 *  - Relevant memories
 *  - Session-specific facts learned so far
 */

const llm = require('../utils/llmClient');
const indexer = require('./indexer');
const contextEngineer = require('../context/contextEngineer');
const { MemoryManager } = require('../memory/memoryManager');
const costTracker = require('../utils/costTracker');
const plannerEngine = require('../planner/plannerEngine');
const logger = require('../utils/logger');

// Max messages to keep in raw history before compacting
const MAX_HISTORY = 12;
// Max tokens to spend on compressed history summary
const HISTORY_BUDGET = 1000;

class ConversationEngine {
    constructor() {
        this._conversations = new Map(); // convId → { messages, compactedSummary, sessionFacts }
    }

    /**
     * Send a message in a conversation. Creates the conversation if it doesn't exist.
     */
    async chat(message, convId = 'default', opts = {}) {
        const { sessionId = convId, topK = 6 } = opts;

        if (!this._conversations.has(convId)) {
            this._conversations.set(convId, {
                messages: [],
                compactedSummary: null,
                sessionFacts: [],
                turnCount: 0,
            });
        }

        const conv = this._conversations.get(convId);
        conv.turnCount++;

        logger.info(`[Conv:${convId}] Turn ${conv.turnCount}: "${message.slice(0, 60)}"`);

        // 1. Retrieve fresh context for this message
        const docs = indexer.search(message, topK);
        const engineered = contextEngineer.engineer(docs, message, 'general');

        // 2. Retrieve relevant memories
        const memories = MemoryManager.getRelevant(message, 4);
        const memContext = MemoryManager.formatAsContext(memories);

        // 3. Build system prompt with session knowledge
        const systemPrompt = this._buildSystem(conv, memContext);

        // 4. Build messages array (history + new message)
        const historyMessages = this._buildHistory(conv);
        const userContent = this._buildUserContent(message, engineered.chunks);

        const allMessages = [
            ...historyMessages,
            { role: 'user', content: userContent },
        ];

        // 5. Call LLM
        const response = await llm.chat({
            model: llm.model('smart'),
            max_tokens: 2000,
            system: systemPrompt,
            messages: allMessages,
        });

        const answer = response.content[0].text;

        // 6. Track cost
        const cost = costTracker.record({
            model: llm.model('smart'),
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            sessionId,
            queryType: 'conversation',
        });

        // 7. Update conversation history
        conv.messages.push({ role: 'user', content: message, timestamp: new Date().toISOString() });
        conv.messages.push({ role: 'assistant', content: answer, timestamp: new Date().toISOString(), sources: engineered.chunks.map(c => c.filename) });

        // 8. Auto-compact if history is too long
        if (conv.messages.length >= MAX_HISTORY) {
            await this._compact(conv, convId);
        }

        // 9. Extract session-specific facts (quick, lightweight)
        this._extractSessionFacts(conv, message, answer);

        // 10. Background memory extraction
        MemoryManager.extractFromExchange(message, answer, sessionId).catch(() => { });

        return {
            answer,
            convId,
            turn: conv.turnCount,
            contextChunks: engineered.chunks.length,
            memoriesUsed: memories.length,
            isCompacted: !!conv.compactedSummary,
            usage: {
                inputTokens: response.usage.input_tokens,
                outputTokens: response.usage.output_tokens,
                costUsd: cost.costUsd,
            },
        };
    }

    /**
     * Ask a follow-up question referencing previous context
     */
    async followUp(message, convId = 'default', opts = {}) {
        const conv = this._conversations.get(convId);
        if (!conv || conv.messages.length === 0) {
            return this.chat(message, convId, opts);
        }
        // Add a hint that this is a follow-up
        return this.chat(`[Follow-up on our conversation] ${message}`, convId, opts);
    }

    /**
     * Get conversation history
     */
    getHistory(convId = 'default') {
        const conv = this._conversations.get(convId);
        if (!conv) return [];
        return conv.messages;
    }

    /**
     * Reset a conversation
     */
    reset(convId = 'default') {
        this._conversations.delete(convId);
        logger.info(`[Conv:${convId}] Reset`);
    }

    /**
     * List active conversations
     */
    list() {
        return [...this._conversations.entries()].map(([id, conv]) => ({
            id,
            turns: conv.turnCount,
            messages: conv.messages.length,
            isCompacted: !!conv.compactedSummary,
            lastMessage: conv.messages.at(-1)?.timestamp,
        }));
    }

    // ── Private helpers ──────────────────────────────────────────────────────────

    _buildSystem(conv, memContext) {
        const parts = [
            `You are an expert developer assistant with deep knowledge of the codebase.
Answer questions based on provided context. Be conversational but precise.
If you refer to something from earlier in the conversation, say so explicitly.`,
        ];

        if (conv.compactedSummary) {
            parts.push(`## Earlier Conversation Summary\n${conv.compactedSummary}`);
        }

        if (conv.sessionFacts.length > 0) {
            parts.push(`## Facts established this session\n${conv.sessionFacts.map(f => `- ${f}`).join('\n')}`);
        }

        if (memContext) parts.push(memContext);

        return parts.join('\n\n');
    }

    _buildHistory(conv) {
        // Only pass the recent raw messages (before compaction point)
        const recent = conv.messages.slice(conv.compactedSummary ? -6 : -10);
        return recent.map(m => ({ role: m.role, content: m.content }));
    }

    _buildUserContent(message, contextChunks) {
        if (contextChunks.length === 0) return message;
        const ctxStr = contextChunks
            .map((c, i) => `[${i + 1}] ${c.filename}:\n\`\`\`\n${c.content.slice(0, 600)}\n\`\`\``)
            .join('\n\n');
        return `${message}\n\n## Relevant codebase context:\n${ctxStr}`;
    }

    async _compact(conv, convId) {
        logger.info(`[Conv:${convId}] Compacting ${conv.messages.length} messages`);
        try {
            const result = await plannerEngine.compact(conv.messages, convId);
            if (result.compacted) {
                conv.compactedSummary = result.summary;
                // Keep only the last 4 messages raw
                conv.messages = conv.messages.slice(-4);
                logger.info(`[Conv:${convId}] Compacted to summary + 4 recent messages`);
            }
        } catch (err) {
            logger.warn(`[Conv:${convId}] Compact failed: ${err.message}`);
        }
    }

    _extractSessionFacts(conv, question, answer) {
        // Quick heuristic extraction of facts to inject next turn
        const factPatterns = [
            /the (\w+) (?:function|method|class|module|file) (?:is|does|handles|returns) ([^.]{10,60})\./gi,
            /(?:causes|caused by|because of) ([^.]{10,60})\./gi,
        ];

        for (const pattern of factPatterns) {
            const matches = answer.matchAll(pattern);
            for (const m of matches) {
                const fact = m[0].replace(/["`]/g, '').trim().slice(0, 120);
                if (!conv.sessionFacts.includes(fact) && conv.sessionFacts.length < 8) {
                    conv.sessionFacts.push(fact);
                }
            }
        }
    }
}

module.exports = new ConversationEngine();
