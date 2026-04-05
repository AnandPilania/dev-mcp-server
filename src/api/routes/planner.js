const express = require('express');
const router = express.Router();
const plannerEngine = require('../../planner/plannerEngine');
const costTracker = require('../../utils/costTracker');
const indexer = require('../../core/indexer');
const logger = require('../../utils/logger');

/** POST /api/plan — generate an execution plan for a task */
router.post('/', async (req, res) => {
  const { task, sessionId } = req.body;
  if (!task) return res.status(400).json({ error: 'task is required' });

  try {
    // Retrieve relevant context chunks for the plan
    const context = indexer.search(task, 6);
    const plan = await plannerEngine.generatePlan(task, context, sessionId);
    res.json(plan);
  } catch (err) {
    logger.error(`Plan error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/plan/compact — compact a conversation history */
router.post('/compact', async (req, res) => {
  const { messages, sessionId } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array is required' });
  }
  try {
    const result = await plannerEngine.compact(messages, sessionId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/plan/doctor — environment health check */
router.get('/doctor', async (req, res) => {
  try {
    const result = await plannerEngine.doctor();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/cost — get cost summary */
router.get('/cost', (req, res) => {
  const { sessionId } = req.query;
  res.json(costTracker.getSummary(sessionId || 'default'));
});

module.exports = router;
