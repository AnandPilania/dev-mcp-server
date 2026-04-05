/**
 * LSPTool — lightweight symbol navigation
 * without requiring a full Language Server. Uses grep + indexer + AI.
 *
 * Provides:
 *  - Go-to-definition: find where a symbol is defined
 *  - Find references: find all usages of a symbol
 *  - Hover docs: generate documentation for a symbol at a location
 *  - Symbol outline: list all symbols in a file
 *  - Workspace symbols: find symbols matching a query
 */

const llm = require('../utils/llmClient');
const GrepTool = require('../tools/GrepTool');
const store = require('../storage/store');
const indexer = require('../core/indexer');
const costTracker = require('../utils/costTracker');
const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');

class SymbolNavigator {
    /**
     * Go-to-definition: find where a symbol is defined
     */
    async goToDefinition(symbol, cwd = process.cwd()) {
        logger.info(`[LSP] go-to-definition: ${symbol}`);

        const definitions = await GrepTool.findDefinitions(symbol, cwd);

        // Also search the indexed store for this symbol in metadata
        const fromIndex = store.getAll()
            .filter(doc => doc.metadata?.functions?.includes(symbol) || doc.metadata?.classes?.includes(symbol))
            .map(doc => ({
                file: doc.filePath,
                lineNumber: null, // We don't store line numbers in index
                kind: doc.metadata?.classes?.includes(symbol) ? 'class' : 'function',
                fromIndex: true,
            }));

        const combined = [
            ...definitions.map(d => ({ ...d, kind: this._inferKind(d.line), fromIndex: false })),
            ...fromIndex,
        ];

        // Deduplicate by file
        const seen = new Set();
        const deduped = combined.filter(d => {
            const key = d.file + (d.lineNumber || '');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        return {
            symbol,
            definitions: deduped,
            count: deduped.length,
        };
    }

    /**
     * Find all references to a symbol
     */
    async findReferences(symbol, cwd = process.cwd()) {
        logger.info(`[LSP] find-references: ${symbol}`);

        const usages = await GrepTool.search(symbol, { cwd, maxResults: 50, contextLines: 1 });
        const imports = await GrepTool.findImports(symbol, cwd);

        return {
            symbol,
            references: usages.matches.map(m => ({
                file: m.file,
                line: m.lineNumber,
                text: m.line.trim(),
                type: m.line.includes('import') || m.line.includes('require') ? 'import' : 'usage',
            })),
            total: usages.total,
        };
    }

    /**
     * Hover documentation: generate docs for a symbol using AI
     */
    async hover(symbol, filePath = null, sessionId = 'default') {
        logger.info(`[LSP] hover: ${symbol}`);

        // Find definition to get the actual code
        const def = await this.goToDefinition(symbol);
        const docs = indexer.searchForUsages(symbol, 4);

        const contextParts = [];
        if (filePath && fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf-8').slice(0, 3000);
            contextParts.push(`File context:\n${content}`);
        }
        if (docs.length > 0) {
            contextParts.push('Codebase context:\n' + docs.map(d => d.content.slice(0, 500)).join('\n---\n'));
        }

        const response = await llm.chat({
            model: llm.model('fast'),
            max_tokens: 400,
            messages: [{
                role: 'user',
                content: `Generate concise hover documentation for the symbol "${symbol}".
Include: type, purpose (1-2 sentences), parameters (if function), return value, and any gotchas.
Format as markdown. Be brief — this is hover text, not a full doc.

${contextParts.join('\n\n')}`,
            }],
        });

        costTracker.record({
            model: llm.model('fast'),
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            sessionId,
            queryType: 'lsp-hover',
        });

        return {
            symbol,
            documentation: response.content[0].text,
            definitions: def.definitions.slice(0, 3),
        };
    }

    /**
     * Symbol outline: list all symbols (functions, classes, exports) in a file
     */
    async outline(filePath) {
        const abs = path.resolve(filePath);
        if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);

        const content = fs.readFileSync(abs, 'utf-8');
        const symbols = [];
        const lines = content.split('\n');

        const patterns = [
            { regex: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/, kind: 'function' },
            { regex: /^(?:export\s+)?class\s+(\w+)/, kind: 'class' },
            { regex: /^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/, kind: 'arrow-function' },
            { regex: /^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/, kind: 'method' },
            { regex: /^module\.exports\s*=\s*(?:new\s+)?(\w+)/, kind: 'export' },
            { regex: /^exports\.(\w+)\s*=/, kind: 'export' },
        ];

        lines.forEach((line, idx) => {
            for (const { regex, kind } of patterns) {
                const m = line.match(regex);
                if (m && m[1] && !['if', 'for', 'while', 'catch', 'switch'].includes(m[1])) {
                    symbols.push({ name: m[1], kind, line: idx + 1, text: line.trim().slice(0, 80) });
                    break;
                }
            }
        });

        return {
            filePath: abs,
            filename: path.basename(abs),
            symbols,
            count: symbols.length,
        };
    }

    /**
     * Workspace symbol search: find any symbol matching a query
     */
    async workspaceSymbols(query, cwd = process.cwd()) {
        const docs = indexer.search(query, 10);
        const symbols = [];

        for (const doc of docs) {
            const meta = doc.metadata || {};
            const allSymbols = [
                ...(meta.functions || []).map(n => ({ name: n, kind: 'function', file: doc.filename, path: doc.filePath })),
                ...(meta.classes || []).map(n => ({ name: n, kind: 'class', file: doc.filename, path: doc.filePath })),
                ...(meta.exports || []).map(n => ({ name: n, kind: 'export', file: doc.filename, path: doc.filePath })),
            ];
            symbols.push(...allSymbols.filter(s => s.name.toLowerCase().includes(query.toLowerCase())));
        }

        // Deduplicate
        const seen = new Set();
        return {
            query,
            symbols: symbols.filter(s => {
                const key = `${s.name}:${s.path}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            }).slice(0, 30),
        };
    }

    /**
     * Rename symbol — suggest all places that need updating
     */
    async renameSymbol(oldName, newName, cwd = process.cwd()) {
        const refs = await this.findReferences(oldName, cwd);
        return {
            oldName,
            newName,
            affectedFiles: [...new Set(refs.references.map(r => r.file))],
            references: refs.references,
            suggestion: `Update ${refs.references.length} occurrences across ${[...new Set(refs.references.map(r => r.file))].length} files`,
        };
    }

    _inferKind(line = '') {
        if (/class\s+\w/.test(line)) return 'class';
        if (/function\s+\w/.test(line)) return 'function';
        if (/const\s+\w+\s*=\s*(?:async\s*)?\(/.test(line)) return 'arrow-function';
        return 'symbol';
    }
}

module.exports = new SymbolNavigator();
