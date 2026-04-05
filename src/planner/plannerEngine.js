/**
 * Plan Mode: Before executing a complex change, generate a step-by-step plan
 *            and get user approval before proceeding.
 *
 * Compact:   Compress long conversation history into a dense summary
 *            to stay within context limits.
 */

const llm = require('../utils/llmClient');
const costTracker = require('../utils/costTracker');
const logger = require('../utils/logger');

class PlannerEngine {
    /**
     * Generate an execution plan for a complex task.
     * This is the "think before you act" pattern.
     *
     * @param {string} task - What the user wants to do
     * @param {Array}  context - Retrieved codebase chunks
     * @param {string} sessionId
     */
    async generatePlan(task, context = [], sessionId = 'default') {
        const contextStr = context.length > 0
            ? `\n\n## Relevant Codebase Context\n${context.map(c => `**${c.filename}**:\n${c.content.slice(0, 800)}`).join('\n\n---\n\n')}`
            : '';

        const response = await llm.chat({
            model: llm.model('smart'),
            max_tokens: 1500,
            system: `You are a senior developer creating an execution plan. Be specific, step-by-step, and honest about risks.
Format the plan as:

## Understanding
(What you understand about the task and codebase context)

## Plan
Step 1: [action] — [file/component affected] — [risk: low|medium|high]
Step 2: ...
...

## Prerequisites
(Anything that needs to happen before starting)

## Risks & Rollback
(What could go wrong and how to undo it)

## Estimated Effort
(Quick estimate: minutes/hours)`,
            messages: [{
                role: 'user',
                content: `Create an execution plan for this task:\n\n${task}${contextStr}`,
            }],
        });

        costTracker.record({
            model: llm.model('smart'),
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            sessionId,
            queryType: 'plan',
        });

        return {
            task,
            plan: response.content[0].text,
            generatedAt: new Date().toISOString(),
            approved: false,
        };
    }

    /**
     * Compact a conversation history into a dense summary.
     * Reduces token usage by replacing old messages with a compressed summary.
     *
     * @param {Array} messages - Array of { role, content } message objects
     * @param {string} sessionId
     */
    async compact(messages, sessionId = 'default') {
        if (!messages || messages.length < 4) {
            return { compacted: false, reason: 'Too few messages to compact', messages };
        }

        // Keep last 2 messages verbatim, compact the rest
        const toCompact = messages.slice(0, -2);
        const toKeep = messages.slice(-2);

        const historyText = toCompact.map(m =>
            `${m.role.toUpperCase()}: ${m.content?.slice(0, 500) || ''}`
        ).join('\n\n');

        const response = await llm.chat({
            model: llm.model('fast'),
            max_tokens: 800,
            messages: [{
                role: 'user',
                content: `Compress this conversation history into a dense, information-preserving summary that captures:
1. What was asked and answered
2. Key facts discovered about the codebase
3. Any decisions made or actions taken
4. Open questions or unresolved issues

Keep it under 400 words. Be specific (include file names, function names, error types).

History to compress:
${historyText}`,
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
        const compactedMessage = {
            role: 'system',
            content: `[Compacted conversation summary]\n${summary}`,
            compacted: true,
            originalCount: toCompact.length,
            compactedAt: new Date().toISOString(),
        };

        const compactedMessages = [compactedMessage, ...toKeep];

        logger.info(`[Compact] ${messages.length} messages → ${compactedMessages.length} (${toCompact.length} compacted)`);

        return {
            compacted: true,
            originalCount: messages.length,
            newCount: compactedMessages.length,
            savedMessages: messages.length - compactedMessages.length,
            messages: compactedMessages,
            summary,
        };
    }

    /**
     * Doctor — check environment health
     */
    async doctor() {
        const checks = [];
        const BashTool = require('../tools/BashTool');

        const run = async (name, cmd, parse) => {
            try {
                const r = await BashTool.executeOrThrow(cmd, {});
                checks.push({ name, status: 'ok', detail: parse ? parse(r.stdout) : r.stdout.trim() });
            } catch (err) {
                checks.push({ name, status: 'fail', detail: err.message.slice(0, 100) });
            }
        };

        await run('Node.js', 'node --version', v => v.trim());
        await run('npm', 'npm --version', v => `v${v.trim()}`);
        await run('git', 'git --version', v => v.trim());
        await run('ripgrep', 'rg --version', v => v.split('\n')[0]);

        // Check API key
        // checks.push({
        //     name: 'ANTHROPIC_API_KEY',
        //     status: process.env.ANTHROPIC_API_KEY ? 'ok' : 'fail',
        //     detail: process.env.ANTHROPIC_API_KEY
        //         ? `Set (${process.env.ANTHROPIC_API_KEY.slice(0, 10)}...)`
        //         : 'Not set — add to .env',
        // });

        // Check data directory
        const fs = require('fs');
        const dataDir = require('path').join(process.cwd(), 'data');
        checks.push({
            name: 'data/ directory',
            status: fs.existsSync(dataDir) ? 'ok' : 'warn',
            detail: fs.existsSync(dataDir) ? 'Exists' : 'Will be created on first ingest',
        });

        // Knowledge base
        const store = require('../storage/store');
        const stats = store.getStats();
        checks.push({
            name: 'Knowledge base',
            status: stats.totalDocs > 0 ? 'ok' : 'warn',
            detail: stats.totalDocs > 0
                ? `${stats.totalDocs} docs from ${stats.totalFiles} files`
                : 'Empty — run: node cli.js ingest <path>',
        });

        const passed = checks.filter(c => c.status === 'ok').length;
        const failed = checks.filter(c => c.status === 'fail').length;
        const warned = checks.filter(c => c.status === 'warn').length;

        return {
            checks,
            summary: { passed, failed, warned, total: checks.length },
            healthy: failed === 0,
        };
    }
}

module.exports = new PlannerEngine();
