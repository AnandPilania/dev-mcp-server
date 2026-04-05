/**
 * Saves full conversation history and context so sessions can be resumed later.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const SESSIONS_DIR = path.join(process.cwd(), 'data', 'sessions');

class SessionManager {
    constructor() {
        this._ensureDir();
        this._active = new Map(); // sessionId -> { messages, meta }
    }

    _ensureDir() {
        if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    }

    _sessionFile(id) {
        return path.join(SESSIONS_DIR, `${id}.json`);
    }

    /**
     * Create a new session
     */
    create(options = {}) {
        const { name = null, context = {} } = options;
        const id = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const session = {
            id,
            name: name || `Session ${new Date().toLocaleString()}`,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            messages: [],          // { role, content, mode, sources, timestamp }
            context,               // metadata about what was ingested, etc.
            stats: { queries: 0, totalTokens: 0, totalCostUsd: 0 },
        };
        this._active.set(id, session);
        this._save(session);
        logger.info(`[Session] Created: ${id} "${session.name}"`);
        return session;
    }

    /**
     * Add a message to a session
     */
    addMessage(sessionId, message) {
        const session = this._getOrLoad(sessionId);
        if (!session) throw new Error(`Session not found: ${sessionId}`);

        session.messages.push({
            ...message,
            timestamp: new Date().toISOString(),
        });
        session.stats.queries++;
        if (message.tokens) session.stats.totalTokens += message.tokens;
        if (message.costUsd) session.stats.totalCostUsd += message.costUsd;
        session.updatedAt = new Date().toISOString();

        this._save(session);
        return session;
    }

    /**
     * Get conversation history for a session (for context compaction)
     */
    getHistory(sessionId, limit = 20) {
        const session = this._getOrLoad(sessionId);
        if (!session) return [];
        return session.messages.slice(-limit);
    }

    /**
     * Resume a session — returns session + last N messages
     */
    resume(sessionId) {
        const session = this._getOrLoad(sessionId);
        if (!session) throw new Error(`Session not found: ${sessionId}`);
        logger.info(`[Session] Resumed: ${sessionId}`);
        return {
            ...session,
            resumedAt: new Date().toISOString(),
        };
    }

    /**
     * List all saved sessions
     */
    list() {
        this._ensureDir();
        const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
        return files.map(f => {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf-8'));
                return {
                    id: data.id,
                    name: data.name,
                    createdAt: data.createdAt,
                    updatedAt: data.updatedAt,
                    messageCount: data.messages?.length || 0,
                    stats: data.stats,
                };
            } catch { return null; }
        }).filter(Boolean).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    }

    /**
     * Delete a session
     */
    delete(sessionId) {
        this._active.delete(sessionId);
        const file = this._sessionFile(sessionId);
        if (fs.existsSync(file)) {
            fs.unlinkSync(file);
            return true;
        }
        return false;
    }

    /**
     * Export a session as markdown (for sharing)
     */
    exportMarkdown(sessionId) {
        const session = this._getOrLoad(sessionId);
        if (!session) throw new Error(`Session not found: ${sessionId}`);

        const lines = [
            `# Session: ${session.name}`,
            `> Created: ${session.createdAt} | Queries: ${session.stats.queries}`,
            '',
        ];

        for (const msg of session.messages) {
            const role = msg.role === 'user' ? '**You**' : '**MCP**';
            const mode = msg.mode ? ` _(${msg.mode})_` : '';
            lines.push(`### ${role}${mode}`);
            lines.push(msg.content);
            if (msg.sources?.length) {
                lines.push('');
                lines.push(`*Sources: ${msg.sources.map(s => s.file).join(', ')}*`);
            }
            lines.push('');
        }

        return lines.join('\n');
    }

    _getOrLoad(id) {
        if (this._active.has(id)) return this._active.get(id);
        const file = this._sessionFile(id);
        if (!fs.existsSync(file)) return null;
        try {
            const session = JSON.parse(fs.readFileSync(file, 'utf-8'));
            this._active.set(id, session);
            return session;
        } catch { return null; }
    }

    _save(session) {
        fs.writeFileSync(this._sessionFile(session.id), JSON.stringify(session, null, 2));
    }
}

module.exports = new SessionManager();
