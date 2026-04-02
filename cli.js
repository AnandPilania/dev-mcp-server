#!/usr/bin/env node
require('dotenv').config();

const { Command } = require('commander');
const chalk = require('chalk');
const ora = require('ora');
const readline = require('readline');

const ingester = require('./src/core/ingester');
const indexer = require('./src/core/indexer');
const { QueryEngine, detectMode, QUERY_MODES } = require('./src/core/queryEngine');
const store = require('./src/storage/store');

const program = new Command();

const banner = chalk.cyan(`
╔══════════════════════════════════════════════════════╗
║     Dev MCP Server — Model Context Platform          ║
║     AI that understands YOUR codebase                ║
╚══════════════════════════════════════════════════════╝
`);

program
    .command('ingest <path>')
    .description('Ingest a file or directory into the knowledge base')
    .option('-t, --type <type>', 'Force type: code | config | documentation | log | schema')
    .action(async (inputPath, opts) => {
        console.log(banner);
        const fs = require('fs');
        const stat = fs.statSync(inputPath);
        const spinner = ora();

        if (stat.isDirectory()) {
            spinner.start(chalk.blue(`Scanning directory: ${inputPath}`));
            try {
                const result = await ingester.ingestDirectory(inputPath);
                spinner.succeed(chalk.green('Ingestion complete'));
                console.log('\n' + chalk.bold('Results:'));
                console.log(`  ${chalk.green('✓')} Ingested: ${result.ingested} files`);
                console.log(`  ${chalk.yellow('⚠')} Skipped:  ${result.skipped} files`);
                console.log(`  ${chalk.red('✗')} Failed:   ${result.failed} files`);
                console.log(`  ${chalk.cyan('◈')} Chunks:   ${result.totalChunks} total`);
                if (result.errors.length > 0) {
                    console.log('\n' + chalk.red('Errors:'));
                    result.errors.slice(0, 5).forEach(e =>
                        console.log(`  ${e.file}: ${e.error}`)
                    );
                }
            } catch (err) {
                spinner.fail(chalk.red(`Failed: ${err.message}`));
                process.exit(1);
            }
        } else {
            spinner.start(chalk.blue(`Ingesting file: ${inputPath}`));
            try {
                const result = await ingester.ingestFile(inputPath);
                indexer.build();
                spinner.succeed(chalk.green(`Ingested: ${result.chunks} chunks`));
            } catch (err) {
                spinner.fail(chalk.red(`Failed: ${err.message}`));
                process.exit(1);
            }
        }
    });

program
    .command('query [question]')
    .description('Ask a question about your codebase')
    .option('-m, --mode <mode>', 'Force mode: debug | usage | impact | general')
    .option('-k, --top-k <n>', 'Number of context chunks', '8')
    .option('-i, --interactive', 'Start interactive REPL session')
    .action(async (question, opts) => {
        console.log(banner);

        const stats = store.getStats();
        if (stats.totalDocs === 0) {
            console.log(chalk.yellow('⚠  Knowledge base is empty!'));
            console.log(chalk.gray('   Run: node cli.js ingest <path>'));
            process.exit(1);
        }

        console.log(chalk.gray(`📚 Knowledge base: ${stats.totalDocs} docs from ${stats.totalFiles} files\n`));

        if (opts.interactive || !question) {
            await startRepl();
            return;
        }

        await askQuestion(question, opts);
    });

