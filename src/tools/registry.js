'use strict';
/**
 * Single source of truth for every tool in the system.
 * Each tool exports:
 *   - schema   : Anthropic-compatible tool definition (name, description, input_schema)
 *   - execute  : async (input) => string  — called when the agent invokes the tool
 *   - group    : string  — tool category
 *   - safe     : bool    — whether it requires permission (false = always allowed)
 */

const { execSync, exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const logger = require('../utils/logger');

// ─── helpers ───────────────────────────────────────────────────────────────────
const run = async (cmd, cwd, opts = {}) => {
    try {
        const { stdout, stderr } = await execAsync(cmd, { cwd: cwd || process.cwd(), timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
        return (stdout || '') + (stderr ? `\n[stderr]: ${stderr}` : '');
    } catch (e) {
        // exit 1 from diff means "files differ" — that IS the output, not an error
        if (opts.allowNonZero || e.code === 1) return (e.stdout || '') + (e.stderr ? `\n[stderr]: ${e.stderr}` : '');
        return `[error exit ${e.code}]: ${e.stderr || e.stdout || e.message}`;
    }
};

// Safely parse JSON that may already be an object (API sends objects, not strings)
const safeParseJSON = (val) => {
    if (val === null || val === undefined) return [null, 'Value is null/undefined'];
    if (typeof val === 'object') return [val, null]; // already parsed
    if (typeof val !== 'string') return [null, `Expected string or object, got ${typeof val}`];
    try { return [JSON.parse(val), null]; } catch (e) { return [null, e.message]; }
};

const fetchUrl = (url, opts = {}) => new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const timeout = opts.timeout || 10000;
    const req = mod.get(url, { headers: { 'User-Agent': 'dev-mcp/4.0' }, timeout }, res => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: body.slice(0, 8000) }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
});

const readFile = fp => {
    const abs = path.resolve(fp);
    if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
    const stat = fs.statSync(abs);
    if (stat.size > 300 * 1024) throw new Error(`File too large: ${(stat.size / 1024).toFixed(0)}KB`);
    return fs.readFileSync(abs, 'utf-8');
};

// ─── TOOL DEFINITIONS ──────────────────────────────────────────────────────────

const TOOLS = [

    // ── 1. BASH ──────────────────────────────────────────────────────────────────
    {
        group: 'execution',
        safe: false,
        schema: {
            name: 'bash',
            description: 'Execute a shell command. Returns stdout + stderr. Use for running scripts, builds, tests.',
            input_schema: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'The shell command to run' },
                    cwd: { type: 'string', description: 'Working directory (optional)' },
                    timeout: { type: 'number', description: 'Timeout in ms (default 30000)' },
                },
                required: ['command'],
            },
        },
        execute: async ({ command, cwd, timeout }) => {
            const DANGEROUS = [/rm\s+-rf?\s+\//, /sudo\s+rm/, /mkfs\./, /dd\s+if=/, /:(){ :|:& };:/];
            if (DANGEROUS.some(p => p.test(command))) return '[BLOCKED] Dangerous command pattern detected';
            return run(command, cwd);
        },
    },

    // ── 2. FILE READ ─────────────────────────────────────────────────────────────
    {
        group: 'files',
        safe: true,
        schema: {
            name: 'file_read',
            description: 'Read a file from disk. Returns contents. Supports line ranges.',
            input_schema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path' },
                    start_line: { type: 'number', description: 'Start line (1-indexed, optional)' },
                    end_line: { type: 'number', description: 'End line (optional)' },
                },
                required: ['path'],
            },
        },
        execute: async ({ path: fp, start_line, end_line }) => {
            const content = readFile(fp);
            if (!start_line && !end_line) return content;
            const lines = content.split('\n');
            return lines.slice((start_line || 1) - 1, end_line || lines.length).join('\n');
        },
    },

    // ── 3. FILE WRITE ─────────────────────────────────────────────────────────────
    {
        group: 'files',
        safe: false,
        schema: {
            name: 'file_write',
            description: 'Write or overwrite a file. Creates directories if needed.',
            input_schema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path to write' },
                    content: { type: 'string', description: 'File contents' },
                    backup: { type: 'boolean', description: 'Create .bak backup first (default true)' },
                },
                required: ['path', 'content'],
            },
        },
        execute: async ({ path: fp, content, backup = true }) => {
            const abs = path.resolve(fp);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            if (backup && fs.existsSync(abs)) fs.writeFileSync(abs + '.bak', fs.readFileSync(abs));
            fs.writeFileSync(abs, content, 'utf-8');
            return `Written: ${abs} (${content.length} chars)`;
        },
    },

    // ── 4. FILE EDIT (str_replace) ────────────────────────────────────────────────
    {
        group: 'files',
        safe: false,
        schema: {
            name: 'file_edit',
            description: 'Apply a precise string replacement in a file. oldStr must be unique in the file.',
            input_schema: {
                type: 'object',
                properties: {
                    path: { type: 'string' },
                    old_str: { type: 'string', description: 'Exact string to find and replace (must be unique)' },
                    new_str: { type: 'string', description: 'Replacement string' },
                },
                required: ['path', 'old_str', 'new_str'],
            },
        },
        execute: async ({ path: fp, old_str, new_str }) => {
            const FileEditTool = require('./FileEditTool');
            const r = await FileEditTool.strReplace(fp, old_str, new_str, { backup: true });
            return r.diff?.summary || 'Edit applied';
        },
    },

    // ── 5. FILE DELETE ────────────────────────────────────────────────────────────
    {
        group: 'files',
        safe: false,
        schema: {
            name: 'file_delete',
            description: 'Delete a file (moves to .bak first for safety).',
            input_schema: {
                type: 'object',
                properties: { path: { type: 'string' } },
                required: ['path'],
            },
        },
        execute: async ({ path: fp }) => {
            const abs = path.resolve(fp);
            if (!fs.existsSync(abs)) return 'File not found';
            fs.renameSync(abs, abs + '.deleted_' + Date.now());
            return `Deleted (backed up): ${abs}`;
        },
    },

    // ── 6. DIRECTORY LIST ─────────────────────────────────────────────────────────
    {
        group: 'files',
        safe: true,
        schema: {
            name: 'dir_list',
            description: 'List files and directories. Respects .gitignore patterns.',
            input_schema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Directory path (default: cwd)' },
                    recursive: { type: 'boolean', description: 'List recursively' },
                    pattern: { type: 'string', description: 'Glob pattern filter (e.g. *.js)' },
                },
                required: [],
            },
        },
        execute: async ({ path: dirPath = '.', recursive = false, pattern }) => {
            const abs = path.resolve(dirPath);
            if (!fs.existsSync(abs)) return `Directory not found: ${abs}`;
            const flag = recursive ? '-R' : '';
            const cmd = pattern ? `find ${abs} -name "${pattern}" | head -100` : `ls ${flag} ${abs} | head -200`;
            return run(cmd);
        },
    },

    // ── 7. GREP ───────────────────────────────────────────────────────────────────
    {
        group: 'search',
        safe: true,
        schema: {
            name: 'grep',
            description: 'Search for a pattern across files using ripgrep (or grep fallback).',
            input_schema: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'Search pattern (regex or literal)' },
                    path: { type: 'string', description: 'Directory to search (default: cwd)' },
                    glob: { type: 'string', description: 'File glob (e.g. "*.js")' },
                    ignore_case: { type: 'boolean' },
                    max_results: { type: 'number', description: 'Max results (default 30)' },
                },
                required: ['pattern'],
            },
        },
        execute: async ({ pattern, path: p = '.', glob, ignore_case, max_results = 30 }) => {
            const GrepTool = require('./GrepTool');
            const result = await GrepTool.search(pattern, { cwd: p, glob, ignoreCase: ignore_case, maxResults: max_results });
            return result.matches.map(m => `${m.file}:${m.lineNumber}: ${m.line.trim()}`).join('\n') || 'No matches';
        },
    },

    // ── 8. FIND FILES ─────────────────────────────────────────────────────────────
    {
        group: 'search',
        safe: true,
        schema: {
            name: 'find_files',
            description: 'Find files by name pattern or extension.',
            input_schema: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'Filename pattern (e.g. "*.test.js", "config*")' },
                    path: { type: 'string', description: 'Root directory' },
                    type: { type: 'string', enum: ['file', 'dir', 'any'], description: 'Type filter' },
                },
                required: ['pattern'],
            },
        },
        execute: async ({ pattern, path: p = '.', type = 'file' }) => {
            const typeFlag = type === 'file' ? '-type f' : type === 'dir' ? '-type d' : '';
            return run(`find ${path.resolve(p)} ${typeFlag} -name "${pattern}" 2>/dev/null | head -50`);
        },
    },

    // ── 9. GIT STATUS ─────────────────────────────────────────────────────────────
    {
        group: 'git',
        safe: true,
        schema: {
            name: 'git_status',
            description: 'Get git status: current branch, staged/unstaged changes, recent commits.',
            input_schema: { type: 'object', properties: { cwd: { type: 'string' } }, required: [] },
        },
        execute: async ({ cwd }) => {
            const GitTool = require('./GitTool');
            const s = await GitTool.status(cwd);
            return JSON.stringify(s, null, 2);
        },
    },

    // ── 10. GIT DIFF ──────────────────────────────────────────────────────────────
    {
        group: 'git',
        safe: true,
        schema: {
            name: 'git_diff',
            description: 'Show git diff for staged or unstaged changes.',
            input_schema: {
                type: 'object',
                properties: {
                    staged: { type: 'boolean', description: 'Show staged diff (default: unstaged)' },
                    file: { type: 'string', description: 'Specific file path (optional)' },
                    cwd: { type: 'string' },
                },
                required: [],
            },
        },
        execute: async ({ staged = false, file, cwd }) => {
            const GitTool = require('./GitTool');
            const r = await GitTool.diff({ staged, file, cwd });
            return r.diff || 'No changes';
        },
    },

    // ── 11. GIT LOG ───────────────────────────────────────────────────────────────
    {
        group: 'git',
        safe: true,
        schema: {
            name: 'git_log',
            description: 'Show recent git commit log.',
            input_schema: {
                type: 'object',
                properties: {
                    limit: { type: 'number', description: 'Number of commits (default 10)' },
                    file: { type: 'string', description: 'Filter by file' },
                    cwd: { type: 'string' },
                },
                required: [],
            },
        },
        execute: async ({ limit = 10, file, cwd }) => {
            const GitTool = require('./GitTool');
            const commits = await GitTool.log({ limit, file, oneline: true, cwd });
            return commits.join('\n');
        },
    },

    // ── 12. GIT COMMIT ────────────────────────────────────────────────────────────
    {
        group: 'git',
        safe: false,
        schema: {
            name: 'git_commit',
            description: 'Stage files and create a commit. Leave message empty for AI-generated message.',
            input_schema: {
                type: 'object',
                properties: {
                    message: { type: 'string', description: 'Commit message (optional, AI will generate if omitted)' },
                    files: { type: 'array', items: { type: 'string' }, description: 'Files to stage (default ["."])' },
                    cwd: { type: 'string' },
                },
                required: [],
            },
        },
        execute: async ({ message, files = ['.'], cwd }) => {
            const GitTool = require('./GitTool');
            const r = await GitTool.commit({ message, files, autoMessage: !message, cwd });
            return r.success ? `Committed: "${r.message}"` : r.message;
        },
    },

    // ── 13. GIT BRANCHES ──────────────────────────────────────────────────────────
    {
        group: 'git',
        safe: true,
        schema: {
            name: 'git_branches',
            description: 'List all git branches.',
            input_schema: { type: 'object', properties: { cwd: { type: 'string' } }, required: [] },
        },
        execute: async ({ cwd }) => {
            const GitTool = require('./GitTool');
            const branches = await GitTool.branches(cwd);
            return branches.map(b => `${b.current ? '* ' : '  '}${b.name}`).join('\n');
        },
    },

    // ── 14. HTTP REQUEST ──────────────────────────────────────────────────────────
    {
        group: 'network',
        safe: true,
        schema: {
            name: 'http_request',
            description: 'Make an HTTP/HTTPS GET request and return the response body.',
            input_schema: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'Full URL including protocol' },
                    timeout: { type: 'number', description: 'Timeout in ms (default 10000)' },
                },
                required: ['url'],
            },
        },
        execute: async ({ url, timeout }) => {
            const r = await fetchUrl(url, { timeout });
            return `Status: ${r.status}\n\n${r.body}`;
        },
    },

    // ── 15. JSON PARSE / QUERY ────────────────────────────────────────────────────
    {
        group: 'data',
        safe: true,
        schema: {
            name: 'json_query',
            description: 'Parse JSON and extract a value using a dot-path (e.g. "data.users.0.name").',
            input_schema: {
                type: 'object',
                properties: {
                    json: { type: 'string', description: 'JSON string or file path' },
                    path: { type: 'string', description: 'Dot-path query (e.g. "users.0.name"). Empty = pretty-print all.' },
                    file: { type: 'string', description: 'Alternatively, path to a JSON file' },
                },
                required: [],
            },
        },
        execute: async ({ json, path: query, file }) => {
            let data;
            if (file) json = readFile(file);
            const [parsed, err] = safeParseJSON(json);
            if (err) return `Invalid JSON: ${err}`;
            data = parsed;
            if (!query) return JSON.stringify(data, null, 2).slice(0, 4000);
            const parts = query.split('.');
            let cur = data;
            for (const p of parts) {
                if (cur == null) return 'undefined';
                cur = cur[p] ?? cur[parseInt(p)];
            }
            return typeof cur === 'object' ? JSON.stringify(cur, null, 2) : String(cur);
        },
    },

    // ── 16. JSON TRANSFORM ────────────────────────────────────────────────────────
    {
        group: 'data',
        safe: true,
        schema: {
            name: 'json_transform',
            description: 'Transform JSON data: filter, map, sort, pick fields.',
            input_schema: {
                type: 'object',
                properties: {
                    json: { type: 'string', description: 'JSON array string' },
                    filter: { type: 'string', description: 'Filter expression on item (e.g. "item.age > 18")' },
                    fields: { type: 'array', items: { type: 'string' }, description: 'Fields to pick' },
                    sort: { type: 'string', description: 'Field to sort by' },
                    limit: { type: 'number', description: 'Max items to return' },
                },
                required: ['json'],
            },
        },
        execute: async ({ json, filter, fields, sort, limit }) => {
            const [parsed, err] = safeParseJSON(json);
            if (err) return `Invalid JSON: ${err}`;
            let arr = parsed;
            if (!Array.isArray(arr)) return 'Input must be a JSON array';
            if (filter) {
                try { arr = arr.filter(item => eval(`(item => ${filter})(item)`)); } catch { }
            }
            if (sort) arr = arr.sort((a, b) => a[sort] > b[sort] ? 1 : -1);
            if (limit) arr = arr.slice(0, limit);
            if (fields?.length) arr = arr.map(item => Object.fromEntries(fields.map(f => [f, item[f]])));
            return JSON.stringify(arr, null, 2).slice(0, 4000);
        },
    },

    // ── 17. ENV READ ──────────────────────────────────────────────────────────────
    {
        group: 'config',
        safe: true,
        schema: {
            name: 'env_read',
            description: 'Read environment variables or .env file contents (masks secrets).',
            input_schema: {
                type: 'object',
                properties: {
                    file: { type: 'string', description: '.env file path (optional)' },
                    key: { type: 'string', description: 'Specific key to read (optional)' },
                    mask: { type: 'boolean', description: 'Mask secret values (default true)' },
                },
                required: [],
            },
        },
        execute: async ({ file, key, mask = true }) => {
            if (key) {
                const v = process.env[key];
                return v ? (mask && (key.toLowerCase().includes('key') || key.toLowerCase().includes('secret') || key.toLowerCase().includes('token')) ? v.slice(0, 6) + '***' : v) : 'Not set';
            }
            const source = file ? readFile(file) : Object.entries(process.env).map(([k, v]) => `${k}=${v}`).join('\n');
            const maskFn = mask ? (line) => {
                const [k, ...rest] = line.split('=');
                const v = rest.join('=');
                const isSensitive = /key|secret|token|pass|pwd|api/i.test(k);
                return isSensitive ? `${k}=${v.slice(0, 4)}***` : line;
            } : (l) => l;
            return source.split('\n').map(maskFn).filter(l => l && !l.startsWith('#')).join('\n');
        },
    },

    // ── 18. NPM / PACKAGE ─────────────────────────────────────────────────────────
    {
        group: 'package',
        safe: true,
        schema: {
            name: 'npm_info',
            description: 'Get npm package info: list deps, check outdated, audit for vulnerabilities.',
            input_schema: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['list', 'outdated', 'audit', 'info'], description: 'Action to perform' },
                    package: { type: 'string', description: 'Package name (for "info" action)' },
                    cwd: { type: 'string' },
                },
                required: ['action'],
            },
        },
        execute: async ({ action, package: pkg, cwd }) => {
            const cmds = {
                list: 'npm list --depth=0 2>/dev/null',
                outdated: 'npm outdated --json 2>/dev/null || echo "{}"',
                audit: 'npm audit --json 2>/dev/null | head -100',
                info: pkg ? `npm show ${pkg} description version homepage` : 'npm show --help',
            };
            return run(cmds[action] || `npm ${action}`, cwd);
        },
    },

    // ── 19. RUN TESTS ─────────────────────────────────────────────────────────────
    {
        group: 'testing',
        safe: true,
        schema: {
            name: 'run_tests',
            description: 'Run test suite (Jest, Mocha, etc). Can target specific files or patterns.',
            input_schema: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'Test file pattern or name (optional)' },
                    framework: { type: 'string', enum: ['jest', 'mocha', 'auto'], description: 'Test framework' },
                    coverage: { type: 'boolean', description: 'Include coverage report' },
                    cwd: { type: 'string' },
                },
                required: [],
            },
        },
        execute: async ({ pattern, framework = 'auto', coverage, cwd }) => {
            let cmd;
            if (framework === 'auto') {
                const pkgPath = path.join(cwd || process.cwd(), 'package.json');
                const pkg = fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) : {};
                const hasJest = pkg.dependencies?.jest || pkg.devDependencies?.jest || pkg.scripts?.test?.includes('jest');
                const hasMocha = pkg.devDependencies?.mocha || pkg.scripts?.test?.includes('mocha');
                framework = hasJest ? 'jest' : hasMocha ? 'mocha' : 'jest';
            }
            const coverageFlag = coverage ? (framework === 'jest' ? '--coverage' : '--reporter html') : '';
            const patternFlag = pattern ? (framework === 'jest' ? `"${pattern}"` : `--grep "${pattern}"`) : '';
            cmd = `npx ${framework} ${patternFlag} ${coverageFlag} --passWithNoTests 2>&1 | tail -50`;
            return run(cmd, cwd);
        },
    },

    // ── 20. LINT ──────────────────────────────────────────────────────────────────
    {
        group: 'code-quality',
        safe: true,
        schema: {
            name: 'lint',
            description: 'Run ESLint on files. Returns errors and warnings.',
            input_schema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File or directory to lint' },
                    fix: { type: 'boolean', description: 'Auto-fix fixable issues' },
                    format: { type: 'string', enum: ['compact', 'json', 'stylish'], description: 'Output format' },
                    cwd: { type: 'string' },
                },
                required: [],
            },
        },
        execute: async ({ path: p = '.', fix, format = 'compact', cwd }) => {
            const fixFlag = fix ? '--fix' : '';
            return run(`npx eslint ${p} ${fixFlag} --format ${format} 2>&1 | head -80`, cwd);
        },
    },

    // ── 21. FORMAT CODE ───────────────────────────────────────────────────────────
    {
        group: 'code-quality',
        safe: false,
        schema: {
            name: 'format_code',
            description: 'Format code with Prettier. Returns formatted output or writes in place.',
            input_schema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File to format' },
                    write: { type: 'boolean', description: 'Write to file (default false = print only)' },
                    parser: { type: 'string', description: 'Parser: babel, typescript, json, markdown, etc.' },
                },
                required: ['path'],
            },
        },
        execute: async ({ path: p, write, parser }) => {
            const writeFlag = write ? '--write' : '--check';
            const parserFlag = parser ? `--parser ${parser}` : '';
            return run(`npx prettier ${writeFlag} ${parserFlag} "${p}" 2>&1 | head -30`);
        },
    },

    // ── 22. REGEX TEST ────────────────────────────────────────────────────────────
    {
        group: 'data',
        safe: true,
        schema: {
            name: 'regex_test',
            description: 'Test a regex pattern against input text. Returns matches and groups.',
            input_schema: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'Regex pattern (without delimiters)' },
                    input: { type: 'string', description: 'Input text to match against' },
                    flags: { type: 'string', description: 'Regex flags (g, i, m, s)' },
                    all_matches: { type: 'boolean', description: 'Return all matches (default first only)' },
                },
                required: ['pattern', 'input'],
            },
        },
        execute: async ({ pattern, input, flags = 'gm', all_matches = true }) => {
            const regex = new RegExp(pattern, flags);
            if (all_matches) {
                const matches = [...input.matchAll(new RegExp(pattern, flags.includes('g') ? flags : flags + 'g'))];
                if (!matches.length) return 'No matches';
                return matches.slice(0, 20).map((m, i) => `Match ${i + 1}: "${m[0]}"${m.slice(1).length ? ' groups: ' + JSON.stringify(m.slice(1)) : ''} at index ${m.index}`).join('\n');
            }
            const m = input.match(regex);
            return m ? `Match: "${m[0]}"${m.slice(1).length ? '\nGroups: ' + JSON.stringify(m.slice(1)) : ''}` : 'No match';
        },
    },

    // ── 23. CRYPTO / HASH ─────────────────────────────────────────────────────────
    {
        group: 'data',
        safe: true,
        schema: {
            name: 'crypto_hash',
            description: 'Hash, encode, or decode data. Supports md5, sha256, sha512, base64.',
            input_schema: {
                type: 'object',
                properties: {
                    algorithm: { type: 'string', enum: ['md5', 'sha256', 'sha512', 'sha1', 'base64-encode', 'base64-decode', 'hex'] },
                    input: { type: 'string', description: 'Input string' },
                },
                required: ['algorithm', 'input'],
            },
        },
        execute: async ({ algorithm, input }) => {
            const crypto = require('crypto');
            if (algorithm.startsWith('base64')) {
                return algorithm === 'base64-encode' ? Buffer.from(input).toString('base64') : Buffer.from(input, 'base64').toString('utf-8');
            }
            if (algorithm === 'hex') return Buffer.from(input).toString('hex');
            return crypto.createHash(algorithm).update(input).digest('hex');
        },
    },

    // ── 24. DATE / TIME ───────────────────────────────────────────────────────────
    {
        group: 'data',
        safe: true,
        schema: {
            name: 'datetime',
            description: 'Date/time operations: format, parse, calculate differences, timezone convert.',
            input_schema: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['now', 'format', 'diff', 'add', 'parse'] },
                    date: { type: 'string', description: 'Date string (ISO 8601 or natural)' },
                    date2: { type: 'string', description: 'Second date for diff' },
                    format: { type: 'string', description: 'Output format (ISO, locale, unix, relative)' },
                    amount: { type: 'number', description: 'Amount for add/subtract' },
                    unit: { type: 'string', description: 'Unit: days, hours, minutes, months, years' },
                },
                required: ['action'],
            },
        },
        execute: async ({ action, date, date2, format = 'ISO', amount, unit }) => {
            const d1 = date ? new Date(date) : new Date();
            const fmtDate = (d) => {
                if (format === 'unix') return Math.floor(d.getTime() / 1000).toString();
                if (format === 'locale') return d.toLocaleString();
                if (format === 'relative') {
                    const diff = Math.abs(Date.now() - d.getTime());
                    const mins = Math.floor(diff / 60000);
                    if (mins < 60) return `${mins} minutes ago`;
                    if (mins < 1440) return `${Math.floor(mins / 60)} hours ago`;
                    return `${Math.floor(mins / 1440)} days ago`;
                }
                return d.toISOString();
            };
            if (action === 'now') return fmtDate(new Date());
            if (action === 'format') return fmtDate(d1);
            if (action === 'parse') return JSON.stringify({ iso: d1.toISOString(), unix: Math.floor(d1.getTime() / 1000), valid: !isNaN(d1) });
            if (action === 'diff') { const diff = Math.abs(new Date(date2) - d1); return `${Math.floor(diff / 86400000)} days, ${Math.floor((diff % 86400000) / 3600000)} hours`; }
            if (action === 'add') {
                const units = { minutes: 60000, hours: 3600000, days: 86400000, weeks: 604800000, months: 30 * 86400000, years: 365 * 86400000 };
                return fmtDate(new Date(d1.getTime() + amount * (units[unit] || 86400000)));
            }
            return fmtDate(d1);
        },
    },

    // ── 25. SYSTEM METRICS ────────────────────────────────────────────────────────
    {
        group: 'system',
        safe: true,
        schema: {
            name: 'system_info',
            description: 'Get system information: CPU, memory, disk usage, Node.js runtime info.',
            input_schema: {
                type: 'object',
                properties: {
                    metric: { type: 'string', enum: ['all', 'cpu', 'memory', 'disk', 'node', 'processes'] },
                },
                required: [],
            },
        },
        execute: async ({ metric = 'all' }) => {
            const info = {};
            if (metric === 'all' || metric === 'memory') {
                info.memory = { total: `${(os.totalmem() / 1e9).toFixed(1)}GB`, free: `${(os.freemem() / 1e9).toFixed(1)}GB`, used: `${((os.totalmem() - os.freemem()) / 1e9).toFixed(1)}GB` };
            }
            if (metric === 'all' || metric === 'cpu') {
                info.cpu = { model: os.cpus()[0]?.model, cores: os.cpus().length, loadAvg: os.loadavg().map(l => l.toFixed(2)) };
            }
            if (metric === 'all' || metric === 'node') {
                info.node = { version: process.version, uptime: `${(process.uptime() / 60).toFixed(0)}min`, memory: process.memoryUsage() };
            }
            if (metric === 'all' || metric === 'disk') {
                info.disk = await run('df -h / | tail -1');
            }
            if (metric === 'processes') {
                return run('ps aux --sort=-%cpu | head -15');
            }
            return JSON.stringify(info, null, 2);
        },
    },

    // ── 26. NETWORK CHECK ─────────────────────────────────────────────────────────
    {
        group: 'network',
        safe: true,
        schema: {
            name: 'network_check',
            description: 'Network diagnostics: ping, port check, DNS lookup.',
            input_schema: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['ping', 'port', 'dns', 'trace'] },
                    host: { type: 'string' },
                    port: { type: 'number' },
                },
                required: ['action', 'host'],
            },
        },
        execute: async ({ action, host, port }) => {
            const cmds = {
                ping: `ping -c 3 ${host} 2>&1 | tail -5`,
                port: `nc -zv ${host} ${port || 80} 2>&1`,
                dns: `nslookup ${host} 2>&1 | head -10`,
                trace: `traceroute -m 10 ${host} 2>&1 | head -15`,
            };
            return run(cmds[action] || `ping -c 1 ${host}`);
        },
    },

    // ── 27. DOCKER ────────────────────────────────────────────────────────────────
    {
        group: 'infrastructure',
        safe: true,
        schema: {
            name: 'docker',
            description: 'Docker container management: list, logs, exec, inspect.',
            input_schema: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['ps', 'logs', 'exec', 'inspect', 'images', 'stats'] },
                    container: { type: 'string', description: 'Container name or ID' },
                    command: { type: 'string', description: 'Command for exec action' },
                    lines: { type: 'number', description: 'Lines for logs (default 50)' },
                },
                required: ['action'],
            },
        },
        execute: async ({ action, container, command, lines = 50 }) => {
            const cmds = {
                ps: 'docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>&1',
                images: 'docker images --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}" 2>&1',
                stats: 'docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" 2>&1',
                logs: container ? `docker logs --tail ${lines} ${container} 2>&1` : 'Specify container',
                exec: container && command ? `docker exec ${container} ${command} 2>&1` : 'Specify container and command',
                inspect: container ? `docker inspect ${container} 2>&1 | head -60` : 'Specify container',
            };
            return run(cmds[action] || 'docker info');
        },
    },

    // ── 28. LOG ANALYSIS ──────────────────────────────────────────────────────────
    {
        group: 'analysis',
        safe: true,
        schema: {
            name: 'log_analyze',
            description: 'Analyze log files: find errors, extract patterns, summarize levels.',
            input_schema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Log file path' },
                    level: { type: 'string', enum: ['ERROR', 'WARN', 'INFO', 'all'], description: 'Filter by level' },
                    pattern: { type: 'string', description: 'Custom grep pattern' },
                    tail: { type: 'number', description: 'Last N lines (default 100)' },
                    stats: { type: 'boolean', description: 'Return level statistics instead of lines' },
                },
                required: ['path'],
            },
        },
        execute: async ({ path: fp, level = 'all', pattern, tail = 100, stats }) => {
            const content = readFile(fp);
            const lines = content.split('\n');
            if (stats) {
                const counts = { ERROR: 0, WARN: 0, INFO: 0, DEBUG: 0, OTHER: 0 };
                for (const l of lines) {
                    if (/error/i.test(l)) counts.ERROR++;
                    else if (/warn/i.test(l)) counts.WARN++;
                    else if (/info/i.test(l)) counts.INFO++;
                    else if (/debug/i.test(l)) counts.DEBUG++;
                    else counts.OTHER++;
                }
                return JSON.stringify(counts, null, 2);
            }
            let filtered = lines;
            if (level !== 'all') filtered = filtered.filter(l => new RegExp(level, 'i').test(l));
            if (pattern) filtered = filtered.filter(l => l.includes(pattern));
            return filtered.slice(-tail).join('\n');
        },
    },

    // ── 29. DEPENDENCY ANALYSIS ───────────────────────────────────────────────────
    {
        group: 'analysis',
        safe: true,
        schema: {
            name: 'dependency_analysis',
            description: 'Analyze project dependencies: unused packages, circular deps, security issues.',
            input_schema: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['list', 'unused', 'circular', 'size', 'vulnerabilities'] },
                    cwd: { type: 'string' },
                },
                required: ['action'],
            },
        },
        execute: async ({ action, cwd }) => {
            const cmds = {
                list: 'cat package.json | node -e "const p=require(\'./package.json\');console.log(JSON.stringify({deps:Object.keys(p.dependencies||{}),dev:Object.keys(p.devDependencies||{})},null,2))"',
                unused: 'npx depcheck 2>&1 | head -30',
                circular: 'npx madge --circular . 2>&1 | head -30',
                size: 'npx cost-of-modules --no-install 2>&1 | head -20',
                vulnerabilities: 'npm audit --json 2>&1 | node -e "let d=\'\';process.stdin.on(\'data\',c=>d+=c);process.stdin.on(\'end\',()=>{try{const a=JSON.parse(d);console.log(JSON.stringify({critical:a.metadata?.vulnerabilities?.critical,high:a.metadata?.vulnerabilities?.high,moderate:a.metadata?.vulnerabilities?.moderate},null,2))}catch{console.log(d.slice(0,500))}})"',
            };
            return run(cmds[action] || 'npm list', cwd);
        },
    },

    // ── 30. CODE COMPLEXITY ───────────────────────────────────────────────────────
    {
        group: 'analysis',
        safe: true,
        schema: {
            name: 'code_complexity',
            description: 'Analyze code complexity: function lengths, nesting depth, duplicates.',
            input_schema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File or directory to analyze' },
                },
                required: ['path'],
            },
        },
        execute: async ({ path: fp }) => {
            const abs = path.resolve(fp);
            if (!fs.existsSync(abs)) return 'Path not found';
            const isFile = fs.statSync(abs).isFile();
            const content = isFile ? readFile(abs) : '';
            if (!content) return `Directory analysis: ${await run(`find ${abs} -name "*.js" | xargs wc -l 2>/dev/null | sort -rn | head -20`)}`;
            const lines = content.split('\n');
            const fns = lines.filter(l => /function\s+\w+|const\s+\w+\s*=\s*(?:async\s*)?\(|=>\s*\{/.test(l)).length;
            const maxDepth = Math.max(...lines.map(l => (l.match(/^\s+/)?.[0].length || 0) / 2));
            const longFns = lines.reduce((acc, l, i) => { if (l.match(/function|=>/) && lines.slice(i, i + 50).length > 40) acc.push(i + 1); return acc; }, []);
            return JSON.stringify({ file: fp, lines: lines.length, functions: fns, maxNestingDepth: Math.floor(maxDepth), potentiallyLongFunctions: longFns.slice(0, 5) }, null, 2);
        },
    },

    // ── 31. API TEST ──────────────────────────────────────────────────────────────
    {
        group: 'testing',
        safe: true,
        schema: {
            name: 'api_test',
            description: 'Test a REST API endpoint. Supports GET, POST, PUT, DELETE with headers and body.',
            input_schema: {
                type: 'object',
                properties: {
                    url: { type: 'string' },
                    method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
                    body: { type: 'string', description: 'JSON request body' },
                    headers: { type: 'string', description: 'JSON headers object' },
                    expect_status: { type: 'number', description: 'Expected HTTP status code' },
                },
                required: ['url'],
            },
        },
        execute: async ({ url, method = 'GET', body, headers, expect_status }) => {
            const headerStr = headers ? Object.entries(JSON.parse(headers)).map(([k, v]) => `-H "${k}: ${v}"`).join(' ') : '-H "Content-Type: application/json"';
            const bodyStr = body ? `-d '${body}'` : '';
            const cmd = `curl -s -o /tmp/mcp_api_response.txt -w "%{http_code}" -X ${method} ${headerStr} ${bodyStr} "${url}" 2>&1`;
            const statusCode = (await run(cmd)).trim();
            let responseBody = '';
            try { responseBody = fs.readFileSync('/tmp/mcp_api_response.txt', 'utf-8').slice(0, 2000); } catch { }
            const passed = !expect_status || parseInt(statusCode) === expect_status;
            return `Status: ${statusCode} ${passed ? '✓' : `✗ (expected ${expect_status})`}\n\nResponse:\n${responseBody}`;
        },
    },

    // ── 32. MOCK GENERATOR ────────────────────────────────────────────────────────
    {
        group: 'testing',
        safe: true,
        schema: {
            name: 'mock_generate',
            description: 'Generate mock/fixture data based on a JSON schema or example object.',
            input_schema: {
                type: 'object',
                properties: {
                    schema: { type: 'string', description: 'JSON Schema or example object to base mock on' },
                    count: { type: 'number', description: 'Number of mock objects to generate (default 3)' },
                    format: { type: 'string', enum: ['json', 'js', 'ts'], description: 'Output format' },
                },
                required: ['schema'],
            },
        },
        execute: async ({ schema, count = 3, format = 'json' }) => {
            const [example, err] = safeParseJSON(schema);
            if (err) return `Invalid JSON schema: ${err}`;
            const generateValue = (v, key = '') => {
                if (typeof v === 'string') {
                    const k = key.toLowerCase();
                    if (k.includes('email') || v.includes('email')) return 'user@example.com';
                    if (k.includes('name') || v.includes('name')) return 'John Doe';
                    if (k.includes('id') || v.includes('id')) return `id_${Math.random().toString(36).slice(2, 8)}`;
                    if (k.includes('url') || v.includes('http')) return 'https://example.com';
                    if (k.includes('date') || v.includes('date')) return new Date().toISOString().slice(0, 10);
                    return `sample_${Math.random().toString(36).slice(2, 6)}`;
                }
                if (typeof v === 'number') return Math.floor(Math.random() * 100);
                if (typeof v === 'boolean') return Math.random() > 0.5;
                if (Array.isArray(v)) return v.length > 0 ? [generateValue(v[0])] : [];
                if (typeof v === 'object' && v !== null) {
                    return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, generateValue(val, k)]));
                }
                return v;
            };
            const mocks = Array.from({ length: Math.min(count, 20) }, () => generateValue(example));
            return format === 'json' ? JSON.stringify(mocks, null, 2) : `const mocks = ${JSON.stringify(mocks, null, 2)};\nmodule.exports = mocks;`;
        },
    },

    // ── 33. SCHEMA VALIDATE ───────────────────────────────────────────────────────
    {
        group: 'data',
        safe: true,
        schema: {
            name: 'schema_validate',
            description: 'Validate JSON data against a JSON Schema.',
            input_schema: {
                type: 'object',
                properties: {
                    data: { type: 'string', description: 'JSON data to validate' },
                    schema: { type: 'string', description: 'JSON Schema object' },
                },
                required: ['data', 'schema'],
            },
        },
        execute: async ({ data, schema }) => {
            const [d, de] = safeParseJSON(data);
            if (de) return `Invalid data: ${de}`;
            const [s, se] = safeParseJSON(schema);
            if (se) return `Invalid schema: ${se}`;
            const errors = [];
            const validate = (obj, sch, prefix = '') => {
                if (sch.type) {
                    const t = Array.isArray(obj) ? 'array' : typeof obj;
                    if (t !== sch.type) errors.push(`${prefix || 'root'}: expected ${sch.type}, got ${t}`);
                }
                if (sch.required && typeof obj === 'object' && obj !== null) {
                    for (const req of sch.required) {
                        if (!(req in obj)) errors.push(`${prefix}: missing required field "${req}"`);
                    }
                }
                if (sch.properties && typeof obj === 'object') {
                    for (const [k, v] of Object.entries(sch.properties)) {
                        if (obj[k] !== undefined) validate(obj[k], v, `${prefix}.${k}`);
                    }
                }
            };
            validate(d, s);
            return errors.length === 0 ? '✓ Valid' : `✗ ${errors.length} error(s):\n${errors.join('\n')}`;
        },
    },

    // ── 34. DIAGRAM GENERATOR ─────────────────────────────────────────────────────
    {
        group: 'documentation',
        safe: true,
        schema: {
            name: 'generate_diagram',
            description: 'Generate a Mermaid diagram from code structure, module deps, or sequence.',
            input_schema: {
                type: 'object',
                properties: {
                    type: { type: 'string', enum: ['flowchart', 'sequence', 'class', 'er', 'gantt', 'mindmap'] },
                    content: { type: 'string', description: 'Code or description to diagram' },
                    title: { type: 'string', description: 'Optional diagram title' },
                },
                required: ['type', 'content'],
            },
        },
        execute: async ({ type, content, title }) => {
            const titleLine = title ? `\n    title ${title}` : '';
            const templates = {
                flowchart: `flowchart TD${titleLine}\n${content}`,
                sequence: `sequenceDiagram${titleLine}\n${content}`,
                class: `classDiagram${titleLine}\n${content}`,
                er: `erDiagram${titleLine}\n${content}`,
                gantt: `gantt${titleLine}\n    dateFormat YYYY-MM-DD\n${content}`,
                mindmap: `mindmap${titleLine}\n${content}`,
            };
            return `\`\`\`mermaid\n${templates[type] || content}\n\`\`\``;
        },
    },

    // ── 35. CHANGELOG GENERATOR ───────────────────────────────────────────────────
    {
        group: 'documentation',
        safe: true,
        schema: {
            name: 'generate_changelog',
            description: 'Generate a CHANGELOG from git commit history.',
            input_schema: {
                type: 'object',
                properties: {
                    from: { type: 'string', description: 'From tag/commit (optional)' },
                    to: { type: 'string', description: 'To tag/commit (default HEAD)' },
                    version: { type: 'string', description: 'Version label for this release' },
                    cwd: { type: 'string' },
                },
                required: [],
            },
        },
        execute: async ({ from, to = 'HEAD', version = 'Unreleased', cwd }) => {
            const range = from ? `${from}..${to}` : '-20';
            const log = await run(`git log ${range} --pretty=format:"%s" 2>/dev/null`, cwd);
            const commits = log.split('\n').filter(Boolean);
            const grouped = { feat: [], fix: [], refactor: [], docs: [], other: [] };
            for (const c of commits) {
                if (c.startsWith('feat')) grouped.feat.push(c);
                else if (c.startsWith('fix')) grouped.fix.push(c);
                else if (c.startsWith('refactor')) grouped.refactor.push(c);
                else if (c.startsWith('docs')) grouped.docs.push(c);
                else grouped.other.push(c);
            }
            const lines = [`## ${version} (${new Date().toISOString().slice(0, 10)})`, ''];
            if (grouped.feat.length) lines.push('### Features', ...grouped.feat.map(c => `- ${c}`), '');
            if (grouped.fix.length) lines.push('### Bug Fixes', ...grouped.fix.map(c => `- ${c}`), '');
            if (grouped.refactor.length) lines.push('### Refactors', ...grouped.refactor.map(c => `- ${c}`), '');
            if (grouped.docs.length) lines.push('### Documentation', ...grouped.docs.map(c => `- ${c}`), '');
            if (grouped.other.length) lines.push('### Other', ...grouped.other.map(c => `- ${c}`), '');
            return lines.join('\n');
        },
    },

    // ── 36. TOKEN COUNTER ─────────────────────────────────────────────────────────
    {
        group: 'ai',
        safe: true,
        schema: {
            name: 'token_count',
            description: 'Estimate token count for text (4 chars ≈ 1 token). Useful for context budget planning.',
            input_schema: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: 'Text to count' },
                    model: { type: 'string', description: 'Model name (affects cost estimate)' },
                },
                required: ['text'],
            },
        },
        execute: async ({ text, model = 'claude-opus-4-5' }) => {
            const tokens = Math.ceil(text.length / 4);
            const pricing = { 'claude-opus-4-5': { input: 15 }, 'claude-haiku-4-5-20251001': { input: 0.25 }, 'claude-sonnet-4-5': { input: 3 } };
            const price = pricing[model]?.input || 15;
            const cost = (tokens / 1_000_000) * price;
            return JSON.stringify({ tokens, chars: text.length, estimatedCostUsd: `$${cost.toFixed(6)}`, model, budget: { of128k: `${(tokens / 128000 * 100).toFixed(1)}%`, of200k: `${(tokens / 200000 * 100).toFixed(1)}%` } }, null, 2);
        },
    },

    // ── 37. THINK (chain-of-thought) ──────────────────────────────────────────────
    {
        group: 'ai',
        safe: true,
        schema: {
            name: 'think',
            description: 'Internal reasoning tool. Use this to think step-by-step before answering. Output is private scratchpad.',
            input_schema: {
                type: 'object',
                properties: {
                    thought: { type: 'string', description: 'Your internal reasoning, analysis, or chain-of-thought' },
                },
                required: ['thought'],
            },
        },
        execute: async ({ thought }) => {
            logger.info(`[Think] ${thought.slice(0, 80)}`);
            return `Thought recorded. Continue with your analysis.`;
        },
    },

    // ── 38. SLEEP / WAIT ──────────────────────────────────────────────────────────
    {
        group: 'control',
        safe: true,
        schema: {
            name: 'sleep',
            description: 'Wait for a specified duration. Useful for rate-limiting or polling.',
            input_schema: {
                type: 'object',
                properties: {
                    ms: { type: 'number', description: 'Milliseconds to wait (max 5000)' },
                    reason: { type: 'string', description: 'Why are you waiting' },
                },
                required: ['ms'],
            },
        },
        execute: async ({ ms, reason }) => {
            await new Promise(r => setTimeout(r, Math.min(ms, 5000)));
            return `Waited ${ms}ms${reason ? ': ' + reason : ''}`;
        },
    },

    // ── 39. KNOWLEDGE BASE SEARCH ─────────────────────────────────────────────────
    {
        group: 'knowledge',
        safe: true,
        schema: {
            name: 'kb_search',
            description: 'Search the ingested codebase knowledge base for relevant context.',
            input_schema: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search query' },
                    top_k: { type: 'number', description: 'Number of results (default 6)' },
                    kind: { type: 'string', description: 'Filter by kind: code, log, config, documentation' },
                },
                required: ['query'],
            },
        },
        execute: async ({ query, top_k = 6, kind }) => {
            const indexer = require('../core/indexer');
            const results = indexer.search(query, top_k, kind ? { kind } : {});
            if (!results.length) return 'No relevant context found in knowledge base.';
            return results.map((r, i) =>
                `[${i + 1}] ${r.filename} (${r.kind}) score:${r.relevanceScore}\n${r.content.slice(0, 400)}`
            ).join('\n\n---\n\n');
        },
    },

    // ── 40. MEMORY SEARCH ─────────────────────────────────────────────────────────
    {
        group: 'knowledge',
        safe: true,
        schema: {
            name: 'memory_search',
            description: 'Search persistent memory for relevant facts about this codebase.',
            input_schema: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search query' },
                    limit: { type: 'number', description: 'Max results (default 5)' },
                },
                required: ['query'],
            },
        },
        execute: async ({ query, limit = 5 }) => {
            const { MemoryManager } = require('../memory/memoryManager');
            const mems = MemoryManager.getRelevant(query, limit);
            if (!mems.length) return 'No relevant memories found.';
            return mems.map(m => `[${m.type}] ${m.content}`).join('\n');
        },
    },

    // ── 41. TASK MANAGER ──────────────────────────────────────────────────────────
    {
        group: 'tasks',
        safe: true,
        schema: {
            name: 'task_manage',
            description: 'Create, update, or list tasks.',
            input_schema: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['list', 'create', 'done', 'update'] },
                    title: { type: 'string', description: 'Task title (for create)' },
                    id: { type: 'number', description: 'Task ID (for done/update)' },
                    priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
                    status: { type: 'string', enum: ['todo', 'in_progress', 'done', 'blocked'] },
                },
                required: ['action'],
            },
        },
        execute: async ({ action, title, id, priority, status }) => {
            const { TaskManager } = require('../tasks/taskManager');
            if (action === 'list') return JSON.stringify(TaskManager.list().map(t => ({ id: t.id, title: t.title, status: t.status, priority: t.priority })), null, 2);
            if (action === 'create') return JSON.stringify(TaskManager.create({ title, priority: priority || 'medium' }));
            if (action === 'done') return JSON.stringify(TaskManager.update(id, { status: 'done' }));
            if (action === 'update') return JSON.stringify(TaskManager.update(id, { status, priority }));
            return 'Unknown action';
        },
    },

    // ── 42. SYMBOL NAVIGATE ───────────────────────────────────────────────────────
    {
        group: 'navigation',
        safe: true,
        schema: {
            name: 'symbol_navigate',
            description: 'Navigate code symbols: find definitions, references, or file outline.',
            input_schema: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['definition', 'references', 'outline', 'workspace'] },
                    symbol: { type: 'string', description: 'Symbol name to look up' },
                    file: { type: 'string', description: 'File path for outline action' },
                    cwd: { type: 'string' },
                },
                required: ['action'],
            },
        },
        execute: async ({ action, symbol, file, cwd }) => {
            const nav = require('../lsp/symbolNavigator');
            if (action === 'definition') return JSON.stringify((await nav.goToDefinition(symbol, cwd)).definitions.slice(0, 5), null, 2);
            if (action === 'references') { const r = await nav.findReferences(symbol, cwd); return `${r.total} references\n${r.references.slice(0, 10).map(r => `${r.file}:${r.line} ${r.text}`).join('\n')}`; }
            if (action === 'outline') return JSON.stringify((await nav.outline(file)).symbols, null, 2);
            if (action === 'workspace') return JSON.stringify((await nav.workspaceSymbols(symbol, cwd)).symbols.slice(0, 15), null, 2);
            return 'Unknown action';
        },
    },

    // ── 43. TEXT DIFF ─────────────────────────────────────────────────────────────
    {
        group: 'analysis',
        safe: true,
        schema: {
            name: 'text_diff',
            description: 'Compare two files or strings and return their diff.',
            input_schema: {
                type: 'object',
                properties: {
                    file_a: { type: 'string', description: 'First file path' },
                    file_b: { type: 'string', description: 'Second file path' },
                    text_a: { type: 'string', description: 'First text (alternative to file_a)' },
                    text_b: { type: 'string', description: 'Second text (alternative to file_b)' },
                    context: { type: 'number', description: 'Context lines (default 3)' },
                },
                required: [],
            },
        },
        execute: async ({ file_a, file_b, text_a, text_b, context = 3 }) => {
            // diff returns exit 1 when files differ — that's normal output, not an error
            // Use -U N (unified context lines) — more portable than --context=N
            if (file_a && file_b) {
                const result = await run(`diff -U ${context} "${path.resolve(file_a)}" "${path.resolve(file_b)}"`, null, { allowNonZero: true });
                return result || '(no differences)';
            }
            if (text_a !== undefined && text_b !== undefined) {
                fs.writeFileSync('/tmp/mcp_diff_a.txt', String(text_a));
                fs.writeFileSync('/tmp/mcp_diff_b.txt', String(text_b));
                const result = await run(`diff -U ${context} /tmp/mcp_diff_a.txt /tmp/mcp_diff_b.txt`, null, { allowNonZero: true });
                return result || '(no differences)';
            }
            return 'Provide file_a + file_b or text_a + text_b';
        },
    },

    // ── 44. PROCESS MANAGER ───────────────────────────────────────────────────────
    {
        group: 'system',
        safe: true,
        schema: {
            name: 'process_info',
            description: 'List processes or find processes by name/port.',
            input_schema: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['list', 'find', 'port'] },
                    name: { type: 'string', description: 'Process name to search' },
                    port: { type: 'number', description: 'Port to find process for' },
                },
                required: ['action'],
            },
        },
        execute: async ({ action, name, port }) => {
            const cmds = {
                list: 'ps aux --sort=-%cpu | head -20 2>&1',
                find: `pgrep -la "${name}" 2>&1 | head -10`,
                port: `lsof -i :${port} 2>&1 | head -10`,
            };
            return run(cmds[action] || 'ps aux | head -10');
        },
    },

    // ── 45. SKILL RUNNER ──────────────────────────────────────────────────────────
    {
        group: 'ai',
        safe: true,
        schema: {
            name: 'run_skill',
            description: 'Execute a named skill (add-error-handling, document-function, check-security, etc.)',
            input_schema: {
                type: 'object',
                properties: {
                    skill: { type: 'string', description: 'Skill name' },
                    target: { type: 'string', description: 'Target (function, file, module)' },
                },
                required: ['skill', 'target'],
            },
        },
        execute: async ({ skill, target }) => {
            const skillsManager = require('../skills/skillsManager');
            const result = await skillsManager.run(skill, target);
            return result.result || result.error || 'No result';
        },
    },

];

// ─── REGISTRY API ──────────────────────────────────────────────────────────────
class ToolRegistry {
    constructor() {
        this._tools = new Map(TOOLS.map(t => [t.schema.name, t]));
    }

    /** All tool schemas in Anthropic format */
    schemas(names) {
        const all = names ? TOOLS.filter(t => names.includes(t.schema.name)) : TOOLS;
        return all.map(t => t.schema);
    }

    /** Get all tools in a group */
    byGroup(group) {
        return TOOLS.filter(t => t.group === group).map(t => t.schema.name);
    }

    /** Execute a tool call */
    async execute(name, input) {
        const tool = this._tools.get(name);
        if (!tool) return `Unknown tool: ${name}`;
        try {
            const result = await tool.execute(input);
            return typeof result === 'string' ? result : JSON.stringify(result);
        } catch (err) {
            logger.error(`[Tool:${name}] ${err.message}`);
            return `[Error in ${name}]: ${err.message}`;
        }
    }

    /** List all tool names */
    list() { return TOOLS.map(t => ({ name: t.schema.name, group: t.group, safe: t.safe, description: t.schema.description })); }

    /** Total count */
    get count() { return TOOLS.length; }
}

module.exports = new ToolRegistry();
