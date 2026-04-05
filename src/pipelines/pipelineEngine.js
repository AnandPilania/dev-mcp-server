/**
 * Well-structured, multi-step pipelines for common developer workflows.
 * Each pipeline is a sequence of named steps, each producing output
 * that feeds into the next.
 */

const logger = require('../utils/logger');
const costTracker = require('../utils/costTracker');
const { MemoryManager } = require('../memory/memoryManager');
const { TaskManager } = require('../tasks/taskManager');
const indexer = require('../core/indexer');

// ── PIPELINE STEP REGISTRY ─────────────────────────────────────────────────────
// Each step is a function: (input, context, state) => output
const STEP_REGISTRY = {

    'retrieve-context': async (input, ctx) => {
        const docs = indexer.search(input.query || input.task || input, ctx.topK || 8);
        return { docs, count: docs.length };
    },

    'engineer-context': async (input, ctx, state) => {
        const contextEngineer = require('../context/contextEngineer');
        const docs = state['retrieve-context']?.docs || [];
        const engineered = contextEngineer.engineer(docs, input.task, input.mode);
        return engineered;
    },

    'query-ai': async (input, ctx, state) => {
        const { QueryEngine } = require('../core/queryEngine');
        const result = await QueryEngine.query(input.task || input.query, {
            mode: input.mode,
            sessionId: ctx.sessionId,
        });
        return result;
    },

    'run-debug-agent': async (input, ctx, state) => {
        const { DebugAgent } = require('../agents/specialists');
        const docs = state['retrieve-context']?.docs || [];
        return DebugAgent.run(input.task || input.error, { context: docs, sessionId: ctx.sessionId });
    },

    'run-security-agent': async (input, ctx, state) => {
        const { SecurityAgent } = require('../agents/specialists');
        const docs = state['retrieve-context']?.docs || [];
        return SecurityAgent.run(input.task, { context: docs, sessionId: ctx.sessionId });
    },

    'run-architecture-agent': async (input, ctx, state) => {
        const { ArchitectureAgent } = require('../agents/specialists');
        const docs = state['retrieve-context']?.docs || [];
        return ArchitectureAgent.run(input.task, { context: docs, sessionId: ctx.sessionId });
    },

    'run-doc-agent': async (input, ctx, state) => {
        const { DocumentationAgent } = require('../agents/specialists');
        const docs = state['retrieve-context']?.docs || [];
        return DocumentationAgent.run(input.task, { context: docs, sessionId: ctx.sessionId });
    },

    'generate-plan': async (input, ctx, state) => {
        const plannerEngine = require('../planner/plannerEngine');
        const docs = state['retrieve-context']?.docs || [];
        return plannerEngine.generatePlan(input.task, docs, ctx.sessionId);
    },

    'decompose-task': async (input, ctx) => {
        const taskDecomposer = require('../agents/taskDecomposer');
        return taskDecomposer.decompose(input.task, ctx.sessionId);
    },

    'git-review': async (input, ctx) => {
        const GitTool = require('../tools/GitTool');
        return GitTool.review({ cwd: input.cwd, focus: input.focus });
    },

    'grep-todos': async (input, ctx) => {
        const GrepTool = require('../tools/GrepTool');
        return GrepTool.findTodos(input.cwd || process.cwd());
    },

    'grep-definitions': async (input, ctx) => {
        const GrepTool = require('../tools/GrepTool');
        return GrepTool.findDefinitions(input.symbol, input.cwd);
    },

    'create-tasks': async (input, ctx, state) => {
        // Auto-create tasks from agent findings
        const prevResult = Object.values(state).pop();
        const answer = prevResult?.answer || prevResult?.result || '';

        // Extract action items (lines starting with - or numbered)
        const actionItems = answer.split('\n')
            .filter(l => /^[\-\*\d]\s/.test(l.trim()))
            .slice(0, 5)
            .map(l => l.replace(/^[\-\*\d\.\s]+/, '').trim())
            .filter(l => l.length > 10);

        const tasks = actionItems.map(title =>
            TaskManager.create({ title, priority: 'medium', tags: ['pipeline-generated'], linkedQuery: input.task })
        );

        return { tasksCreated: tasks.length, tasks };
    },

    'save-to-memory': async (input, ctx, state) => {
        const prevResult = Object.values(state).pop();
        const answer = prevResult?.answer || prevResult?.synthesis || '';
        if (answer && answer.length > 50) {
            const mem = MemoryManager.add(
                `Pipeline result for "${(input.task || '').slice(0, 60)}": ${answer.slice(0, 300)}`,
                'fact',
                ['pipeline-result']
            );
            return { saved: true, memoryId: mem.id };
        }
        return { saved: false };
    },
};

