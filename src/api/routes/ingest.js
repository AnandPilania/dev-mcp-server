const express = require('express');
const router = express.Router();
const ingester = require('../../core/ingester');
const indexer = require('../../core/indexer');
const store = require('../../storage/store');
const logger = require('../../utils/logger');

router.post('/file', async (req, res) => {
    const { filePath } = req.body;

    if (!filePath) {
        return res.status(400).json({ error: 'filePath is required' });
    }

    try {
        const result = await ingester.ingestFile(filePath);
        indexer.build();
        res.json({ success: true, result });
    } catch (err) {
        logger.error(`Ingest file error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

router.post('/directory', async (req, res) => {
    const { dirPath } = req.body;

    if (!dirPath) {
        return res.status(400).json({ error: 'dirPath is required' });
    }

    try {
        const result = await ingester.ingestDirectory(dirPath);
        res.json({ success: true, result });
    } catch (err) {
        logger.error(`Ingest directory error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

router.post('/raw', async (req, res) => {
    const { content, kind, label, tags } = req.body;

    if (!content) {
        return res.status(400).json({ error: 'content is required' });
    }

    try {
        const result = await ingester.ingestRawText(content, { kind, label, tags });
        indexer.build();
        res.json({ success: true, result });
    } catch (err) {
        logger.error(`Ingest raw error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

router.delete('/clear', (req, res) => {
    store.clear();
    indexer.invalidate();
    res.json({ success: true, message: 'Knowledge base cleared' });
});

router.get('/files', (req, res) => {
    const files = store.getIngestedFiles();
    res.json({ files, count: files.length });
});

module.exports = router;
