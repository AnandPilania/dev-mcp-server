const express = require('express');
const router = express.Router();
const { MemoryManager, MEMORY_TYPES } = require('../../memory/memoryManager');

/** GET /api/memory — list all memories */
router.get('/', (req, res) => {
  const { type } = req.query;
  const memories = MemoryManager.list(type || null);
  res.json({ memories, stats: MemoryManager.getStats() });
});

/** POST /api/memory — add a memory manually */
router.post('/', (req, res) => {
  const { content, type, tags } = req.body;
  if (!content) return res.status(400).json({ error: 'content is required' });
  try {
    const entry = MemoryManager.add(content, type || MEMORY_TYPES.FACT, tags || []);
    res.json({ success: true, entry });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /api/memory/:id — delete a memory */
router.delete('/:id', (req, res) => {
  const deleted = MemoryManager.delete(req.params.id);
  res.json({ success: deleted });
});

/** DELETE /api/memory — clear all memories */
router.delete('/', (req, res) => {
  MemoryManager.clear();
  res.json({ success: true, message: 'All memories cleared' });
});

/** GET /api/memory/types — list valid memory types */
router.get('/types', (req, res) => {
  res.json({ types: Object.values(MEMORY_TYPES) });
});

module.exports = router;
