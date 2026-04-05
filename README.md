# 🧠 Dev MCP Server — Model Context Platform v1.0

> **45 tools · 10 specialist agents · 10 pre-built teams · Dreamer · Compactor · Prompt Engineering · Plugins · Cron · Worktrees**
>
> An AI system that understands your codebase, learns from every interaction, dreams while you sleep, and coordinates teams of specialist agents — all grounded in your *actual* code, not generic knowledge.

**Inspired by:**
- *"How I Built an MCP Server That Made Developers Faster"* — the original RAG-over-codebase concept
- **Claude Code** — 40+ tools, agent teams, coordinator, dreamer, context engineering, pipelines, plugins, worktrees, cron, prompt engineering

---

## Why This Exists

Every dev team pays an invisible tax:
- Debugging code you didn't write, with zero context
- Junior devs waiting on seniors for answers buried somewhere in the codebase
- AI that gives generic answers to specific, system-level problems
- Knowledge that lives in someone's head and dies when they leave

**The root cause isn't bad code. It's scattered context.**

Dev MCP Server fixes this by giving your AI permanent, growing knowledge of your actual system — then making it smarter over time, automatically.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Dev MCP Server  v1.0                                  │
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                       INGESTION LAYER                                │    │
│  │  Files/Dirs/Raw → FileParser → Chunker → Store → TF-IDF Indexer     │    │
│  │  FileWatcher (live re-ingest on change)                              │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                   ↓                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    CONTEXT ENGINEERING LAYER                         │    │
│  │  ContextEngineer (budget/priority/rank) + Compactor (sliding window) │    │
│  │  MemoryManager (persistent facts) + Improver (usage feedback)        │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                   ↓                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                      45-TOOL REGISTRY                                │    │
│  │  bash · file_read/write/edit/delete · grep · git_* · http_request   │    │
│  │  json_query/transform · regex_test · crypto_hash · datetime          │    │
│  │  run_tests · lint · api_test · mock_generate · code_complexity       │    │
│  │  docker · system_info · log_analyze · dependency_analysis            │    │
│  │  generate_diagram · kb_search · memory_search · think · + 20 more   │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                   ↓                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                       AGENT LAYER                                    │    │
│  │                                                                       │    │
│  │  ┌─────────────────────────────────────────────────────────────┐    │    │
│  │  │  10 Specialist Agents (real tool-use loop)         │    │    │
│  │  │  Debug · Arch · Security · Docs · Refactor · Perf            │    │    │
│  │  │  Test · DevOps · Data · Planner                              │    │    │
│  │  └─────────────────────────────────────────────────────────────┘    │    │
│  │  ┌─────────────────────────────────────────────────────────────┐    │    │
│  │  │  ORCHESTRATION                                               │    │    │
│  │  │  TaskDecomposer → subtasks → specialist routing              │    │    │
│  │  │  TeamCoordinator → 10 named teams → consolidated report     │    │    │
│  │  │  PipelineEngine → 6 multi-step resilient workflows           │    │    │
│  │  │  Inter-Agent Messaging → agents send messages to each other  │    │    │
│  │  └─────────────────────────────────────────────────────────────┘    │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                   ↓                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │               BACKGROUND INTELLIGENCE                                │    │
│  │  Dreamer (5 phases) · Improver · Cron Scheduler                      │    │
│  │  Proactive Monitor (5 checks) · Team Memory Sync                     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                   ↓                                          │
│  ┌──────────────┐ ┌──────────────┐ ┌────────────┐ ┌───────────────────┐   │
│  │  REST API    │ │  CLI (REPL)  │ │  Dashboard  │ │   Plugin System   │   │
│  │  40+ routes  │ │  /commands   │ │  /dashboard │ │  user extensions  │   │
│  └──────────────┘ └──────────────┘ └────────────┘ └───────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```
---

## Quick Start

### Option A — via npx (no install required)

Run the server or query your codebase immediately without cloning the repo.

```bash
# In your project root (where your .env lives):
npx dev-mcp-server ingest ./src
npx dev-mcp-server query "Why is getUserById throwing?"
npx dev-mcp-server query -i   # Start the interactive REPL
npx dev-mcp-server start # WebUI dashboard
```
**Note:** npx will look for .env in the directory you run the command from,
so make sure your credentials are there before running.

---

### Option B - Local Install (Full Platform)

Recommended for using the Dashboard, Specialist Agents, and Dreamer background tasks.
```bash
git clone <repo>
cd dev-mcp-server
npm install
cp .env.example .env        # Add your LLM provider details

