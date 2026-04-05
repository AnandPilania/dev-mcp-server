// ── skills.js ──────────────────────────────────────────────────────────────────
const express = require('express');
const skillsRouter = express.Router();
const skillsManager = require('../../skills/skillsManager');

skillsRouter.get('/', (req, res) => res.json({ skills: skillsManager.list(req.query) }));
skillsRouter.post('/', (req, res) => {
  try { res.json({ skill: skillsManager.create(req.body.name, req.body.description, req.body.prompt, req.body.tags) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
skillsRouter.post('/:name', async (req, res) => {
  const { target, sessionId, extraContext } = req.body;
  if (!target) return res.status(400).json({ error: 'target is required' });
  try { res.json(await skillsManager.run(req.params.name, target, { sessionId, extraContext })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
skillsRouter.delete('/:name', (req, res) => {
  try { res.json({ success: skillsManager.delete(req.params.name) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
module.exports.skillsRouter = skillsRouter;

// ── lsp.js ─────────────────────────────────────────────────────────────────────
const lspRouter = express.Router();
const symbolNavigator = require('../../lsp/symbolNavigator');

lspRouter.get('/definition/:symbol', async (req, res) => {
  try { res.json(await symbolNavigator.goToDefinition(req.params.symbol, req.query.cwd)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
lspRouter.get('/references/:symbol', async (req, res) => {
  try { res.json(await symbolNavigator.findReferences(req.params.symbol, req.query.cwd)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
lspRouter.post('/hover', async (req, res) => {
  try { res.json(await symbolNavigator.hover(req.body.symbol, req.body.filePath, req.body.sessionId)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
lspRouter.get('/outline', async (req, res) => {
  if (!req.query.path) return res.status(400).json({ error: 'path is required' });
  try { res.json(await symbolNavigator.outline(req.query.path)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
lspRouter.get('/symbols', async (req, res) => {
  if (!req.query.q) return res.status(400).json({ error: 'q is required' });
  try { res.json(await symbolNavigator.workspaceSymbols(req.query.q, req.query.cwd)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
lspRouter.post('/rename', async (req, res) => {
  const { oldName, newName, cwd } = req.body;
  if (!oldName || !newName) return res.status(400).json({ error: 'oldName and newName required' });
  try { res.json(await symbolNavigator.renameSymbol(oldName, newName, cwd)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
module.exports.lspRouter = lspRouter;

// ── files.js ───────────────────────────────────────────────────────────────────
const filesRouter = express.Router();
const FileEditTool = require('../../tools/FileEditTool');

filesRouter.get('/read', (req, res) => {
  if (!req.query.path) return res.status(400).json({ error: 'path is required' });
  try { res.json(FileEditTool.read(req.query.path, { startLine: req.query.startLine, endLine: req.query.endLine })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
filesRouter.post('/str-replace', async (req, res) => {
  const { filePath, oldStr, newStr, dryRun, backup } = req.body;
  if (!filePath || !oldStr) return res.status(400).json({ error: 'filePath and oldStr required' });
  try { res.json(await FileEditTool.strReplace(filePath, oldStr, newStr || '', { dryRun, backup })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
filesRouter.post('/insert-after', async (req, res) => {
  const { filePath, afterStr, insertText, dryRun } = req.body;
  if (!filePath || !afterStr || !insertText) return res.status(400).json({ error: 'filePath, afterStr, insertText required' });
  try { res.json(await FileEditTool.insertAfter(filePath, afterStr, insertText, { dryRun })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
filesRouter.post('/rewrite', async (req, res) => {
  const { filePath, content, dryRun, backup } = req.body;
  if (!filePath || !content) return res.status(400).json({ error: 'filePath and content required' });
  try { res.json(await FileEditTool.rewrite(filePath, content, { dryRun, backup })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
filesRouter.post('/ai-edit', async (req, res) => {
  const { filePath, instruction, dryRun, sessionId } = req.body;
  if (!filePath || !instruction) return res.status(400).json({ error: 'filePath and instruction required' });
  try { res.json(await FileEditTool.aiEdit(filePath, instruction, { dryRun, sessionId })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
filesRouter.post('/undo', (req, res) => {
  if (!req.body.filePath) return res.status(400).json({ error: 'filePath required' });
  try { res.json(FileEditTool.undo(req.body.filePath)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
module.exports.filesRouter = filesRouter;

// ── monitor.js ─────────────────────────────────────────────────────────────────
const monitorRouter = express.Router();
const { ProactiveMonitor } = require('../../monitor/proactiveMonitor');

monitorRouter.get('/status', (req, res) => res.json(ProactiveMonitor.getStatus()));
monitorRouter.get('/alerts', (req, res) => {
  const { severity, unacknowledged, limit } = req.query;
  res.json({ alerts: ProactiveMonitor.getAlerts({ severity, unacknowledged: unacknowledged === 'true', limit: parseInt(limit) || 50 }) });
});
monitorRouter.post('/run-all', async (req, res) => {
  try { res.json({ results: await ProactiveMonitor.runAll() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
monitorRouter.post('/run/:checkId', async (req, res) => {
  try { res.json(await ProactiveMonitor.runCheck(req.params.checkId)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
monitorRouter.post('/alerts/:id/acknowledge', (req, res) => {
  try { res.json(ProactiveMonitor.acknowledge(req.params.id)); }
  catch (e) { res.status(404).json({ error: e.message }); }
});
monitorRouter.post('/acknowledge-all', (req, res) => {
  const count = ProactiveMonitor.acknowledgeAll();
  res.json({ success: true, acknowledged: count });
});
monitorRouter.post('/start', (req, res) => {
  ProactiveMonitor.start(req.body.cwd);
  res.json({ success: true, message: 'Monitor started' });
});
monitorRouter.post('/stop', (req, res) => {
  ProactiveMonitor.stop();
  res.json({ success: true });
});
module.exports.monitorRouter = monitorRouter;

// ── conversation.js ────────────────────────────────────────────────────────────
const convRouter = express.Router();
const conversationEngine = require('../../core/conversationEngine');

convRouter.post('/', async (req, res) => {
  const { message, convId, sessionId, topK } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });
  try { res.json(await conversationEngine.chat(message, convId || 'default', { sessionId, topK })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
convRouter.post('/follow-up', async (req, res) => {
  const { message, convId, sessionId } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });
  try { res.json(await conversationEngine.followUp(message, convId || 'default', { sessionId })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
convRouter.get('/', (req, res) => res.json({ conversations: conversationEngine.list() }));
convRouter.get('/:id/history', (req, res) => res.json({ history: conversationEngine.getHistory(req.params.id) }));
convRouter.delete('/:id', (req, res) => { conversationEngine.reset(req.params.id); res.json({ success: true }); });
module.exports.convRouter = convRouter;

// ── watcher.js ─────────────────────────────────────────────────────────────────
const watcherRouter = express.Router();
const fileWatcher = require('../../watcher/fileWatcher');

watcherRouter.get('/status', (req, res) => res.json(fileWatcher.getStatus()));
watcherRouter.post('/watch', (req, res) => {
  if (!req.body.path) return res.status(400).json({ error: 'path is required' });
  try { res.json(fileWatcher.watch(req.body.path)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
watcherRouter.post('/unwatch', (req, res) => {
  if (!req.body.path) return res.status(400).json({ error: 'path is required' });
  res.json({ success: fileWatcher.unwatch(req.body.path) });
});
watcherRouter.post('/stop', (req, res) => { fileWatcher.stopAll(); res.json({ success: true }); });
module.exports.watcherRouter = watcherRouter;
