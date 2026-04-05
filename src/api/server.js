require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const logger = require('../utils/logger');
const dreamer = require('../agents/dreamer');
const improver = require('../agents/improver');
const cronScheduler = require('../cron/cronScheduler');
const pluginManager = require('../plugins/pluginManager');
const llm = require('../utils/llmClient');
const store = require('../storage/store');

// Routes
const ingestRoutes = require('./routes/ingest');
const queryRoutes = require('./routes/query');
const knowledgeRoutes = require('./routes/knowledge');
const gitRoutes = require('./routes/git');
const toolsRoutes = require('./routes/tools');
const memoryRoutes = require('./routes/memory');
const tasksRoutes = require('./routes/tasks');
const sessionsRoutes = require('./routes/sessions');
const plannerRoutes = require('./routes/planner');
const agentsRoutes = require('./routes/agents');
const pipelinesRoutes = require('./routes/pipelines');
const { skillsRouter, lspRouter, filesRouter, monitorRouter, convRouter, watcherRouter } = require('./routes/newRoutes');
const { toolsRegistryRouter, promptsRouter, compactorRouter } = require('./routes/extras');
const { pluginsRouter, worktreesRouter, cronRouter, messagesRouter, teamMemRouter, contextVizRouter } = require('./routes/v5routes');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(morgan('dev', {
    stream: { write: (msg) => logger.info(msg.trim()) },
}));

// ── Routes ────────────────────────────────────────────────────
app.use('/api/ingest', ingestRoutes);
app.use('/api/query', queryRoutes);
app.use('/api/knowledge', knowledgeRoutes);
app.use('/api/git', gitRoutes);
app.use('/api/tools', toolsRoutes);
app.use('/api/memory', memoryRoutes);
app.use('/api/tasks', tasksRoutes);
app.use('/api/sessions', sessionsRoutes);
app.use('/api', plannerRoutes); // /api/plan, /api/cost
app.use('/api/agents', agentsRoutes);
app.use('/api/pipelines', pipelinesRoutes);
app.use('/api/skills', skillsRouter);
app.use('/api/lsp', lspRouter);
app.use('/api/files', filesRouter);
app.use('/api/monitor', monitorRouter);
app.use('/api/chat', convRouter);
app.use('/api/watcher', watcherRouter);
app.use('/api/registry', toolsRegistryRouter);
app.use('/api/prompts', promptsRouter);
app.use('/api/compact', compactorRouter);
app.use('/api/plugins', pluginsRouter);
app.use('/api/worktrees', worktreesRouter);
app.use('/api/cron', cronRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/team-memory', teamMemRouter);
app.use('/api/context', contextVizRouter);

// ── Dashboard (single-file HTML UI) ──────────────────────────────────────────
const path = require('path');
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, '../dashboard/index.html'));
});

// ── LLM provider info ────────────────────────────────────────────────────────
app.get('/api/llm/info', (req, res) => res.json(llm.getInfo()));

// ── Health check ──────────────────────────────────────────────
app.get('/health', (req, res) => {
    const stats = store.getStats();
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        knowledgeBase: stats,
    });
});