# Ingest your codebase
node cli.js ingest ./src

# Start interactive REPL (recommended)
node cli.js query -i

# Or start the REST API + Dashboard
npm start
open http://localhost:3000/dashboard
```

---

## The 45-Tool Registry

Every tool has an compatible `tool_use` schema. Agents invoke them natively in the real API loop.

| Group              | Tools                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| **execution**      | `bash`                                                                                                  |
| **files**          | `file_read`, `file_write`, `file_edit` (str_replace), `file_delete`, `dir_list`                         |
| **search**         | `grep` (ripgrep + fallback), `find_files`                                                               |
| **git**            | `git_status`, `git_diff`, `git_log`, `git_commit` (AI message), `git_branches`                          |
| **network**        | `http_request`, `network_check` (ping/port/dns)                                                         |
| **data**           | `json_query`, `json_transform`, `regex_test`, `crypto_hash`, `datetime`, `schema_validate`, `text_diff` |
| **config**         | `env_read` (masks secrets)                                                                              |
| **package**        | `npm_info` (list/outdated/audit)                                                                        |
| **testing**        | `run_tests` (Jest/Mocha), `lint` (ESLint), `api_test` (curl), `mock_generate`                           |
| **code-quality**   | `format_code` (Prettier), `code_complexity`                                                             |
| **analysis**       | `log_analyze`, `dependency_analysis` (circular/unused/vulns)                                            |
| **docs**           | `generate_diagram` (Mermaid), `generate_changelog` (from git)                                           |
| **infrastructure** | `docker` (ps/logs/exec/inspect)                                                                         |
| **system**         | `system_info`, `process_info`                                                                           |
| **ai**             | `token_count`, `think` (CoT scratchpad), `run_skill`                                                    |
| **knowledge**      | `kb_search`, `memory_search`                                                                            |
| **tasks**          | `task_manage`                                                                                           |
| **navigation**     | `symbol_navigate` (definition/references/outline)                                                       |
| **control**        | `sleep`                                                                                                 |

```bash
# Execute any tool directly
curl -X POST http://localhost:3000/api/registry/execute \
  -d '{"tool": "code_complexity", "input": {"path": "./src/services"}}'

# List all tools
curl http://localhost:3000/api/registry
```

---

## 10 Specialist Agents

Each agent runs the **real tool-use loop** — it can call any of its assigned tools multiple times, chain tool calls, and reason between steps.

| Agent                | Tools Available                                                                      | Specialty                        |
| -------------------- | ------------------------------------------------------------------------------------ | -------------------------------- |
| `DebugAgent`         | bash, file_read, grep, kb_search, git_diff, log_analyze, think...                    | Root cause analysis, exact fixes |
| `ArchitectureAgent`  | file_read, dir_list, grep, generate_diagram, code_complexity, dependency_analysis... | Module coupling, design review   |
| `SecurityAgent`      | bash, grep, api_test, env_read, regex_test, log_analyze...                           | OWASP audit, vuln scanning       |
| `DocumentationAgent` | file_read, kb_search, symbol_navigate, generate_diagram, generate_changelog...       | JSDoc, READMEs, API docs         |
| `RefactorAgent`      | file_read, file_edit, grep, code_complexity, lint, format_code, text_diff...         | Duplication, readability         |
| `PerformanceAgent`   | file_read, grep, log_analyze, system_info, run_tests, bash...                        | N+1 queries, memory leaks        |
| `TestAgent`          | file_read, file_write, run_tests, grep, mock_generate, symbol_navigate...            | Test writing and coverage        |
| `DevOpsAgent`        | bash, docker, system_info, process_info, network_check, env_read...                  | CI/CD, Docker, infra             |
| `DataAgent`          | json_query, json_transform, schema_validate, grep, regex_test, mock_generate...      | Schemas, data pipelines          |
| `PlannerAgent`       | kb_search, memory_search, task_manage, git_log, generate_diagram, think...           | Task breakdown, planning         |

```bash
# Run any agent
curl -X POST http://localhost:3000/api/agents/SecurityAgent \
  -d '{"task": "Audit the auth module for vulnerabilities"}'

