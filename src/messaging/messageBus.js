'use strict';
/**
 * A lightweight in-process message bus allowing agents to communicate.
 * Each agent has an inbox. Messages can be sent with priority levels.
 *
 * Used when:
 *  - DebugAgent finds a security issue → notifies SecurityAgent
 *  - PlannerAgent creates tasks → notifies the right specialist
 *  - TeamCoordinator broadcasts findings to all agents
 *  - Cron jobs need to alert about findings
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const MSG_FILE = path.join(process.cwd(), 'data', 'messages.json');

const PRIORITY = { LOW: 'low', NORMAL: 'normal', HIGH: 'high', URGENT: 'urgent' };

class MessageBus {
    constructor() {
        this._store = this._load();
        this._subscribers = new Map(); // agentName → callback[]
    }

    _load() {
        try { if (fs.existsSync(MSG_FILE)) return JSON.parse(fs.readFileSync(MSG_FILE, 'utf-8')); } catch { }
        return { messages: [], nextId: 1 };
    }
    _save() { fs.writeFileSync(MSG_FILE, JSON.stringify(this._store, null, 2)); }

    /**
     * Send a message from one agent to another
     */
    send({ from, to, content, priority = PRIORITY.NORMAL, metadata = {}, replyTo }) {
        if (!from || !to || !content) throw new Error('from, to, content required');

        const msg = {
            id: this._store.nextId++,
            from,
            to,
            content,
            priority,
            metadata,
            replyTo: replyTo || null,
            sentAt: new Date().toISOString(),
            readAt: null,
            read: false,
        };

        this._store.messages.push(msg);

        // Keep last 500 messages
        if (this._store.messages.length > 500) {
            this._store.messages = this._store.messages.slice(-500);
        }

        this._save();
        logger.info(`[MsgBus] ${from} → ${to}: "${content.slice(0, 60)}" [${priority}]`);

        // Notify live subscribers (real-time delivery)
        const subs = this._subscribers.get(to) || [];
        for (const cb of subs) {
            try { cb(msg); } catch { }
        }

        return msg;
    }

    /**
     * Broadcast to all agents (or a list)
     */
    broadcast({ from, content, to: recipients, priority = PRIORITY.NORMAL, metadata = {} }) {
        const all = recipients || ['DebugAgent', 'ArchitectureAgent', 'SecurityAgent', 'DocumentationAgent', 'RefactorAgent', 'PerformanceAgent', 'TestAgent', 'DevOpsAgent', 'DataAgent', 'PlannerAgent'];
        return all.map(to => this.send({ from, to, content, priority, metadata }));
    }

    /**
     * Get inbox for an agent
     */
    inbox(agentName, opts = {}) {
        const { unreadOnly = false, priority, limit = 50 } = opts;
        let msgs = this._store.messages.filter(m => m.to === agentName);
        if (unreadOnly) msgs = msgs.filter(m => !m.read);
        if (priority) msgs = msgs.filter(m => m.priority === priority);
        return msgs
            .sort((a, b) => {
                const pOrder = { urgent: 0, high: 1, normal: 2, low: 3 };
                return (pOrder[a.priority] ?? 2) - (pOrder[b.priority] ?? 2);
            })
            .slice(-limit)
            .reverse();
    }

    /**
     * Get all messages from a specific sender
     */
    sentBy(agentName, limit = 20) {
        return this._store.messages
            .filter(m => m.from === agentName)
            .slice(-limit)
            .reverse();
    }

    /**
     * Mark a message as read
     */
    markRead(id) {
        const msg = this._store.messages.find(m => m.id === id);
        if (!msg) throw new Error(`Message ${id} not found`);
        msg.read = true;
        msg.readAt = new Date().toISOString();
        this._save();
        return msg;
    }

    markAllRead(agentName) {
        let count = 0;
        const now = new Date().toISOString();
        for (const msg of this._store.messages) {
            if (msg.to === agentName && !msg.read) {
                msg.read = true; msg.readAt = now; count++;
            }
        }
        this._save();
        return count;
    }

    /**
     * Reply to a message
     */
    reply(originalId, { from, content, priority = PRIORITY.NORMAL }) {
        const original = this._store.messages.find(m => m.id === originalId);
        if (!original) throw new Error(`Message ${originalId} not found`);
        return this.send({ from, to: original.from, content, priority, replyTo: originalId });
    }

    /**
     * Subscribe to live messages for an agent (callback-based)
     */
    subscribe(agentName, callback) {
        if (!this._subscribers.has(agentName)) this._subscribers.set(agentName, []);
        this._subscribers.get(agentName).push(callback);
        return () => {
            const subs = this._subscribers.get(agentName) || [];
            this._subscribers.set(agentName, subs.filter(c => c !== callback));
        };
    }

    delete(id) {
        const before = this._store.messages.length;
        this._store.messages = this._store.messages.filter(m => m.id !== id);
        this._save();
        return before !== this._store.messages.length;
    }

    clearInbox(agentName) {
        this._store.messages = this._store.messages.filter(m => m.to !== agentName);
        this._save();
    }

    getStats() {
        const msgs = this._store.messages;
        return {
            total: msgs.length,
            unread: msgs.filter(m => !m.read).length,
            byAgent: [...new Set(msgs.map(m => m.to))].map(a => ({
                agent: a,
                unread: msgs.filter(m => m.to === a && !m.read).length,
                total: msgs.filter(m => m.to === a).length,
            })),
        };
    }
}

module.exports = { MessageBus: new MessageBus(), PRIORITY };
