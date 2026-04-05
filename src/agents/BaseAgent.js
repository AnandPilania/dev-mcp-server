
'use strict';
/**
 * Foundation for all agents — tool-use loop, memory injection, cost tracking.
 * Provider-agnostic: uses llmClient which routes to Anthropic / Azure / Ollama.
 */

const llm = require('../utils/llmClient');
const toolRegistry = require('../tools/registry');
const contextEngineer = require('../context/contextEngineer');
const { MemoryManager } = require('../memory/memoryManager');
const costTracker = require('../utils/costTracker');
const logger = require('../utils/logger');

class BaseAgent {
    constructor(cfg = {}) {
        this.name = cfg.name || 'Agent';
        this.role = cfg.role || 'General assistant';
        this.model = cfg.model || 'smart';   // alias: fast | default | smart
        this.toolNames = cfg.toolNames || [];
        this.maxTokens = cfg.maxTokens || 2000;
        this.maxLoops = cfg.maxLoops || 8;
        this.sessionId = cfg.sessionId || `agent_${this.name.toLowerCase()}`;

        this._history = [];
        this._callCount = 0;
        this._tokenCount = 0;
    }

    async run(task, opts = {}) {
        const { context = [], extraSystem = '' } = opts;

        const engineered = contextEngineer.engineer(context, task, opts.mode || 'general');
        const memories = MemoryManager.getRelevant(task, 4);
        const memContext = MemoryManager.formatAsContext(memories);
        const systemPrompt = this._buildSystem(memContext, extraSystem);
        const userMessage = this._buildUserMessage(task, engineered.chunks);

        const history = [];
        history.push({ role: 'user', content: userMessage });

        logger.info(`[${this.name}] task="${task.slice(0, 60)}" tools=${this.toolNames.length} ctx=${engineered.chunks.length} provider=${llm.provider}`);

        const toolSchemas = llm.supportsTools() && this.toolNames.length
            ? toolRegistry.schemas(this.toolNames)
            : [];

        const toolResults = [];
        let loops = 0;
        let response;

        while (loops < this.maxLoops) {
            loops++;

            response = await llm.chat({
                model: this.model,
                system: systemPrompt,
                messages: history,
                max_tokens: this.maxTokens,
                tools: toolSchemas.length ? toolSchemas : undefined,
            });

            this._callCount++;
            this._tokenCount += (response.usage.input_tokens + response.usage.output_tokens);
            costTracker.record({
                model: llm.model(this.model),
                inputTokens: response.usage.input_tokens,
                outputTokens: response.usage.output_tokens,
                sessionId: opts.sessionId || this.sessionId,
                queryType: `agent_${this.name.toLowerCase()}`,
            });

            if (response.stop_reason !== 'tool_use') break;

            const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
            if (!toolUseBlocks.length) break;

            history.push({ role: 'assistant', content: response.content });

            const toolResultContent = [];
            for (const tu of toolUseBlocks) {
                logger.info(`[${this.name}] → tool: ${tu.name}(${JSON.stringify(tu.input).slice(0, 80)})`);
                const output = await toolRegistry.execute(tu.name, tu.input);
                toolResults.push({ tool: tu.name, input: tu.input, output: output.slice(0, 500) });
                toolResultContent.push({ type: 'tool_result', tool_use_id: tu.id, content: output });
            }
            history.push({ role: 'user', content: toolResultContent });
        }

        const answer = (response?.content || [])
            .filter(b => b.type === 'text').map(b => b.text).join('\n').trim();

        MemoryManager.extractFromExchange(task, answer, opts.sessionId || this.sessionId).catch(() => { });

        return { agent: this.name, answer, toolResults, loops, contextChunks: engineered.chunks.length, memoriesUsed: memories.length };
    }

    reset() { this._history = []; }
    getStats() { return { name: this.name, calls: this._callCount, tokens: this._tokenCount, historyLen: this._history.length }; }

    _buildSystem(memContext, extra) {
        return [`You are ${this.name}. ${this.role}`, `Ground every statement in evidence from tools or provided context.`, extra || '', memContext || ''].filter(Boolean).join('\n\n');
    }

    _buildUserMessage(task, chunks) {
        const ctx = chunks.length
            ? '\n\n## Codebase Context\n' + chunks.map((c, i) => `[${i + 1}] **${c.filename}** (${c.kind})\n\`\`\`\n${c.content.slice(0, 700)}\n\`\`\``).join('\n\n')
            : '';
        return `## Task\n${task}${ctx}`;
    }
}

module.exports = BaseAgent;