# Decompose a complex task across multiple agents
curl -X POST http://localhost:3000/api/agents/decompose/run \
  -d '{"task": "Audit payment module for security issues, perf problems, and missing docs", "parallel": false}'
```

---

## 10 Pre-Built Teams

Teams run **sequentially** — each agent sees what the previous found and builds on it.

| Team             | Agents                            | Use Case                          |
| ---------------- | --------------------------------- | --------------------------------- |
| `full-audit`     | Security + Perf + Refactor + Docs | Complete codebase health check    |
| `feature-review` | Arch + Security + Test + Docs     | Review before merging             |
| `bug-triage`     | Debug + Perf + Docs               | Triage a production bug           |
| `onboarding`     | Arch + Docs + Debug + Planner     | New developer getting up to speed |
| `refactor-safe`  | Arch + Refactor + Test + Security | Safe, verified refactoring        |
| `release-prep`   | Docs + Security + Test + DevOps   | Pre-release checklist             |
| `data-audit`     | Data + Security + Perf            | Data layer audit                  |
| `ci-setup`       | DevOps + Test + Security          | Fix or set up CI/CD               |
| `post-mortem`    | Debug + Perf + Planner + Docs     | Incident post-mortem              |
| `greenfield`     | Arch + Security + Planner + Test  | Plan a new feature/service        |

```bash
# Run a named team
curl -X POST http://localhost:3000/api/agents/teams/post-mortem \
  -d '{"task": "Production outage last night — getUserById returning null"}'

# Auto-select the best team
curl -X POST http://localhost:3000/api/agents/teams/auto \
  -d '{"task": "Prepare the v1.0 release"}'
```

---

## 6 Pre-Built Pipelines

Multi-step workflows where each step feeds the next. Resilient — a failing step doesn't stop the pipeline.

| Pipeline                    | Steps                                             | Use Case             |
| --------------------------- | ------------------------------------------------- | -------------------- |
| `debug-pipeline`            | retrieve → debug → create-tasks → save-memory     | Debug + action items |
| `security-audit-pipeline`   | retrieve → architecture → security → create-tasks | Full security scan   |
| `onboarding-pipeline`       | retrieve → architecture → docs → grep-todos       | New dev onboarding   |
| `feature-planning-pipeline` | retrieve → decompose → plan → create-tasks        | Plan a feature       |
| `code-review-pipeline`      | retrieve → git-review → security → save-memory    | Code review          |
| `impact-analysis-pipeline`  | retrieve → architecture → debug → plan → tasks    | Change impact        |

```bash
curl -X POST http://localhost:3000/api/pipelines/security-audit-pipeline \
  -d '{"task": "Audit the API layer"}'
```

---

## The Dreamer — 5-Phase Background Intelligence

Runs every 30 minutes automatically. No commands needed.

| Phase               | What it does                                       |
| ------------------- | -------------------------------------------------- |
| **Consolidate**     | Merges duplicate memories, resolves contradictions |
| **Patterns**        | Scans codebase for conventions, anti-patterns      |
| **Suggestions**     | Generates proactive improvements nobody asked for  |
| **Knowledge Graph** | Connects related facts across memories             |
| **Prune**           | Removes stale/unused memories older than 30 days   |

```bash
# Check what the dreamer found
curl http://localhost:3000/api/agents/dreamer/status

