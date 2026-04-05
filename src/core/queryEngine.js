const llm = require('../utils/llmClient');
const indexer = require('./indexer');
const logger = require('../utils/logger');
const costTracker = require('../utils/costTracker');
const { MemoryManager } = require('../memory/memoryManager');

// The 3 core query modes from the article
const QUERY_MODES = {
    DEBUG: 'debug',       // "Why is this failing?"
    USAGE: 'usage',       // "Where is this used?"
    IMPACT: 'impact',     // "If I change this, what breaks?"
    GENERAL: 'general',   // Open-ended question
};

/**
 * Detect the most appropriate query mode from the question text
 */
function detectMode(question) {
    const q = question.toLowerCase();

    if (/why.*(fail|error|crash|break|throw|exception|not work)/i.test(q) ||
        /what.*(error|exception|wrong|cause|happen)/i.test(q) ||
        /debug|trace|stack|exception|ClassCastException|NullPointer|TypeError/i.test(q)) {
        return QUERY_MODES.DEBUG;
    }

    if (/where.*(use|call|reference|import|depend)|who.*(use|call)|find.*(usage|reference)/i.test(q)) {
        return QUERY_MODES.USAGE;
    }

    if (/if.*change|what.*break|impact|affect|depend|side effect|ripple|downstream/i.test(q)) {
        return QUERY_MODES.IMPACT;
    }

    return QUERY_MODES.GENERAL;
}

/**
 * Build a mode-specific system prompt
 */
function buildSystemPrompt(mode) {
    const base = `You are an expert developer assistant with deep knowledge of the codebase.
You answer questions ONLY based on the code context provided — never guess or hallucinate.
If the context doesn't contain enough information, say so clearly.
Be concise, direct, and developer-friendly. Use code examples from the context when relevant.`;

    const modeInstructions = {
        [QUERY_MODES.DEBUG]: `
Your job: DIAGNOSE the root cause of bugs and errors.
- Identify the exact type mismatch, null reference, or logic flaw
- Trace the execution flow that leads to the error
- Point to the specific file, function, and line range where the issue originates
- Provide a concrete fix with code
Format: Root Cause → Affected Flow → Fix`,

        [QUERY_MODES.USAGE]: `
Your job: FIND all usages of a function, class, module, or variable.
- List every file where it is imported or referenced
- Explain HOW it is used in each context (called directly, passed as callback, extended, etc.)
- Note any patterns or inconsistencies in usage
Format: Summary → File-by-file breakdown`,

        [QUERY_MODES.IMPACT]: `
Your job: ANALYSE what would break or change if the target is modified.
- List all files/modules that directly depend on it
- Identify indirect dependencies (things that use things that use it)
- Flag any risky or tightly-coupled areas
- Suggest safe modification strategies
Format: Direct Impact → Indirect Impact → Risk Level → Safe change strategy`,

        [QUERY_MODES.GENERAL]: `
Your job: Answer the developer's question using the codebase context.
- Be specific and cite the relevant files/functions
- If the answer spans multiple files, connect the dots
- If something is unclear in the code, flag it`,
    };

    return base + (modeInstructions[mode] || modeInstructions[QUERY_MODES.GENERAL]);
}

/**
 * Format retrieved context chunks into a readable prompt section
 */
function formatContext(docs) {
    if (!docs || docs.length === 0) {
        return 'No relevant context found in the codebase index.';
    }

    return docs
        .map((doc, i) => {
            const meta = doc.metadata || {};
            const metaSummary = [
                meta.functions?.length ? `Functions: ${meta.functions.slice(0, 5).join(', ')}` : null,
                meta.classes?.length ? `Classes: ${meta.classes.join(', ')}` : null,
                meta.imports?.length ? `Imports: ${meta.imports.slice(0, 3).join(', ')}` : null,
                meta.errors?.length ? `Errors: ${meta.errors.slice(0, 3).join(', ')}` : null,
                meta.patterns?.length ? `Patterns: ${meta.patterns.join(', ')}` : null,
            ]
                .filter(Boolean)
                .join(' | ');

            return `--- [${i + 1}] ${doc.filename} (${doc.kind}) | Score: ${doc.relevanceScore} ---
Path: ${doc.filePath}
${metaSummary ? `Meta: ${metaSummary}` : ''}
\`\`\`
${doc.content}
\`\`\``;
        })
        .join('\n\n');
}

