/**
 * Continuous improvement without explicit prompts.
 * Tracks which answers were helpful, learns from patterns in queries,
 * and adapts retrieval weights over time.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { MemoryManager } = require('../memory/memoryManager');

const FEEDBACK_FILE = path.join(process.cwd(), 'data', 'feedback.json');
const QUERY_STATS_FILE = path.join(process.cwd(), 'data', 'query-stats.json');

class Improver {
    constructor() {
        this._feedback = this._load(FEEDBACK_FILE, { entries: [], stats: {} });
        this._queryStats = this._load(QUERY_STATS_FILE, {
            totalQueries: 0,
            byMode: {},
            commonTerms: {},
            sourceEffectiveness: {}, // filePath → helpfulness score
            retrieval: { avgChunks: 0, avgScore: 0 },
        });
    }

    _load(file, def) {
        try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { }
        return def;
    }
    _save(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

    /**
     * Record feedback on an answer (thumbs up/down + optional text)
     */
    recordFeedback(queryId, rating, comment = '') {
        const entry = {
            queryId,
            rating,        // 1 = helpful, -1 = not helpful, 0 = neutral
            comment,
            timestamp: new Date().toISOString(),
        };
        this._feedback.entries.push(entry);

        // Update stats
        this._feedback.stats.total = (this._feedback.stats.total || 0) + 1;
        this._feedback.stats.positive = (this._feedback.stats.positive || 0) + (rating > 0 ? 1 : 0);
        this._feedback.stats.negative = (this._feedback.stats.negative || 0) + (rating < 0 ? 1 : 0);

        this._save(FEEDBACK_FILE, this._feedback);
        logger.info(`[Improver] Feedback recorded: ${rating > 0 ? '👍' : rating < 0 ? '👎' : '😐'} for ${queryId}`);

        // Trigger learning if we have enough feedback
        if (this._feedback.entries.length % 10 === 0) {
            this._learnFromFeedback().catch(() => { });
        }

        return entry;
    }

    /**
     * Record a query event for pattern learning
     */
    recordQuery({ queryId, question, mode, sources, answer, durationMs }) {
        this._queryStats.totalQueries++;

        // Track mode frequency
        this._queryStats.byMode[mode] = (this._queryStats.byMode[mode] || 0) + 1;

        // Track term frequency (for improving retrieval)
        const terms = question.toLowerCase().split(/\W+/).filter(t => t.length > 3);
        for (const term of terms) {
            this._queryStats.commonTerms[term] = (this._queryStats.commonTerms[term] || 0) + 1;
        }

        // Track which sources are frequently retrieved (= probably important files)
        if (sources) {
            for (const src of sources) {
                if (!this._queryStats.sourceEffectiveness[src.path]) {
                    this._queryStats.sourceEffectiveness[src.path] = { retrievals: 0, helpfulCount: 0 };
                }
                this._queryStats.sourceEffectiveness[src.path].retrievals++;
            }
        }

        // Running average for chunk stats
        const n = this._queryStats.totalQueries;
        const srcCount = sources?.length || 0;
        this._queryStats.retrieval.avgChunks =
            ((this._queryStats.retrieval.avgChunks * (n - 1)) + srcCount) / n;

        this._save(QUERY_STATS_FILE, this._queryStats);
    }

    /**
     * Get the most frequently retrieved (therefore most important) files
     * Used to boost their ingestion priority
     */
    getHotFiles(limit = 10) {
        return Object.entries(this._queryStats.sourceEffectiveness)
            .sort(([, a], [, b]) => b.retrievals - a.retrievals)
            .slice(0, limit)
            .map(([path, stats]) => ({ path, ...stats }));
    }

    /**
     * Get the most common query terms — useful for seeing what devs struggle with
     */
    getTopTerms(limit = 20) {
        return Object.entries(this._queryStats.commonTerms)
            .sort(([, a], [, b]) => b - a)
            .slice(0, limit)
            .map(([term, count]) => ({ term, count }));
    }

    /**
     * Learn from accumulated feedback — update memory weights and system config
     */
    async _learnFromFeedback() {
        const recent = this._feedback.entries.slice(-20);
        const negatives = recent.filter(e => e.rating < 0);

        if (negatives.length < 3) return;

        logger.info(`[Improver] Learning from ${negatives.length} negative feedbacks`);

        // Add a memory about what kinds of answers aren't working
        if (negatives.length >= 3) {
            const comments = negatives
                .filter(e => e.comment)
                .map(e => e.comment)
                .join('; ');

            if (comments) {
                MemoryManager.add(
                    `Improvement needed: users found answers unhelpful in these areas: ${comments}`,
                    'preference',
                    ['improver-feedback']
                );
            }
        }
    }

    /**
     * Get a dashboard summary of system health & improvement metrics
     */
    getSummary() {
        const total = this._feedback.stats.total || 0;
        const positive = this._feedback.stats.positive || 0;
        const negative = this._feedback.stats.negative || 0;
        const satisfactionRate = total > 0 ? ((positive / total) * 100).toFixed(1) : 'N/A';

        return {
            queries: {
                total: this._queryStats.totalQueries,
                byMode: this._queryStats.byMode,
                avgContextChunks: this._queryStats.retrieval.avgChunks.toFixed(1),
            },
            feedback: {
                total,
                positive,
                negative,
                satisfactionRate: total > 0 ? `${satisfactionRate}%` : 'No feedback yet',
            },
            topTerms: this.getTopTerms(10),
            hotFiles: this.getHotFiles(5),
        };
    }

    getFeedbackStats() {
        return this._feedback.stats;
    }
}

module.exports = new Improver();
