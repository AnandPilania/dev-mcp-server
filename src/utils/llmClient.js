'use strict';
/**
 * Universal LLM client. Reads LLM_PROVIDER from env and returns
 * a unified interface regardless of the underlying provider.
 *
 * Supported providers:
 *   anthropic  — Anthropic Claude (default)
 *   azure      — Azure OpenAI Service
 *   ollama     — Local Ollama server
 *
 * Unified API (mirrors Anthropic's messages.create shape):
 *   await llm.chat({ model, system, messages, max_tokens, tools, stream })
 *   → { content: [{ type:'text', text }], usage: { input_tokens, output_tokens }, stop_reason }
 *
 * Model resolution:
 *   llm.model('fast')    → haiku  / gpt-4o-mini / mistral
 *   llm.model('smart')   → opus   / gpt-4-turbo / llama3
 *   llm.model('default') → sonnet / gpt-4o     / llama3
 */

require('dotenv').config();

const PROVIDER = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase();

// ── Model alias maps ───────────────────────────────────────────────────────────
const MODEL_ALIASES = {
    anthropic: {
        fast: 'claude-haiku-4-5-20251001',
        default: 'claude-sonnet-4-5',
        smart: 'claude-opus-4-5',
    },
    azure: {
        fast: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o-mini',
        default: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o',
        smart: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o',
    },
    ollama: {
        fast: process.env.LLM_MODEL || 'llama3',
        default: process.env.LLM_MODEL || 'llama3',
        smart: process.env.LLM_MODEL || 'llama3',
    },
};

// ── Pricing map (per million tokens, USD) ─────────────────────────────────────
const PRICING = {
    'claude-opus-4-5': { input: 15.0, output: 75.0 },
    'claude-sonnet-4-5': { input: 3.0, output: 15.0 },
    'claude-haiku-4-5-20251001': { input: 0.25, output: 1.25 },
    'claude-haiku-4-5': { input: 0.25, output: 1.25 },
    'gpt-4o': { input: 5.0, output: 15.0 },
    'gpt-4o-mini': { input: 0.15, output: 0.6 },
    'gpt-4-turbo': { input: 10.0, output: 30.0 },
    // Ollama is free (local), track 0
    default: { input: 0, output: 0 },
};

// ─────────────────────────────────────────────────────────────────────────────
// ANTHROPIC ADAPTER
// ─────────────────────────────────────────────────────────────────────────────
class AnthropicAdapter {
    constructor() {
        const Anthropic = require('@anthropic-ai/sdk');
        this._client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        this.providerName = 'anthropic';
    }

    async chat({ model, system, messages, max_tokens = 2000, tools, stream = false }) {
        const params = { model, max_tokens, messages };
        if (system) params.system = system;
        if (tools?.length) params.tools = tools;
        if (stream) params.stream = true;

        const response = await this._client.messages.create(params);

        if (stream) return response; // pass the raw stream through

        return {
            content: response.content,
            stop_reason: response.stop_reason,
            usage: {
                input_tokens: response.usage.input_tokens,
                output_tokens: response.usage.output_tokens,
            },
            _raw: response,
        };
    }

    supportsTools() { return true; }
    supportsStreaming() { return true; }
}

// ─────────────────────────────────────────────────────────────────────────────
// AZURE OPENAI ADAPTER
// ─────────────────────────────────────────────────────────────────────────────
class AzureAdapter {
    constructor() {
        const { AzureOpenAI } = require('openai');
        this._client = new AzureOpenAI({
            endpoint: process.env.AZURE_OPENAI_ENDPOINT,
            apiKey: process.env.AZURE_OPENAI_API_KEY,
            apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-05-01-preview',
            deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
        });
        this.providerName = 'azure';
    }

    async chat({ model, system, messages, max_tokens = 2000, tools, stream = false }) {
        // Convert Anthropic message format → OpenAI format
        const oaiMessages = this._convertMessages(system, messages);

        const params = {
            model: process.env.AZURE_OPENAI_DEPLOYMENT || model,
            messages: oaiMessages,
            max_tokens,
        };

        if (tools?.length) {
            params.tools = tools.map(t => ({
                type: 'function',
                function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.input_schema || {},
                },
            }));
        }

        if (stream) {
            const s = await this._client.chat.completions.create({ ...params, stream: true });
            return this._wrapAzureStream(s);
        }

