'use strict';
/**
 * Schedule any agent task to run automatically on a cron schedule.
 * Results are saved to memory + create tasks for any action items found.
 *
 * Schedule format: standard cron (minute hour day month weekday)
 * Examples:
 *   "0 9 * * 1-5"   — 9am weekdays
 *   "0 0 * * *"     — midnight daily
 *   "0/30 * * * *"  — every 30 minutes
 *   "@daily"        — once a day
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const CRON_FILE = path.join(process.cwd(), 'data', 'cron-jobs.json');
const RUN_LOG = path.join(process.cwd(), 'data', 'cron-runs.json');

// Minimal cron parser — converts cron expr to ms interval
function parseCronInterval(schedule) {
    const presets = {
        '@hourly': 3600000,
        '@daily': 86400000,
        '@weekly': 604800000,
        '@monthly': 2592000000,
    };
    if (presets[schedule]) return presets[schedule];

    // For simplicity, support "every N minutes" patterns
    const parts = schedule.split(' ');
    if (parts.length === 5) {
        const minute = parts[0];
        if (minute.startsWith('*/')) return parseInt(minute.slice(2)) * 60000;
        if (minute.startsWith('0/')) return parseInt(minute.slice(2)) * 60000;
        // Default: run once per day
        return 86400000;
    }
    return 3600000; // fallback: hourly
}

class CronScheduler {
    constructor() {
        this._jobs = this._loadJobs();
        this._handles = new Map();  // jobName → setInterval handle
        this._running = false;
        this._runLog = this._loadRunLog();
    }

    _loadJobs() {
        try { if (fs.existsSync(CRON_FILE)) return JSON.parse(fs.readFileSync(CRON_FILE, 'utf-8')); } catch { }
        return {};
    }
    _saveJobs() { fs.writeFileSync(CRON_FILE, JSON.stringify(this._jobs, null, 2)); }

    _loadRunLog() {
        try { if (fs.existsSync(RUN_LOG)) return JSON.parse(fs.readFileSync(RUN_LOG, 'utf-8')); } catch { }
        return { runs: [] };
    }
    _saveRunLog() {
        if (this._runLog.runs.length > 200) this._runLog.runs = this._runLog.runs.slice(-200);
        fs.writeFileSync(RUN_LOG, JSON.stringify(this._runLog, null, 2));
    }

    /**
     * Create and register a new cron job
     */
    create(opts = {}) {
        const {
            name,
            schedule,
            task,
            agent = 'DebugAgent',
            enabled = true,
            description = '',
            team,         // use a team instead of single agent
            pipeline,     // use a pipeline instead
        } = opts;

        if (!name || !schedule || !task) throw new Error('name, schedule, task are required');
        if (this._jobs[name]) throw new Error(`Job "${name}" already exists`);

        const job = {
            name,
            schedule,
            task,
            agent: team ? null : (pipeline ? null : agent),
            team: team || null,
            pipeline: pipeline || null,
            description,
            enabled,
            createdAt: new Date().toISOString(),
            lastRun: null,
            lastStatus: null,
            runCount: 0,
        };

        this._jobs[name] = job;
        this._saveJobs();

        if (enabled && this._running) {
            this._schedule(job);
        }

        logger.info(`[Cron] Created: ${name} (${schedule}) → ${agent || team || pipeline}`);
        return job;
    }

    /**
     * Start the scheduler — register all enabled jobs
     */
    start() {
        if (this._running) return;
        this._running = true;
        let scheduled = 0;
        for (const job of Object.values(this._jobs)) {
            if (job.enabled) { this._schedule(job); scheduled++; }
        }
        logger.info(`[Cron] ⏰ Started: ${scheduled} job(s) scheduled`);
    }

    stop() {
        for (const handle of this._handles.values()) clearInterval(handle);
        this._handles.clear();
        this._running = false;
        logger.info('[Cron] Stopped');
    }

