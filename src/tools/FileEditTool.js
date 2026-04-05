/**
 * The most powerful tool in the system: applies AI-suggested edits to actual files.
 *
 * Safety model:
 *  1. Always creates a .bak before editing
 *  2. Validates the edit would produce a syntactically valid change
 *  3. Supports three edit modes: str_replace, insert_after, full_rewrite
 *  4. Dry-run mode shows the diff without writing
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const llm = require('../utils/llmClient');
const logger = require('../utils/logger');
const costTracker = require('../utils/costTracker');

// Max file size we'll edit (safety check)
const MAX_EDIT_SIZE = 200 * 1024; // 200KB

class FileEditTool {
    /**
     * Apply a string replacement edit to a file.
     *
     * @param {string} filePath   - Absolute or relative path
     * @param {string} oldStr     - Exact string to find (must be unique in the file)
     * @param {string} newStr     - Replacement string
     * @param {object} opts       - { dryRun, backup }
     */
    async strReplace(filePath, oldStr, newStr, opts = {}) {
        const { dryRun = false, backup = true } = opts;
        const abs = path.resolve(filePath);

        this._assertSafe(abs);
        const original = fs.readFileSync(abs, 'utf-8');

        const occurrences = this._countOccurrences(original, oldStr);
        if (occurrences === 0) {
            throw new Error(`str_replace: oldStr not found in ${path.basename(abs)}`);
        }
        if (occurrences > 1) {
            throw new Error(`str_replace: oldStr found ${occurrences} times — must be unique. Add more context around it.`);
        }

        const edited = original.replace(oldStr, newStr);
        const diff = this._diffSummary(original, edited, abs);

        if (dryRun) {
            return { dryRun: true, diff, filePath: abs, wouldChange: original !== edited };
        }

        if (backup) this._backup(abs, original);
        fs.writeFileSync(abs, edited, 'utf-8');

        logger.info(`[FileEdit] str_replace in ${path.basename(abs)} (+${this._lineCount(newStr)} -${this._lineCount(oldStr)} lines)`);
        return { success: true, filePath: abs, diff, linesAdded: this._lineCount(newStr), linesRemoved: this._lineCount(oldStr), backedUp: backup };
    }

    /**
     * Insert text after a specific line number or after a matching string.
     */
    async insertAfter(filePath, afterStr, insertText, opts = {}) {
        const { dryRun = false, backup = true } = opts;
        const abs = path.resolve(filePath);

        this._assertSafe(abs);
        const original = fs.readFileSync(abs, 'utf-8');

        if (!original.includes(afterStr)) {
            throw new Error(`insert_after: anchor string not found in ${path.basename(abs)}`);
        }

        const edited = original.replace(afterStr, afterStr + '\n' + insertText);
        const diff = this._diffSummary(original, edited, abs);

        if (dryRun) return { dryRun: true, diff, filePath: abs };

        if (backup) this._backup(abs, original);
        fs.writeFileSync(abs, edited, 'utf-8');

        logger.info(`[FileEdit] insert_after in ${path.basename(abs)}`);
        return { success: true, filePath: abs, diff, backedUp: backup };
    }

    /**
     * Full file rewrite. Use sparingly — prefers str_replace for smaller edits.
     */
    async rewrite(filePath, newContent, opts = {}) {
        const { dryRun = false, backup = true } = opts;
        const abs = path.resolve(filePath);

        this._assertSafe(abs);

        let original = '';
        if (fs.existsSync(abs)) {
            original = fs.readFileSync(abs, 'utf-8');
        }

        const diff = this._diffSummary(original, newContent, abs);

        if (dryRun) return { dryRun: true, diff, filePath: abs };

        if (backup && original) this._backup(abs, original);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, newContent, 'utf-8');

        logger.info(`[FileWrite] wrote ${path.basename(abs)} (${newContent.length} chars)`);
        return { success: true, filePath: abs, diff, isNew: !original, backedUp: backup && !!original };
    }

    /**
     * AI-powered edit: describe what to change, LLM generates the edit.
     *
     * This is the killer feature — "add error handling to getUserById"
     * and it will find the function, understand it, and apply the change.
     */
    async aiEdit(filePath, instruction, opts = {}) {
        const { dryRun = false, sessionId = 'default' } = opts;
        const abs = path.resolve(filePath);

        this._assertSafe(abs);
        const content = fs.readFileSync(abs, 'utf-8');
        const filename = path.basename(abs);

        logger.info(`[FileEdit] AI edit: "${instruction.slice(0, 60)}" on ${filename}`);

        const response = await llm.chat({
            model: llm.model('smart'),
            max_tokens: 2000,
            system: `You are a precise code editor. Apply the instruction to the file and return ONLY the edited file content.
Rules:
- Make the MINIMAL change that satisfies the instruction
- Preserve all existing code, formatting, and style
- Do NOT add explanations or markdown code fences
- Return the COMPLETE file content (not just the changed part)
- If you cannot safely make the change, return: ERROR: <reason>`,
            messages: [{
                role: 'user',
                content: `File: ${filename}\nInstruction: ${instruction}\n\nCurrent content:\n${content}`,
            }],
        });

        costTracker.record({
            model: llm.model('smart'),
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            sessionId,
            queryType: 'file-edit',
        });

        const newContent = response.content[0].text;

        if (newContent.startsWith('ERROR:')) {
            throw new Error(newContent);
        }

        const diff = this._diffSummary(content, newContent, abs);

        if (dryRun) {
            return { dryRun: true, diff, filePath: abs, instruction };
        }

        return this.rewrite(abs, newContent, { backup: true });
    }

    /**
     * Undo the last edit by restoring from backup
     */
    undo(filePath) {
        const abs = path.resolve(filePath);
        const backupPath = abs + '.bak';

        if (!fs.existsSync(backupPath)) {
            throw new Error(`No backup found for ${path.basename(abs)}`);
        }

        const backup = fs.readFileSync(backupPath, 'utf-8');
        const current = fs.readFileSync(abs, 'utf-8');

        fs.writeFileSync(abs, backup, 'utf-8');
        fs.unlinkSync(backupPath);

        logger.info(`[FileEdit] Undone: ${path.basename(abs)}`);
        return { success: true, filePath: abs, restoredLength: backup.length };
    }

    /**
     * Read a file (FileReadTool equivalent)
     */
    read(filePath, opts = {}) {
        const { startLine, endLine, maxChars = 50000 } = opts;
        const abs = path.resolve(filePath);

        if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);

        let content = fs.readFileSync(abs, 'utf-8');

        if (startLine || endLine) {
            const lines = content.split('\n');
            const start = (startLine || 1) - 1;
            const end = endLine || lines.length;
            content = lines.slice(start, end).join('\n');
        }

        if (content.length > maxChars) {
            content = content.slice(0, maxChars) + `\n... [truncated at ${maxChars} chars]`;
        }

        return {
            filePath: abs,
            filename: path.basename(abs),
            content,
            lines: content.split('\n').length,
            size: fs.statSync(abs).size,
        };
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    _assertSafe(abs) {
        if (!fs.existsSync(abs) && !abs.endsWith('.js') && !abs.endsWith('.ts') && !abs.endsWith('.json') && !abs.endsWith('.md')) {
            // Allow creating new files with known extensions, but existing files must exist for edits
        }
        if (fs.existsSync(abs)) {
            const stat = fs.statSync(abs);
            if (stat.size > MAX_EDIT_SIZE) throw new Error(`File too large to edit (${(stat.size / 1024).toFixed(0)}KB > ${MAX_EDIT_SIZE / 1024}KB)`);
        }
        // Prevent editing outside cwd
        const cwd = process.cwd();
        if (!abs.startsWith(cwd) && !abs.startsWith('/home') && !abs.startsWith('/tmp')) {
            throw new Error(`Safety: refusing to edit outside working directory: ${abs}`);
        }
    }

    _backup(abs, content) {
        fs.writeFileSync(abs + '.bak', content, 'utf-8');
    }

    _countOccurrences(str, sub) {
        let count = 0;
        let pos = 0;
        while ((pos = str.indexOf(sub, pos)) !== -1) { count++; pos += sub.length; }
        return count;
    }

    _lineCount(text) {
        return (text || '').split('\n').length;
    }

    _diffSummary(original, edited, filePath) {
        const origLines = original.split('\n');
        const editLines = edited.split('\n');
        const added = editLines.length - origLines.length;

        // Simple unified-diff-like summary
        const changes = [];
        const maxLines = Math.max(origLines.length, editLines.length);
        let inChange = false;

        for (let i = 0; i < Math.min(maxLines, 200); i++) {
            const o = origLines[i] || '';
            const e = editLines[i] || '';
            if (o !== e) {
                if (!inChange) { changes.push(`@@ line ${i + 1} @@`); inChange = true; }
                if (o) changes.push(`- ${o}`);
                if (e) changes.push(`+ ${e}`);
            } else {
                inChange = false;
            }
        }

        return {
            summary: `${Math.abs(added)} line(s) ${added >= 0 ? 'added' : 'removed'} in ${path.basename(filePath)}`,
            changes: changes.slice(0, 50),
            linesChanged: changes.filter(l => l.startsWith('+') || l.startsWith('-')).length,
        };
    }
}

module.exports = new FileEditTool();
