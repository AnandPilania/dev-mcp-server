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
const GitTool = require('./src/tools/GitTool');
const BashTool = require('./src/tools/BashTool');
const GrepTool = require('./src/tools/GrepTool');
const { MemoryManager, MEMORY_TYPES } = require('./src/memory/memoryManager');
const { TaskManager, STATUS, PRIORITY } = require('./src/tasks/taskManager');
const sessionMgr = require('./src/sessions/sessionManager');
const plannerEngine = require('./src/planner/plannerEngine');
const costTracker = require('./src/utils/costTracker');

const program = new Command();

const banner = chalk.cyan(`
╔══════════════════════════════════════════════════════════════╗
║     Dev MCP Server v1.0 — Model Context Platform            ║
║     AI that understands YOUR codebase                        ║
╚══════════════════════════════════════════════════════════════╝
`);

// ── Helpers ────────────────────────────────────────────────────

const modeColor = { debug: chalk.red, usage: chalk.blue, impact: chalk.yellow, general: chalk.cyan };
const modeEmoji = { debug: '🐛', usage: '🔍', impact: '💥', general: '💬' };

async function askQuestion(question, opts = {}) {
    const mode = opts.mode || detectMode(question);
    const topK = parseInt(opts.topK || 8);
    const sessionId = opts.sessionId || 'default';

    const colorFn = modeColor[mode] || chalk.cyan;
    console.log(colorFn(`\n${modeEmoji[mode]} Mode: ${mode.toUpperCase()}`));
    console.log(chalk.bold(`Q: ${question}\n`));

    const spinner = ora('Retrieving context and thinking...').start();
    try {
        const result = await QueryEngine.query(question, { mode, topK, sessionId });
        spinner.stop();

        console.log(chalk.gray('─'.repeat(64)));
        console.log(chalk.gray(`Sources (${result.sources.length}) | Memories used: ${result.memoriesUsed}`));
        result.sources.forEach((s, i) =>
            console.log(chalk.gray(`  [${i + 1}] ${s.file} (${s.kind}) — ${s.relevanceScore}`))
        );
        console.log(chalk.gray('─'.repeat(64)));
        console.log('\n' + chalk.bold('Answer:\n'));
        console.log(result.answer);
        if (result.usage) {
            const cost = costTracker.formatCost(result.usage.costUsd || 0);
            console.log(chalk.gray(`\n[Tokens: ${result.usage.inputTokens}↑ ${result.usage.outputTokens}↓ | Cost: ${cost}]`));
        }

        // Persist to session
        if (opts.sessionId) {
            sessionMgr.addMessage(opts.sessionId, { role: 'user', content: question });
            sessionMgr.addMessage(opts.sessionId, {
                role: 'assistant', content: result.answer, mode,
                sources: result.sources,
                tokens: (result.usage?.inputTokens || 0) + (result.usage?.outputTokens || 0),
                costUsd: result.usage?.costUsd || 0,
            });
        }
        return result;
    } catch (err) {
        spinner.fail(chalk.red(`Error: ${err.message}`));
    }
}

// ── INGEST ─────────────────────────────────────────────────────
program
    .command('ingest <path>')
    .description('Ingest a file or directory into the knowledge base')
    .action(async (inputPath) => {
        console.log(banner);
        const fs = require('fs');
        const spinner = ora();
        const stat = fs.statSync(inputPath);
        if (stat.isDirectory()) {
            spinner.start(chalk.blue(`Scanning: ${inputPath}`));
            const result = await ingester.ingestDirectory(inputPath);
            spinner.succeed(chalk.green('Done'));
            console.log(`  ${chalk.green('✓')} ${result.ingested} files | ${result.totalChunks} chunks | ${result.skipped} skipped | ${result.failed} failed`);
        } else {
            spinner.start(chalk.blue(`Ingesting: ${inputPath}`));
            const result = await ingester.ingestFile(inputPath);
            indexer.build();
            spinner.succeed(chalk.green(`${result.chunks} chunks indexed`));
        }
    });

