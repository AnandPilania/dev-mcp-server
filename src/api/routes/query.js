const express = require('express');
const router = express.Router();
const { QueryEngine, QUERY_MODES } = require('../../core/queryEngine');
const logger = require('../../utils/logger');

router.post('/', async (req, res) => {
    const { question, topK, filter, mode } = req.body;

    if (!question) {
        return res.status(400).json({ error: 'question is required' });
    }

    try {
        const result = await QueryEngine.query(question, { topK, filter, mode });
        res.json(result);
    } catch (err) {
        logger.error(`Query error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

router.post('/debug', async (req, res) => {
    const { error, stackTrace, question, topK } = req.body;

    if (!error && !question) {
        return res.status(400).json({ error: 'error or question is required' });
    }

    try {
        let result;
        if (error) {
            result = await QueryEngine.debugError(error, stackTrace, { topK });
        } else {
            result = await QueryEngine.query(question, { mode: QUERY_MODES.DEBUG, topK });
        }
        res.json(result);
    } catch (err) {
        logger.error(`Debug query error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

router.post('/usage', async (req, res) => {
    const { symbol, topK } = req.body;

    if (!symbol) {
        return res.status(400).json({ error: 'symbol is required' });
    }

    try {
        const result = await QueryEngine.findUsages(symbol, { topK });
        res.json(result);
    } catch (err) {
        logger.error(`Usage query error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

router.post('/impact', async (req, res) => {
    const { target, changeDescription, topK } = req.body;

    if (!target) {
        return res.status(400).json({ error: 'target is required' });
    }

    try {
        const result = await QueryEngine.analyzeImpact(target, changeDescription, { topK });
        res.json(result);
    } catch (err) {
        logger.error(`Impact query error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

router.post('/stream', async (req, res) => {
    const { question, topK, mode } = req.body;

    if (!question) {
        return res.status(400).json({ error: 'question is required' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    try {
        const generator = await QueryEngine.query(question, { topK, mode, stream: true });

        for await (const chunk of generator) {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);

            if (chunk.type === 'done') {
                res.end();
                return;
            }
        }
    } catch (err) {
        logger.error(`Stream query error: ${err.message}`);
        res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
        res.end();
    }
});

module.exports = router;
