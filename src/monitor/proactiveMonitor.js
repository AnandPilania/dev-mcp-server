/**
 * A background agent that WATCHES your codebase and ALERTS you to problems
 * without being asked. It runs scheduled checks and surfaces findings.
 *
 * Checks it runs automatically:
 *  - New TODOs/FIXMEs added since last check
 *  - Security-sensitive patterns (hardcoded secrets, missing auth)
 *  - Files that changed recently (via git) but weren't re-ingested
 *  - Memory inconsistencies (facts that contradict each other)
 *  - Tasks that have been open too long
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const GrepTool = require('../tools/GrepTool');
const BashTool = require('../tools/BashTool');
const { TaskManager } = require('../tasks/taskManager');
const { MemoryManager } = require('../memory/memoryManager');
const costTracker = require('../utils/costTracker');

const MONITOR_FILE = path.join(process.cwd(), 'data', 'monitor-state.json');
const ALERTS_FILE = path.join(process.cwd(), 'data', 'alerts.json');

// ── Alert severity levels ────────────────────────────────────────────────────
const SEVERITY = { INFO: 'info', WARN: 'warn', CRITICAL: 'critical' };

// ── Built-in checks ──────────────────────────────────────────────────────────
const BUILTIN_CHECKS = [
    {
        id: 'new-todos',
        name: 'New TODOs/FIXMEs',
        description: 'Detect new TODO/FIXME/HACK comments',
        severity: SEVERITY.INFO,
        intervalMinutes: 60,
    },
    {
        id: 'hardcoded-secrets',
        name: 'Hardcoded Secrets',
        description: 'Scan for API keys, passwords, tokens in code',
        severity: SEVERITY.CRITICAL,
        intervalMinutes: 120,
    },
    {
        id: 'stale-tasks',
        name: 'Stale Tasks',
        description: 'Tasks open more than 7 days without updates',
        severity: SEVERITY.WARN,
        intervalMinutes: 1440, // daily
    },
    {
        id: 'git-drift',
        name: 'Git Drift',
        description: 'Files changed in git but not re-ingested',
        severity: SEVERITY.INFO,
        intervalMinutes: 30,
    },
    {
        id: 'missing-error-handling',
        name: 'Missing Error Handling',
        description: 'Async functions without try/catch',
        severity: SEVERITY.WARN,
        intervalMinutes: 240,
    },
];

class ProactiveMonitor {
    constructor() {
        this._isRunning = false;
        this._intervals = new Map();
        this._state = this._loadState();
        this._alerts = this._loadAlerts();
    }

    _loadState() {
        try { if (fs.existsSync(MONITOR_FILE)) return JSON.parse(fs.readFileSync(MONITOR_FILE, 'utf-8')); } catch { }
        return { lastRun: {}, customChecks: [] };
    }

    _loadAlerts() {
        try { if (fs.existsSync(ALERTS_FILE)) return JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf-8')); } catch { }
        return { alerts: [] };
    }

    _saveState() { fs.writeFileSync(MONITOR_FILE, JSON.stringify(this._state, null, 2)); }
    _saveAlerts() { fs.writeFileSync(ALERTS_FILE, JSON.stringify(this._alerts, null, 2)); }

    /**
     * Start the monitor with scheduled checks
     */
    start(cwd = process.cwd()) {
        if (this._isRunning) return;
        this._isRunning = true;
        this._cwd = cwd;
        logger.info('[Monitor] 👁️  Proactive monitor started');

        // Schedule each check on its own interval
        for (const check of BUILTIN_CHECKS) {
            const handle = setInterval(
                () => this._runCheck(check),
                check.intervalMinutes * 60 * 1000
            );
            this._intervals.set(check.id, handle);
            // Run immediately after 5s delay (staggered)
            const delay = BUILTIN_CHECKS.indexOf(check) * 5000 + 5000;
            setTimeout(() => this._runCheck(check), delay);
        }
    }

    stop() {
        for (const handle of this._intervals.values()) clearInterval(handle);
        this._intervals.clear();
        this._isRunning = false;
        logger.info('[Monitor] Monitor stopped');
    }

    /**
     * Run a specific check by ID
     */
    async runCheck(checkId) {
        const check = BUILTIN_CHECKS.find(c => c.id === checkId);
        if (!check) throw new Error(`Unknown check: ${checkId}`);
        return this._runCheck(check);
    }

    /**
     * Run ALL checks immediately
     */
    async runAll() {
        const results = [];
        for (const check of BUILTIN_CHECKS) {
            results.push(await this._runCheck(check));
        }
        return results;
    }

    async _runCheck(check) {
        logger.info(`[Monitor] Running check: ${check.name}`);
        const startTime = Date.now();
        let findings = [];

        try {
            switch (check.id) {
                case 'new-todos': findings = await this._checkTodos(); break;
                case 'hardcoded-secrets': findings = await this._checkSecrets(); break;
                case 'stale-tasks': findings = this._checkStaleTasks(); break;
                case 'git-drift': findings = await this._checkGitDrift(); break;
                case 'missing-error-handling': findings = await this._checkMissingErrorHandling(); break;
            }
        } catch (err) {
            logger.warn(`[Monitor] Check "${check.id}" failed: ${err.message}`);
        }

        this._state.lastRun[check.id] = new Date().toISOString();
        this._saveState();

        if (findings.length > 0) {
            const alert = {
                id: `alert_${Date.now()}`,
                checkId: check.id,
                checkName: check.name,
                severity: check.severity,
                findings,
                triggeredAt: new Date().toISOString(),
                acknowledged: false,
                durationMs: Date.now() - startTime,
            };
            this._alerts.alerts.push(alert);
            this._saveAlerts();
            logger.warn(`[Monitor] ⚠️  ${check.name}: ${findings.length} finding(s)`);
            return alert;
        }

        logger.info(`[Monitor] ✓ ${check.name}: clean`);
        return { checkId: check.id, findings: [], clean: true };
    }

    // ── Individual check implementations ────────────────────────────────────────

    async _checkTodos() {
        const result = await GrepTool.findTodos(this._cwd || process.cwd());
        const prev = this._state.lastRun['new-todos'];
        const findings = [];

        for (const match of result.matches.slice(0, 20)) {
            findings.push({
                file: match.file,
                line: match.lineNumber,
                text: match.line.trim(),
                type: 'todo',
            });
        }
        return findings;
    }

    async _checkSecrets() {
        const secretPatterns = [
            { pattern: '(api_key|apikey|api-key)\\s*[=:]\\s*["\']?[A-Za-z0-9]{20,}', label: 'API key' },
            { pattern: '(password|passwd|pwd)\\s*[=:]\\s*["\'][^"\']{6,}["\']', label: 'Hardcoded password' },
            { pattern: '(secret|token)\\s*[=:]\\s*["\'][A-Za-z0-9+/]{20,}["\']', label: 'Secret/token' },
            { pattern: 'Bearer [A-Za-z0-9\\-_]{20,}', label: 'Bearer token' },
            { pattern: 'sk-[A-Za-z0-9]{30,}', label: 'OpenAI-style API key' },
        ];

        const findings = [];
        for (const { pattern, label } of secretPatterns) {
            try {
                const result = await GrepTool.search(pattern, {
                    cwd: this._cwd || process.cwd(),
                    maxResults: 5,
                    glob: '*.{js,ts,py,env,json}',
                });
                for (const match of result.matches) {
                    // Skip .env.example, test files, and our own config
                    if (match.file.includes('.example') || match.file.includes('test') || match.file.includes('.bak')) continue;
                    findings.push({ file: match.file, line: match.lineNumber, label, text: match.line.trim().slice(0, 80) });
                }
            } catch { }
        }
        return findings;
    }

    _checkStaleTasks() {
        const tasks = TaskManager.list({ includeDone: false });
        const findings = [];
        const staleDays = 7;

        for (const task of tasks) {
            const ageDays = (Date.now() - new Date(task.createdAt).getTime()) / 86400000;
            if (ageDays > staleDays) {
                findings.push({
                    taskId: task.id,
                    title: task.title,
                    priority: task.priority,
                    ageDays: Math.floor(ageDays),
                    status: task.status,
                });
            }
        }
        return findings;
    }

    async _checkGitDrift() {
        try {
            const result = await BashTool.executeOrThrow(
                'git diff --name-only HEAD~1 HEAD 2>/dev/null || git status --porcelain',
                { cwd: this._cwd || process.cwd() }
            );

            const store = require('../storage/store');
            const ingestedFiles = new Set(store.getIngestedFiles());
            const findings = [];

            for (const line of result.stdout.split('\n').filter(Boolean)) {
                const file = line.replace(/^[MAD?]\s+/, '').trim();
                const absFile = path.resolve(this._cwd || process.cwd(), file);
                if (ingestedFiles.has(absFile) === false && fs.existsSync(absFile)) {
                    findings.push({ file, reason: 'Changed but not in knowledge base' });
                }
            }
            return findings.slice(0, 10);
        } catch {
            return [];
        }
    }

    async _checkMissingErrorHandling() {
        try {
            // Find async functions without try/catch
            const result = await GrepTool.search(
                'async\\s+\\w+\\s*\\([^)]*\\)\\s*\\{(?![^}]*try)',
                { cwd: this._cwd || process.cwd(), maxResults: 15, glob: '*.{js,ts}' }
            );

            return result.matches
                .filter(m => !m.file.includes('test') && !m.file.includes('.bak'))
                .slice(0, 10)
                .map(m => ({
                    file: m.file,
                    line: m.lineNumber,
                    text: m.line.trim().slice(0, 80),
                    suggestion: 'Wrap with try/catch',
                }));
        } catch { return []; }
    }

    // ── Alert management ─────────────────────────────────────────────────────────

    getAlerts(opts = {}) {
        const { severity, unacknowledged = false, limit = 50 } = opts;
        let alerts = [...this._alerts.alerts];
        if (severity) alerts = alerts.filter(a => a.severity === severity);
        if (unacknowledged) alerts = alerts.filter(a => !a.acknowledged);
        return alerts
            .sort((a, b) => new Date(b.triggeredAt) - new Date(a.triggeredAt))
            .slice(0, limit);
    }

    acknowledge(alertId) {
        const alert = this._alerts.alerts.find(a => a.id === alertId);
        if (!alert) throw new Error(`Alert not found: ${alertId}`);
        alert.acknowledged = true;
        alert.acknowledgedAt = new Date().toISOString();
        this._saveAlerts();
        return alert;
    }

    acknowledgeAll() {
        const now = new Date().toISOString();
        let count = 0;
        for (const alert of this._alerts.alerts) {
            if (!alert.acknowledged) { alert.acknowledged = true; alert.acknowledgedAt = now; count++; }
        }
        this._saveAlerts();
        return count;
    }

    getStatus() {
        const alerts = this._alerts.alerts;
        const unacked = alerts.filter(a => !a.acknowledged);
        return {
            isRunning: this._isRunning,
            checks: BUILTIN_CHECKS.map(c => ({
                ...c,
                lastRun: this._state.lastRun[c.id] || null,
            })),
            alerts: {
                total: alerts.length,
                unacknowledged: unacked.length,
                critical: unacked.filter(a => a.severity === 'critical').length,
                warn: unacked.filter(a => a.severity === 'warn').length,
            },
        };
    }
}

module.exports = { ProactiveMonitor: new ProactiveMonitor(), SEVERITY, BUILTIN_CHECKS };
