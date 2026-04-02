#!/usr/bin/env node
/**
 * crossmind — Agent-native CLI for 15 social platforms.
 * Usage: crossmind <platform> <command> [args] [options]
 */

import { Command } from 'commander';

// Platform adapters
import { registerHackerNews } from './platforms/hackernews/index.js';
import { registerLobsters } from './platforms/lobsters/index.js';
import { registerDevTo } from './platforms/devto/index.js';
import { registerStackOverflow } from './platforms/stackoverflow/index.js';
import { registerArxiv } from './platforms/arxiv/index.js';
import { registerGitHub } from './platforms/github/index.js';
import { registerProductHunt } from './platforms/producthunt/index.js';
import { registerX } from './platforms/x/index.js';
import { registerReddit } from './platforms/reddit/index.js';
import { registerBluesky } from './platforms/bluesky/index.js';
import { registerYouTube } from './platforms/youtube/index.js';
import { registerMedium } from './platforms/medium/index.js';
import { registerSubstack } from './platforms/substack/index.js';
import { registerInstagram } from './platforms/instagram/index.js';
import { registerLinkedIn } from './platforms/linkedin/index.js';

// Command groups
import { registerAuthCommands } from './commands/auth.js';
import { registerAccountCommands } from './commands/account.js';
import { registerExtractCookieCommand } from './commands/extract-cookie.js';
import { registerConfigCommands } from './commands/config.js';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const VERSION: string = (_require('../package.json') as { version: string }).version;

const program = new Command();

program
  .name('crossmind')
  .description('Agent-native CLI for 15 social platforms. Compact output by default, --json for structured data.')
  .version(VERSION, '-v, --version', 'Print version and exit')
  .helpOption('-h, --help', 'Show help')
  .addHelpText('after', `
Platforms:
  Public API (no auth):  hn, lb, dev, so, arxiv, gh, ph
  Cookie auth:           x, ig, li
  OAuth / app password:  reddit, bsky, yt (API key)

Examples:
  crossmind hn top 10
  crossmind x search "AI agents" 20
  crossmind reddit r MachineLearning 25 --sort top --time week
  crossmind gh trending --lang typescript --period daily
  crossmind arxiv search "large language models" --cat cs.AI 10
  crossmind bsky timeline 20
  crossmind auth login x --auth-token <token> --ct0 <ct0>
  crossmind auth login reddit
  crossmind extract-cookie instagram

Auth guides:     crossmind <platform> --help
Data directory:  ~/.crossmind/ (or set CROSSMIND_DATA_DIR / --data-dir)
`);

// ── Platform commands ──────────────────────────────────────────────────────
registerHackerNews(program);
registerLobsters(program);
registerDevTo(program);
registerStackOverflow(program);
registerArxiv(program);
registerGitHub(program);
registerProductHunt(program);
registerX(program);
registerReddit(program);
registerBluesky(program);
registerYouTube(program);
registerMedium(program);
registerSubstack(program);
registerInstagram(program);
registerLinkedIn(program);

// ── Utility commands ───────────────────────────────────────────────────────
registerAuthCommands(program);
registerAccountCommands(program);
registerExtractCookieCommand(program);
registerConfigCommands(program);

// ── Parse ──────────────────────────────────────────────────────────────────
program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
