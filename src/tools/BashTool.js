/**
 * BashTool — executes shell commands with a permission model.
 * Supports: allow-once, allow-session, deny, auto-approve safe commands.
 */

const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

// Commands that are always safe to run without asking
const SAFE_COMMANDS = new Set([
    'ls', 'pwd', 'echo', 'cat', 'head', 'tail', 'wc', 'grep', 'find',
    'git status', 'git log', 'git diff', 'git branch', 'git show',
    'node --version', 'npm list', 'npm outdated', 'npx --version',
    'which', 'env', 'printenv', 'date', 'uname', 'whoami', 'hostname',
]);

// Commands that are always dangerous — never auto-approve
const DANGEROUS_PATTERNS = [
    /rm\s+-rf?\s+\//,
    /sudo\s+rm/,
    />\s*\/dev\/(sd|hd|nvme)/,
    /mkfs\./,
    /dd\s+if=/,
    /chmod\s+-R\s+777\s+\//,
    /curl.*(sh|bash)\s*\|.*sh/,
    /wget.*(sh|bash)\s*\|.*sh/,
    /:(){ :|:& };:/,   // fork bomb
];

const PERMISSION_FILE = path.join(process.cwd(), 'data', 'bash-permissions.json');

class BashTool {
    constructor() {
        this._sessionPermissions = new Map(); // command -> 'allow' | 'deny'
        this._loadPersisted();
    }

    _loadPersisted() {
        try {
            if (fs.existsSync(PERMISSION_FILE)) {
                const data = JSON.parse(fs.readFileSync(PERMISSION_FILE, 'utf-8'));
                // Only load 'always-allow' entries (not session ones)
                for (const [cmd, perm] of Object.entries(data.alwaysAllow || {})) {
                    this._sessionPermissions.set(cmd, 'allow');
                }
            }
        } catch { }
    }

    _savePersisted() {
        const alwaysAllow = {};
        for (const [cmd, perm] of this._sessionPermissions.entries()) {
            if (perm === 'allow-always') alwaysAllow[cmd] = true;
        }
        fs.writeFileSync(PERMISSION_FILE, JSON.stringify({ alwaysAllow }, null, 2));
    }

    /**
     * Check permission level for a command.
     * Returns: 'auto-safe' | 'session-allowed' | 'needs-approval' | 'dangerous'
     */
    checkPermission(command) {
        const cmd = command.trim();

        // Check dangerous patterns first
        for (const pattern of DANGEROUS_PATTERNS) {
            if (pattern.test(cmd)) return 'dangerous';
        }

        // Check if first token is a safe command
        const firstToken = cmd.split(/\s+/)[0];
        if (SAFE_COMMANDS.has(firstToken) || SAFE_COMMANDS.has(cmd.slice(0, 20))) {
            return 'auto-safe';
        }

        // Check session/persisted permissions
        if (this._sessionPermissions.has(cmd)) {
            return 'session-allowed';
        }

        return 'needs-approval';
    }

    /**
     * Grant permission for a command (session or always)
     */
    grantPermission(command, level = 'session') {
        if (level === 'always') {
            this._sessionPermissions.set(command.trim(), 'allow-always');
            this._savePersisted();
        } else {
            this._sessionPermissions.set(command.trim(), 'allow');
        }
    }

    /**
     * Execute a command and return { stdout, stderr, exitCode, durationMs }
     */
    async execute(command, options = {}) {
        const { cwd = process.cwd(), timeout = 30000, env = {} } = options;

        const permission = this.checkPermission(command);

        if (permission === 'dangerous') {
            throw new Error(`⛔ Dangerous command blocked: ${command}`);
        }

        if (permission === 'needs-approval' && !options.approved) {
            return {
                needsApproval: true,
                command,
                permission,
                message: `Command requires approval: ${command}`,
            };
        }

        const start = Date.now();
        logger.info(`[BashTool] exec: ${command.slice(0, 100)}`);

        return new Promise((resolve) => {
            exec(command, {
                cwd,
                timeout,
                env: { ...process.env, ...env },
                maxBuffer: 10 * 1024 * 1024, // 10MB
            }, (error, stdout, stderr) => {
                const durationMs = Date.now() - start;
                resolve({
                    stdout: stdout || '',
                    stderr: stderr || '',
                    exitCode: error ? (error.code || 1) : 0,
                    durationMs,
                    command,
                    timedOut: error?.killed || false,
                });
            });
        });
    }

    /**
     * Execute and throw if non-zero exit
     */
    async executeOrThrow(command, options = {}) {
        const result = await this.execute(command, { ...options, approved: true });
        if (result.exitCode !== 0) {
            throw new Error(`Command failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
        }
        return result;
    }
}

module.exports = new BashTool();
