/**
 * Hacker News platform adapter.
 * Uses the Firebase REST API — no auth required.
 * Commands: top, new, ask, show, jobs, search
 */

import { Command } from 'commander';
import { executePipeline } from '../../http/pipeline.js';
import { printOutput } from '../../output/formatter.js';
import { request } from '../../http/client.js';

const PLATFORM = 'hackernews';

const SEARCH_TEMPLATE = '{rank}. score:{score} comments:{comments} author:{author} {title} {url}';

type HnType = 'story' | 'ask_hn' | 'show_hn' | 'job' | 'comment';
type HnSort = 'relevance' | 'recent';

interface AlgoliaHit {
  objectID: string;
  title?: string;
  story_title?: string;
  comment_text?: string;
  url?: string;
  story_url?: string;
  author: string;
  points?: number;
  num_comments?: number;
  created_at_i: number;
  _tags?: string[];
}

interface AlgoliaResponse {
  hits: AlgoliaHit[];
}

function resolveType(hit: AlgoliaHit): string {
  const tags = hit._tags ?? [];
  for (const tag of ['ask_hn', 'show_hn', 'job', 'comment', 'story']) {
    if (tags.includes(tag)) return tag;
  }
  return 'story';
}

function mapAlgoliaHit(hit: AlgoliaHit, index: number): Record<string, unknown> {
  return {
    rank: index + 1,
    id: parseInt(hit.objectID, 10) || hit.objectID,
    title: hit.title ?? hit.story_title ?? hit.comment_text?.slice(0, 120) ?? '',
    url: hit.url ?? hit.story_url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
    author: hit.author,
    score: hit.points ?? 0,
    comments: hit.num_comments ?? 0,
    created_at: hit.created_at_i,
    type: resolveType(hit),
  };
}

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

  hn
    .command('search <query> [limit]')
    .description('Search Hacker News via Algolia')
    .option('--json', 'Output as JSON array')
    .option('--type <type>', 'Filter by type: story (default), ask_hn, show_hn, job, comment', 'story')
    .option('--sort <sort>', 'Sort order: relevance (default) or recent', 'relevance')
    .action(async (
      query: string,
      limitArg: string | undefined,
      opts: { json?: boolean; type?: string; sort?: string }
    ) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 20;
      const typeFilter = (opts.type ?? 'story') as HnType;
      const sort = (opts.sort ?? 'relevance') as HnSort;

      try {
        const endpoint = sort === 'recent' ? 'search_by_date' : 'search';
        const encodedQuery = encodeURIComponent(query);
        const url = `https://hn.algolia.com/api/v1/${endpoint}?query=${encodedQuery}&hitsPerPage=${limit}&tags=${typeFilter}`;

        const data = await request<AlgoliaResponse>(url);
        const items = (data.hits ?? []).slice(0, limit).map((hit, i) => mapAlgoliaHit(hit, i));

        printOutput(items, SEARCH_TEMPLATE, `hn/search`, start, { json: opts.json });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