// ── Root info ─────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({
        name: 'Dev MCP Server — Model Context Platform',
        version: '1.0.0',
        description: '45 tools · 10 agents · 10 teams · Dreamer · Compactor · Prompt Engineering · Plugins · Cron · Worktrees · Messaging',
        endpoints: {
            health: 'GET /health',
            ingest: {
                file: 'POST /api/ingest/file',
                directory: 'POST /api/ingest/directory',
                raw: 'POST /api/ingest/raw',
                clear: 'DELETE /api/ingest/clear',
                listFiles: 'GET /api/ingest/files',
            },
            query: {
                general: 'POST /api/query',
                debug: 'POST /api/query/debug',
                usage: 'POST /api/query/usage',
                impact: 'POST /api/query/impact',
                stream: 'POST /api/query/stream',
            },
            knowledge: {
                stats: 'GET /api/knowledge/stats',
                search: 'GET /api/knowledge/search?q=<query>',
                files: 'GET /api/knowledge/files',
                rebuild: 'POST /api/knowledge/rebuild',
            },
            git: {
                status: 'GET /api/git/status',
                diff: 'GET /api/git/diff',
                commit: 'POST /api/git/commit',
                review: 'POST /api/git/review',
                log: 'GET /api/git/log',
                branches: 'GET /api/git/branches',
            },
            tools: {
                bash: 'POST /api/tools/bash',
                bashPermit: 'POST /api/tools/bash/permit',
                grep: 'GET /api/tools/grep?pattern=<pattern>',
                definitions: 'GET /api/tools/grep/definitions/:symbol',
                imports: 'GET /api/tools/grep/imports/:module',
                todos: 'GET /api/tools/grep/todos',
            },
            memory: {
                list: 'GET /api/memory',
                add: 'POST /api/memory',
                delete: 'DELETE /api/memory/:id',
                clear: 'DELETE /api/memory',
            },
            tasks: {
                list: 'GET /api/tasks',
                create: 'POST /api/tasks',
                get: 'GET /api/tasks/:id',
                update: 'PATCH /api/tasks/:id',
                addNote: 'POST /api/tasks/:id/notes',
                delete: 'DELETE /api/tasks/:id',
            },
            sessions: {
                list: 'GET /api/sessions',
                create: 'POST /api/sessions',
                resume: 'GET /api/sessions/:id',
                addMessage: 'POST /api/sessions/:id/messages',
                export: 'GET /api/sessions/:id/export',
                delete: 'DELETE /api/sessions/:id',
            },
            planner: {
                plan: 'POST /api/plan',
                compact: 'POST /api/plan/compact',
                doctor: 'GET /api/plan/doctor',
                cost: 'GET /api/cost',
            },
        },
    });
});

// ── 404 ───────────────────────────────────────────────────────
app.use((req, res) => {
    res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// ── Error handler ─────────────────────────────────────────────
app.use((err, req, res, next) => {
    logger.error(`Unhandled error: ${err.message}`);
    res.status(500).json({ error: 'Internal server error', detail: err.message });
});

// ── Boot ──────────────────────────────────────────────────────
app.listen(PORT, async () => {
    logger.info(`🚀 Dev MCP Server running on http://localhost:${PORT}`);
    logger.info(`📚 Knowledge base: ${store.getStats().totalDocs} documents`);

    // Auto-build index if data exists
    const stats = store.getStats();
    if (stats.totalDocs > 0) {
        logger.info('🔍 Rebuilding search index...');
        const indexer = require('../core/indexer');
        const count = indexer.build();
        logger.info(`✅ Index ready: ${count} documents`);
    } else {
        logger.info('📭 Knowledge base is empty — run: node cli.js ingest <path>');
    }

    // Start the Dreamer for background cognitive work
    if (process.env.ENABLE_DREAMER !== 'false') {
        const intervalMin = parseInt(process.env.DREAM_INTERVAL_MINUTES) || 30;
        dreamer.start(intervalMin);
        logger.info(`💤 Dreamer started (every ${intervalMin} min)`);
    }

    // Start Cron Scheduler
    if (process.env.ENABLE_CRON !== 'false') {
        cronScheduler.start();
        logger.info(`⏰ Cron scheduler started`);
    }

    // Load Plugins
    const toolRegistry = require('../tools/registry');
    await pluginManager.loadAll(app, {
        toolRegistry,
        store,
        indexer: require('../core/indexer'),
        memoryManager: require('../memory/memoryManager').MemoryManager,
    });
    logger.info(`🔌 Plugins: ${pluginManager.getStats().enabled} enabled`);
    if (process.env.ENABLE_MONITOR !== 'false') {
        const { ProactiveMonitor } = require('../monitor/proactiveMonitor');
        ProactiveMonitor.start(process.cwd());
        logger.info(`👁️  Proactive monitor started`);
    }
});

module.exports = app;
