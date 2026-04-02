# 🧠 Dev MCP Server — Model Context Platform

> AI that understands **your** codebase, not just the internet.

Inspired by the article *"How I Built an MCP Server That Made Developers Faster and Work Easier"* — this is a full implementation of the **Model Context Platform** concept: instead of generic AI answers, every response is grounded in your actual code, error logs, API behavior, and bug history.

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
- Your API behavior — including weird edge cases
- How your modules connect to each other

---

## The 3 Core Queries

Straight from the article — the three questions developers ask every single day:

| Query | Endpoint | Example |
|-------|----------|---------|
| 🐛 **Why is this failing?** | `POST /api/query/debug` | `"Why is ClassCastException thrown in UserService?"` |
| 🔍 **Where is this used?** | `POST /api/query/usage` | `"Where is getUserById called?"` |
| 💥 **If I change this, what breaks?** | `POST /api/query/impact` | `"If I change the User model, what breaks?"` |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Dev MCP Server                        │
│                                                          │
│  ┌──────────┐    ┌──────────┐    ┌──────────────────┐   │
│  │ Ingester │───▶│  Store   │───▶│     Indexer      │   │
│  │          │    │ (JSON)   │    │  (TF-IDF Search) │   │
│  └──────────┘    └──────────┘    └──────────────────┘   │
│       │                                   │              │
│       ▼                                   ▼              │
│  ┌──────────┐                  ┌─────────────────────┐  │
│  │   CLI    │                  │    Query Engine      │  │
│  │  (REPL)  │                  │  (Retrieval + Claude)│  │
│  └──────────┘                  └─────────────────────┘  │
│                                          │               │
│                                          ▼               │
│                                  ┌──────────────┐        │
│                                  │ Express REST │        │
│                                  │     API      │        │
│                                  └──────────────┘        │
└─────────────────────────────────────────────────────────┘
```

**How it works:**
1. **Ingest** — Feed your codebase into the system (files, directories, raw logs)
2. **Index** — TF-IDF search index built over all chunks
3. **Query** — Question arrives → relevant context retrieved → Claude answers based on *your* code

---

## Quick Start

### 1. Install
```bash
git clone <repo>
cd dev-mcp-server
npm install
cp .env.example .env
# Add your ANTHROPIC_API_KEY to .env
```

### 2. Ingest your codebase
```bash
# Ingest a whole project directory
node cli.js ingest ./src

# Ingest a single file
node cli.js ingest ./services/UserService.js

# Try with the included samples
node cli.js ingest ./samples
```

### 3. Ask questions
```bash
# Interactive REPL (best experience)
node cli.js query -i

# Single question
node cli.js query "Why is ClassCastException happening in UserService?"

# Debug shorthand
node cli.js debug "ClassCastException" --stack "at UserService.getUserById:45"

# Check stats
node cli.js stats
```

### 4. Or use the REST API
```bash
npm start
# Server runs at http://localhost:3000
```

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
# General question (auto-detects debug/usage/impact mode)
curl -X POST http://localhost:3000/api/query \
  -H "Content-Type: application/json" \
  -d '{"question": "Why does getUserById sometimes throw ClassCastException?"}'

# Debug mode (why is this failing?)
curl -X POST http://localhost:3000/api/query/debug \
  -H "Content-Type: application/json" \
  -d '{"error": "ClassCastException", "stackTrace": "at UserService.getUserById:45"}'

# Usage search (where is this used?)
curl -X POST http://localhost:3000/api/query/usage \
  -H "Content-Type: application/json" \
  -d '{"symbol": "getUserById"}'

# Impact analysis (what breaks if I change this?)
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
# Stats
curl http://localhost:3000/api/knowledge/stats

# Raw search (no AI, just retrieval)
curl "http://localhost:3000/api/knowledge/search?q=ClassCastException&topK=5"

# List all ingested files
curl http://localhost:3000/api/knowledge/files

# Force rebuild index
curl -X POST http://localhost:3000/api/knowledge/rebuild

# Clear everything
curl -X DELETE http://localhost:3000/api/ingest/clear
```

---

## Supported File Types

| Type | Extensions |
|------|-----------|
| Code | `.js` `.ts` `.jsx` `.tsx` `.py` `.java` `.go` `.rb` `.php` `.cs` `.rs` |
| Config | `.json` `.yaml` `.yml` `.env` `.toml` `.xml` |
| Docs | `.md` `.txt` |
| Logs | `.log` |
| Schema | `.sql` `.graphql` `.gql` |
| Scripts | `.sh` `.bash` |

---

## What to Ingest

The article is clear: **ingest real stuff, not clean summaries**.

```bash
# Real code
node cli.js ingest ./src

# Actual error logs (the ugly ones)
node cli.js ingest ./logs

# API responses and config
node cli.js ingest ./config

# Bug fix notes — paste directly
node cli.js query  # then use the REPL to ingest raw text
```

**The key insight from the article:**
> *"Docs lie. Or rather, docs go stale. Code doesn't."*

---

## Lessons From the Article

1. **Don't add too much data** — results get noisy. Ingest what your team actually uses.
2. **Data quality > model quality** — clean, connected context beats a better AI every time.
3. **Solve real problems** — the 3 core queries (debug, usage, impact) cover 90% of daily dev questions.
4. **AI retrieves, not guesses** — the system finds relevant context first, then answers from that.

---

## Project Structure

```
dev-mcp-server/
├── src/
│   ├── api/
│   │   ├── server.js          # Express server
│   │   └── routes/
│   │       ├── ingest.js      # Ingest endpoints
│   │       ├── query.js       # Query endpoints (debug/usage/impact)
│   │       └── knowledge.js   # Knowledge base management
│   ├── core/
│   │   ├── ingester.js        # File & directory ingestion
│   │   ├── indexer.js         # TF-IDF indexer + search
│   │   └── queryEngine.js     # Retrieval + Anthropic Q&A
│   ├── storage/
│   │   └── store.js           # JSON persistence layer
│   └── utils/
│       ├── fileParser.js      # File chunking & metadata extraction
│       └── logger.js          # Winston logger
├── samples/                   # Example files for testing
├── data/                      # Auto-created: stores index.json + meta.json
├── logs/                      # Auto-created: combined.log + error.log
├── cli.js                     # CLI tool
├── .env.example
└── README.md
```
