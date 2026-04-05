const express = require('express');
const router = express.Router();
const { TaskManager, STATUS, PRIORITY } = require('../../tasks/taskManager');

/** GET /api/tasks */
router.get('/', (req, res) => {
  const { status, priority, tags, assignee, includeDone } = req.query;
  const tasks = TaskManager.list({
    status, priority,
    tags: tags ? tags.split(',') : undefined,
    assignee,
    includeDone: includeDone === 'true',
  });
  res.json({ tasks, stats: TaskManager.getStats() });
});

/** POST /api/tasks */
router.post('/', (req, res) => {
  try {
    const task = TaskManager.create(req.body);
    res.status(201).json({ success: true, task });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** GET /api/tasks/:id */
router.get('/:id', (req, res) => {
  const task = TaskManager.get(parseInt(req.params.id));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(task);
});

/** PATCH /api/tasks/:id */
router.patch('/:id', (req, res) => {
  try {
    const task = TaskManager.update(parseInt(req.params.id), req.body);
    res.json({ success: true, task });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** POST /api/tasks/:id/notes */
router.post('/:id/notes', (req, res) => {
  const { note } = req.body;
  if (!note) return res.status(400).json({ error: 'note is required' });
  try {
    const task = TaskManager.addNote(parseInt(req.params.id), note);
    res.json({ success: true, task });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** DELETE /api/tasks/:id */
router.delete('/:id', (req, res) => {
  const deleted = TaskManager.delete(parseInt(req.params.id));
  res.json({ success: deleted });
});

/** GET /api/tasks/meta/constants */
router.get('/meta/constants', (req, res) => {
  res.json({ STATUS, PRIORITY });
});

module.exports = router;