# Trigger immediately
curl -X POST http://localhost:3000/api/agents/dreamer/now
```

---

## Context Compactor

Sliding-window compaction keeps conversations fresh without hitting token limits.

- **Window**: keeps last 6 messages verbatim (always fresh)
- **Body**: older messages → compressed summary
- **Multi-tier**: if the summary itself is too long, compress it again
- **Importance scoring**: tool results and key decisions weighted higher

```bash
# Check if a conversation needs compaction
curl -X POST http://localhost:3000/api/compact/check \
  -d '{"messages": [...]}'

# Compact
curl -X POST http://localhost:3000/api/compact/compact \
  -d '{"messages": [...], "sessionId": "my-session"}'

# Deep compact (compress the summary too)
curl -X POST http://localhost:3000/api/compact/deep-compact \
  -d '{"messages": [...]}'
```

---

## Prompt Engineering System

8 built-in templates + analyse/improve/generate/A-B test any prompt.

| Template              | Description                                      |
| --------------------- | ------------------------------------------------ |
| `chain-of-thought`    | Step-by-step reasoning before answering          |
| `role-expert`         | Frame as domain expert with 20+ years experience |
| `few-shot`            | Provide examples before the actual task          |
| `structured-output`   | Force JSON output with a schema                  |
| `critique-and-revise` | Self-critique and improve an answer              |
| `least-to-most`       | Break into simpler sub-problems first            |
| `react-agent`         | ReAct (Reason + Act) prompting pattern           |
| `socratic`            | Lead to the answer through questions             |

```bash
# Analyse a prompt for weaknesses
curl -X POST http://localhost:3000/api/prompts/analyse \
  -d '{"prompt": "Tell me about authentication"}'

# Auto-improve a prompt
curl -X POST http://localhost:3000/api/prompts/improve \
  -d '{"prompt": "Tell me about authentication", "goal": "security audit context"}'

# Apply a template
curl -X POST http://localhost:3000/api/prompts/apply \
  -d '{"template": "chain-of-thought", "variables": {"prompt": "Why is getUserById slow?"}}'

# A/B test two prompts
curl -X POST http://localhost:3000/api/prompts/ab-test \
  -d '{"promptA": "...", "promptB": "...", "testInput": "..."}'

# Inject chain-of-thought into any prompt
curl -X POST http://localhost:3000/api/prompts/cot \
  -d '{"prompt": "Debug this error", "style": "detailed"}'
```

---

## 8 Built-In Skills

Named, reusable prompt workflows. Run with one command.

| Skill                | What it does                                     |
| -------------------- | ------------------------------------------------ |
| `add-error-handling` | Wrap async code in try/catch with proper logging |
| `document-function`  | Generate complete JSDoc with examples            |
| `check-security`     | OWASP-style targeted security audit              |
| `explain-flow`       | Trace full execution flow of a function          |
| `find-similar`       | Find duplicate/similar logic in the codebase     |
| `write-tests`        | Generate Jest unit tests with mocks              |
| `performance-audit`  | Find N+1 queries, memory leaks, blocking I/O     |
| `migration-plan`     | Step-by-step safe migration plan                 |

```bash
node cli.js query -i
❯ /skill run write-tests getUserById
❯ /skill run check-security AuthController.js
❯ /skill run add-error-handling UserService.js
```

---

## Plugin System

Extend the system with custom plugins — add tools, agents, routes, or startup hooks.

```javascript
// plugins/my-plugin.js
module.exports = {
  name: 'my-plugin',
  version: '1.0.0',
  async register(app, { toolRegistry, agentRegistry }) {
    // Add a custom tool
    toolRegistry.addTool({
      schema: { name: 'my_tool', description: '...', input_schema: { ... } },
      execute: async (input) => 'result',
    });
    // Add a custom route
    app.get('/api/my-plugin/hello', (req, res) => res.json({ hello: 'world' }));
  },
};
```

```bash
# List installed plugins
curl http://localhost:3000/api/plugins

