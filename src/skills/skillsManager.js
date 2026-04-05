/**
 * Skills are named, reusable prompt templates / workflows that users define once
 * and reuse across queries. They can reference placeholders {target}, {context}, etc.
 *
 * Examples:
 *   /skill run add-error-handling UserService.js
 *   /skill run document-function getUserById
 *   /skill run check-security AuthController.js
 */

const fs = require('fs');
const path = require('path');
const llm = require('../utils/llmClient');
const logger = require('../utils/logger');
const costTracker = require('../utils/costTracker');
const { MemoryManager } = require('../memory/memoryManager');
const indexer = require('../core/indexer');

const SKILLS_FILE = path.join(process.cwd(), 'data', 'skills.json');

// ── Built-in skills (ship with the system) ─────────────────────────────────────
const BUILTIN_SKILLS = {
    'add-error-handling': {
        name: 'add-error-handling',
        description: 'Add proper try/catch error handling to a function or file',
        prompt: `Analyse {target} in the codebase and add proper error handling:
- Wrap async operations in try/catch
- Log errors with context (function name, input params)
- Return/throw appropriate error types
- Don't swallow errors silently
Show the exact changes needed as a diff.`,
        tags: ['code-quality', 'builtin'],
        builtIn: true,
    },
    'document-function': {
        name: 'document-function',
        description: 'Generate JSDoc documentation for a function or module',
        prompt: `Generate complete JSDoc documentation for {target}:
- @description — what it does
- @param — each parameter with type and description
- @returns — return type and description
- @throws — errors it can throw
- @example — a realistic usage example
Base everything on the actual code, not assumptions.`,
        tags: ['documentation', 'builtin'],
        builtIn: true,
    },
    'check-security': {
        name: 'check-security',
        description: 'Security audit of a specific file or function',
        prompt: `Perform a targeted security audit of {target}:
1. Input validation — are all inputs sanitized?
2. Auth checks — are endpoints/methods properly protected?
3. SQL/NoSQL injection — are queries parameterized?
4. Sensitive data — are secrets/tokens handled safely?
5. Error messages — do they leak internal details?
Rate each finding CRITICAL / HIGH / MEDIUM / LOW. Provide exact fixes.`,
        tags: ['security', 'builtin'],
        builtIn: true,
    },
    'explain-flow': {
        name: 'explain-flow',
        description: 'Explain the execution flow through a function or module',
        prompt: `Trace and explain the complete execution flow of {target}:
1. Entry point and inputs
2. Step-by-step what happens (include function calls, DB calls, external calls)
3. All possible exit paths (happy path, errors, edge cases)
4. Side effects (what state is changed, what events are emitted)
Use numbered steps. Reference actual file/function names from the codebase.`,
        tags: ['understanding', 'builtin'],
        builtIn: true,
    },
    'find-similar': {
        name: 'find-similar',
        description: 'Find similar patterns or duplicated logic in the codebase',
        prompt: `Find all code in the codebase that is similar to or duplicates {target}:
- Functions with the same purpose implemented differently
- Copy-pasted blocks with minor variations
- Patterns that should be extracted into a shared utility
List each occurrence with file name and line reference.
Suggest how to consolidate them.`,
        tags: ['refactoring', 'builtin'],
        builtIn: true,
    },
    'write-tests': {
        name: 'write-tests',
        description: 'Generate unit test cases for a function',
        prompt: `Write comprehensive unit tests for {target}:
- Happy path test cases
- Edge cases (null/undefined inputs, empty arrays, boundary values)
- Error cases (what should throw or return error)
- Mock external dependencies (DB, APIs, cache)
Use Jest syntax. Base tests on the ACTUAL behaviour in the code, not assumptions.`,
        tags: ['testing', 'builtin'],
        builtIn: true,
    },
    'performance-audit': {
        name: 'performance-audit',
        description: 'Find performance issues in a specific file or function',
        prompt: `Audit {target} for performance issues:
- N+1 database queries (calling DB inside a loop)
- Missing async/await (synchronous blocking operations)
- Unnecessary data loading (fetching more than needed)
- Missing caching opportunities
- Inefficient algorithms or data structures
For each issue: severity, location, and specific fix.`,
        tags: ['performance', 'builtin'],
        builtIn: true,
    },
    'migration-plan': {
        name: 'migration-plan',
        description: 'Plan a safe migration or refactor of a module',
        prompt: `Create a step-by-step migration plan for changing {target}:
1. Current state analysis
2. All code that depends on it (imports, usages)
3. Proposed new implementation
4. Migration steps in safe order (least risk first)
5. Rollback strategy
6. How to test each step
Be specific about which files to change and in what order.`,
        tags: ['planning', 'builtin'],
        builtIn: true,
    },
};