// ── PRE-BUILT PIPELINES ────────────────────────────────────────────────────────
const PIPELINES = {
    'debug-pipeline': {
        description: 'Full debug workflow: retrieve context → run debug agent → create fix tasks',
        steps: ['retrieve-context', 'run-debug-agent', 'create-tasks', 'save-to-memory'],
    },
    'security-audit-pipeline': {
        description: 'Security scan: retrieve context → architecture overview → security scan → save findings',
        steps: ['retrieve-context', 'run-architecture-agent', 'run-security-agent', 'create-tasks', 'save-to-memory'],
    },
    'onboarding-pipeline': {
        description: 'New developer onboarding: codebase context → architecture → docs → todo list',
        steps: ['retrieve-context', 'run-architecture-agent', 'run-doc-agent', 'grep-todos', 'save-to-memory'],
    },
    'feature-planning-pipeline': {
        description: 'Plan a feature: retrieve context → decompose task → generate plan → create tasks',
        steps: ['retrieve-context', 'decompose-task', 'generate-plan', 'create-tasks'],
    },
    'code-review-pipeline': {
        description: 'Full code review: git diff → security scan → architecture check → doc suggestions',
        steps: ['retrieve-context', 'git-review', 'run-security-agent', 'save-to-memory'],
    },
    'impact-analysis-pipeline': {
        description: 'Analyse change impact: retrieve context → architecture analysis → debug risks → plan',
        steps: ['retrieve-context', 'run-architecture-agent', 'run-debug-agent', 'generate-plan', 'create-tasks'],
    },
};

class PipelineEngine {
    /**
     * Run a named pre-built pipeline
     */
    async run(pipelineName, input, options = {}) {
        const pipeline = PIPELINES[pipelineName];
        if (!pipeline) throw new Error(`Unknown pipeline: ${pipelineName}. Available: ${Object.keys(PIPELINES).join(', ')}`);

        logger.info(`[Pipeline] Running "${pipelineName}" with ${pipeline.steps.length} steps`);
        return this._execute(pipeline.steps, input, options);
    }

    /**
     * Run a custom pipeline from a steps array
     */
    async runCustom(steps, input, options = {}) {
        logger.info(`[Pipeline] Custom pipeline: [${steps.join(' → ')}]`);
        return this._execute(steps, input, options);
    }

    async _execute(steps, input, options = {}) {
        const { sessionId = 'default', topK = 8 } = options;
        const ctx = { sessionId, topK };
        const state = {};
        const stepResults = [];
        const startTime = Date.now();

        for (const stepName of steps) {
            const fn = STEP_REGISTRY[stepName];
            if (!fn) {
                logger.warn(`[Pipeline] Unknown step: ${stepName} — skipping`);
                continue;
            }

            logger.info(`[Pipeline] Step: ${stepName}`);
            const stepStart = Date.now();

            try {
                const result = await fn(input, ctx, state);
                state[stepName] = result;
                stepResults.push({
                    step: stepName,
                    success: true,
                    durationMs: Date.now() - stepStart,
                    outputKeys: Object.keys(result || {}),
                });
            } catch (err) {
                logger.error(`[Pipeline] Step "${stepName}" failed: ${err.message}`);
                stepResults.push({ step: stepName, success: false, error: err.message, durationMs: Date.now() - stepStart });
                // Continue to next step (resilient pipeline)
            }
        }

        // Final output = last successful step's result
        const lastSuccess = [...stepResults].reverse().find(s => s.success);
        const finalOutput = lastSuccess ? state[lastSuccess.step] : null;

        return {
            pipeline: steps.join(' → '),
            input: typeof input === 'string' ? input : input.task,
            steps: stepResults,
            state, // All intermediate results
            finalOutput,
            durationMs: Date.now() - startTime,
            successCount: stepResults.filter(s => s.success).length,
            totalSteps: steps.length,
        };
    }

    getAvailablePipelines() {
        return Object.entries(PIPELINES).map(([name, def]) => ({
            name, description: def.description, steps: def.steps,
        }));
    }

    getAvailableSteps() {
        return Object.keys(STEP_REGISTRY);
    }
}

module.exports = new PipelineEngine();
