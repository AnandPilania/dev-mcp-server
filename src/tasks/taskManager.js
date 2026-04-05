/**
 * Lightweight task tracker that integrates with the query engine.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const TASKS_FILE = path.join(process.cwd(), 'data', 'tasks.json');

const STATUS = { TODO: 'todo', IN_PROGRESS: 'in_progress', DONE: 'done', BLOCKED: 'blocked' };
const PRIORITY = { LOW: 'low', MEDIUM: 'medium', HIGH: 'high', CRITICAL: 'critical' };

class TaskManager {
    constructor() {
        this._data = this._load();
    }

    _load() {
        try {
            if (fs.existsSync(TASKS_FILE)) return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8'));
        } catch { }
        return { tasks: [], nextId: 1 };
    }

    _save() {
        fs.writeFileSync(TASKS_FILE, JSON.stringify(this._data, null, 2));
    }

    /**
     * Create a new task
     */
    create(options = {}) {
        const {
            title,
            description = '',
            priority = PRIORITY.MEDIUM,
            tags = [],
            linkedFiles = [],
            linkedQuery = null,
            assignee = null,
        } = options;

        if (!title) throw new Error('Task title is required');

        const task = {
            id: this._data.nextId++,
            title: title.trim(),
            description: description.trim(),
            status: STATUS.TODO,
            priority,
            tags,
            linkedFiles,
            linkedQuery,
            assignee,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            completedAt: null,
            notes: [],
        };

        this._data.tasks.push(task);
        this._save();
        logger.info(`[Tasks] Created #${task.id}: ${task.title}`);
        return task;
    }

    /**
     * Update a task
     */
    update(id, updates = {}) {
        const task = this._data.tasks.find(t => t.id === id);
        if (!task) throw new Error(`Task #${id} not found`);

        const allowed = ['title', 'description', 'status', 'priority', 'tags', 'linkedFiles', 'assignee'];
        for (const key of allowed) {
            if (updates[key] !== undefined) task[key] = updates[key];
        }

        task.updatedAt = new Date().toISOString();
        if (updates.status === STATUS.DONE && !task.completedAt) {
            task.completedAt = new Date().toISOString();
        }

        this._save();
        return task;
    }

    /**
     * Add a note to a task
     */
    addNote(id, note) {
        const task = this._data.tasks.find(t => t.id === id);
        if (!task) throw new Error(`Task #${id} not found`);
        task.notes.push({ text: note, addedAt: new Date().toISOString() });
        task.updatedAt = new Date().toISOString();
        this._save();
        return task;
    }

    /**
     * Get tasks with optional filters
     */
    list(filters = {}) {
        let tasks = [...this._data.tasks];
        if (filters.status) tasks = tasks.filter(t => t.status === filters.status);
        if (filters.priority) tasks = tasks.filter(t => t.priority === filters.priority);
        if (filters.tags?.length) tasks = tasks.filter(t => filters.tags.some(tag => t.tags.includes(tag)));
        if (filters.assignee) tasks = tasks.filter(t => t.assignee === filters.assignee);
        if (!filters.includeDone) tasks = tasks.filter(t => t.status !== STATUS.DONE);

        // Sort: critical > high > medium > low, then by date
        const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
        tasks.sort((a, b) => {
            const pdiff = (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2);
            if (pdiff !== 0) return pdiff;
            return new Date(b.createdAt) - new Date(a.createdAt);
        });

        return tasks;
    }

    get(id) {
        return this._data.tasks.find(t => t.id === id) || null;
    }

    delete(id) {
        const before = this._data.tasks.length;
        this._data.tasks = this._data.tasks.filter(t => t.id !== id);
        this._save();
        return before !== this._data.tasks.length;
    }

    getStats() {
        const tasks = this._data.tasks;
        const byStatus = {};
        const byPriority = {};
        for (const t of tasks) {
            byStatus[t.status] = (byStatus[t.status] || 0) + 1;
            byPriority[t.priority] = (byPriority[t.priority] || 0) + 1;
        }
        return {
            total: tasks.length,
            byStatus,
            byPriority,
            overdue: tasks.filter(t => t.status !== STATUS.DONE && t.dueDate && new Date(t.dueDate) < new Date()).length,
        };
    }
}

module.exports = { TaskManager: new TaskManager(), STATUS, PRIORITY };
