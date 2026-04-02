const natural = require('natural');
const store = require('../storage/store');
const logger = require('../utils/logger');

const tokenizer = new natural.WordTokenizer();
const TfIdf = natural.TfIdf;

class Indexer {
    constructor() {
        this.tfidf = new TfIdf();
        this._docMap = [];
        this._built = false;
    }

    build() {
        this.tfidf = new TfIdf();
        this._docMap = [];

        const docs = store.getAll();
        for (const doc of docs) {
            const text = this._docToText(doc);
            this.tfidf.addDocument(text);
            this._docMap.push(doc.id);
        }

        this._built = true;
        logger.info(`Index built: ${docs.length} documents`);
        return docs.length;
    }

    search(query, topK = 8, filter = {}) {
        if (!this._built || this._docMap.length === 0) {
            this.build();
        }

        const queryTokens = tokenizer.tokenize(query.toLowerCase());
        const scores = new Array(this._docMap.length).fill(0);

        for (const token of queryTokens) {
            this.tfidf.tfidfs(token, (i, measure) => {
                if (i < scores.length) {
                    scores[i] += measure;
                }
            });
        }

        const allDocs = store.getAll();
        scores.forEach((_, i) => {
            const doc = allDocs[i];
            if (!doc) return;
            const textLower = doc.content.toLowerCase();
            for (const token of queryTokens) {
                if (token.length > 3 && textLower.includes(token)) {
                    scores[i] += 0.5;
                }
            }

            if (doc.metadata) {
                const metaText = JSON.stringify(doc.metadata).toLowerCase();
                for (const token of queryTokens) {
                    if (token.length > 3 && metaText.includes(token)) {
                        scores[i] += 1.0;
                    }
                }
            }
        });

        let results = scores
            .map((score, i) => ({ score, doc: allDocs[i] }))
            .filter(r => r.doc && r.score > 0);

        if (filter.kind) {
            results = results.filter(r => r.doc.kind === filter.kind);
        }
        if (filter.filename) {
            results = results.filter(r =>
                r.doc.filename.toLowerCase().includes(filter.filename.toLowerCase())
            );
        }

        results.sort((a, b) => b.score - a.score);

        const seenFiles = new Map();
        const deduped = [];
        for (const r of results) {
            const fp = r.doc.filePath;
            if (!seenFiles.has(fp)) {
                seenFiles.set(fp, r);
                deduped.push(r);
            } else if (r.score > seenFiles.get(fp).score) {
                const idx = deduped.findIndex(d => d.doc.filePath === fp);
                deduped[idx] = r;
            }
            if (deduped.length >= topK) break;
        }

        return deduped.slice(0, topK).map(r => ({
            ...r.doc,
            relevanceScore: parseFloat(r.score.toFixed(4)),
        }));
    }

    searchForErrors(errorType, topK = 6) {
        const results = this.search(errorType, topK * 2);
        return results
            .map(doc => ({
                ...doc,
                relevanceScore: doc.kind === 'log'
                    ? doc.relevanceScore * 1.5
                    : doc.metadata?.isBugFix
                        ? doc.relevanceScore * 1.3
                        : doc.relevanceScore,
            }))
            .sort((a, b) => b.relevanceScore - a.relevanceScore)
            .slice(0, topK);
    }

    searchForUsages(symbol, topK = 8) {
        const query = `${symbol} usage import call reference`;
        const results = this.search(query, topK * 2);

        return results
            .map(doc => {
                let boost = 1;
                if (doc.content.includes(symbol)) boost = 2;
                if (doc.metadata?.imports?.some(i => i.includes(symbol))) boost = 2.5;
                if (doc.metadata?.functions?.includes(symbol)) boost = 3;
                return { ...doc, relevanceScore: doc.relevanceScore * boost };
            })
            .sort((a, b) => b.relevanceScore - a.relevanceScore)
            .slice(0, topK);
    }

    searchForImpact(target, topK = 8) {
        const query = `${target} depends import module connection`;
        const results = this.search(query, topK * 2);

        return results
            .map(doc => {
                let boost = 1;
                if (doc.content.includes(target)) boost = 2;
                if (doc.metadata?.imports?.some(i => i.includes(target))) boost = 3;
                return { ...doc, relevanceScore: doc.relevanceScore * boost };
            })
            .sort((a, b) => b.relevanceScore - a.relevanceScore)
            .slice(0, topK);
    }

    _docToText(doc) {
        const parts = [
            doc.filename,
            doc.kind,
            doc.content,
            doc.metadata?.functions?.join(' ') || '',
            doc.metadata?.classes?.join(' ') || '',
            doc.metadata?.imports?.join(' ') || '',
            doc.metadata?.exports?.join(' ') || '',
            doc.metadata?.errors?.join(' ') || '',
            doc.metadata?.patterns?.join(' ') || '',
            doc.metadata?.tables?.join(' ') || '',
        ];
        return parts.join(' ');
    }

    invalidate() {
        this._built = false;
    }
}

const indexer = new Indexer();
module.exports = indexer;
