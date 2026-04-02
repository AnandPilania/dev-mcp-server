# 🧠 Dev MCP Server — Model Context Platform

> AI that understands **your** codebase, not just the internet.

Inspired by *"How I Built an MCP Server That Made Developers Faster and Work Easier"* — a full implementation of the **Model Context Platform** concept: instead of generic AI answers, every response is grounded in your actual code, error logs, API behavior, and bug history.

---

## The Problem It Solves

Every team has this invisible tax:
- Debugging code you didn't write, with zero context
- Explaining things that are already written *somewhere*
- Digging through 10 files to understand one API
- Answering the same question for the third time this week

The root cause isn't bad code. It's a **context problem** — knowledge scattered across services, logs, configs, and people's heads.

---

## What It Does

Before answering any question, the AI looks up your **actual system**. It knows:

- Your data models and DTOs
- Your naming conventions and code patterns
- Your most common bugs and how you fixed them
- Your API behaviour — including weird edge cases
- How your modules connect to each other

---

## The 3 Core Queries

| Query                                | Endpoint                 | Example                                              |
| ------------------------------------ | ------------------------ | ---------------------------------------------------- |
| 🐛 **Why is this failing?**           | `POST /api/query/debug`  | `"Why is ClassCastException thrown in UserService?"` |
| 🔍 **Where is this used?**            | `POST /api/query/usage`  | `"Where is getUserById called?"`                     |
| 💥 **If I change this, what breaks?** | `POST /api/query/impact` | `"If I change the User model, what breaks?"`         |

---

## Quick Start

### Option A — via npx (no install required)

```bash
# In your project root (where your .env lives):
npx dev-mcp-server ingest ./src
npx dev-mcp-server query "Why is getUserById throwing?"
npx dev-mcp-server query -i   # interactive REPL
```

> **Note:** `npx` will look for `.env` in the directory you run the command from,
> so make sure your credentials are there before running.

### Option B — local install

```bash
git clone <repo>
cd dev-mcp-server
npm install
cp .env.example .env
# Edit .env — choose your LLM provider and add credentials
```

```bash
# Ingest your codebase
node cli.js ingest ./src

# Ask questions
node cli.js query -i                          # interactive REPL
node cli.js query "Why is getUserById failing?"
node cli.js debug "ClassCastException" --stack "at UserService:45"
node cli.js stats
```

### Option C — REST API server

```bash
npm start
# Runs at http://localhost:3000
```

---

## LLM Providers

The server supports three backends. Switch between them with a single environment variable — no code changes needed.

### Anthropic (default)

```env
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-your-key-here
LLM_MODEL=claude-opus-4-5          # optional, this is the default
```

### Ollama (local / self-hosted)

Run any model locally — no API key needed.

```bash
# Install Ollama: https://ollama.com
ollama pull llama3      # or mistral, codellama, phi3, etc.
```

```env
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434   # optional, this is the default
LLM_MODEL=llama3                        # optional, this is the default
```

### Azure OpenAI

```env
LLM_PROVIDER=azure
AZURE_OPENAI_ENDPOINT=https://<your-resource>.openai.azure.com
AZURE_OPENAI_API_KEY=your-azure-key-here
AZURE_OPENAI_DEPLOYMENT=gpt-4o          # your deployment name in Azure AI Studio
AZURE_OPENAI_API_VERSION=2024-05-01-preview   # optional, has a sensible default
```

> The deployment name is also used as `LLM_MODEL`. If you want to override the model
> label independently, set `LLM_MODEL` explicitly.

---

## Ingest & Ignore Rules

### Default ignore list

The following patterns are always excluded, regardless of any other configuration:

```
**/node_modules/**    **/.git/**        **/dist/**
**/build/**           **/coverage/**    **/*.min.js
**/package-lock.json  **/yarn.lock
```

### .gitignore integration

By default the server reads the `.gitignore` in the directory being ingested and adds those patterns on top of the baseline. This means anything your team already ignores in git is also ignored during ingestion — no duplicate config.

```env
# Disable .gitignore integration (enabled by default):
INGEST_USE_GITIGNORE=false
```

### Extra ignore patterns

Add any additional glob patterns via a comma-separated env var:

```env
INGEST_EXTRA_IGNORE=**/fixtures/**,**/__snapshots__/**,**/test-data/**
```

All three sources (baseline + `.gitignore` + `INGEST_EXTRA_IGNORE`) are merged and deduplicated before each directory ingest. The log output tells you exactly what was applied:

```
Ignore sources: baseline, .gitignore (12 patterns), INGEST_EXTRA_IGNORE (2 patterns)
```

---

## Configuration Reference

Copy `.env.example` to `.env` and fill in the relevant section for your chosen provider.

| Variable                   | Default                  | Description                                     |
| -------------------------- | ------------------------ | ----------------------------------------------- |
| `LLM_PROVIDER`             | `anthropic`              | LLM backend: `anthropic` \| `ollama` \| `azure` |
| `LLM_MODEL`                | *(per provider)*         | Model or deployment name override               |
| `ANTHROPIC_API_KEY`        | —                        | Required when `LLM_PROVIDER=anthropic`          |
| `OLLAMA_BASE_URL`          | `http://localhost:11434` | Ollama server URL                               |
| `AZURE_OPENAI_ENDPOINT`    | —                        | Required when `LLM_PROVIDER=azure`              |
| `AZURE_OPENAI_API_KEY`     | —                        | Required when `LLM_PROVIDER=azure`              |
| `AZURE_OPENAI_DEPLOYMENT`  | —                        | Required when `LLM_PROVIDER=azure`              |
| `AZURE_OPENAI_API_VERSION` | `2024-05-01-preview`     | Azure API version                               |
| `INGEST_USE_GITIGNORE`     | `true`                   | Read `.gitignore` during ingest                 |
| `INGEST_EXTRA_IGNORE`      | —                        | Comma-separated extra glob patterns to ignore   |
| `PORT`                     | `3000`                   | HTTP server port                                |
| `LOG_LEVEL`                | `info`                   | `error` \| `warn` \| `info` \| `debug`          |