# Enable/disable a plugin
curl -X POST http://localhost:3000/api/plugins/my-plugin/enable
```

---

## Worktree Manager

Git worktree isolation for safe experimentation. Run agents on a branch without touching your working tree.

```bash
# Create an isolated worktree for a risky refactor
curl -X POST http://localhost:3000/api/worktrees \
  -d '{"branch": "refactor/auth-system", "path": "/tmp/worktrees/auth"}'

# Run an agent in the worktree (safe, isolated)
curl -X POST http://localhost:3000/api/agents/RefactorAgent \
  -d '{"task": "Refactor auth module", "cwd": "/tmp/worktrees/auth"}'

# Delete when done
curl -X DELETE http://localhost:3000/api/worktrees/auth
```

---

## Cron Scheduler

Schedule agent tasks to run automatically — daily security scans, weekly audits, etc.

```bash
# Schedule a daily security check at 9am
curl -X POST http://localhost:3000/api/cron \
  -d '{"name": "daily-security", "schedule": "0 9 * * *", "task": "Security audit of auth module", "agent": "SecurityAgent"}'

# List all scheduled jobs
curl http://localhost:3000/api/cron

# Trigger manually
curl -X POST http://localhost:3000/api/cron/daily-security/run
```

---

## Team Memory Sync

Shared memory store that all agents on a team can read and write — knowledge that persists across sessions and users.

```bash
# Write to team memory
curl -X POST http://localhost:3000/api/team-memory \
  -d '{"team": "backend", "content": "UserService.getUserById has a known ClassCastException bug", "type": "bug"}'

# All agents automatically read team memory on queries
# Or read it explicitly
curl "http://localhost:3000/api/team-memory?team=backend"
```

---

## Inter-Agent Messaging

Agents can send structured messages to each other during complex workflows.

```bash
# Send a message from one agent to another
curl -X POST http://localhost:3000/api/messages \
  -d '{"from": "DebugAgent", "to": "SecurityAgent", "content": "Found ClassCastException — check if it exposes user data", "priority": "high"}'

# An agent reads its inbox
curl "http://localhost:3000/api/messages/inbox/SecurityAgent"
```

---

## Context Visualizer

See exactly what's in the context window for any query — which chunks were selected, their scores, token budget used.

```bash
curl -X POST http://localhost:3000/api/context/visualize \
  -d '{"query": "Why is getUserById failing?", "mode": "debug"}'
# Returns: { chunks, budgetUsed, dropped, engineeredScores, memoryContext }
```

---

## 3 Core Queries (the original concept)

```bash
# 🐛 Why is this failing?
node cli.js query "Why is ClassCastException happening in UserService?"

# 🔍 Where is this used?
node cli.js query "Where is getUserById called across the codebase?"

# 💥 What breaks if I change this?
node cli.js query "If I change the UserDTO schema, what breaks?"
```

---

## CLI Commands

```bash
node cli.js ingest <path>           # Ingest a file or directory
node cli.js query -i                # Interactive REPL (recommended)
node cli.js query "question"        # Single query
node cli.js debug "error message"   # Quick debug
node cli.js plan "task"             # Generate execution plan
node cli.js git <commit|review|diff|log>
node cli.js grep <pattern>          # Search codebase
node cli.js tasks [list|add|done]
node cli.js memory [list|add|stats|clear]
node cli.js sessions [list|export]
node cli.js doctor                  # Environment health check
node cli.js stats                   # System overview
node cli.js cost                    # Token usage & cost
node cli.js clear                   # Reset knowledge base
```

### REPL slash commands

```
/plan <task>           Generate execution plan
/git                   Git status
/git commit            AI-generated commit message
/git review            AI code review
/agent <name> <task>   Run a specialist agent
/team <name> <task>    Run an agent team
/skill run <name> <target>
/grep <pattern>        Search codebase
/lsp <symbol>          Go to definition
/memory                Show memories
/memory add <text>     Add memory manually
/compact               Compress conversation history
/cost                  Token usage & cost
/doctor                Environment health
/help                  Show all commands
/exit                  Save & exit
```

---

## Complete REST API

```
# Core
GET  /health                          # System health + KB stats
GET  /dashboard                       # Web UI
GET  /                                # API map

