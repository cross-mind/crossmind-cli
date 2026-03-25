/**
 * DEV.to platform adapter.
 * Public REST API — no auth required for reads.
 * Commands: top, latest, trending, search
 */

import { Command } from 'commander';
import { executePipeline } from '../../http/pipeline.js';
import { printOutput } from '../../output/formatter.js';

const PLATFORM = 'devto';

export function registerDevTo(program: Command): void {
  const dev = program
    .command('dev')
    .description('DEV.to — developer community articles');

  dev
    .command('top [limit]')
    .description('Top articles (most reactions, past week)')
    .option('--json', 'Output as JSON array')
    .action(async (limitArg: string | undefined, opts: { json?: boolean }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 20;
      try {
        const { items, template } = await executePipeline(PLATFORM, 'top', { limit });
        printOutput(items, template, 'dev/top', start, { json: opts.json });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  dev
    .command('latest [limit]')
    .description('Latest articles')
    .option('--json', 'Output as JSON array')
    .action(async (limitArg: string | undefined, opts: { json?: boolean }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 20;
      try {
        const { items, template } = await executePipeline(PLATFORM, 'latest', { limit });
        printOutput(items, template, 'dev/latest', start, { json: opts.json });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  dev
    .command('search <query> [limit]')
    .description('Search articles by keyword')
    .option('--json', 'Output as JSON array')
    .action(async (query: string, limitArg: string | undefined, opts: { json?: boolean }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 20;
      try {
        const { items, template } = await executePipeline(PLATFORM, 'search', { query, limit });
        printOutput(items, template, 'dev/search', start, { json: opts.json });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