// ── QUERY ──────────────────────────────────────────────────────
program
    .command('query [question]')
    .description('Ask a question about your codebase')
    .option('-m, --mode <mode>', 'Force mode: debug|usage|impact|general')
    .option('-k, --top-k <n>', 'Context chunks to retrieve', '8')
    .option('-s, --session <id>', 'Session ID for persistence')
    .option('-i, --interactive', 'Start interactive REPL')
    .action(async (question, opts) => {
        console.log(banner);
        const stats = store.getStats();
        if (stats.totalDocs === 0) {
            console.log(chalk.yellow('⚠  Knowledge base is empty — run: node cli.js ingest <path>'));
            process.exit(1);
        }
        console.log(chalk.gray(`📚 ${stats.totalDocs} docs | 🧠 ${MemoryManager.getStats().total} memories\n`));
        if (opts.interactive || !question) { await startRepl(opts); return; }
        await askQuestion(question, opts);
    });

// ── INTERACTIVE REPL ───────────────────────────────────────────
async function startRepl(opts = {}) {
    let sessionId = opts.session;
    if (!sessionId) {
        const sess = sessionMgr.create({ name: `REPL ${new Date().toLocaleString()}` });
        sessionId = sess.id;
        console.log(chalk.gray(`📝 New session: ${sessionId}`));
    } else {
        console.log(chalk.gray(`📂 Resuming session: ${sessionId}`));
    }

    console.log(chalk.cyan('Interactive mode. Commands: /debug /usage /impact /plan /git /task /memory /cost /doctor /compact /exit\n'));

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const prompt = () => {
        rl.question(chalk.bold.cyan('❯ '), async (input) => {
            const trimmed = input.trim();
            if (!trimmed) { prompt(); return; }

            // Slash commands
            if (trimmed === '/exit' || trimmed === '/quit') {
                console.log(chalk.gray(`\nSession saved: ${sessionId}`));
                rl.close(); process.exit(0);
            }

            if (trimmed === '/cost') {
                const s = costTracker.getSummary(sessionId);
                console.log(chalk.cyan('\n💰 Cost Summary:'));
                if (s.session) console.log(`  Session: ${s.session.calls} calls | ${s.session.inputTokens + s.session.outputTokens} tokens | ${costTracker.formatCost(s.session.costUsd)}`);
                console.log(`  All-time: ${s.allTime.calls} calls | ${costTracker.formatCost(s.allTime.costUsd)}`);
                prompt(); return;
            }

            if (trimmed === '/doctor') {
                const spinner = ora('Running diagnostics...').start();
                const result = await plannerEngine.doctor();
                spinner.stop();
                console.log(chalk.bold('\n🩺 Doctor Report:'));
                for (const c of result.checks) {
                    const icon = c.status === 'ok' ? chalk.green('✓') : c.status === 'warn' ? chalk.yellow('⚠') : chalk.red('✗');
                    console.log(`  ${icon} ${c.name.padEnd(22)} ${chalk.gray(c.detail)}`);
                }
                console.log(chalk.gray(`\n  ${result.summary.passed}/${result.summary.total} checks passed`));
                prompt(); return;
            }

            if (trimmed.startsWith('/plan ')) {
                const task = trimmed.slice(6);
                const spinner = ora('Generating plan...').start();
                try {
                    const context = indexer.search(task, 5);
                    const plan = await plannerEngine.generatePlan(task, context, sessionId);
                    spinner.stop();
                    console.log(chalk.bold('\n📋 Plan:\n'));
                    console.log(plan.plan);
                } catch (err) { spinner.fail(err.message); }
                prompt(); return;
            }

            if (trimmed.startsWith('/git ')) {
                const sub = trimmed.slice(5);
                await handleGitCommand(sub);
                prompt(); return;
            }

            if (trimmed === '/git') {
                const status = await GitTool.status();
                console.log(chalk.bold('\n📦 Git Status:'));
                console.log(`  Branch: ${chalk.cyan(status.branch)} | ↑${status.ahead} ↓${status.behind}`);
                if (status.staged.length) console.log(`  Staged: ${status.staged.map(f => chalk.green(f.file)).join(', ')}`);
                if (status.unstaged.length) console.log(`  Modified: ${status.unstaged.map(f => chalk.yellow(f.file)).join(', ')}`);
                if (status.untracked.length) console.log(`  Untracked: ${status.untracked.slice(0, 5).map(f => chalk.gray(f)).join(', ')}`);
                if (status.recentCommits.length) {
                    console.log(chalk.gray('  Recent commits:'));
                    status.recentCommits.slice(0, 3).forEach(c => console.log(chalk.gray(`    ${c}`)));
                }
                prompt(); return;
            }

            if (trimmed.startsWith('/task ')) {
                await handleTaskCommand(trimmed.slice(6));
                prompt(); return;
            }

            if (trimmed === '/tasks') {
                const tasks = TaskManager.list();
                if (tasks.length === 0) { console.log(chalk.gray('No open tasks.')); }
                else {
                    console.log(chalk.bold('\n📋 Open Tasks:'));
                    tasks.forEach(t => {
                        const p = t.priority === 'critical' ? chalk.red : t.priority === 'high' ? chalk.yellow : chalk.gray;
                        console.log(`  ${p(`[${t.priority}]`)} #${t.id} ${t.title} ${chalk.gray(`(${t.status})`)}`);
                    });
                }
                prompt(); return;
            }

            if (trimmed === '/memory') {
                const mems = MemoryManager.list().slice(0, 10);
                console.log(chalk.bold('\n🧠 Recent Memories:'));
                if (mems.length === 0) console.log(chalk.gray('  None yet.'));
                mems.forEach(m => console.log(`  [${chalk.cyan(m.type)}] ${m.content.slice(0, 90)}`));
                prompt(); return;
            }

            if (trimmed.startsWith('/memory add ')) {
                const mem = MemoryManager.add(trimmed.slice(12));
                console.log(chalk.green(`✓ Memory saved: ${mem.id}`));
                prompt(); return;
            }

            if (trimmed === '/compact') {
                const history = sessionMgr.getHistory(sessionId, 30);
                if (history.length < 4) { console.log(chalk.gray('Not enough history to compact.')); prompt(); return; }
                const spinner = ora('Compacting conversation...').start();
                const result = await plannerEngine.compact(history, sessionId);
                spinner.succeed(`Compacted ${result.savedMessages} messages → summary`);
                prompt(); return;
            }

            if (trimmed.startsWith('/grep ')) {
                const pattern = trimmed.slice(6);
                const spinner = ora(`Searching for: ${pattern}`).start();
                const result = await GrepTool.search(pattern, { maxResults: 20 });
                spinner.stop();
                console.log(chalk.bold(`\n🔎 ${result.total} matches (${result.tool}):`));
                result.matches.slice(0, 15).forEach(m =>
                    console.log(`  ${chalk.cyan(m.file)}:${chalk.yellow(m.lineNumber)}  ${m.line.trim().slice(0, 80)}`)
                );
                prompt(); return;
            }

            if (trimmed === '/help') {
                console.log(chalk.cyan(`
  Query modes (auto-detected):
    🐛 debug  — "Why is X failing?"
    🔍 usage  — "Where is X used?"
    💥 impact — "If I change X, what breaks?"
    💬 general — any other question

  Slash commands:
    /plan <task>       Generate an execution plan
    /git               Git status
    /git commit        Auto-commit with AI message
    /git review        AI code review of changes
    /git diff          Show current diff
    /tasks             List open tasks
    /task add <title>  Create a task
    /task done <id>    Mark task complete
    /memory            Show stored memories
    /memory add <text> Add a memory manually
    /grep <pattern>    Search codebase with ripgrep
    /compact           Compress conversation history
    /cost              Show token usage & cost
    /doctor            Check environment health
    /exit              Save & exit
        `));
                prompt(); return;
            }

            // Default: treat as a query
            await askQuestion(trimmed, { sessionId });
            prompt();
        });
    };
    prompt();
}