# Ingest
POST /api/ingest/file                 # { filePath }
POST /api/ingest/directory            # { dirPath }
POST /api/ingest/raw                  # { content, kind, label }
DELETE /api/ingest/clear

# Query (auto-detects debug/usage/impact mode)
POST /api/query                       # { question, mode?, topK? }
POST /api/query/debug                 # { error, stackTrace? }
POST /api/query/usage                 # { symbol }
POST /api/query/impact                # { target, changeDescription? }
POST /api/query/stream                # SSE streaming

# Multi-turn Conversation
POST /api/chat                        # { message, convId? }
POST /api/chat/follow-up              # { message, convId }
GET  /api/chat                        # list conversations
DELETE /api/chat/:id

# Knowledge Base
GET  /api/knowledge/stats
GET  /api/knowledge/search?q=<query>
GET  /api/knowledge/files
POST /api/knowledge/rebuild

# Tools Registry
GET  /api/registry                    # list all 45 tools
GET  /api/registry/groups
POST /api/registry/execute            # { tool, input }

# Agents (10 specialists)
GET  /api/agents                      # list agents + stats
POST /api/agents/:name                # { task }
POST /api/agents/:name/reset
POST /api/agents/decompose/run        # { task, parallel? }
POST /api/agents/decompose/plan

# Teams (10 teams)
GET  /api/agents/teams/list
POST /api/agents/teams/:name          # { task }
POST /api/agents/teams/auto           # { task }
POST /api/agents/teams/custom         # { agents[], task }

# Dreamer
GET  /api/agents/dreamer/status
POST /api/agents/dreamer/now
POST /api/agents/dreamer/start        # { intervalMinutes? }
POST /api/agents/dreamer/stop

# Improver
GET  /api/agents/improver/summary
POST /api/agents/improver/feedback    # { queryId, rating, comment? }

# Pipelines
GET  /api/pipelines
POST /api/pipelines/:name             # { task }
POST /api/pipelines/custom/run        # { steps[], task }

# Skills
GET  /api/skills
POST /api/skills/:name                # { target }
POST /api/skills                      # create custom skill
DELETE /api/skills/:name

# Prompt Engineering
GET  /api/prompts/templates
POST /api/prompts/analyse             # { prompt }
POST /api/prompts/improve             # { prompt, goal? }
POST /api/prompts/generate            # { task }
POST /api/prompts/ab-test             # { promptA, promptB, testInput }
POST /api/prompts/apply               # { template, variables }
POST /api/prompts/cot                 # { prompt, style? }

# Context
POST /api/compact/compact             # { messages[] }
POST /api/compact/deep-compact
POST /api/compact/check               # { messages[] }
POST /api/context/visualize           # { query, mode? }

# Git
GET  /api/git/status
GET  /api/git/diff
POST /api/git/commit
POST /api/git/review
GET  /api/git/log
GET  /api/git/branches

# LSP / Symbol Navigation
GET  /api/lsp/definition/:symbol
GET  /api/lsp/references/:symbol
POST /api/lsp/hover                   # { symbol, filePath? }
GET  /api/lsp/outline?path=<file>
GET  /api/lsp/symbols?q=<query>
POST /api/lsp/rename                  # { oldName, newName }

# File Operations
GET  /api/files/read?path=<file>
POST /api/files/str-replace           # { filePath, old_str, new_str }
POST /api/files/insert-after          # { filePath, afterStr, insertText }
POST /api/files/rewrite               # { filePath, content }
POST /api/files/ai-edit               # { filePath, instruction }
POST /api/files/undo                  # { filePath }

