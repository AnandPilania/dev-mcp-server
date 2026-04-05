'use strict';
/**
 * A dedicated prompt engineering system.
 *
 * Features:
 *   - Analyse a prompt for weaknesses
 *   - Improve a prompt automatically
 *   - Generate prompts from a task description
 *   - A/B test two prompts against a benchmark
 *   - Prompt template library with variables
 *   - Chain-of-thought injection
 */

const llm = require('../utils/llmClient');
const fs = require('fs');
const path = require('path');
const costTracker = require('../utils/costTracker');
const logger = require('../utils/logger');

const LIBRARY_FILE = path.join(process.cwd(), 'data', 'prompt-library.json');

// ── Built-in prompt templates ─────────────────────────────────────────────────
const BUILTIN_TEMPLATES = {
    'chain-of-thought': {
        name: 'chain-of-thought',
        description: 'Adds structured reasoning steps before the answer',
        template: `{prompt}

Think through this step by step:
1. What is being asked?
2. What information do I have?
3. What approach should I take?
4. Work through the solution
5. Verify the answer

Answer:`,
        variables: ['prompt'],
    },
    'role-expert': {
        name: 'role-expert',
        description: 'Frame Anu as a domain expert',
        template: `You are a world-class {domain} expert with 20+ years of experience.
You give precise, evidence-based answers grounded in real-world practice.
You never guess — if you are uncertain, you say so clearly.

Task: {task}`,
        variables: ['domain', 'task'],
    },
    'few-shot': {
        name: 'few-shot',
        description: 'Provide examples before the actual task',
        template: `Here are examples of the task:

Example 1:
Input: {example1_input}
Output: {example1_output}

Example 2:
Input: {example2_input}
Output: {example2_output}

Now do the same for:
Input: {actual_input}
Output:`,
        variables: ['example1_input', 'example1_output', 'example2_input', 'example2_output', 'actual_input'],
    },
    'structured-output': {
        name: 'structured-output',
        description: 'Force structured JSON output',
        template: `{task}

Respond ONLY with a JSON object in this exact format (no markdown, no explanation):
{schema}`,
        variables: ['task', 'schema'],
    },
    'critique-and-revise': {
        name: 'critique-and-revise',
        description: 'Self-critique and improve an answer',
        template: `{task}

First, provide your initial answer.
Then, critique it: what's missing, what could be wrong, what could be clearer?
Finally, provide a revised, improved answer incorporating your critique.

Initial answer:
[your first attempt]

Critique:
[what you'd improve]

Revised answer:
[your improved answer]`,
        variables: ['task'],
    },
    'least-to-most': {
        name: 'least-to-most',
        description: 'Break down into simpler sub-problems first',
        template: `To solve: {problem}

First, identify the simpler sub-problems that lead to the solution.
Solve each sub-problem in order, using each answer to help with the next.

Sub-problems:
1. [simplest piece]
2. [next piece]
...

Now solve each:`,
        variables: ['problem'],
    },
    'react-agent': {
        name: 'react-agent',
        description: 'ReAct (Reason + Act) prompting pattern',
        template: `Task: {task}

Use this format:
Thought: [your reasoning about the current situation]
Action: [action to take from: {available_actions}]
Observation: [result of the action]
... (repeat until done)
Thought: I now have enough information to answer
Answer: [final answer]`,
        variables: ['task', 'available_actions'],
    },
    'socratic': {
        name: 'socratic',
        description: 'Lead the user to the answer through questions',
        template: `Instead of directly answering "{question}", help the user discover the answer themselves.

Ask 2-3 probing questions that guide them toward understanding.
After they respond, lead them closer to the answer.
Only reveal the full answer if they are completely stuck.`,
        variables: ['question'],
    },
};

class PromptEngineer {
    constructor() {
        this._library = this._loadLibrary();
    }