async function handleGitCommand(sub) {
    try {
        if (sub === 'commit' || sub === 'commit --auto') {
            const spinner = ora('Creating AI commit message...').start();
            const result = await GitTool.commit({ autoMessage: true });
            spinner.stop();
            if (result.success) console.log(chalk.green(`\n✓ Committed: "${result.message}"`));
            else console.log(chalk.yellow(`⚠ ${result.message}`));
        } else if (sub === 'review') {
            const spinner = ora('Running AI code review...').start();
            const result = await GitTool.review({});
            spinner.stop();
            console.log(chalk.bold('\n📝 Code Review:\n'));
            console.log(result.review);
            if (result.hasIssues) console.log(chalk.red('\n⚠ Issues found — review before merging'));
        } else if (sub === 'diff') {
            const result = await GitTool.diff({});
            if (!result.hasChanges) { console.log(chalk.gray('No changes.')); return; }
            console.log(result.diff.slice(0, 3000));
        } else if (sub === 'log') {
            const commits = await GitTool.log({ oneline: true, limit: 10 });
            console.log(chalk.bold('\n📜 Recent Commits:'));
            commits.forEach(c => console.log(chalk.gray(`  ${c}`)));
        } else {
            console.log(chalk.gray(`Unknown git subcommand: ${sub}. Try: commit, review, diff, log`));
        }
    } catch (err) {
        console.log(chalk.red(`Git error: ${err.message}`));
    }
}