---

## API Reference

### Ingest

```bash
# Ingest a file
curl -X POST http://localhost:3000/api/ingest/file \
  -H "Content-Type: application/json" \
  -d '{"filePath": "./src/services/UserService.js"}'

# Ingest a directory
curl -X POST http://localhost:3000/api/ingest/directory \
  -H "Content-Type: application/json" \
  -d '{"dirPath": "./src"}'

# Ingest raw text (paste an error log, bug description, etc.)
curl -X POST http://localhost:3000/api/ingest/raw \
  -H "Content-Type: application/json" \
  -d '{
    "content": "ClassCastException at UserService line 45: Mongoose doc passed to UserDTO. Fix: call .toObject() first.",
    "kind": "log",
    "label": "production-bug-2024-03-15"
  }'
```

### Query

```bash
# General question — auto-detects debug / usage / impact mode
curl -X POST http://localhost:3000/api/query \
  -H "Content-Type: application/json" \
  -d '{"question": "Why does getUserById sometimes throw ClassCastException?"}'

# Force debug mode
curl -X POST http://localhost:3000/api/query/debug \
  -H "Content-Type: application/json" \
  -d '{"error": "ClassCastException", "stackTrace": "at UserService.getUserById:45"}'

# Usage search
curl -X POST http://localhost:3000/api/query/usage \
  -H "Content-Type: application/json" \
  -d '{"symbol": "getUserById"}'

# Impact analysis
curl -X POST http://localhost:3000/api/query/impact \
  -H "Content-Type: application/json" \
  -d '{"target": "UserDTO", "changeDescription": "add a new required field"}'

# Streaming (Server-Sent Events)
curl -X POST http://localhost:3000/api/query/stream \
  -H "Content-Type: application/json" \
  -d '{"question": "How does user status update work end to end?"}'
```

### Knowledge Base

```bash
curl http://localhost:3000/api/knowledge/stats
curl "http://localhost:3000/api/knowledge/search?q=ClassCastException&topK=5"
curl http://localhost:3000/api/knowledge/files
curl -X POST http://localhost:3000/api/knowledge/rebuild
curl -X DELETE http://localhost:3000/api/ingest/clear
```

---

## Supported File Types

| Category | Extensions                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------ |
| Code     | `.js` `.ts` `.jsx` `.tsx` `.mjs` `.cjs` `.py` `.java` `.go` `.rb` `.php` `.cs` `.cpp` `.c` `.rs` |
| Config   | `.json` `.yaml` `.yml` `.env` `.toml` `.xml`                                                     |
| Docs     | `.md` `.txt`                                                                                     |
| Logs     | `.log`                                                                                           |
| Schema   | `.sql` `.graphql` `.gql`                                                                         |
| Scripts  | `.sh` `.bash`                                                                                    |

---

## What to Ingest

The key insight: **ingest real stuff, not clean summaries**.

```bash
node cli.js ingest ./src          # actual source code
node cli.js ingest ./logs         # real error logs — the ugly ones
node cli.js ingest ./config       # environment configs and schemas
node cli.js ingest ./docs         # ADRs, runbooks, onboarding notes
```

Paste knowledge directly in the interactive REPL:

```
❯ node cli.js query -i
❯ We fixed a bug last week where the Mongoose document wasn't being converted
  to a plain object before passing to UserDTO. Always call .toObject() first.
```

> *"Docs lie. Or rather, docs go stale. Code doesn't."*

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Dev MCP Server                                  │
│                                                                      │
│  ┌──────────┐    ┌──────────┐    ┌────────────────────────┐  │
│  │ Ingester  │───▶│  Store    │──▶│        Indexer             │  │
│  │           │     │ (JSON)    │    │   (TF-IDF Search)          │  │
│  └──────────┘    └──────────┘    └────────────────────────┘  │
│       │                                      │               │
│       ▼                                      ▼               │
│  ┌──────────┐                  ┌───────────────────────────┐ │
│  │   CLI     │                  │       Query Engine        │ │
│  │  (REPL)   │                  │  Retrieval + LLM Client   │ │
│  └──────────┘                  └───────────────────────────┘ │
│                                              │                │
│                                             ┌┴──────────────┐│
│                                             │  Anthropic /  ││
│                                             │  Ollama /     ││
│                                             │  Azure OpenAI ││
│                                             └───────────────┘│
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                    Express REST API                     │  │
│  └────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**How it works:**
1. **Ingest** — Feed your codebase in (files, directories, raw text)
2. **Index** — TF-IDF search index built over all chunks
3. **Query** — Question arrives → relevant context retrieved → LLM answers based on *your* code

---

## Key Design Decisions

**Data quality beats model quality.** The retrieval step (TF-IDF over your actual files) matters more than which AI model you use. A focused, well-curated knowledge base with a smaller model will outperform a bloated one with GPT-4.

**No embeddings, no vector DB.** TF-IDF is deterministic, fast, and requires zero infrastructure. For most codebases (< 50k files) it's entirely sufficient.

**Provider-agnostic by design.** The `llmClient` abstraction means you can switch from Anthropic to a local Ollama model to Azure OpenAI by changing one line in `.env` — useful for cost control, data residency requirements, or offline usage.

**Ingest real artefacts.** Error logs, not summaries of error logs. Actual API responses, not docs about API responses. The messier the better — the system is built to handle it.
