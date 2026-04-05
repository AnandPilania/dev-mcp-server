const express = require('express');
const router = express.Router();
const BashTool = require('../../tools/BashTool');
const GrepTool = require('../../tools/GrepTool');
const logger = require('../../utils/logger');

/** POST /api/tools/bash  — execute a shell command */
router.post('/bash', async (req, res) => {
  const { command, cwd, timeout, approved } = req.body;
  if (!command) return res.status(400).json({ error: 'command is required' });

  const permission = BashTool.checkPermission(command);
  if (permission === 'dangerous') {
    return res.status(403).json({ error: 'Command blocked: dangerous pattern detected', permission });
  }
  if (permission === 'needs-approval' && !approved) {
    return res.status(202).json({ needsApproval: true, command, permission,
      message: 'Set approved:true in body to execute, or grant permission via /api/tools/bash/permit' });
  }

  try {
    const result = await BashTool.execute(command, { cwd, timeout, approved: true });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/tools/bash/permit  — grant permission for a command */
router.post('/bash/permit', (req, res) => {
  const { command, level } = req.body;
  if (!command) return res.status(400).json({ error: 'command is required' });
  BashTool.grantPermission(command, level || 'session');
  res.json({ success: true, command, level: level || 'session' });
});

/** GET /api/tools/grep  — search codebase */
router.get('/grep', async (req, res) => {
  const { pattern, cwd, glob, ignoreCase, maxResults, contextLines, literal } = req.query;
  if (!pattern) return res.status(400).json({ error: 'pattern is required' });

  try {
    const result = await GrepTool.search(pattern, {
      cwd, glob, ignoreCase: ignoreCase === 'true',
      maxResults: parseInt(maxResults) || 50,
      contextLines: parseInt(contextLines) || 2,
      literal: literal === 'true',
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/tools/grep/definitions/:symbol  — find symbol definitions */
router.get('/grep/definitions/:symbol', async (req, res) => {
  try {
    const matches = await GrepTool.findDefinitions(req.params.symbol, req.query.cwd);
    res.json({ symbol: req.params.symbol, matches, count: matches.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/tools/grep/imports/:module  — find all imports of a module */
router.get('/grep/imports/:module', async (req, res) => {
  try {
    const result = await GrepTool.findImports(req.params.module, req.query.cwd);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/tools/grep/todos  — find all TODO/FIXME comments */
router.get('/grep/todos', async (req, res) => {
  try {
    const result = await GrepTool.findTodos(req.query.cwd);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
