/**
 * Breaks complex tasks into smaller, parallelizable subtasks and delegates
 * each to the most appropriate specialist agent.
 */

const llm = require('../utils/llmClient');
const costTracker = require('../utils/costTracker');
const logger = require('../utils/logger');
const indexer = require('../core/indexer');
const contextEngineer = require('../context/contextEngineer');

// Agent → what kinds of subtasks it handles
const AGENT_CAPABILITIES = {
    DebugAgent: ['debug', 'error', 'exception', 'crash', 'fix', 'trace', 'failing'],
    ArchitectureAgent: ['architecture', 'structure', 'design', 'coupling', 'module', 'dependency', 'overview'],
    SecurityAgent: ['security', 'vulnerability', 'auth', 'injection', 'xss', 'csrf', 'secret', 'token'],
    DocumentationAgent: ['document', 'docs', 'comment', 'readme', 'api', 'explain', 'describe'],
    RefactorAgent: ['refactor', 'clean', 'improve', 'duplicate', 'simplify', 'rewrite', 'quality'],
    PerformanceAgent: ['performance', 'slow', 'bottleneck', 'optimize', 'memory', 'leak', 'n+1', 'query'],
};

class TaskDecomposer {
    /**
     * Decompose a complex task into subtasks using
     */
    async decompose(task, sessionId = 'default') {
        logger.info(`[Decomposer] Decomposing: "${task.slice(0, 80)}"`);

        const response = await llm.chat({
            model: llm.model('fast'),
            max_tokens: 800,
            system: `You are a task decomposition engine for a developer AI system.
Break the given task into 2-5 concrete, independent subtasks.
Each subtask should be assigned to ONE of these agents:
${Object.entries(AGENT_CAPABILITIES).map(([a, k]) => `- ${a}: handles ${k.slice(0, 4).join(', ')} etc.`).join('\n')}

Return ONLY a JSON array:
[{"subtask": "...", "agent": "AgentName", "priority": 1, "rationale": "..."}]
Priority 1 = highest. No preamble, no markdown fences.`,
            messages: [{ role: 'user', content: `Task: ${task}` }],
        });

        costTracker.record({
            model: llm.model('fast'),
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            sessionId,
            queryType: 'decompose',
        });

        try {
            const subtasks = JSON.parse(response.content[0].text.trim());
            logger.info(`[Decomposer] Generated ${subtasks.length} subtasks`);
            return subtasks.sort((a, b) => a.priority - b.priority);
        } catch {
            // Fallback: single subtask routed by keyword matching
            const agent = this._routeByKeyword(task);
            return [{ subtask: task, agent, priority: 1, rationale: 'Keyword-based routing' }];
        }
    }

    /**
     * Decompose AND execute all subtasks, optionally in parallel
     */
    async decomposeAndRun(task, options = {}) {
        const { parallel = false, sessionId = 'default', maxSubtasks = 4 } = options;

        const subtasks = await this.decompose(task, sessionId);
        const limited = subtasks.slice(0, maxSubtasks);

        logger.info(`[Decomposer] Executing ${limited.length} subtasks (parallel=${parallel})`);

        // Retrieve shared context for all subtasks up front
        const sharedDocs = indexer.search(task, 10);

        const runSubtask = async (subtask) => {
            const agents = require('./specialists');
            const agent = agents[subtask.agent];

            if (!agent) {
                logger.warn(`[Decomposer] Unknown agent: ${subtask.agent}, using DebugAgent`);
                return { subtask: subtask.subtask, agent: subtask.agent, error: 'Agent not found' };
            }

            // Get subtask-specific context on top of shared context
            const specificDocs = indexer.search(subtask.subtask, 5);
            const allDocs = this._mergeDedupe(sharedDocs, specificDocs);

            logger.info(`[Decomposer] → ${subtask.agent}: "${subtask.subtask.slice(0, 50)}"`);

            try {
                const result = await agent.run(subtask.subtask, { context: allDocs, sessionId });
                return {
                    subtask: subtask.subtask,
                    agent: subtask.agent,
                    rationale: subtask.rationale,
                    priority: subtask.priority,
                    result: result.answer,
                    toolResults: result.toolResults,
                    contextChunks: result.contextChunks,
                };
            } catch (err) {
                logger.error(`[Decomposer] ${subtask.agent} failed: ${err.message}`);
                return { subtask: subtask.subtask, agent: subtask.agent, error: err.message };
            }
        };

        let results;
        if (parallel) {
            results = await Promise.all(limited.map(runSubtask));
        } else {
            results = [];
            for (const subtask of limited) {
                results.push(await runSubtask(subtask));
            }
        }

        // Synthesize all results into a coherent final answer
        const synthesis = await this._synthesize(task, results, sessionId);

        return {
            originalTask: task,
            subtasks: limited,
            results,
            synthesis,
            agentsUsed: [...new Set(limited.map(s => s.agent))],
        };
    }

    /**
     * Synthesize multiple agent results into one coherent answer
     */
    async _synthesize(originalTask, results, sessionId) {
        const successful = results.filter(r => !r.error);
        if (successful.length === 0) return 'All subtasks failed.';
        if (successful.length === 1) return successful[0].result;

        const parts = successful.map(r =>
            `## ${r.agent} (re: ${r.subtask.slice(0, 60)})\n${r.result}`
        ).join('\n\n---\n\n');

        const response = await llm.chat({
            model: llm.model('fast'),
            max_tokens: 1000,
            messages: [{
                role: 'user',
                content: `Original task: ${originalTask}\n\nAgent results:\n${parts}\n\nSynthesize these into ONE clear, developer-focused answer. Remove duplication. Keep all concrete details (file names, line numbers, code). Be concise.`,
            }],
        });

        costTracker.record({
            model: llm.model('fast'),
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            sessionId,
            queryType: 'synthesize',
        });

        return response.content[0].text;
    }

    _routeByKeyword(task) {
        const lower = task.toLowerCase();
        for (const [agent, keywords] of Object.entries(AGENT_CAPABILITIES)) {
            if (keywords.some(k => lower.includes(k))) return agent;
        }
        return 'DebugAgent'; // default
    }

    _mergeDedupe(a, b) {
        const seen = new Set(a.map(d => d.id));
        return [...a, ...b.filter(d => !seen.has(d.id))];
    }
}

module.exports = new TaskDecomposer();
