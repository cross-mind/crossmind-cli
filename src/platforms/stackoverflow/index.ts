/**
 * Stack Overflow platform adapter.
 * Public REST API (Stack Exchange API v2.3) — no auth required for reads.
 * Commands: top, search, questions, trending
 */

import { Command } from 'commander';
import { executePipeline } from '../../http/pipeline.js';
import { printOutput } from '../../output/formatter.js';

const PLATFORM = 'stackoverflow';

export function registerStackOverflow(program: Command): void {
  const so = program
    .command('so')
    .description('Stack Overflow — questions and answers');

  so
    .command('top [limit]')
    .description('Top questions (by votes, this month)')
    .option('--tag <tag>', 'Filter by tag (e.g. javascript, python)')
    .option('--json', 'Output as JSON array')
    .action(async (limitArg: string | undefined, opts: { tag?: string; json?: boolean }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 20;
      try {
        const { items, template } = await executePipeline(PLATFORM, 'top', { limit, tag: opts.tag ?? '' });
        printOutput(items, template, 'so/top', start, { json: opts.json });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  so
    .command('search <query> [limit]')
    .description('Search questions')
    .option('--tag <tag>', 'Filter by tag')
    .option('--json', 'Output as JSON array')
    .action(async (query: string, limitArg: string | undefined, opts: { tag?: string; json?: boolean }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 20;
      try {
        const { items, template } = await executePipeline(PLATFORM, 'search', { query, limit, tag: opts.tag ?? '' });
        printOutput(items, template, 'so/search', start, { json: opts.json });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  so
    .command('trending [limit]')
    .description('Trending questions (most active today)')
    .option('--json', 'Output as JSON array')
    .action(async (limitArg: string | undefined, opts: { json?: boolean }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 20;
      try {
        const { items, template } = await executePipeline(PLATFORM, 'trending', { limit });
        printOutput(items, template, 'so/trending', start, { json: opts.json });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
