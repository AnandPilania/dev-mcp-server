const express = require('express');
const router = express.Router();
const pipelineEngine = require('../../pipelines/pipelineEngine');
const logger = require('../../utils/logger');

/** GET /api/pipelines — list all available pipelines and steps */
router.get('/', (req, res) => {
  res.json({
    pipelines: pipelineEngine.getAvailablePipelines(),
    availableSteps: pipelineEngine.getAvailableSteps(),
  });
});

/** POST /api/pipelines/:name — run a named pipeline */
router.post('/:name', async (req, res) => {
  const { task, sessionId, topK, ...rest } = req.body;
  if (!task) return res.status(400).json({ error: 'task is required' });

  try {
    const result = await pipelineEngine.run(req.params.name, { task, ...rest }, { sessionId, topK });
    res.json(result);
  } catch (err) {
    logger.error(`Pipeline error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/pipelines/custom/run — run a custom steps pipeline */
router.post('/custom/run', async (req, res) => {
  const { steps, task, sessionId, topK, ...rest } = req.body;
  if (!task || !steps?.length) return res.status(400).json({ error: 'task and steps[] are required' });

  try {
    const result = await pipelineEngine.runCustom(steps, { task, ...rest }, { sessionId, topK });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
