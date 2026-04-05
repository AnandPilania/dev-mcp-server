/**
 * GrepTool — ripgrep-based content search with fallback.
 * Searches for patterns across the codebase quickly without needing to ingest first.
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const path = require('path');
const logger = require('../utils/logger');

// Check if ripgrep is available
let RG_AVAILABLE = null;
async function checkRg() {
    if (RG_AVAILABLE !== null) return RG_AVAILABLE;
    try {
        await execAsync('rg --version');
        RG_AVAILABLE = true;
    } catch {
        RG_AVAILABLE = false;
    }
    return RG_AVAILABLE;
}

class GrepTool {
    /**
     * Search for a pattern in files
     * @param {string} pattern  - regex or literal string
     * @param {object} opts
     *   cwd          - directory to search in
     *   glob         - file glob filter (e.g. '*.js')
     *   ignoreCase   - case-insensitive
     *   maxResults   - limit results
     *   contextLines - lines of context around each match
     *   literal      - treat pattern as literal string (no regex)
     */
    async search(pattern, opts = {}) {
        const {
            cwd = process.cwd(),
            glob,
            ignoreCase = false,
            maxResults = 50,
            contextLines = 2,
            literal = false,
        } = opts;

        const useRg = await checkRg();

        if (useRg) {
            return this._rgSearch(pattern, { cwd, glob, ignoreCase, maxResults, contextLines, literal });
        } else {
            return this._nativeSearch(pattern, { cwd, glob, ignoreCase, maxResults });
        }
    }

    async _rgSearch(pattern, opts) {
        const { cwd, glob, ignoreCase, maxResults, contextLines, literal } = opts;

        const flags = [
            '--json',
            `--max-count=${maxResults}`,
            `--context=${contextLines}`,
            ignoreCase ? '--ignore-case' : '',
            literal ? '--fixed-strings' : '',
            glob ? `--glob '${glob}'` : '',
            '--hidden',
            '--no-follow',
            // Standard ignores
            '--glob !node_modules',
            '--glob !.git',
            '--glob !dist',
            '--glob !build',
            '--glob !*.min.js',
        ].filter(Boolean).join(' ');

        const cmd = `rg ${flags} ${JSON.stringify(pattern)}`;

        try {
            const { stdout } = await execAsync(cmd, { cwd, maxBuffer: 5 * 1024 * 1024 });
            return this._parseRgJson(stdout, maxResults);
        } catch (err) {
            if (err.code === 1) return { matches: [], total: 0, tool: 'ripgrep', note: 'No matches found' };
            throw new Error(`ripgrep error: ${err.message}`);
        }
    }

    _parseRgJson(output, maxResults) {
        const lines = output.trim().split('\n').filter(Boolean);
        const matches = [];
        let total = 0;

        for (const line of lines) {
            try {
                const obj = JSON.parse(line);
                if (obj.type === 'match') {
                    total++;
                    if (matches.length < maxResults) {
                        matches.push({
                            file: obj.data.path.text,
                            lineNumber: obj.data.line_number,
                            line: obj.data.lines.text.trimEnd(),
                            submatches: obj.data.submatches?.map(s => s.match?.text) || [],
                        });
                    }
                }
            } catch { }
        }

        return { matches, total, tool: 'ripgrep' };
    }

    async _nativeSearch(pattern, opts) {
        const { cwd, ignoreCase, maxResults } = opts;
        const { glob: globModule } = require('glob');
        const fs = require('fs');

        const files = await globModule('**/*', {
            cwd,
            absolute: true,
            nodir: true,
            ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
        });

        const regex = new RegExp(pattern, ignoreCase ? 'gi' : 'g');
        const matches = [];

        for (const file of files) {
            if (matches.length >= maxResults) break;
            try {
                const content = fs.readFileSync(file, 'utf-8');
                const lines = content.split('\n');
                lines.forEach((line, idx) => {
                    if (matches.length < maxResults && regex.test(line)) {
                        matches.push({
                            file: path.relative(cwd, file),
                            lineNumber: idx + 1,
                            line: line.trimEnd(),
                            submatches: [],
                        });
                    }
                    regex.lastIndex = 0;
                });
            } catch { }
        }

        return { matches, total: matches.length, tool: 'native-grep' };
    }

    /**
     * Quick search: find all definitions of a symbol (function, class, const)
     */
    async findDefinitions(symbol, cwd = process.cwd()) {
        const patterns = [
            `function ${symbol}`,
            `class ${symbol}`,
            `const ${symbol}\\s*=`,
            `let ${symbol}\\s*=`,
            `var ${symbol}\\s*=`,
            `${symbol}\\s*\\(`,           // method definition
            `exports\\.${symbol}`,
            `module\\.exports.*${symbol}`,
        ];

        const allMatches = [];
        for (const p of patterns) {
            try {
                const result = await this.search(p, { cwd, maxResults: 10 });
                allMatches.push(...result.matches);
            } catch { }
        }

        // Deduplicate by file+line
        const seen = new Set();
        return allMatches.filter(m => {
            const key = `${m.file}:${m.lineNumber}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    /**
     * Find all imports/requires of a module
     */
    async findImports(moduleName, cwd = process.cwd()) {
        const pattern = `(import|require).*['"]${moduleName}['"]`;
        return this.search(pattern, { cwd, maxResults: 30 });
    }

    /**
     * Find all TODO/FIXME/HACK/BUG comments
     */
    async findTodos(cwd = process.cwd()) {
        const pattern = '(TODO|FIXME|HACK|BUG|XXX|NOTE)\\s*[:\\-]?';
        return this.search(pattern, { cwd, maxResults: 100, ignoreCase: true });
    }
}

module.exports = new GrepTool();