async function handleTaskCommand(args) {
    const parts = args.split(' ');
    const sub = parts[0];
    const rest = parts.slice(1).join(' ');
    try {
        if (sub === 'add') {
            const task = TaskManager.create({ title: rest });
            console.log(chalk.green(`✓ Task #${task.id} created: ${task.title}`));
        } else if (sub === 'done') {
            const task = TaskManager.update(parseInt(rest), { status: STATUS.DONE });
            console.log(chalk.green(`✓ Task #${task.id} marked done`));
        } else if (sub === 'list') {
            const tasks = TaskManager.list();
            tasks.forEach(t => console.log(`  #${t.id} [${t.priority}] ${t.title} (${t.status})`));
        } else {
            console.log(chalk.gray('Usage: /task add <title> | /task done <id> | /task list'));
        }
    } catch (err) {
        console.log(chalk.red(`Task error: ${err.message}`));
    }
}

// ── STANDALONE COMMANDS ────────────────────────────────────────

program
    .command('debug <error>')
    .description('Quick debug: explain an error in context of your codebase')
    .option('-s, --stack <trace>', 'Stack trace')
    .action(async (error, opts) => {
        console.log(banner);
        await askQuestion(`Why is this error happening?\nError: ${error}${opts.stack ? '\nStack:\n' + opts.stack : ''}`, { mode: QUERY_MODES.DEBUG });
    });

program
    .command('plan <task>')
    .description('Generate a step-by-step execution plan before making changes')
    .action(async (task) => {
        console.log(banner);
        const spinner = ora('Analysing codebase and generating plan...').start();
        try {
            const context = indexer.search(task, 6);
            const plan = await plannerEngine.generatePlan(task, context);
            spinner.stop();
            console.log(chalk.bold('\n📋 Execution Plan:\n'));
            console.log(plan.plan);
        } catch (err) { spinner.fail(err.message); }
    });

program
    .command('git <subcommand>')
    .description('Git operations: status | diff | commit | review | log | branches')
    .option('-f, --focus <areas>', 'Review focus areas')
    .action(async (sub, opts) => {
        console.log(banner);
        if (sub === 'status') {
            const status = await GitTool.status();
            console.log(JSON.stringify(status, null, 2));
        } else {
            await handleGitCommand(sub);
        }
    });

program
    .command('grep <pattern>')
    .description('Search codebase with ripgrep (or native fallback)')
    .option('-d, --dir <path>', 'Directory to search')
    .option('-g, --glob <glob>', 'File glob filter')
    .option('-i, --ignore-case', 'Case insensitive')
    .option('-n, --max <n>', 'Max results', '50')
    .action(async (pattern, opts) => {
        console.log(banner);
        const spinner = ora(`Searching: ${pattern}`).start();
        try {
            const result = await GrepTool.search(pattern, {
                cwd: opts.dir || process.cwd(),
                glob: opts.glob,
                ignoreCase: opts.ignoreCase,
                maxResults: parseInt(opts.max),
            });
            spinner.stop();
            console.log(chalk.bold(`\n🔎 ${result.matches.length} of ${result.total} matches (${result.tool}):\n`));
            result.matches.forEach(m =>
                console.log(`${chalk.cyan(m.file)}:${chalk.yellow(String(m.lineNumber).padStart(4))}  ${m.line.trim().slice(0, 100)}`)
            );
        } catch (err) { spinner.fail(err.message); }
    });

