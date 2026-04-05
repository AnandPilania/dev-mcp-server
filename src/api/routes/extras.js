'use strict';
const express = require('express');
const logger  = require('../../utils/logger');

// ── TOOL REGISTRY ROUTES ──────────────────────────────────────────────────────
const toolsRegistryRouter = express.Router();
const registry = require('../../tools/registry');

toolsRegistryRouter.get('/', (req, res) => {
  res.json({ count: registry.count, tools: registry.list() });
});

toolsRegistryRouter.get('/groups', (req, res) => {
  const groups = {};
  for (const t of registry.list()) {
    (groups[t.group] = groups[t.group] || []).push(t.name);
  }
  res.json(groups);
});

toolsRegistryRouter.post('/execute', async (req, res) => {
  const { tool, input } = req.body;
  if (!tool || !input) return res.status(400).json({ error: 'tool and input required' });
  try {
    const result = await registry.execute(tool, input);
    res.json({ tool, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports.toolsRegistryRouter = toolsRegistryRouter;

// ── PROMPT ENGINEERING ROUTES ─────────────────────────────────────────────────
const promptsRouter = express.Router();
const pe = require('../../prompts/promptEngineer');

promptsRouter.get('/templates', (req, res) => {
  res.json({ templates: pe.listTemplates() });
});
promptsRouter.get('/templates/:name', (req, res) => {
  const t = pe.getTemplate(req.params.name);
  if (!t) return res.status(404).json({ error: 'Template not found' });
  res.json(t);
});
promptsRouter.post('/templates', (req, res) => {
  const { name, description, template, variables } = req.body;
  if (!name || !template) return res.status(400).json({ error: 'name and template required' });
  try { res.json(pe.saveTemplate(name, description, template, variables)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
promptsRouter.delete('/templates/:name', (req, res) => {
  try { res.json({ success: pe.deleteTemplate(req.params.name) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
promptsRouter.post('/apply', (req, res) => {
  const { template, variables } = req.body;
  if (!template) return res.status(400).json({ error: 'template required' });
  try { res.json({ result: pe.applyTemplate(template, variables || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
promptsRouter.post('/cot', (req, res) => {
  const { prompt, style } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  res.json({ result: pe.injectCoT(prompt, style) });
});
promptsRouter.post('/analyse', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  try { res.json(await pe.analyse(prompt, req.body)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
promptsRouter.post('/improve', async (req, res) => {
  const { prompt, goal, style } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  try { res.json(await pe.improve(prompt, { goal, style, sessionId: req.body.sessionId })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
promptsRouter.post('/generate', async (req, res) => {
  const { task, type, model, includeExamples } = req.body;
  if (!task) return res.status(400).json({ error: 'task required' });
  try { res.json(await pe.generate(task, { type, model, includeExamples, sessionId: req.body.sessionId })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
promptsRouter.post('/ab-test', async (req, res) => {
  const { promptA, promptB, testInput } = req.body;
  if (!promptA || !promptB || !testInput) return res.status(400).json({ error: 'promptA, promptB, testInput required' });
  try { res.json(await pe.abTest(promptA, promptB, testInput, req.body)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports.promptsRouter = promptsRouter;

// ── COMPACTOR ROUTES ──────────────────────────────────────────────────────────
const compactorRouter = express.Router();
const compactor = require('../../context/compactor');

compactorRouter.post('/compact', async (req, res) => {
  const { messages, sessionId, force } = req.body;
  if (!messages?.length) return res.status(400).json({ error: 'messages array required' });
  try { res.json(await compactor.compact(messages, { sessionId, force })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
compactorRouter.post('/deep-compact', async (req, res) => {
  const { messages, sessionId } = req.body;
  if (!messages?.length) return res.status(400).json({ error: 'messages array required' });
  try { res.json(await compactor.deepCompact(messages, { sessionId })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
compactorRouter.post('/check', (req, res) => {
  const { messages } = req.body;
  res.json(compactor.needsCompaction(messages || []));
});

module.exports.compactorRouter = compactorRouter;
