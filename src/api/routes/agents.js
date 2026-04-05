const express = require('express');
const router = express.Router();
const specialists = require('../../agents/specialists');
const taskDecomposer = require('../../agents/taskDecomposer');
const teamCoordinator = require('../../agents/teamCoordinator');
const dreamer = require('../../agents/dreamer');
const improver = require('../../agents/improver');
const indexer = require('../../core/indexer');
const logger = require('../../utils/logger');

/** POST /api/agents/:name — run a specialist agent directly */
router.post('/:name', async (req, res) => {
  const { name } = req.params;
  const { task, topK = 8, sessionId } = req.body;
  if (!task) return res.status(400).json({ error: 'task is required' });

  const agentKey = Object.keys(specialists).find(
    k => k.toLowerCase() === name.toLowerCase() || k.toLowerCase().replace('agent', '') === name.toLowerCase()
  );
  const agent = specialists[agentKey];
  if (!agent) {
    return res.status(404).json({
      error: `Agent not found: ${name}`,
      available: Object.keys(specialists),
    });
  }

  try {
    const context = indexer.search(task, topK);
    const result = await agent.run(task, { context, sessionId });
    res.json(result);
  } catch (err) {
    logger.error(`Agent ${name} error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/agents — list all available agents */
router.get('/', (req, res) => {
  res.json({
    agents: Object.keys(specialists).map(name => ({
      name,
      role: specialists[name].role,
      model: specialists[name].model,
      stats: specialists[name].getStats(),
    })),
  });
});

/** POST /api/agents/:name/reset — reset agent history */
router.post('/:name/reset', (req, res) => {
  const agent = specialists[req.params.name];
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  agent.reset();
  res.json({ success: true });
});

// ── DECOMPOSER ──────────────────────────────────────────────────────────────────

/** POST /api/agents/decompose/run — decompose and run a complex task */
router.post('/decompose/run', async (req, res) => {
  const { task, parallel = false, sessionId, maxSubtasks = 4 } = req.body;
  if (!task) return res.status(400).json({ error: 'task is required' });
  try {
    const result = await taskDecomposer.decomposeAndRun(task, { parallel, sessionId, maxSubtasks });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/agents/decompose/plan — decompose only, no execution */
router.post('/decompose/plan', async (req, res) => {
  const { task, sessionId } = req.body;
  if (!task) return res.status(400).json({ error: 'task is required' });
  try {
    const subtasks = await taskDecomposer.decompose(task, sessionId);
    res.json({ task, subtasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── TEAMS ───────────────────────────────────────────────────────────────────────

/** GET /api/agents/teams/list */
router.get('/teams/list', (req, res) => {
  res.json({ teams: teamCoordinator.getAvailableTeams() });
});

/** POST /api/agents/teams/:name — run a named team */
router.post('/teams/:name', async (req, res) => {
  const { task, sessionId } = req.body;
  if (!task) return res.status(400).json({ error: 'task is required' });
  try {
    const result = await teamCoordinator.runTeam(req.params.name, task, { sessionId });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/agents/teams/auto — auto-select and run the best team */
router.post('/teams/auto', async (req, res) => {
  const { task, sessionId } = req.body;
  if (!task) return res.status(400).json({ error: 'task is required' });
  try {
    const result = await teamCoordinator.autoRun(task, { sessionId });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/agents/teams/custom — run a custom team */
router.post('/teams/custom', async (req, res) => {
  const { agents: agentNames, task, sessionId, sequential = true } = req.body;
  if (!task || !agentNames?.length) return res.status(400).json({ error: 'task and agents[] are required' });
  try {
    const result = await teamCoordinator.runCustomTeam(agentNames, task, { sessionId, sequential });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DREAMER ─────────────────────────────────────────────────────────────────────

/** GET /api/agents/dreamer/status */
router.get('/dreamer/status', (req, res) => {
  res.json(dreamer.getStatus());
});

/** POST /api/agents/dreamer/start — start background dreaming */
router.post('/dreamer/start', (req, res) => {
  const { intervalMinutes = 30 } = req.body;
  dreamer.start(intervalMinutes);
  res.json({ success: true, message: `Dreamer started (every ${intervalMinutes} min)` });
});

/** POST /api/agents/dreamer/stop */
router.post('/dreamer/stop', (req, res) => {
  dreamer.stop();
  res.json({ success: true });
});

/** POST /api/agents/dreamer/now — run a dream cycle immediately */
router.post('/dreamer/now', async (req, res) => {
  try {
    const result = await dreamer.dreamNow();
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── IMPROVER ────────────────────────────────────────────────────────────────────

/** GET /api/agents/improver/summary */
router.get('/improver/summary', (req, res) => {
  res.json(improver.getSummary());
});

/** POST /api/agents/improver/feedback */
router.post('/improver/feedback', (req, res) => {
  const { queryId, rating, comment } = req.body;
  if (!queryId || rating === undefined) return res.status(400).json({ error: 'queryId and rating required' });
  const entry = improver.recordFeedback(queryId, rating, comment);
  res.json({ success: true, entry });
});

module.exports = router;
