'use strict';
const express = require('express');
const logger  = require('../../utils/logger');

// ── PLUGINS ───────────────────────────────────────────────────────────────────
const pluginsRouter = express.Router();
const pluginManager = require('../../plugins/pluginManager');

pluginsRouter.get('/', (req, res) => res.json({ plugins: pluginManager.list(), stats: pluginManager.getStats() }));
pluginsRouter.get('/:name', (req, res) => {
  const p = pluginManager.get(req.params.name);
  if (!p) return res.status(404).json({ error: 'Plugin not found' });
  res.json(p);
});
pluginsRouter.post('/:name/enable', (req, res) => {
  try { res.json(pluginManager.enable(req.params.name)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
pluginsRouter.post('/:name/disable', (req, res) => {
  try { res.json(pluginManager.disable(req.params.name)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports.pluginsRouter = pluginsRouter;

// ── WORKTREES ─────────────────────────────────────────────────────────────────
const worktreesRouter = express.Router();
const wm = require('../../worktrees/worktreeManager');

worktreesRouter.get('/', async (req, res) => {
  try { res.json({ worktrees: await wm.list(req.query.cwd), stats: wm.getStats() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
worktreesRouter.post('/', async (req, res) => {
  const { name, branch, cwd, createBranch } = req.body;
  if (!name || !branch) return res.status(400).json({ error: 'name and branch required' });
  try { res.status(201).json(await wm.create(name, branch, { cwd, createBranch })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
worktreesRouter.get('/:name', (req, res) => {
  const wt = wm.get(req.params.name);
  if (!wt) return res.status(404).json({ error: 'Worktree not found' });
  res.json(wt);
});
worktreesRouter.get('/:name/diff', async (req, res) => {
  try { res.json(await wm.diff(req.params.name)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
worktreesRouter.get('/:name/log', async (req, res) => {
  try { res.json({ log: await wm.log(req.params.name, req.query.limit) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
worktreesRouter.post('/:name/commit', async (req, res) => {
  try { res.json(await wm.commit(req.params.name, req.body.message)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
worktreesRouter.delete('/:name', async (req, res) => {
  try { res.json(await wm.remove(req.params.name, { force: req.query.force === 'true' })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports.worktreesRouter = worktreesRouter;

// ── CRON ──────────────────────────────────────────────────────────────────────
const cronRouter = express.Router();
const cron = require('../../cron/cronScheduler');

cronRouter.get('/', (req, res) => res.json({ jobs: cron.list(), stats: cron.getStats() }));
cronRouter.post('/', (req, res) => {
  try { res.status(201).json(cron.create(req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
cronRouter.get('/:name', (req, res) => {
  const job = cron.list().find(j => j.name === req.params.name);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});
cronRouter.patch('/:name', (req, res) => {
  try { res.json(cron.update(req.params.name, req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
cronRouter.post('/:name/run', async (req, res) => {
  try { res.json(await cron.runNow(req.params.name)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
cronRouter.get('/:name/history', (req, res) => {
  res.json({ runs: cron.getRunHistory(req.params.name, req.query.limit) });
});
cronRouter.delete('/:name', (req, res) => {
  try { res.json({ success: cron.delete(req.params.name) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports.cronRouter = cronRouter;

// ── MESSAGING ─────────────────────────────────────────────────────────────────
const messagesRouter = express.Router();
const { MessageBus, PRIORITY } = require('../../messaging/messageBus');

messagesRouter.post('/', (req, res) => {
  try { res.status(201).json(MessageBus.send(req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
messagesRouter.post('/broadcast', (req, res) => {
  try { res.json({ messages: MessageBus.broadcast(req.body) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
messagesRouter.get('/inbox/:agent', (req, res) => {
  res.json({
    messages: MessageBus.inbox(req.params.agent, {
      unreadOnly: req.query.unread === 'true',
      priority:   req.query.priority,
      limit:      parseInt(req.query.limit) || 50,
    }),
  });
});
messagesRouter.get('/sent/:agent', (req, res) => {
  res.json({ messages: MessageBus.sentBy(req.params.agent) });
});
messagesRouter.post('/:id/read', (req, res) => {
  try { res.json(MessageBus.markRead(parseInt(req.params.id))); }
  catch (e) { res.status(404).json({ error: e.message }); }
});
messagesRouter.post('/inbox/:agent/read-all', (req, res) => {
  res.json({ read: MessageBus.markAllRead(req.params.agent) });
});
messagesRouter.post('/:id/reply', (req, res) => {
  try { res.json(MessageBus.reply(parseInt(req.params.id), req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
messagesRouter.delete('/:id', (req, res) => {
  res.json({ success: MessageBus.delete(parseInt(req.params.id)) });
});
messagesRouter.get('/stats/overview', (req, res) => {
  res.json({ stats: MessageBus.getStats(), priorities: PRIORITY });
});

module.exports.messagesRouter = messagesRouter;

// ── TEAM MEMORY ───────────────────────────────────────────────────────────────
const teamMemRouter = express.Router();
const teamMemory = require('../../memory/teamMemory');

teamMemRouter.get('/', (req, res) => {
  const entries = teamMemory.get(req.query.team || 'global', {
    type:  req.query.type,
    limit: parseInt(req.query.limit) || 50,
  });
  res.json({ entries, stats: teamMemory.getStats() });
});
teamMemRouter.post('/', (req, res) => {
  try { res.status(201).json(teamMemory.add(req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
teamMemRouter.get('/search', (req, res) => {
  if (!req.query.q) return res.status(400).json({ error: 'q required' });
  res.json({ results: teamMemory.search(req.query.q, req.query.team) });
});
teamMemRouter.get('/teams', (req, res) => {
  res.json({ teams: teamMemory.listTeams() });
});
teamMemRouter.delete('/:id', (req, res) => {
  res.json({ success: teamMemory.delete(req.params.id) });
});
teamMemRouter.delete('/', (req, res) => {
  if (!req.query.team) return res.status(400).json({ error: 'team query param required' });
  teamMemory.clearTeam(req.query.team);
  res.json({ success: true });
});

module.exports.teamMemRouter = teamMemRouter;

// ── CONTEXT VISUALIZER ────────────────────────────────────────────────────────
const contextVizRouter = express.Router();
const contextVisualizer = require('../../context/contextVisualizer');

contextVizRouter.post('/visualize', (req, res) => {
  const { query, mode, topK, team } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });
  try {
    const viz = contextVisualizer.visualize(query, { mode, topK, team });
    res.json(viz);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

contextVizRouter.post('/visualize/text', (req, res) => {
  const { query, mode, topK } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });
  try {
    const viz  = contextVisualizer.visualize(query, { mode, topK });
    const text = contextVisualizer.format(viz);
    res.type('text/plain').send(text);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports.contextVizRouter = contextVizRouter;
