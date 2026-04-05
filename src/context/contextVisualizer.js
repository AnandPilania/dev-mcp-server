'use strict';
/**
 * Shows developers exactly what's going into the LLM context window:
 *  - Which chunks were retrieved and why (score breakdown)
 *  - How much of the token budget each piece uses
 *  - What memories are being injected
 *  - What the final prompt looks like (sanitized)
 *  - Token breakdown by section
 */

const indexer = require('../core/indexer');
const contextEngineer = require('./contextEngineer');
const { MemoryManager } = require('../memory/memoryManager');
const teamMemory = require('../memory/teamMemory');

const EST_TOKENS = text => Math.ceil((text || '').length / 4);

class ContextVisualizer {
    /**
     * Visualize the full context that would be sent for a given query
     */
    visualize(query, opts = {}) {
        const { mode = 'general', topK = 8, team, sessionId } = opts;

        // 1. Retrieve docs
        let docs;
        switch (mode) {
            case 'debug': docs = indexer.searchForErrors(query, topK); break;
            case 'usage': docs = indexer.searchForUsages(query, topK); break;
            case 'impact': docs = indexer.searchForImpact(query, topK); break;
            default: docs = indexer.search(query, topK);
        }

        // 2. Engineer context
        const engineered = contextEngineer.engineer(docs, query, mode);

        // 3. Get memories
        const memories = MemoryManager.getRelevant(query, 5);
        const memContext = MemoryManager.formatAsContext(memories);
        const teamContext = teamMemory.formatForAgent ? teamMemory.formatForAgent(team || 'global') : '';

        // 4. Build token breakdown
        const sections = {
            system_prompt: {
                label: 'System Prompt',
                tokens: EST_TOKENS('You are an expert developer assistant...'),
                content: '[system prompt — not shown for brevity]',
            },
            memory_context: {
                label: 'Memory Context',
                tokens: EST_TOKENS(memContext),
                content: memContext || '(no relevant memories)',
                count: memories.length,
            },
            team_memory: {
                label: 'Team Memory',
                tokens: EST_TOKENS(teamContext),
                content: teamContext || '(no team memory)',
            },
            retrieval_context: {
                label: 'Retrieved Codebase Context',
                tokens: engineered.budgetUsed,
                chunks: engineered.chunks.map(c => ({
                    file: c.filename,
                    kind: c.kind,
                    chunkIndex: c.chunkIndex,
                    relevanceScore: c.relevanceScore,
                    engineeredScore: c.engineeredScore,
                    tokens: EST_TOKENS(c.content),
                    trimmed: c.trimmed || false,
                    snippet: c.content.slice(0, 100) + (c.content.length > 100 ? '...' : ''),
                    metadata: {
                        functions: c.metadata?.functions?.slice(0, 3) || [],
                        classes: c.metadata?.classes?.slice(0, 3) || [],
                        isBugFix: c.metadata?.isBugFix || false,
                    },
                })),
                dropped: engineered.dropped,
            },
            user_query: {
                label: 'User Query',
                tokens: EST_TOKENS(query),
                content: query,
            },
        };

        const totalTokens = Object.values(sections).reduce((s, sec) => s + (sec.tokens || 0), 0);

        return {
            query,
            mode,
            totalTokens,
            budgetUtilization: `${((totalTokens / 8000) * 100).toFixed(1)}%`,
            sections,
            summary: {
                chunksRetrieved: docs.length,
                chunksUsed: engineered.chunks.length,
                chunksDropped: engineered.dropped,
                memoriesInjected: memories.length,
                topSources: engineered.chunks.slice(0, 3).map(c => `${c.filename} (${c.relevanceScore})`),
            },
            warnings: [
                totalTokens > 7000 ? '⚠ Context is near limit — consider using /compact' : null,
                engineered.dropped > 2 ? `⚠ ${engineered.dropped} chunks dropped due to budget` : null,
                memories.length === 0 ? 'ℹ No relevant memories found — knowledge grows with use' : null,
            ].filter(Boolean),
        };
    }

    /**
     * Format context visualization as a human-readable string
     */
    format(viz) {
        const lines = [
            `╔══ Context Window Visualization ══╗`,
            `  Query:  "${viz.query.slice(0, 60)}"`,
            `  Mode:   ${viz.mode}`,
            `  Tokens: ${viz.totalTokens} (~${viz.budgetUtilization} of budget)`,
            ``,
            `  Sources (${viz.summary.chunksUsed} used, ${viz.summary.chunksDropped} dropped):`,
        ];

        for (const chunk of viz.sections.retrieval_context.chunks) {
            lines.push(`    [${chunk.kind}] ${chunk.file} — rel:${chunk.relevanceScore} eng:${chunk.engineeredScore} ${chunk.trimmed ? '(trimmed)' : ''}`);
        }

        if (viz.summary.memoriesInjected > 0) {
            lines.push(``, `  Memories injected: ${viz.summary.memoriesInjected}`);
        }

        if (viz.warnings.length) {
            lines.push(``, `  Warnings:`);
            viz.warnings.forEach(w => lines.push(`    ${w}`));
        }

        return lines.join('\n');
    }
}

module.exports = new ContextVisualizer();
