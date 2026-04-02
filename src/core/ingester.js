const path = require('path');
const fs = require('fs');
const { glob } = require('glob');
const { parseFile, shouldSkip, FILE_TYPE_MAP } = require('../utils/fileParser');
const store = require('../storage/store');
const indexer = require('./indexer');
const logger = require('../utils/logger');

class Ingester {
    async ingestFile(filePath) {
        const absPath = path.resolve(filePath);

        if (!fs.existsSync(absPath)) {
            throw new Error(`File not found: ${absPath}`);
        }

        if (shouldSkip(absPath)) {
            logger.warn(`Skipping: ${absPath}`);
            return { skipped: true };
        }

        const ext = path.extname(absPath).toLowerCase();
        if (!FILE_TYPE_MAP[ext]) {
            logger.warn(`Unsupported file type: ${ext}`);
            return { skipped: true, reason: 'unsupported type' };
        }

        const stat = fs.statSync(absPath);
        if (stat.size > 500 * 1024) { // skip files > 500KB
            logger.warn(`File too large (${(stat.size / 1024).toFixed(0)}KB): ${absPath}`);
            return { skipped: true, reason: 'file too large' };
        }

        try {
            store.removeByPath(absPath);

            const chunks = parseFile(absPath);
            if (chunks.length === 0) {
                return { skipped: true, reason: 'empty file' };
            }

            const result = store.upsertDocs(chunks);

            indexer.invalidate();

            logger.info(`Ingested: ${path.basename(absPath)} (${chunks.length} chunk(s))`);
            return { success: true, file: absPath, chunks: chunks.length, ...result };

        } catch (err) {
            logger.error(`Failed to ingest ${absPath}: ${err.message}`);
            throw err;
        }
    }

    async ingestDirectory(dirPath, options = {}) {
        const absDir = path.resolve(dirPath);

        if (!fs.existsSync(absDir)) {
            throw new Error(`Directory not found: ${absDir}`);
        }

        const extensions = Object.keys(FILE_TYPE_MAP).map(e => e.slice(1));
        const pattern = `**/*.{${extensions.join(',')}}`;

        logger.info(`Scanning: ${absDir}`);
        const files = await glob(pattern, {
            cwd: absDir,
            absolute: true,
            ignore: [
                '**/node_modules/**',
                '**/.git/**',
                '**/dist/**',
                '**/build/**',
                '**/coverage/**',
                '**/*.min.js',
                '**/package-lock.json',
                '**/yarn.lock',
            ],
        });

        logger.info(`Found ${files.length} files to process`);

        const results = {
            total: files.length,
            ingested: 0,
            skipped: 0,
            failed: 0,
            totalChunks: 0,
            errors: [],
        };

        for (const file of files) {
            try {
                const result = await this.ingestFile(file);
                if (result.skipped) {
                    results.skipped++;
                } else {
                    results.ingested++;
                    results.totalChunks += result.chunks || 0;
                }
            } catch (err) {
                results.failed++;
                results.errors.push({ file, error: err.message });
            }

            if ((results.ingested + results.skipped) % 50 === 0) {
                logger.info(`Progress: ${results.ingested + results.skipped}/${files.length}`);
            }
        }

        const docCount = indexer.build();
        logger.info(`Index rebuilt with ${docCount} documents`);

        return results;
    }

    async ingestRawText(content, options = {}) {
        const {
            kind = 'documentation',
            label = 'manual-entry',
            tags = [],
        } = options;

        if (!content || content.trim().length === 0) {
            throw new Error('Content cannot be empty');
        }

        const id = `raw::${label}::${Date.now()}`;
        const doc = {
            id,
            filePath: `raw://${label}`,
            filename: label,
            ext: '.txt',
            kind,
            chunkIndex: 0,
            totalChunks: 1,
            content: content.trim(),
            lines: content.split('\n').length,
            ingestedAt: new Date().toISOString(),
            metadata: {
                isRaw: true,
                tags,
                label,
            },
        };

        store.upsertDocs([doc]);
        indexer.invalidate();

        logger.info(`Ingested raw text: "${label}" (${content.length} chars)`);
        return { success: true, id, kind, label };
    }
}

module.exports = new Ingester();
