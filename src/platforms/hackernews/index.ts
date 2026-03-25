/**
 * Hacker News platform adapter.
 * Uses the Firebase REST API — no auth required.
 * Commands: top, new, ask, show, jobs
 */

import { Command } from 'commander';
import { executePipeline } from '../../http/pipeline.js';
import { printOutput } from '../../output/formatter.js';

const PLATFORM = 'hackernews';

function hnCommand(
  parent: Command,
  name: string,
  description: string
): void {
  parent
    .command(`${name} [limit]`)
    .description(description)
    .option('--json', 'Output as JSON array')
    .option('--data-dir <dir>', 'Data directory override')
    .action(async (limitArg: string | undefined, opts: { json?: boolean; dataDir?: string }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 20;

      try {
        const { items, template } = await executePipeline(PLATFORM, name, { limit });
        printOutput(items, template, `hn/${name}`, start, { json: opts.json });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}

export function registerHackerNews(program: Command): void {
  const hn = program
    .command('hn')
    .description('Hacker News — read top stories, new stories, Ask HN, Show HN');

  hnCommand(hn, 'top', 'Top stories');
  hnCommand(hn, 'new', 'Newest stories');
  hnCommand(hn, 'ask', 'Ask HN posts');
  hnCommand(hn, 'show', 'Show HN posts');
  hnCommand(hn, 'jobs', 'Job postings');
}