async function askQuestion(question, opts = {}) {
    const mode = opts.mode || detectMode(question);
    const topK = parseInt(opts.topK || 8);

    const modeColors = {
        [QUERY_MODES.DEBUG]: chalk.red,
        [QUERY_MODES.USAGE]: chalk.blue,
        [QUERY_MODES.IMPACT]: chalk.yellow,
        [QUERY_MODES.GENERAL]: chalk.cyan,
    };

    const modeEmoji = {
        [QUERY_MODES.DEBUG]: '🐛',
        [QUERY_MODES.USAGE]: '🔍',
        [QUERY_MODES.IMPACT]: '💥',
        [QUERY_MODES.GENERAL]: '💬',
    };

    const colorFn = modeColors[mode] || chalk.cyan;
    console.log(colorFn(`${modeEmoji[mode]} Mode: ${mode.toUpperCase()}`));
    console.log(chalk.bold(`\nQ: ${question}\n`));

    const spinner = ora('Retrieving context and thinking...').start();

    try {
        const result = await QueryEngine.query(question, { mode, topK });
        spinner.stop();

        console.log(chalk.gray('─'.repeat(60)));
        console.log(chalk.gray('Sources used:'));
        result.sources.forEach((s, i) => {
            console.log(chalk.gray(`  [${i + 1}] ${s.file} (${s.kind}) — score: ${s.relevanceScore}`));
        });
        console.log(chalk.gray('─'.repeat(60)));

        console.log('\n' + chalk.bold('Answer:\n'));
        console.log(result.answer);
        console.log(chalk.gray(`\n[Tokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out]`));

    } catch (err) {
        spinner.fail(chalk.red(`Error: ${err.message}`));
    }
}

async function startRepl() {
    console.log(chalk.cyan('Starting interactive session. Type "exit" to quit, "help" for tips.\n'));

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const prompt = () => {
        rl.question(chalk.bold.cyan('\n❯ '), async (input) => {
            const trimmed = input.trim();

            if (!trimmed) {
                prompt();
                return;
            }

            if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
                console.log(chalk.cyan('\nGoodbye!\n'));
                rl.close();
                process.exit(0);
            }

            if (trimmed.toLowerCase() === 'help') {
                console.log(chalk.cyan(`
Tips:
  🐛 Debug:  "Why is ClassCastException happening in UserService?"
  🔍 Usage:  "Where is getUserById used?"
  💥 Impact: "If I change the User model, what breaks?"
  💬 General: Any question about your codebase
        `));
                prompt();
                return;
            }

            if (trimmed.toLowerCase() === 'stats') {
                const stats = store.getStats();
                console.log(chalk.cyan(JSON.stringify(stats, null, 2)));
                prompt();
                return;
            }

            await askQuestion(trimmed);
            prompt();
        });
    };

    prompt();
}

program
    .command('stats')
    .description('Show knowledge base statistics')
    .action(() => {
        const stats = store.getStats();
        const files = store.getIngestedFiles();

        console.log(banner);
        console.log(chalk.bold('Knowledge Base Stats:'));
        console.log(`  Total documents: ${chalk.green(stats.totalDocs)}`);
        console.log(`  Total files:     ${chalk.green(stats.totalFiles)}`);
        console.log(`  Last ingested:   ${chalk.gray(stats.lastIngested || 'Never')}`);
        console.log('\n' + chalk.bold('By type:'));
        Object.entries(stats.fileTypes || {}).forEach(([type, count]) => {
            console.log(`  ${type.padEnd(15)} ${chalk.cyan(count)} docs`);
        });

        if (files.length > 0) {
            console.log('\n' + chalk.bold(`Ingested files (${files.length}):`));
            files.slice(0, 20).forEach(f => console.log(`  ${chalk.gray(f)}`));
            if (files.length > 20) {
                console.log(chalk.gray(`  ... and ${files.length - 20} more`));
            }
        }
    });

program
    .command('clear')
    .description('Clear the entire knowledge base')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (opts) => {
        if (!opts.yes) {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            rl.question(chalk.red('⚠  This will delete all indexed data. Continue? (y/N) '), (answer) => {
                rl.close();
                if (answer.toLowerCase() === 'y') {
                    store.clear();
                    indexer.invalidate();
                    console.log(chalk.green('✓ Knowledge base cleared'));
                } else {
                    console.log('Cancelled.');
                }
                process.exit(0);
            });
        } else {
            store.clear();
            indexer.invalidate();
            console.log(chalk.green('✓ Knowledge base cleared'));
        }
    });

program
    .command('debug <error>')
    .description('Quick debug: explain an error in context of your codebase')
    .option('-s, --stack <trace>', 'Stack trace')
    .action(async (error, opts) => {
        console.log(banner);
        await askQuestion(`Why is this error happening and how do I fix it?\nError: ${error}${opts.stack ? '\nStack:\n' + opts.stack : ''}`, { mode: QUERY_MODES.DEBUG });
    });

program.parse(process.argv);
