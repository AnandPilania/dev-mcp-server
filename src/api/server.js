require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const logger = require('../utils/logger');
const indexer = require('../core/indexer');
const store = require('../storage/store');

const ingestRoutes = require('./routes/ingest');
const queryRoutes = require('./routes/query');
const knowledgeRoutes = require('./routes/knowledge');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(morgan('dev', {
    stream: { write: (msg) => logger.info(msg.trim()) },
}));

app.use('/api/ingest', ingestRoutes);
app.use('/api/query', queryRoutes);
app.use('/api/knowledge', knowledgeRoutes);

app.get('/health', (req, res) => {
    const stats = store.getStats();
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        knowledgeBase: stats,
    });
});

app.get('/', (req, res) => {
    res.json({
        name: 'Dev MCP Server — Model Context Platform',
        version: '1.0.0',
        description: 'AI that understands YOUR codebase',
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
        },
    });
});

app.use((req, res) => {
    res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

app.use((err, req, res, next) => {
    logger.error(`Unhandled error: ${err.message}`);
    res.status(500).json({ error: 'Internal server error', detail: err.message });
});

app.listen(PORT, () => {
    logger.info(`🚀 Dev MCP Server running on http://localhost:${PORT}`);
    logger.info(`📚 Knowledge base: ${store.getStats().totalDocs} documents`);

    const stats = store.getStats();
    if (stats.totalDocs > 0) {
        logger.info('🔍 Rebuilding search index...');
        const count = indexer.build();
        logger.info(`✅ Index ready: ${count} documents`);
    } else {
        logger.info('📭 Knowledge base is empty — run: node cli.js ingest <path>');
    }
});

module.exports = app;
