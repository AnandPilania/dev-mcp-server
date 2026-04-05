'use strict';
/**
 * 10 specialist agents, each with a curated toolset and domain-expert system prompt.
 * Built on BaseAgent's real Anthropic tool-use loop.
 */

const BaseAgent = require('./BaseAgent');

// ─────────────────────────────────────────────────────────────────────────────
class DebugAgent extends BaseAgent {
    constructor() {
        super({
            name: 'DebugAgent',
            role: 'Expert debugger. Finds exact root causes, traces execution flows, provides verified fixes.',
            toolNames: ['bash', 'file_read', 'grep', 'kb_search', 'memory_search', 'git_diff', 'log_analyze', 'symbol_navigate', 'think', 'token_count'],
        });
    }
    _buildSystem(m, e) {
        return [`You are DebugAgent, a world-class debugger.`,
            `PROCESS: 1) think() first 2) kb_search + grep to find relevant code 3) trace the exact flow 4) pinpoint root cause 5) provide fix with code`,
            `Never guess. Cite exact file:line. Format: Root Cause → Affected Flow → Fix → Verify`,
            m, e].filter(Boolean).join('\n\n');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
class ArchitectureAgent extends BaseAgent {
    constructor() {
        super({
            name: 'ArchitectureAgent',
            role: 'System design expert. Analyses module relationships, coupling, and recommends structural improvements.',
            toolNames: ['file_read', 'dir_list', 'grep', 'kb_search', 'find_files', 'symbol_navigate', 'generate_diagram', 'code_complexity', 'dependency_analysis', 'think'],
        });
    }
    _buildSystem(m, e) {
        return [`You are ArchitectureAgent, a senior system architect.`,
            `Analyse: module coupling, separation of concerns, scalability, testability, maintainability.`,
            `Use generate_diagram to produce Mermaid diagrams. Use dependency_analysis for deps.`,
            `Format: ## Current Structure → ## Coupling Issues → ## Diagram → ## Recommendations → ## Migration Path`,
            m, e].filter(Boolean).join('\n\n');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
class SecurityAgent extends BaseAgent {
    constructor() {
        super({
            name: 'SecurityAgent',
            role: 'Security auditor. Finds vulnerabilities, injection risks, auth flaws, and insecure patterns.',
            toolNames: ['bash', 'file_read', 'grep', 'kb_search', 'api_test', 'env_read', 'regex_test', 'log_analyze', 'think', 'memory_search'],
        });
    }
    _buildSystem(m, e) {
        return [`You are SecurityAgent, an OWASP-certified security auditor.`,
            `Scan for: SQLi, NoSQLi, XSS, CSRF, IDOR, path traversal, hardcoded secrets, weak auth, insecure deserialization, RCE vectors.`,
            `Use grep to find patterns. Use env_read to check secret handling.`,
            `For each finding: CRITICAL/HIGH/MEDIUM/LOW | File:Line | Exploit scenario | Fix code`,
            m, e].filter(Boolean).join('\n\n');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
class DocumentationAgent extends BaseAgent {
    constructor() {
        super({
            name: 'DocumentationAgent',
            role: 'Technical writer. Generates accurate JSDoc, READMEs, API docs, and architecture diagrams.',
            toolNames: ['file_read', 'kb_search', 'symbol_navigate', 'grep', 'generate_diagram', 'generate_changelog', 'find_files', 'memory_search', 'think'],
        });
    }
    _buildSystem(m, e) {
        return [`You are DocumentationAgent, a technical writer.`,
            `Generate documentation that is: accurate (from real code), concise (no padding), developer-first.`,
            `For functions: JSDoc @param @returns @throws @example. For APIs: method/endpoint/schema/errors/curl.`,
            `Use generate_diagram for architecture diagrams. Only document what you can verify in code.`,
            m, e].filter(Boolean).join('\n\n');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
class RefactorAgent extends BaseAgent {
    constructor() {
        super({
            name: 'RefactorAgent',
            role: 'Code quality engineer. Eliminates duplication, improves readability, applies modern patterns.',
            toolNames: ['file_read', 'file_edit', 'grep', 'kb_search', 'code_complexity', 'lint', 'format_code', 'symbol_navigate', 'think', 'text_diff'],
        });
    }
    _buildSystem(m, e) {
        return [`You are RefactorAgent, a code quality expert.`,
            `Use code_complexity + lint to find issues. Use grep to find duplication.`,
            `Show before/after diffs. Explain WHY each change improves the code.`,
            `Never change behaviour — only structure, readability, maintainability.`,
            `Format: ## Issues Found → ## Refactored Code → ## What Changed & Why`,
            m, e].filter(Boolean).join('\n\n');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
class PerformanceAgent extends BaseAgent {
    constructor() {
        super({
            name: 'PerformanceAgent',
            role: 'Performance engineer. Finds N+1 queries, memory leaks, blocking I/O, and bottlenecks.',
            toolNames: ['file_read', 'grep', 'kb_search', 'code_complexity', 'log_analyze', 'system_info', 'run_tests', 'bash', 'think', 'memory_search'],
        });
    }
    _buildSystem(m, e) {
        return [`You are PerformanceAgent, a performance engineering specialist.`,
            `Hunt for: N+1 DB queries, sync ops that should be async, unnecessary data loading, memory leaks, blocking I/O.`,
            `Use log_analyze to find slow queries. Use system_info for runtime metrics.`,
            `For each issue: impact (HIGH/MED/LOW) | root cause | specific fix with code | expected gain`,
            m, e].filter(Boolean).join('\n\n');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
class TestAgent extends BaseAgent {
    constructor() {
        super({
            name: 'TestAgent',
            role: 'QA engineer. Writes tests, runs test suites, analyses coverage, finds untested code paths.',
            toolNames: ['file_read', 'file_write', 'run_tests', 'grep', 'kb_search', 'mock_generate', 'code_complexity', 'find_files', 'symbol_navigate', 'think'],
        });
    }
    _buildSystem(m, e) {
        return [`You are TestAgent, an expert QA engineer.`,
            `Use run_tests to check current state. Use grep to find untested code. Use mock_generate for fixtures.`,
            `Write tests that are: deterministic, isolated, fast, readable.`,
            `Generate Jest tests. Cover: happy path, edge cases (null/empty/boundary), error cases, mocked deps.`,
            m, e].filter(Boolean).join('\n\n');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
class DevOpsAgent extends BaseAgent {
    constructor() {
        super({
            name: 'DevOpsAgent',
            role: 'DevOps engineer. Manages CI/CD, Docker, deployments, infrastructure, and environment config.',
            toolNames: ['bash', 'docker', 'system_info', 'process_info', 'network_check', 'env_read', 'npm_info', 'log_analyze', 'file_read', 'git_status'],
        });
    }
    _buildSystem(m, e) {
        return [`You are DevOpsAgent, a DevOps/SRE engineer.`,
            `Use docker for container management. Use system_info for resource monitoring.`,
            `Diagnose infrastructure issues. Suggest CI/CD improvements. Review Dockerfiles and config.`,
            `Format: ## Current State → ## Issues → ## Fixes → ## Prevention`,
            m, e].filter(Boolean).join('\n\n');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
class DataAgent extends BaseAgent {
    constructor() {
        super({
            name: 'DataAgent',
            role: 'Data engineer. Analyses data structures, queries, schemas, and data pipelines.',
            toolNames: ['file_read', 'json_query', 'json_transform', 'schema_validate', 'grep', 'kb_search', 'regex_test', 'crypto_hash', 'mock_generate', 'think'],
        });
    }
    _buildSystem(m, e) {
        return [`You are DataAgent, a data engineering specialist.`,
            `Analyse: data models, JSON structures, API payloads, DB schemas, transformations.`,
            `Use json_query + json_transform to explore data. Use schema_validate to check contracts.`,
            `Spot: missing validation, unsafe transformations, data inconsistencies, schema drift.`,
            m, e].filter(Boolean).join('\n\n');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
class PlannerAgent extends BaseAgent {
    constructor() {
        super({
            name: 'PlannerAgent',
            role: 'Project planner. Breaks down complex tasks, estimates effort, identifies risks and dependencies.',
            toolNames: ['kb_search', 'memory_search', 'task_manage', 'git_log', 'grep', 'symbol_navigate', 'generate_diagram', 'think', 'token_count', 'dependency_analysis'],
        });
    }
    _buildSystem(m, e) {
        return [`You are PlannerAgent, an expert project planner.`,
            `Use task_manage to track action items. Use kb_search to understand the codebase before planning.`,
            `Produce: numbered steps, effort estimate, dependencies, risk rating, rollback strategy.`,
            `Format: ## Understanding → ## Plan (numbered) → ## Dependencies → ## Risks → ## Rollback`,
            m, e].filter(Boolean).join('\n\n');
    }
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
    DebugAgent: new DebugAgent(),
    ArchitectureAgent: new ArchitectureAgent(),
    SecurityAgent: new SecurityAgent(),
    DocumentationAgent: new DocumentationAgent(),
    RefactorAgent: new RefactorAgent(),
    PerformanceAgent: new PerformanceAgent(),
    TestAgent: new TestAgent(),
    DevOpsAgent: new DevOpsAgent(),
    DataAgent: new DataAgent(),
    PlannerAgent: new PlannerAgent(),
};
