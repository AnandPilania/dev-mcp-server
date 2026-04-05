'use strict';
/**
 * Built-in plugin: stats-plugin
 * Adds /api/stats/overview — a single endpoint that aggregates everything.
 */
module.exports = {
    name: 'stats-plugin',
    version: '1.0.0',
    description: 'Adds /api/stats/overview endpoint aggregating all system stats',
    async register(app, { store, toolRegistry }) {
        app.get('/api/stats/overview', async (req, res) => {
            try {
                const kbStats = store ? store.getStats() : {};
                const { MemoryManager } = require('../../memory/memoryManager');
                const { TaskManager } = require('../../tasks/taskManager');
                const costTracker = require('../../utils/costTracker');
                res.json({
                    version: '1.0.0',
                    knowledgeBase: kbStats,
                    memory: MemoryManager.getStats(),
                    tasks: TaskManager.getStats(),
                    cost: costTracker.getSummary(),
                    tools: toolRegistry ? toolRegistry.count : 0,
                    uptime: process.uptime(),
                });
            } catch (e) { res.status(500).json({ error: e.message }); }
        });
    },
};
