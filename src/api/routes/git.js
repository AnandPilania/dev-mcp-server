const express = require('express');
const router = express.Router();
const GitTool = require('../../tools/GitTool');
const logger = require('../../utils/logger');

/** GET /api/git/status */
router.get('/status', async (req, res) => {
  const { cwd } = req.query;
  try {
    const status = await GitTool.status(cwd);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/git/diff */
router.get('/diff', async (req, res) => {
  const { cwd, staged, file, stat } = req.query;
  try {
    const result = await GitTool.diff({ cwd, staged: staged === 'true', file, stat: stat === 'true' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/git/commit */
router.post('/commit', async (req, res) => {
  const { cwd, files, message, autoMessage } = req.body;
  try {
    const result = await GitTool.commit({ cwd, files, message, autoMessage });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/git/review */
router.post('/review', async (req, res) => {
  const { cwd, staged, file, focus } = req.body;
  try {
    const result = await GitTool.review({ cwd, staged, file, focus });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/git/log */
router.get('/log', async (req, res) => {
  const { cwd, limit, file, oneline } = req.query;
  try {
    const result = await GitTool.log({ cwd, limit: parseInt(limit) || 10, file, oneline: oneline === 'true' });
    res.json({ commits: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/git/branches */
router.get('/branches', async (req, res) => {
  const { cwd } = req.query;
  try {
    const result = await GitTool.branches(cwd);
    res.json({ branches: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