    _loadLibrary() {
        try { if (fs.existsSync(LIBRARY_FILE)) return JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf-8')); } catch { }
        return {};
    }
    _saveLibrary() { fs.writeFileSync(LIBRARY_FILE, JSON.stringify(this._library, null, 2)); }

    /**
     * Analyse a prompt and identify its weaknesses
     */
    async analyse(prompt, opts = {}) {
        logger.info(`[PromptEngineer] Analysing prompt (${prompt.length} chars)`);
        const response = await llm.chat({
            model: llm.model('smart'), max_tokens: 800,
            system: `You are a prompt engineering expert. Analyse prompts with precision and suggest concrete improvements.`,
            messages: [{ role: 'user', content: `Analyse this prompt and score it 1-10 on each dimension:\n\n---\n${prompt}\n---\n\nReturn JSON:\n{"scores":{"clarity":0,"specificity":0,"context":0,"output_format":0,"role_framing":0,"examples":0},"weaknesses":["..."],"strengths":["..."],"overall_score":0}` }],
        });
        costTracker.record({ model: llm.model('smart'), inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, sessionId: opts.sessionId || 'prompt-engineer', queryType: 'prompt-analyse' });
        try { return JSON.parse(response.content[0].text.replace(/```json\n?|\n?```/g, '').trim()); }
        catch { return { raw: response.content[0].text }; }
    }

    /**
     * Automatically improve a prompt
     */
    async improve(prompt, opts = {}) {
        const { goal = '', style = 'concise' } = opts;
        logger.info(`[PromptEngineer] Improving prompt`);

        const analysis = await this.analyse(prompt, opts);

        const response = await llm.chat({
            model: llm.model('smart'), max_tokens: 1200,
            system: `You are an expert prompt engineer. Rewrite prompts to be clearer, more specific, and more effective.`,
            messages: [{ role: 'user', content: `Original prompt:\n---\n${prompt}\n---\n\nWeaknesses identified: ${JSON.stringify(analysis.weaknesses || [])}\n\n${goal ? `Goal: ${goal}` : ''}\nStyle: ${style}\n\nRewrite the prompt to fix all weaknesses. Return:\n{"improved_prompt":"...","changes_made":["..."],"expected_improvement":"..."}` }],
        });
        costTracker.record({ model: llm.model('smart'), inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, sessionId: opts.sessionId || 'prompt-engineer', queryType: 'prompt-improve' });

        try {
            const result = JSON.parse(response.content[0].text.replace(/```json\n?|\n?```/g, '').trim());
            return { ...result, original: prompt, analysis };
        } catch {
            return { improved_prompt: response.content[0].text, original: prompt };
        }
    }

    /**
     * Generate a prompt from a task description
     */
    async generate(taskDescription, opts = {}) {
        const { type = 'instruction', model = 'smart', includeExamples = false } = opts;
        logger.info(`[PromptEngineer] Generating prompt for: ${taskDescription.slice(0, 60)}`);

        const response = await llm.chat({
            model: llm.model('smart'), max_tokens: 1000,
            messages: [{ role: 'user', content: `Generate an optimal ${type} prompt for this task:\n"${taskDescription}"\n\nTarget model: ${model}\nInclude examples: ${includeExamples}\n\nReturn:\n{"system_prompt":"...","user_prompt_template":"...","key_techniques":["..."],"variables":["..."]}` }],
        });
        costTracker.record({ model: llm.model('smart'), inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, sessionId: opts.sessionId || 'prompt-engineer', queryType: 'prompt-generate' });
        try { return JSON.parse(response.content[0].text.replace(/```json\n?|\n?```/g, '').trim()); }
        catch { return { user_prompt_template: response.content[0].text }; }
    }

    /**
     * A/B test two prompts against a test case
     */
    async abTest(promptA, promptB, testInput, opts = {}) {
        logger.info(`[PromptEngineer] A/B testing two prompts`);

        const [resA, resB] = await Promise.all([
            llm.chat({ model: llm.model('fast'), max_tokens: 500, messages: [{ role: 'user', content: `${promptA}\n\nInput: ${testInput}` }] }),
            llm.chat({ model: llm.model('fast'), max_tokens: 500, messages: [{ role: 'user', content: `${promptB}\n\nInput: ${testInput}` }] }),
        ]);

        const outputA = resA.content[0].text;
        const outputB = resB.content[0].text;

        // Judge which is better
        const judge = await llm.chat({
            model: llm.model('fast'), max_tokens: 300,
            messages: [{ role: 'user', content: `Compare these two AI outputs for the task: "${testInput}"\n\nOutput A:\n${outputA}\n\nOutput B:\n${outputB}\n\nWhich is better and why? Return JSON:\n{"winner":"A|B|tie","score_a":0,"score_b":0,"reasoning":"...","key_difference":"..."}` }],
        });

        for (const r of [resA, resB, judge]) {
            costTracker.record({ model: llm.model('fast'), inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens, sessionId: opts.sessionId || 'prompt-engineer', queryType: 'prompt-abtest' });
        }

        try {
            const verdict = JSON.parse(judge.content[0].text.replace(/```json\n?|\n?```/g, '').trim());
            return { promptA, promptB, testInput, outputA, outputB, verdict };
        } catch {
            return { promptA, promptB, outputA, outputB, verdict: { raw: judge.content[0].text } };
        }
    }

    /**
     * Apply a prompt template with variable substitution
     */
    applyTemplate(templateName, variables = {}) {
        const t = this._library[templateName] || BUILTIN_TEMPLATES[templateName];
        if (!t) throw new Error(`Template not found: ${templateName}. Available: ${this.listTemplates().map(t => t.name).join(', ')}`);
        let result = t.template;
        for (const [k, v] of Object.entries(variables)) {
            result = result.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
        }
        const missing = (result.match(/\{(\w+)\}/g) || []);
        if (missing.length) logger.warn(`[PromptEngineer] Unfilled variables: ${missing.join(', ')}`);
        return result;
    }

    /**
     * Inject chain-of-thought reasoning into any prompt
     */
    injectCoT(prompt, style = 'standard') {
        const injections = {
            standard: `\n\nThink through this carefully, step by step, before giving your final answer.`,
            detailed: `\n\nBefore answering:\n1. Understand what's being asked\n2. Identify relevant information\n3. Consider edge cases\n4. Work through the solution\n5. Verify your answer\n\nNow answer:`,
            socratic: `\n\nAsk yourself: What do I know? What don't I know? What's the simplest path? Then answer:`,
            zero_shot: `\n\nLet's think about this step by step:`,
        };
        return prompt + (injections[style] || injections.standard);
    }

    /** Save a custom template to the library */
    saveTemplate(name, description, template, variables = []) {
        if (BUILTIN_TEMPLATES[name]) throw new Error(`Cannot override built-in template: ${name}`);
        this._library[name] = { name, description, template, variables, custom: true, createdAt: new Date().toISOString() };
        this._saveLibrary();
        return this._library[name];
    }

    deleteTemplate(name) {
        if (BUILTIN_TEMPLATES[name]) throw new Error('Cannot delete built-in templates');
        if (!this._library[name]) throw new Error(`Template not found: ${name}`);
        delete this._library[name]; this._saveLibrary(); return true;
    }

    listTemplates() {
        return [
            ...Object.values(BUILTIN_TEMPLATES).map(t => ({ ...t, builtIn: true })),
            ...Object.values(this._library).map(t => ({ ...t, builtIn: false })),
        ];
    }

    getTemplate(name) {
        return this._library[name] || BUILTIN_TEMPLATES[name] || null;
    }
}

module.exports = new PromptEngineer();
