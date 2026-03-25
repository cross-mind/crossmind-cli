/**
 * GitHub platform adapter.
 * Commands: search, trending, issues, releases, auth login/logout
 */

import { Command } from 'commander';
import { searchRepos, trendingRepos, listIssues, listReleases } from './read.js';
import { printOutput } from '../../output/formatter.js';

const REPO_TEMPLATE = '{rank}. {full_name} [{language}] stars:{stars} forks:{forks} {description} {url}';
const ISSUE_TEMPLATE = '{rank}. #{number} [{state}] {title} by:{author} comments:{comments} {url}';
const RELEASE_TEMPLATE = '{rank}. {tag} {name} ({published_at}) {url}';

export function registerGitHub(program: Command): void {
  const gh = program
    .command('gh')
    .description('GitHub — repositories, issues, releases, trending');

  gh
    .command('search <query> [limit]')
    .description('Search GitHub repositories')
    .option('--sort <sort>', 'Sort: stars, forks, updated, best-match (default: stars)', 'stars')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--json', 'Output as JSON array')
    .action(async (
      query: string,
      limitArg: string | undefined,
      opts: { sort: string; account?: string; dataDir?: string; json?: boolean }
    ) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 20;
      try {
        const items = await searchRepos(query, opts.sort as 'stars', limit, opts.account, opts.dataDir);
        printOutput(items as unknown as Record<string, unknown>[], REPO_TEMPLATE, 'gh/search', start, { json: opts.json });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  gh
    .command('trending [limit]')
    .description('Trending repositories')
    .option('--lang <language>', 'Filter by programming language')
    .option('--period <period>', 'Period: daily, weekly, monthly (default: weekly)', 'weekly')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--json', 'Output as JSON array')
    .action(async (
      limitArg: string | undefined,
      opts: { lang?: string; period: string; account?: string; dataDir?: string; json?: boolean }
    ) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 20;
      try {
        const items = await trendingRepos(
          opts.lang ?? '',
          opts.period as 'daily',
          limit,
          opts.account,
          opts.dataDir
        );
        printOutput(items as unknown as Record<string, unknown>[], REPO_TEMPLATE, 'gh/trending', start, { json: opts.json });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  gh
    .command('issues <repo> [limit]')
    .description('List issues for a repository (e.g. owner/repo)')
    .option('--state <state>', 'Filter: open, closed, all (default: open)', 'open')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--json', 'Output as JSON array')
    .action(async (
      repo: string,
      limitArg: string | undefined,
      opts: { state: string; account?: string; dataDir?: string; json?: boolean }
    ) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 20;
      try {
        const items = await listIssues(repo, opts.state as 'open', limit, opts.account, opts.dataDir);
        printOutput(items as unknown as Record<string, unknown>[], ISSUE_TEMPLATE, `gh/issues/${repo}`, start, { json: opts.json });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  gh
    .command('releases <repo> [limit]')
    .description('List releases for a repository')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--json', 'Output as JSON array')
    .action(async (
      repo: string,
      limitArg: string | undefined,
      opts: { account?: string; dataDir?: string; json?: boolean }
    ) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 10;
      try {
        const items = await listReleases(repo, limit, opts.account, opts.dataDir);
        printOutput(items as unknown as Record<string, unknown>[], RELEASE_TEMPLATE, `gh/releases/${repo}`, start, { json: opts.json });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
