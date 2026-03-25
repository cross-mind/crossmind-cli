/**
 * Lobsters platform adapter.
 * Public JSON API — no auth required.
 * Commands: top, new, hottest
 */

import { Command } from 'commander';
import { executePipeline } from '../../http/pipeline.js';
import { printOutput } from '../../output/formatter.js';

const PLATFORM = 'lobsters';

function lbCommand(
  parent: Command,
  name: string,
  description: string
): void {
  parent
    .command(`${name} [limit]`)
    .description(description)
    .option('--json', 'Output as JSON array')
    .action(async (limitArg: string | undefined, opts: { json?: boolean }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 20;

      try {
        const { items, template } = await executePipeline(PLATFORM, name, { limit });
        printOutput(items, template, `lb/${name}`, start, { json: opts.json });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}

export function registerLobsters(program: Command): void {
  const lb = program
    .command('lb')
    .description('Lobsters — technology news community');

  lbCommand(lb, 'top', 'Top stories (hottest)');
  lbCommand(lb, 'new', 'Newest stories');
  lbCommand(lb, 'hottest', 'Hottest stories (last 24h)');
}