program
    .command('bash <command>')
    .description('Execute a shell command with permission checks')
    .option('-y, --yes', 'Auto-approve')
    .action(async (command, opts) => {
        const perm = BashTool.checkPermission(command);
        if (perm === 'dangerous') { console.log(chalk.red(`⛔ Blocked: dangerous command`)); return; }
        if (perm === 'needs-approval' && !opts.yes) {
            console.log(chalk.yellow(`⚠ Requires approval. Re-run with --yes to execute.`));
            return;
        }
        const result = await BashTool.execute(command, { approved: true });
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(chalk.yellow(result.stderr));
        if (result.exitCode !== 0) process.exit(result.exitCode);
    });

program
    .command('tasks [subcommand]')
    .description('Manage tasks: list | add <title> | done <id> | stats')
    .action((sub = 'list', opts, cmd) => {
        console.log(banner);
        const args = cmd.args || [];
        if (sub === 'list') {
            const tasks = TaskManager.list({ includeDone: args.includes('--all') });
            if (tasks.length === 0) { console.log(chalk.gray('No open tasks.')); return; }
            console.log(chalk.bold('📋 Tasks:\n'));
            tasks.forEach(t => {
                const p = { critical: chalk.red, high: chalk.yellow, medium: chalk.white, low: chalk.gray }[t.priority] || chalk.white;
                console.log(`  ${p(`[${t.priority.padEnd(8)}]`)} #${String(t.id).padStart(3)} ${t.title}`);
                if (t.description) console.log(chalk.gray(`               ${t.description.slice(0, 60)}`));
            });
            const stats = TaskManager.getStats();
            console.log(chalk.gray(`\n  Total: ${stats.total} | Todo: ${stats.byStatus.todo || 0} | In Progress: ${stats.byStatus.in_progress || 0} | Done: ${stats.byStatus.done || 0}`));
        } else if (sub === 'stats') {
            console.log(JSON.stringify(TaskManager.getStats(), null, 2));
        }
    });

program
    .command('memory [subcommand]')
    .description('Manage memories: list | add <text> | clear | stats')
    .action((sub = 'list', opts, cmd) => {
        console.log(banner);
        const rest = cmd.args?.slice(1).join(' ') || '';
        if (sub === 'list') {
            const mems = MemoryManager.list();
            if (mems.length === 0) { console.log(chalk.gray('No memories yet.')); return; }
            console.log(chalk.bold('🧠 Memories:\n'));
            mems.forEach(m => {
                console.log(`  [${chalk.cyan(m.type)}] ${m.content.slice(0, 100)}`);
                console.log(chalk.gray(`           id:${m.id} | used:${m.useCount}x | ${m.createdAt.slice(0, 10)}`));
            });
        } else if (sub === 'add' && rest) {
            const mem = MemoryManager.add(rest);
            console.log(chalk.green(`✓ Memory added: ${mem.id}`));
        } else if (sub === 'stats') {
            console.log(JSON.stringify(MemoryManager.getStats(), null, 2));
        } else if (sub === 'clear') {
            MemoryManager.clear();
            console.log(chalk.green('✓ All memories cleared'));
        }
    });

program
    .command('sessions [subcommand]')
    .description('Manage sessions: list | resume <id> | export <id>')
    .action((sub = 'list', opts, cmd) => {
        console.log(banner);
        const id = cmd.args?.[1];
        if (sub === 'list') {
            const sessions = sessionMgr.list();
            if (sessions.length === 0) { console.log(chalk.gray('No sessions.')); return; }
            console.log(chalk.bold('💾 Sessions:\n'));
            sessions.forEach(s => {
                console.log(`  ${chalk.cyan(s.id)}`);
                console.log(`    ${s.name} | ${s.messageCount} messages | ${s.updatedAt.slice(0, 16)}`);
            });
        } else if (sub === 'export' && id) {
            const md = sessionMgr.exportMarkdown(id);
            console.log(md);
        }
    });