        const response = await this._client.chat.completions.create(params);
        return this._convertResponse(response);
    }

    _convertMessages(system, messages) {
        const result = [];
        if (system) result.push({ role: 'system', content: system });

        for (const msg of messages) {
            if (typeof msg.content === 'string') {
                result.push({ role: msg.role, content: msg.content });
            } else if (Array.isArray(msg.content)) {
                // Handle Anthropic content blocks (text, tool_use, tool_result)
                const textBlocks = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
                const toolUseBlocks = msg.content.filter(b => b.type === 'tool_use');
                const toolResultBlocks = msg.content.filter(b => b.type === 'tool_result');

                if (toolResultBlocks.length) {
                    for (const tr of toolResultBlocks) {
                        result.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content) });
                    }
                } else if (toolUseBlocks.length) {
                    result.push({
                        role: 'assistant',
                        content: textBlocks || null,
                        tool_calls: toolUseBlocks.map(tu => ({
                            id: tu.id, type: 'function',
                            function: { name: tu.name, arguments: JSON.stringify(tu.input || {}) },
                        })),
                    });
                } else {
                    result.push({ role: msg.role, content: textBlocks });
                }
            }
        }
        return result;
    }

    _convertResponse(response) {
        const choice = response.choices[0];
        const content = [];

        if (choice.message.content) {
            content.push({ type: 'text', text: choice.message.content });
        }

        if (choice.message.tool_calls?.length) {
            for (const tc of choice.message.tool_calls) {
                content.push({
                    type: 'tool_use',
                    id: tc.id,
                    name: tc.function.name,
                    input: (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })(),
                });
            }
        }

        const stopMap = { stop: 'end_turn', tool_calls: 'tool_use', length: 'max_tokens' };

        return {
            content,
            stop_reason: stopMap[choice.finish_reason] || 'end_turn',
            usage: {
                input_tokens: response.usage?.prompt_tokens || 0,
                output_tokens: response.usage?.completion_tokens || 0,
            },
            _raw: response,
        };
    }

    async *_wrapAzureStream(stream) {
        for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta;
            if (delta?.content) {
                yield { type: 'content_block_delta', delta: { type: 'text_delta', text: delta.content } };
            }
            if (chunk.choices[0]?.finish_reason) {
                yield { type: 'message_stop' };
            }
        }
    }

    supportsTools() { return true; }
    supportsStreaming() { return true; }
}

// ─────────────────────────────────────────────────────────────────────────────
// OLLAMA ADAPTER
// ─────────────────────────────────────────────────────────────────────────────
class OllamaAdapter {
    constructor() {
        const { OpenAI } = require('openai');
        this._client = new OpenAI({
            baseURL: (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '') + '/v1',
            apiKey: 'ollama', // required by openai SDK but not used by Ollama
        });
        this.providerName = 'ollama';
    }

    async chat({ model, system, messages, max_tokens = 2000, tools, stream = false }) {
        const oaiMessages = [];
        if (system) oaiMessages.push({ role: 'system', content: system });
        for (const m of messages) {
            const content = typeof m.content === 'string'
                ? m.content
                : m.content?.filter?.(b => b.type === 'text').map(b => b.text).join('\n') || '';
            oaiMessages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content });
        }

        const params = { model: model || process.env.LLM_MODEL || 'llama3', messages: oaiMessages, max_tokens };
        // Note: Ollama's tool support is model-dependent — only add if supported
        if (tools?.length) params.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema || {} } }));

        if (stream) {
            const s = await this._client.chat.completions.create({ ...params, stream: true });
            return this._wrapStream(s);
        }

        const response = await this._client.chat.completions.create(params);
        const choice = response.choices[0];
        return {
            content: [{ type: 'text', text: choice.message.content || '' }],
            stop_reason: choice.finish_reason === 'stop' ? 'end_turn' : 'end_turn',
            usage: {
                input_tokens: response.usage?.prompt_tokens || 0,
                output_tokens: response.usage?.completion_tokens || 0,
            },
            _raw: response,
        };
    }

    async *_wrapStream(stream) {
        for await (const chunk of stream) {
            const text = chunk.choices[0]?.delta?.content;
            if (text) yield { type: 'content_block_delta', delta: { type: 'text_delta', text } };
            if (chunk.choices[0]?.finish_reason) yield { type: 'message_stop' };
        }
    }

    supportsTools() { return !!(process.env.OLLAMA_TOOLS === 'true'); }
    supportsStreaming() { return true; }
}

// ─────────────────────────────────────────────────────────────────────────────
// FACTORY + SINGLETON
// ─────────────────────────────────────────────────────────────────────────────

function createAdapter() {
    switch (PROVIDER) {
        case 'azure': return new AzureAdapter();
        case 'ollama': return new OllamaAdapter();
        case 'anthropic':
        default: return new AnthropicAdapter();
    }
}

class LLMClient {
    constructor() {
        this._adapter = createAdapter();
        this._aliases = MODEL_ALIASES[PROVIDER] || MODEL_ALIASES.anthropic;
        this.provider = PROVIDER;
    }

    /**
     * Resolve a model alias ('fast' | 'smart' | 'default') or return the
     * string as-is if it's already a full model name.
     */
    model(alias) {
        return this._aliases[alias] || alias || this._aliases.default;
    }

    /**
     * Main chat method — unified interface across all providers.
     *
     * @param {object} opts
     *   model      - full model name or alias ('fast'|'smart'|'default')
     *   system     - system prompt string
     *   messages   - Anthropic-format messages array
     *   max_tokens - max output tokens
     *   tools      - Anthropic-format tool definitions (translated per provider)
     *   stream     - return streaming response
     */
    async chat(opts) {
        const model = this.model(opts.model);
        return this._adapter.chat({ ...opts, model });
    }

    /**
     * Shorthand: send a single user message, get text back.
     */
    async ask(prompt, opts = {}) {
        const result = await this.chat({
            model: opts.model || 'default',
            system: opts.system,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: opts.max_tokens || 1000,
        });
        return result.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    }

    /**
     * Cost calculation — returns USD for given token counts.
     */
    costUsd(modelName, inputTokens, outputTokens) {
        const resolved = this.model(modelName);
        const p = PRICING[resolved] || PRICING.default;
        return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
    }

    supportsTools() { return this._adapter.supportsTools(); }
    supportsStreaming() { return this._adapter.supportsStreaming(); }

    getInfo() {
        return {
            provider: this.provider,
            models: this._aliases,
            supportsTools: this.supportsTools(),
            supportsStreaming: this.supportsStreaming(),
        };
    }
}

module.exports = new LLMClient();
