const express = require('express');
const router = express.Router();
const sessionManager = require('../../sessions/sessionManager');

/** GET /api/sessions — list all sessions */
router.get('/', (req, res) => {
  res.json({ sessions: sessionManager.list() });
});

/** POST /api/sessions — create a new session */
router.post('/', (req, res) => {
  const session = sessionManager.create(req.body);
  res.status(201).json({ success: true, session });
});

/** GET /api/sessions/:id — get / resume a session */
router.get('/:id', (req, res) => {
  try {
    const session = sessionManager.resume(req.params.id);
    res.json(session);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

/** POST /api/sessions/:id/messages — append a message */
router.post('/:id/messages', (req, res) => {
  try {
    const session = sessionManager.addMessage(req.params.id, req.body);
    res.json({ success: true, messageCount: session.messages.length });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

/** GET /api/sessions/:id/export — export as markdown */
router.get('/:id/export', (req, res) => {
  try {
    const md = sessionManager.exportMarkdown(req.params.id);
    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', `attachment; filename="session-${req.params.id}.md"`);
    res.send(md);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

/** DELETE /api/sessions/:id */
router.delete('/:id', (req, res) => {
  const deleted = sessionManager.delete(req.params.id);
  res.json({ success: deleted });
});

module.exports = router;