program
    .command('doctor')
    .description('Check environment health')
    .action(async () => {
        console.log(banner);
        const spinner = ora('Running diagnostics...').start();
        const result = await plannerEngine.doctor();
        spinner.stop();
        console.log(chalk.bold('🩺 Doctor Report:\n'));
        for (const c of result.checks) {
            const icon = c.status === 'ok' ? chalk.green('✓') : c.status === 'warn' ? chalk.yellow('⚠') : chalk.red('✗');
            console.log(`  ${icon} ${c.name.padEnd(22)} ${chalk.gray(c.detail)}`);
        }
        const allOk = result.healthy;
        console.log(`\n  ${allOk ? chalk.green('✅ All systems healthy') : chalk.red('❌ Issues found — check above')}`);
    });

program
    .command('cost')
    .description('Show token usage and estimated API cost')
    .option('-s, --session <id>', 'Session ID')
    .action((opts) => {
        console.log(banner);
        const summary = costTracker.getSummary(opts.session || 'default');
        console.log(chalk.bold('💰 Cost Summary:\n'));
        if (summary.session) {
            console.log(chalk.bold('  Current Session:'));
            console.log(`    Calls:    ${summary.session.calls}`);
            console.log(`    Tokens:   ${summary.session.inputTokens + summary.session.outputTokens} (${summary.session.inputTokens}↑ ${summary.session.outputTokens}↓)`);
            console.log(`    Cost:     ${chalk.yellow(costTracker.formatCost(summary.session.costUsd))}`);
        }
        console.log(chalk.bold('\n  All-Time:'));
        console.log(`    Calls:    ${summary.allTime.calls}`);
        console.log(`    Tokens:   ${summary.allTime.inputTokens + summary.allTime.outputTokens}`);
        console.log(`    Cost:     ${chalk.yellow(costTracker.formatCost(summary.allTime.costUsd))}`);
    });

program
    .command('stats')
    .description('Show knowledge base statistics')
    .action(() => {
        console.log(banner);
        const kbStats = store.getStats();
        const memStats = MemoryManager.getStats();
        const taskStats = TaskManager.getStats();
        const costSummary = costTracker.getSummary();

        console.log(chalk.bold('📊 System Overview:\n'));
        console.log(chalk.bold('  Knowledge Base:'));
        console.log(`    Documents: ${chalk.green(kbStats.totalDocs)} from ${chalk.green(kbStats.totalFiles)} files`);
        Object.entries(kbStats.fileTypes || {}).forEach(([type, count]) =>
            console.log(`    ${('  ' + type).padEnd(18)} ${chalk.cyan(count)} chunks`)
        );
        console.log(chalk.bold('\n  Memory:'));
        console.log(`    Total: ${chalk.green(memStats.total)} memories`);
        Object.entries(memStats.byType || {}).forEach(([type, count]) =>
            console.log(`    ${('  ' + type).padEnd(18)} ${chalk.cyan(count)}`)
        );
        console.log(chalk.bold('\n  Tasks:'));
        console.log(`    Total: ${chalk.green(taskStats.total)} | Open: ${taskStats.byStatus?.todo || 0}`);
        console.log(chalk.bold('\n  Cost (all-time):'));
        console.log(`    ${costTracker.formatCost(costSummary.allTime.costUsd)} across ${costSummary.allTime.calls} calls`);
    });

program
    .command('clear')
    .description('Clear the knowledge base')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (opts) => {
        if (!opts.yes) {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            rl.question(chalk.red('⚠  Delete all indexed data? (y/N) '), (a) => {
                rl.close();
                if (a.toLowerCase() === 'y') { store.clear(); indexer.invalidate(); console.log(chalk.green('✓ Cleared')); }
                else console.log('Cancelled.');
                process.exit(0);
            });
        } else {
            store.clear(); indexer.invalidate();
            console.log(chalk.green('✓ Knowledge base cleared'));
        }
    });

program.parse(process.argv);