class QueryEngine {
    /**
     * Main query method
     */
    async query(question, options = {}) {
        const {
            mode: forcedMode,
            topK = 8,
            stream = false,
            filter = {},
        } = options;

        if (!question || question.trim().length === 0) {
            throw new Error('Question cannot be empty');
        }

        const mode = forcedMode || detectMode(question);
        logger.info(`Query mode: ${mode} | Q: "${question.slice(0, 80)}..."`);

        // Retrieve relevant context
        let docs;
        switch (mode) {
            case QUERY_MODES.DEBUG:
                docs = indexer.searchForErrors(question, topK);
                break;
            case QUERY_MODES.USAGE:
                // Extract the symbol being searched
                const usageMatch = question.match(/(?:where|how|who).*?(?:is|are|does)?\s+[`"']?(\w+)[`"']?\s+(?:used|called|import|reference)/i);
                const symbol = usageMatch?.[1] || question;
                docs = indexer.searchForUsages(symbol, topK);
                break;
            case QUERY_MODES.IMPACT:
                const impactMatch = question.match(/(?:change|modify|update|refactor)\s+[`"']?(\w+)[`"']?/i);
                const target = impactMatch?.[1] || question;
                docs = indexer.searchForImpact(target, topK);
                break;
            default:
                docs = indexer.search(question, topK, filter);
        }

        const contextText = formatContext(docs);
        const systemPrompt = buildSystemPrompt(mode);

        const userMessage = `## Developer Question
${question}

## Codebase Context (retrieved from your system)
${contextText}

## Answer`;

        const { provider, model } = llm.getInfo();
        logger.info(`Sending to ${provider} (${model}): ${docs.length} context chunks`);

        // Inject relevant memories into context
        const memories = MemoryManager.getRelevant(question, 5);
        const memoryContext = MemoryManager.formatAsContext(memories);
        const fullSystem = memoryContext ? `${systemPrompt}\n\n${memoryContext}` : systemPrompt;

        if (stream) {
            return this._streamQuery(fullSystem, userMessage, docs, mode);
        }

        const response = await llm.chat({
            model: llm.model('smart'),
            max_tokens: 2000,
            system: fullSystem,
            messages: [{ role: 'user', content: userMessage }],
        });

        const answer = response.content[0].text;

        // Track cost
        const sessionId = options.sessionId || 'default';
        const cost = costTracker.record({
            model: llm.model('smart'),
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            sessionId,
            queryType: mode,
        });

        // Auto-extract memories from this exchange (async, fire-and-forget)
        if (options.extractMemories !== false) {
            MemoryManager.extractFromExchange(question, answer, sessionId).catch(() => { });
        }

        return {
            answer,
            mode,
            memoriesUsed: memories.length,
            sources: docs.map(d => ({
                file: d.filename,
                path: d.filePath,
                kind: d.kind,
                relevanceScore: d.relevanceScore,
                functions: d.metadata?.functions?.slice(0, 5) || [],
            })),
            usage: {
                inputTokens: response.usage.input_tokens,
                outputTokens: response.usage.output_tokens,
                costUsd: cost.costUsd,
            },
        };
    }

    /**
     * Streaming version of query
     */
    async *_streamQuery(systemPrompt, userMessage, docs, mode) {
        const stream = await llm.chat({
            model: llm.model('smart'),
            max_tokens: 2000,
            system: systemPrompt,
            messages: [{ role: 'user', content: userMessage }],
            stream: true,
        });

        // First yield metadata
        yield {
            type: 'metadata',
            mode,
            sources: docs.map(d => ({
                file: d.filename,
                path: d.filePath,
                kind: d.kind,
                relevanceScore: d.relevanceScore,
            })),
        };

        // Then stream the answer
        for await (const event of stream) {
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                yield { type: 'text', text: event.delta.text };
            }
            if (event.type === 'message_stop') {
                yield { type: 'done' };
            }
        }
    }

    /**
     * Quick debug helper - answer a specific error without full context retrieval
     */
    async debugError(errorMessage, stackTrace = '', options = {}) {
        const question = `Why is this error happening and how do I fix it?
Error: ${errorMessage}
${stackTrace ? `Stack trace:\n${stackTrace}` : ''}`;

        return this.query(question, { ...options, mode: QUERY_MODES.DEBUG });
    }

    /**
     * Find all usages of a symbol across the codebase
     */
    async findUsages(symbol, options = {}) {
        return this.query(`Where is ${symbol} used across the codebase?`, {
            ...options,
            mode: QUERY_MODES.USAGE,
        });
    }

    /**
     * Impact analysis for a proposed change
     */
    async analyzeImpact(target, changeDescription = '', options = {}) {
        const question = changeDescription
            ? `If I change ${target} to ${changeDescription}, what would break or be affected?`
            : `If I change or remove ${target}, what would break?`;

        return this.query(question, { ...options, mode: QUERY_MODES.IMPACT });
    }
}

module.exports = { QueryEngine: new QueryEngine(), QUERY_MODES, detectMode };