    _schedule(job) {
        if (this._handles.has(job.name)) return;
        const intervalMs = parseCronInterval(job.schedule);
        const handle = setInterval(() => this._run(job), intervalMs);
        this._handles.set(job.name, handle);
        logger.info(`[Cron] Scheduled: ${job.name} every ${intervalMs / 60000}min`);
    }

    /**
     * Run a job immediately (manual trigger)
     */
    async runNow(name) {
        const job = this._jobs[name];
        if (!job) throw new Error(`Job not found: ${name}`);
        return this._run(job);
    }

    async _run(job) {
        const startTime = Date.now();
        logger.info(`[Cron] Running: ${job.name}`);

        const runRecord = {
            jobName: job.name,
            startedAt: new Date().toISOString(),
            status: 'running',
            durationMs: 0,
            result: null,
            error: null,
        };

        try {
            let result;

            if (job.pipeline) {
                const pipelineEngine = require('../pipelines/pipelineEngine');
                result = await pipelineEngine.run(job.pipeline, { task: job.task });
                runRecord.result = result.finalOutput?.answer?.slice(0, 300) || 'Pipeline complete';
            } else if (job.team) {
                const teamCoordinator = require('../agents/teamCoordinator');
                result = await teamCoordinator.runTeam(job.team, job.task, { sessionId: `cron_${job.name}` });
                runRecord.result = result.report?.slice(0, 300) || 'Team run complete';
            } else {
                const agents = require('../agents/specialists');
                const agent = agents[job.agent] || agents['DebugAgent'];
                const indexer = require('../core/indexer');
                const context = indexer.search(job.task, 6);
                result = await agent.run(job.task, { context, sessionId: `cron_${job.name}` });
                runRecord.result = result.answer?.slice(0, 300);
            }

            runRecord.status = 'success';
            runRecord.durationMs = Date.now() - startTime;

            // Update job metadata
            this._jobs[job.name].lastRun = runRecord.startedAt;
            this._jobs[job.name].lastStatus = 'success';
            this._jobs[job.name].runCount = (this._jobs[job.name].runCount || 0) + 1;
            this._saveJobs();

            // Save outcome to memory for the dreamer
            const { MemoryManager } = require('../memory/memoryManager');
            MemoryManager.add(
                `Cron job "${job.name}" result: ${runRecord.result}`,
                'fact',
                ['cron', job.name]
            );

        } catch (err) {
            runRecord.status = 'error';
            runRecord.error = err.message;
            runRecord.durationMs = Date.now() - startTime;
            this._jobs[job.name].lastStatus = 'error';
            this._saveJobs();
            logger.error(`[Cron] ${job.name} failed: ${err.message}`);
        }

        this._runLog.runs.push(runRecord);
        this._saveRunLog();
        return runRecord;
    }

    update(name, updates = {}) {
        const job = this._jobs[name];
        if (!job) throw new Error(`Job not found: ${name}`);
        const allowed = ['schedule', 'task', 'agent', 'enabled', 'description'];
        for (const k of allowed) { if (updates[k] !== undefined) job[k] = updates[k]; }
        this._saveJobs();

        // Re-schedule if running state changed
        if (updates.enabled === true && this._running && !this._handles.has(name)) {
            this._schedule(job);
        } else if (updates.enabled === false) {
            clearInterval(this._handles.get(name));
            this._handles.delete(name);
        }

        return job;
    }

    delete(name) {
        if (!this._jobs[name]) throw new Error(`Job not found: ${name}`);
        clearInterval(this._handles.get(name));
        this._handles.delete(name);
        delete this._jobs[name];
        this._saveJobs();
        return true;
    }

    list() {
        return Object.values(this._jobs);
    }

    getRunHistory(name, limit = 20) {
        return this._runLog.runs
            .filter(r => !name || r.jobName === name)
            .slice(-limit)
            .reverse();
    }

    getStats() {
        const jobs = Object.values(this._jobs);
        return {
            total: jobs.length,
            enabled: jobs.filter(j => j.enabled).length,
            running: this._running,
            totalRuns: this._runLog.runs.length,
        };
    }
}

module.exports = new CronScheduler();
