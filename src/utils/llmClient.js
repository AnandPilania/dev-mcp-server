'use strict';


const PROVIDER = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase();

const DEFAULT_MODELS = {
    anthropic: 'claude-opus-4-5',
    ollama: 'llama3',
    azure: '',
};

function resolveModel() {
    if (PROVIDER === 'azure') {
        return (
            process.env.LLM_MODEL ||
            process.env.AZURE_OPENAI_DEPLOYMENT ||
            (() => { throw new Error('Azure OpenAI requires AZURE_OPENAI_DEPLOYMENT (or LLM_MODEL) to be set.'); })()
        );
    }
    return process.env.LLM_MODEL || DEFAULT_MODELS[PROVIDER] || DEFAULT_MODELS.anthropic;
}

function buildAnthropicClient() {
    const Anthropic = require('@anthropic-ai/sdk');
    if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error('ANTHROPIC_API_KEY is not set. Add it to your .env file.');
    }
    return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

async function anthropicCreate({ model, maxTokens, system, messages, stream }) {
    const client = buildAnthropicClient();
    return client.messages.create({ model, max_tokens: maxTokens, system, messages, stream });
}

function ollamaBaseUrl() {
    return (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
}

async function ollamaCreate({ model, maxTokens, system, messages, stream }) {
    const url = `${ollamaBaseUrl()}/api/chat`;
    const ollamaMessages = [{ role: 'system', content: system }, ...messages];

    const body = JSON.stringify({
        model,
        messages: ollamaMessages,
        stream: Boolean(stream),
        options: { num_predict: maxTokens },
    });

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
    });

    if (!res.ok) {
        const detail = await res.text().catch(() => '(no body)');
        throw new Error(`Ollama request failed [${res.status}]: ${detail}`);
    }

    if (!stream) {
        const data = await res.json();
        return {
            content: [{ text: data.message?.content ?? '' }],
            usage: {
                input_tokens: data.prompt_eval_count ?? 0,
                output_tokens: data.eval_count ?? 0,
            },
        };
    }

    return ollamaStream(res);
}

async function* ollamaStream(res) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let stopped = false;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                let obj;
                try { obj = JSON.parse(trimmed); } catch (_) { continue; }

                if (obj.message?.content) {
                    yield { type: 'content_block_delta', delta: { type: 'text_delta', text: obj.message.content } };
                }
                if (obj.done && !stopped) {
                    stopped = true;
                    yield { type: 'message_stop' };
                }
            }
        }
    } finally {
        reader.releaseLock();
    }
    if (!stopped) yield { type: 'message_stop' };
}

function buildAzureClient() {
    let AzureOpenAI;
    try {
        ({ AzureOpenAI } = require('openai'));
    } catch (_) {
        throw new Error(
            'The "openai" package is required for Azure OpenAI.\n' +
            'Run: npm install openai'
        );
    }

    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;

    if (!apiKey) throw new Error('AZURE_OPENAI_API_KEY is not set.');
    if (!endpoint) throw new Error('AZURE_OPENAI_ENDPOINT is not set. Example: https://<resource>.openai.azure.com');

    return new AzureOpenAI({
        apiKey,
        endpoint,
        apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-05-01-preview',
    });
}

async function azureCreate({ model, maxTokens, system, messages, stream }) {
    const client = buildAzureClient();

    const azureMessages = [{ role: 'system', content: system }, ...messages];

    const params = {
        model,
        messages: azureMessages,
        max_tokens: maxTokens,
        stream: Boolean(stream),
    };

    if (!stream) {
        const response = await client.chat.completions.create(params);
        return {
            content: [{ text: response.choices[0]?.message?.content ?? '' }],
            usage: {
                input_tokens: response.usage?.prompt_tokens ?? 0,
                output_tokens: response.usage?.completion_tokens ?? 0,
            },
        };
    }

    const azureStream = await client.chat.completions.create(params);
    return azureStreamToEvents(azureStream);
}

async function* azureStreamToEvents(azureStream) {
    let stopped = false;

    for await (const chunk of azureStream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
            yield { type: 'content_block_delta', delta: { type: 'text_delta', text: delta } };
        }
        if (chunk.choices[0]?.finish_reason && !stopped) {
            stopped = true;
            yield { type: 'message_stop' };
        }
    }
    if (!stopped) yield { type: 'message_stop' };
}

const llmClient = {
    provider: PROVIDER,
    model: resolveModel(),

    async createMessage({ maxTokens = 2000, system, messages, stream = false }) {
        const model = this.model;

        switch (PROVIDER) {
            case 'anthropic':
                return anthropicCreate({ model, maxTokens, system, messages, stream });
            case 'ollama':
                return ollamaCreate({ model, maxTokens, system, messages, stream });
            case 'azure':
                return azureCreate({ model, maxTokens, system, messages, stream });
            default:
                throw new Error(
                    `Unknown LLM_PROVIDER: "${PROVIDER}". ` +
                    'Supported values: "anthropic", "ollama", "azure".'
                );
        }
    },

    label() {
        return `${PROVIDER}/${this.model}`;
    },
};

module.exports = llmClient;
