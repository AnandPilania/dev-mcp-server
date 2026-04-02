const express = require('express');
const router = express.Router();
const store = require('../../storage/store');
const indexer = require('../../core/indexer');

router.get('/stats', (req, res) => {
    const stats = store.getStats();
    res.json(stats);
});

router.get('/search', (req, res) => {
    const { q, topK = '8', kind } = req.query;

    if (!q) {
        return res.status(400).json({ error: 'q query parameter is required' });
    }

    const filter = kind ? { kind } : {};
    const results = indexer.search(q, parseInt(topK), filter);

    res.json({
        query: q,
        count: results.length,
        results: results.map(r => ({
            file: r.filename,
            path: r.filePath,
            kind: r.kind,
            relevanceScore: r.relevanceScore,
            snippet: r.content.slice(0, 300) + (r.content.length > 300 ? '...' : ''),
            metadata: r.metadata,
        })),
    });
});

router.get('/files', (req, res) => {
    const { kind } = req.query;
    const docs = kind ? store.getByKind(kind) : store.getAll();

    const grouped = {};
    for (const doc of docs) {
        if (!grouped[doc.filePath]) {
            grouped[doc.filePath] = {
                filePath: doc.filePath,
                filename: doc.filename,
                kind: doc.kind,
                chunks: 0,
                ingestedAt: doc.ingestedAt,
                metadata: doc.metadata,
            };
        }
        grouped[doc.filePath].chunks++;
    }

    res.json({
        count: Object.keys(grouped).length,
        files: Object.values(grouped),
    });
});

router.post('/rebuild', (req, res) => {
    const count = indexer.build();
    res.json({ success: true, documentsIndexed: count });
});

module.exports = router;
