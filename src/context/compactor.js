'use strict';
/**
 * Sliding-window context compaction with token-budget awareness.
 *
 * Strategy:
 *   WINDOW: keep the last N messages verbatim (always fresh)
 *   BODY:   older messages → compressed summary
 *   INJECT: summary injected as a system-level recap at the top
 */

const llm = require('../utils/llmClient');
const costTracker = require('../utils/costTracker');
const logger = require('../utils/logger');

// ── constants ──────────────────────────────────────────────────────────────────
const EST_TOKENS = text => Math.ceil((text || '').length / 4);
const WINDOW_MSGS = 6;    // keep this many recent messages verbatim
const MAX_RAW_TOK = 8000; // if history exceeds this, compact
const TARGET_TOK = 3000; // target token count for compacted history

class Compactor {
    /**
     * Ensure a conversation history fits within the token budget.
     * Returns { messages, compacted, summary, savedTokens }
     */
    async compact(messages, opts = {}) {
        const { sessionId = 'default', force = false } = opts;

        if (!messages?.length) return { messages: [], compacted: false };

        // Estimate current token usage
        const totalTokens = messages.reduce((sum, m) => sum + EST_TOKENS(
            Array.isArray(m.content) ? JSON.stringify(m.content) : (m.content || '')
        ), 0);

        logger.info(`[Compactor] history: ${messages.length} messages, ~${totalTokens} tokens`);

        if (!force && totalTokens <= MAX_RAW_TOK) {
            return { messages, compacted: false, totalTokens };
        }

        // Split: window (keep verbatim) + body (compress)
        const window = messages.slice(-WINDOW_MSGS);
        const body = messages.slice(0, -WINDOW_MSGS);

        if (!body.length) {
            return { messages, compacted: false, reason: 'Too few messages to compact' };
        }

        // Importance-weighted body: prioritise tool results and assistant answers
        const importantLines = body
            .filter(m => m.role === 'assistant' || (m.role === 'user' && Array.isArray(m.content)))
            .map(m => {
                const text = Array.isArray(m.content)
                    ? m.content.filter(b => b.type === 'text').map(b => b.text).join(' ')
                    : (m.content || '');
                return `${m.role.toUpperCase()}: ${text.slice(0, 400)}`;
            })
            .join('\n\n');

        // Compress
        const response = await llm.chat({
            model: llm.model('fast'),
            max_tokens: 600,
            messages: [{
                role: 'user',
                content: `Compress this conversation history into a dense, information-preserving summary for a developer AI assistant.

Capture:
- Questions asked and answers given
- File names, function names, error types discovered
- Decisions made or actions taken
- Any unresolved issues or follow-up questions
- Tool results that revealed important facts

Keep it under 400 words. Be specific. Preserve technical details exactly.

History:
${importantLines}`,
            }],
        });

        costTracker.record({
            model: llm.model('fast'),
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            sessionId,
            queryType: 'compact',
        });

        const summary = response.content[0].text;

        // Build compacted history: [summary-message] + [recent window]
        const summaryMessage = {
            role: 'user',
            content: `[Conversation summary — ${body.length} messages compacted]\n${summary}`,
            _compacted: true,
            _originalCount: body.length,
            _compactedAt: new Date().toISOString(),
        };
        // Pair with an assistant ack so the message array stays valid
        const ackMessage = {
            role: 'assistant',
            content: 'Understood — I have the summary of our earlier conversation. Continuing from here.',
        };

        const compactedMessages = [summaryMessage, ackMessage, ...window];
        const newTokens = compactedMessages.reduce((s, m) => s + EST_TOKENS(
            Array.isArray(m.content) ? JSON.stringify(m.content) : (m.content || '')
        ), 0);

        logger.info(`[Compactor] ${messages.length}→${compactedMessages.length} messages, ${totalTokens}→${newTokens} tokens saved ${totalTokens - newTokens}`);

        return {
            compacted: true,
            messages: compactedMessages,
            summary,
            originalCount: messages.length,
            newCount: compactedMessages.length,
            savedTokens: totalTokens - newTokens,
            totalTokens: newTokens,
        };
    }

    /**
     * Multi-tier compaction: compact the summary if it's also too long.
     */
    async deepCompact(messages, opts = {}) {
        let result = await this.compact(messages, opts);

        // If still over budget, compact the summary itself
        if (result.compacted && EST_TOKENS(result.summary) > TARGET_TOK) {
            logger.info('[Compactor] Deep compaction: compressing the summary');
            result = await this.compact(result.messages, { ...opts, force: true });
        }

        return result;
    }

    /**
     * Estimate if a conversation needs compaction.
     */
    needsCompaction(messages) {
        const tokens = messages?.reduce((s, m) => s + EST_TOKENS(
            Array.isArray(m.content) ? JSON.stringify(m.content) : (m.content || '')
        ), 0) || 0;
        return { needs: tokens > MAX_RAW_TOK, tokens, threshold: MAX_RAW_TOK };
    }
}

module.exports = new Compactor();
