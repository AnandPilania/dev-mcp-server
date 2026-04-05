'use strict';
/**
 * Git worktrees let you check out a branch into a separate directory,
 * letting agents work on risky changes without touching your main working tree.
 *
 * Workflow:
 *   1. create(branch, path)   → checkout branch in isolated dir
 *   2. run agents with cwd = worktree path
 *   3. diff(name)             → see what changed
 *   4. merge(name)            → merge back to current branch
 *   5. remove(name)           → clean up
 */

const { execSync } = require('child_process');
const { promisify } = require('util');
const { exec } = require('child_process');
const execAsync = promisify(exec);
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const META_FILE = path.join(process.cwd(), 'data', 'worktrees.json');

const run = async (cmd, cwd) => {
    const { stdout, stderr } = await execAsync(cmd, { cwd: cwd || process.cwd(), timeout: 30000 });
    return (stdout || '').trim();
};

class WorktreeManager {
    constructor() {
        this._worktrees = this._load();
    }

    _load() {
        try { if (fs.existsSync(META_FILE)) return JSON.parse(fs.readFileSync(META_FILE, 'utf-8')); } catch { }
        return {};
    }
    _save() { fs.writeFileSync(META_FILE, JSON.stringify(this._worktrees, null, 2)); }

    /**
     * Create a new worktree from a branch (creates branch if it doesn't exist)
     */
    async create(name, branch, opts = {}) {
        const { cwd = process.cwd(), createBranch = true } = opts;

        if (this._worktrees[name]) throw new Error(`Worktree "${name}" already exists`);

        const worktreePath = path.join(os_tmpdir(), 'mcp-worktrees', name);
        fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

        // Check if branch exists
        const branchExists = await run(`git branch --list "${branch}"`, cwd);
        let addCmd;
        if (!branchExists && createBranch) {
            addCmd = `git worktree add -b "${branch}" "${worktreePath}"`;
        } else {
            addCmd = `git worktree add "${worktreePath}" "${branch}"`;
        }

        logger.info(`[Worktree] Creating: ${name} → ${worktreePath} (${branch})`);
        await run(addCmd, cwd);

        const entry = {
            name,
            branch,
            path: worktreePath,
            sourceCwd: cwd,
            createdAt: new Date().toISOString(),
            status: 'active',
        };
        this._worktrees[name] = entry;
        this._save();

        return entry;
    }

    /**
     * List all worktrees
     */
    async list(cwd = process.cwd()) {
        // Merge local metadata with git's actual worktree list
        let gitList = [];
        try {
            const out = await run('git worktree list --porcelain', cwd);
            const entries = out.split('\n\n').filter(Boolean);
            gitList = entries.map(e => {
                const lines = e.split('\n');
                const p = lines.find(l => l.startsWith('worktree '))?.slice(9);
                const b = lines.find(l => l.startsWith('branch '))?.slice(7);
                return { path: p, branch: b };
            });
        } catch { }

        return Object.values(this._worktrees).map(wt => ({
            ...wt,
            exists: fs.existsSync(wt.path),
            gitTracked: gitList.some(g => g.path === wt.path),
        }));
    }

    /**
     * Get a worktree by name
     */
    get(name) {
        return this._worktrees[name] || null;
    }

    /**
     * Show diff between worktree and its base branch
     */
    async diff(name) {
        const wt = this._worktrees[name];
        if (!wt) throw new Error(`Worktree not found: ${name}`);
        const diff = await run('git diff HEAD', wt.path);
        const status = await run('git status --short', wt.path);
        return { name, branch: wt.branch, diff, status, path: wt.path };
    }

    /**
     * Get the git log for a worktree (commits made in it)
     */
    async log(name, limit = 5) {
        const wt = this._worktrees[name];
        if (!wt) throw new Error(`Worktree not found: ${name}`);
        return run(`git log --oneline -${limit}`, wt.path);
    }

    /**
     * Remove a worktree (prune from git + delete dir)
     */
    async remove(name, opts = {}) {
        const { force = false } = opts;
        const wt = this._worktrees[name];
        if (!wt) throw new Error(`Worktree not found: ${name}`);

        logger.info(`[Worktree] Removing: ${name}`);

        try {
            const forceFlag = force ? '--force' : '';
            await run(`git worktree remove ${forceFlag} "${wt.path}"`, wt.sourceCwd);
        } catch (e) {
            if (force && fs.existsSync(wt.path)) {
                fs.rmSync(wt.path, { recursive: true, force: true });
            }
        }

        // Clean up branch if it was auto-created and not merged
        delete this._worktrees[name];
        this._save();

        return { success: true, name, path: wt.path };
    }

    /**
     * Stage and commit all changes in a worktree
     */
    async commit(name, message) {
        const wt = this._worktrees[name];
        if (!wt) throw new Error(`Worktree not found: ${name}`);
        await run('git add .', wt.path);
        const result = await run(`git commit -m "${message || 'MCP agent changes'}"`, wt.path);
        return { name, result };
    }

    getStats() {
        const wts = Object.values(this._worktrees);
        return { total: wts.length, active: wts.filter(w => fs.existsSync(w.path)).length };
    }
}

// Simple os tmpdir helper
function os_tmpdir() {
    return require('os').tmpdir();
}

module.exports = new WorktreeManager();
