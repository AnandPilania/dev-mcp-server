'use strict';
/**
 * 10 named agent teams covering every common dev workflow.
 * Teams run sequentially (each agent sees prior results) or in parallel.
 */

const llm = require('../utils/llmClient');
const costTracker = require('../utils/costTracker');
const indexer = require('../core/indexer');
const { MemoryManager } = require('../memory/memoryManager');
const logger = require('../utils/logger');

const TEAMS = {
    'full-audit': {
        desc: 'Complete codebase audit: security + performance + quality + docs',
        agents: ['SecurityAgent', 'PerformanceAgent', 'RefactorAgent', 'DocumentationAgent'],
        sequential: true,
    },
    'feature-review': {
        desc: 'Review a new feature: architecture + security + tests + docs',
        agents: ['ArchitectureAgent', 'SecurityAgent', 'TestAgent', 'DocumentationAgent'],
        sequential: true,
    },
    'bug-triage': {
        desc: 'Triage a production bug: debug + perf impact + doc fix',
        agents: ['DebugAgent', 'PerformanceAgent', 'DocumentationAgent'],
        sequential: true,
    },
    'onboarding': {
        desc: 'Onboard a new developer: architecture + patterns + gotchas + tasks',
        agents: ['ArchitectureAgent', 'DocumentationAgent', 'DebugAgent', 'PlannerAgent'],
        sequential: false,
    },
    'refactor-safe': {
        desc: 'Plan a safe refactor: architecture + refactor + tests + security check',
        agents: ['ArchitectureAgent', 'RefactorAgent', 'TestAgent', 'SecurityAgent'],
        sequential: true,
    },
    'release-prep': {
        desc: 'Prepare a release: changelog + security + tests + deployment check',
        agents: ['DocumentationAgent', 'SecurityAgent', 'TestAgent', 'DevOpsAgent'],
        sequential: true,
    },
    'data-audit': {
        desc: 'Audit data layer: schemas + validation + query performance + security',
        agents: ['DataAgent', 'SecurityAgent', 'PerformanceAgent'],
        sequential: true,
    },
    'ci-setup': {
        desc: 'Set up or fix CI/CD: devops analysis + tests + linting + security',
        agents: ['DevOpsAgent', 'TestAgent', 'SecurityAgent'],
        sequential: true,
    },
    'post-mortem': {
        desc: 'Incident post-mortem: debug root cause + perf timeline + prevention plan',
        agents: ['DebugAgent', 'PerformanceAgent', 'PlannerAgent', 'DocumentationAgent'],
        sequential: true,
    },
    'greenfield': {
        desc: 'Plan a new feature or service from scratch: architecture + security + plan',
        agents: ['ArchitectureAgent', 'SecurityAgent', 'PlannerAgent', 'TestAgent'],
        sequential: true,
    },
};

class TeamCoordinator {
    async runTeam(teamName, task, opts = {}) {
        const team = TEAMS[teamName];
        if (!team) throw new Error(`Unknown team: ${teamName}. Available: ${Object.keys(TEAMS).join(', ')}`);
        return this._run(team, task, { ...opts, teamName });
    }

    async runCustomTeam(agentNames, task, opts = {}) {
        return this._run({ agents: agentNames, sequential: opts.sequential !== false, desc: 'Custom team' }, task, { ...opts, teamName: 'custom' });
    }

    async autoRun(task, opts = {}) {
        const name = this._selectTeam(task);
        logger.info(`[Team] Auto-selected: ${name}`);
        return this.runTeam(name, task, opts);
    }

    async _run(team, task, opts = {}) {
        const { sessionId = 'default', teamName = 'custom' } = opts;
        const agents = require('./specialists');
        const sharedCtx = indexer.search(task, 12);
        const memories = MemoryManager.getRelevant(task, 5);
        const memCtx = MemoryManager.formatAsContext(memories);

        const results = [];
        let priorSummary = '';

        const runAgent = async (agentName, idx) => {
            const agent = agents[agentName];
            if (!agent) return { agent: agentName, error: 'Not found' };
            const taskWithPrior = team.sequential && priorSummary
                ? `${task}\n\n## Prior agent findings — build on these, don't repeat:\n${priorSummary}`
                : task;
            logger.info(`[Team:${teamName}] [${idx + 1}/${team.agents.length}] ${agentName}`);
            try {
                const r = await agent.run(taskWithPrior, { context: sharedCtx, extraSystem: memCtx, sessionId });
                if (team.sequential) priorSummary += `\n\n### ${agentName}:\n${r.answer.slice(0, 600)}`;
                return { agent: agentName, answer: r.answer, loops: r.loops, tools: r.toolResults?.length || 0 };
            } catch (err) {
                logger.error(`[Team:${teamName}] ${agentName} failed: ${err.message}`);
                return { agent: agentName, error: err.message };
            }
        };

        if (team.sequential) {
            for (let i = 0; i < team.agents.length; i++) results.push(await runAgent(team.agents[i], i));
        } else {
            results.push(...await Promise.all(team.agents.map((a, i) => runAgent(a, i))));
        }

        const report = await this._consolidate(task, results, teamName, sessionId);
        return { team: teamName, task, results, report, sequential: team.sequential, agentsRun: team.agents };
    }

    async _consolidate(task, results, teamName, sessionId) {
        const successful = results.filter(r => !r.error);
        if (!successful.length) return 'All agents failed.';
        if (successful.length === 1) return successful[0].answer;

        const parts = successful.map(r => `### ${r.agent}\n${r.answer}`).join('\n\n---\n\n');
        const response = await llm.chat({
            model: llm.model('fast'), max_tokens: 1200,
            messages: [{ role: 'user', content: `Consolidate this multi-agent team report into a final developer summary.\n\nTask: ${task}\nTeam: ${teamName}\n\n${parts}\n\nWrite:\n## Executive Summary (3-4 sentences)\n## Critical Findings (numbered, most important first)\n## Action Items (concrete next steps)\n## Agent Breakdown (which agent found what)\n\nBe specific. Include file names and line references. No fluff.` }],
        });
        costTracker.record({ model: llm.model('fast'), inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, sessionId, queryType: 'team-consolidate' });
        return response.content[0].text;
    }

    _selectTeam(task) {
        const t = task.toLowerCase();
        if (/incident|outage|down|crash|post.?mortem/i.test(t)) return 'post-mortem';
        if (/bug|error|exception|fail|crash/i.test(t)) return 'bug-triage';
        if (/release|deploy|ship|version|changelog/i.test(t)) return 'release-prep';
        if (/onboard|new dev|understand|explain codebase/i.test(t)) return 'onboarding';
        if (/refactor|clean|restructure/i.test(t)) return 'refactor-safe';
        if (/data|schema|model|database|query/i.test(t)) return 'data-audit';
        if (/ci|cd|pipeline|docker|deploy/i.test(t)) return 'ci-setup';
        if (/new (feature|service|module|system)/i.test(t)) return 'greenfield';
        if (/audit|scan|review all|security/i.test(t)) return 'full-audit';
        return 'feature-review';
    }

    getTeams() {
        return Object.entries(TEAMS).map(([name, t]) => ({ name, description: t.desc, agents: t.agents, sequential: t.sequential }));
    }
}

module.exports = new TeamCoordinator();