# Shell
POST /api/tools/bash                  # { command, approved? }
POST /api/tools/bash/permit           # { command, level }
GET  /api/tools/grep?pattern=<p>
GET  /api/tools/grep/definitions/:sym
GET  /api/tools/grep/imports/:mod
GET  /api/tools/grep/todos

# Memory
GET  /api/memory
POST /api/memory                      # { content, type, tags? }
DELETE /api/memory/:id
DELETE /api/memory

# Team Memory
GET  /api/team-memory?team=<name>
POST /api/team-memory                 # { team, content, type }
DELETE /api/team-memory/:id

# Tasks
GET  /api/tasks
POST /api/tasks                       # { title, priority }
PATCH /api/tasks/:id
POST /api/tasks/:id/notes
DELETE /api/tasks/:id

# Sessions
GET  /api/sessions
POST /api/sessions
GET  /api/sessions/:id
GET  /api/sessions/:id/export
DELETE /api/sessions/:id

# Planner
POST /api/plan                        # { task }
POST /api/plan/compact                # { messages[] }
GET  /api/plan/doctor
GET  /api/cost?sessionId=<id>

# Monitor
GET  /api/monitor/status
GET  /api/monitor/alerts
POST /api/monitor/run-all
POST /api/monitor/run/:checkId
POST /api/monitor/alerts/:id/acknowledge
POST /api/monitor/acknowledge-all

# Plugins
GET  /api/plugins
POST /api/plugins/:name/enable
POST /api/plugins/:name/disable

# Worktrees
GET  /api/worktrees
POST /api/worktrees                   # { branch, path }
DELETE /api/worktrees/:name

# Cron
GET  /api/cron
POST /api/cron                        # { name, schedule, task, agent }
POST /api/cron/:name/run
DELETE /api/cron/:name

# Inter-Agent Messaging
POST /api/messages                    # { from, to, content, priority }
GET  /api/messages/inbox/:agent
POST /api/messages/:id/read

# Watcher
GET  /api/watcher/status
POST /api/watcher/watch               # { path }
POST /api/watcher/unwatch             # { path }
```

---

## Key Design Principles

1. **AI retrieves, never guesses** — every answer is grounded in your actual code
2. **Context is a budget** — spend tokens on the highest-signal information only
3. **Agents specialise** — 10 experts beat one generalist
4. **Teams think sequentially** — each agent builds on what the previous found
5. **Pipelines are resilient** — a failing step doesn't kill the workflow
6. **Dreaming consolidates knowledge** — 5-phase improvement without prompting
7. **Memory is the nervous system** — every interaction makes the system smarter
8. **Feedback closes the loop** — the improver learns what works and what doesn't
9. **Tools are first-class** — 45 typed tools with real Anthropic `tool_use` integration
10. **Prompts are engineered** — analyse, improve, template, and A/B test every prompt

---

## Environment Variables

```env
ANTHROPIC_API_KEY=sk-ant-...        # Required
PORT=3000                            # Server port (default 3000)
API_KEY=your-secret-key             # Optional: protect API with auth
ENABLE_DREAMER=true                  # Auto-start dreamer (default true)
DREAM_INTERVAL_MINUTES=30           # Dream frequency (default 30)
ENABLE_MONITOR=true                  # Auto-start monitor (default true)
LOG_LEVEL=info                       # Logging level
```

---

## Supported File Types for Ingestion

`.js` `.ts` `.jsx` `.tsx` `.py` `.java` `.go` `.rb` `.php` `.cs` `.rs` `.cpp` `.c` — Code
`.json` `.yaml` `.yml` `.env` `.toml` `.xml` — Config
`.md` `.txt` — Documentation
`.log` — Error logs
`.sql` `.graphql` `.gql` — Schema
`.sh` `.bash` — Scripts