class SkillsManager {
    constructor() {
        this._custom = this._load();
    }

    _load() {
        try {
            if (fs.existsSync(SKILLS_FILE)) return JSON.parse(fs.readFileSync(SKILLS_FILE, 'utf-8'));
        } catch { }
        return {};
    }

    _save() {
        fs.writeFileSync(SKILLS_FILE, JSON.stringify(this._custom, null, 2));
    }

    /**
     * Get a skill by name (checks custom first, then built-in)
     */
    get(name) {
        return this._custom[name] || BUILTIN_SKILLS[name] || null;
    }

    /**
     * List all skills
     */
    list(filter = {}) {
        const all = { ...BUILTIN_SKILLS, ...this._custom };
        let skills = Object.values(all);
        if (filter.tags?.length) {
            skills = skills.filter(s => filter.tags.some(t => s.tags?.includes(t)));
        }
        if (filter.search) {
            const q = filter.search.toLowerCase();
            skills = skills.filter(s => s.name.includes(q) || s.description.includes(q));
        }
        return skills;
    }

    /**
     * Create a custom skill
     */
    create(name, description, prompt, tags = []) {
        if (!name || !prompt) throw new Error('name and prompt are required');
        if (BUILTIN_SKILLS[name]) throw new Error(`Cannot override built-in skill: ${name}`);

        const skill = {
            name: name.toLowerCase().replace(/\s+/g, '-'),
            description,
            prompt,
            tags: [...tags, 'custom'],
            builtIn: false,
            createdAt: new Date().toISOString(),
        };

        this._custom[skill.name] = skill;
        this._save();
        logger.info(`[Skills] Created: ${skill.name}`);
        return skill;
    }

    /**
     * Delete a custom skill
     */
    delete(name) {
        if (BUILTIN_SKILLS[name]) throw new Error('Cannot delete built-in skills');
        if (!this._custom[name]) throw new Error(`Skill not found: ${name}`);
        delete this._custom[name];
        this._save();
        return true;
    }

    /**
     * Execute a skill against a target
     * @param {string} skillName  - Skill to run
     * @param {string} target     - What to run it on (function name, file path, etc.)
     * @param {object} opts
     */
    async run(skillName, target, opts = {}) {
        const { sessionId = 'default', extraContext = '' } = opts;
        const skill = this.get(skillName);
        if (!skill) throw new Error(`Unknown skill: ${skillName}. Run /skill list to see available skills.`);

        logger.info(`[Skills] Running "${skillName}" on "${target}"`);

        // Build the prompt by substituting {target}
        const prompt = skill.prompt.replace(/\{target\}/g, target);

        // Retrieve relevant context for the target
        const docs = indexer.search(`${target} ${skillName}`, 8);
        const memories = MemoryManager.getRelevant(`${skillName} ${target}`, 3);
        const memContext = MemoryManager.formatAsContext(memories);

        const contextStr = docs.length > 0
            ? '\n\n## Codebase Context\n' + docs.map(d =>
                `**${d.filename}** (${d.kind}):\n\`\`\`\n${d.content.slice(0, 800)}\n\`\`\``
            ).join('\n\n---\n\n')
            : '';

        const systemPrompt = [
            `You are an expert developer executing a specific skill: "${skill.name}".`,
            `Be precise, code-focused, and base your answer entirely on the provided codebase context.`,
            memContext,
        ].filter(Boolean).join('\n\n');

        const userMessage = `${prompt}${extraContext ? '\n\nAdditional context: ' + extraContext : ''}${contextStr}`;

        const response = await llm.chat({
            model: llm.model('smart'),
            max_tokens: 2000,
            system: systemPrompt,
            messages: [{ role: 'user', content: userMessage }],
        });

        costTracker.record({
            model: llm.model('smart'),
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            sessionId,
            queryType: `skill-${skillName}`,
        });

        const result = response.content[0].text;

        // Auto-save useful outcomes to memory
        MemoryManager.extractFromExchange(`${skillName} on ${target}`, result, sessionId).catch(() => { });

        return {
            skill: skillName,
            target,
            result,
            sourcesUsed: docs.length,
            usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
        };
    }
}

module.exports = new SkillsManager();
