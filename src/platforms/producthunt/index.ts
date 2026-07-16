/**
 * Product Hunt platform adapter.
 * Uses the Product Hunt GraphQL API v2.
 *
 * Auth: prefers the platform-provided shared Developer Token (no setup needed);
 * falls back to your own token if you've configured one:
 *   crossmind auth login ph --token <your-token>
 *
 * Scope note: Product Hunt's API does NOT support free-text search over
 * products/posts — the `posts` query has no `query` argument. The searchable
 * entity is TOPICS. So `ph search` finds topics by keyword, and `ph top` can
 * then filter to a topic via `--topic <slug>` (the slug comes from `search`).
 */

import { Command } from 'commander';
import { request } from '../../http/client.js';
import { printOutput } from '../../output/formatter.js';
import { loadProductHuntToken } from '../../auth/producthunt.js';

const PH_API = 'https://api.producthunt.com/v2/api/graphql';

interface PHPost {
  rank: number;
  name: string;
  tagline: string;
  votes: number;
  comments: number;
  url: string;
  topics: string;
  created_at: string;
}

interface PHTopic {
  rank: number;
  name: string;
  slug: string;
}

const POST_FIELDS = `
  id name tagline votesCount commentsCount
  url createdAt
  topics { edges { node { name } } }
`;

function mapPostNode(node: Record<string, unknown>, index: number): PHPost {
  const topicEdges = (node['topics'] as { edges: Array<{ node: { name: string } }> } | null)?.edges ?? [];
  return {
    rank: index + 1,
    name: String(node['name'] ?? ''),
    tagline: String(node['tagline'] ?? '').slice(0, 100),
    votes: Number(node['votesCount'] ?? 0),
    comments: Number(node['commentsCount'] ?? 0),
    url: String(node['url'] ?? ''),
    topics: topicEdges.map((t) => t.node.name).join(','),
    created_at: String(node['createdAt'] ?? '').slice(0, 10),
  };
}

function phHeaders(token: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

/** Fetch top posts, optionally narrowed to a topic slug and/or a posted-after date. */
async function fetchPhPosts(
  token: string | undefined,
  opts: { topic?: string; postedAfter?: string; limit: number },
): Promise<PHPost[]> {
  // The `posts` query accepts `topic` and `postedAfter` but NOT a free-text
  // `query` argument — see the file-level note.
  const args = [`first: ${Math.min(opts.limit, 50)}`, 'order: VOTES'];
  if (opts.topic) args.push(`topic: ${JSON.stringify(opts.topic)}`);
  if (opts.postedAfter) args.push(`postedAfter: ${JSON.stringify(opts.postedAfter)}`);

  const gqlQuery = `query { posts(${args.join(', ')}) { edges { node { ${POST_FIELDS} } } } }`;
  const data = await request<{ data: { posts: { edges: Array<{ node: Record<string, unknown> }> } } }>(
    PH_API,
    { method: 'POST', headers: phHeaders(token), body: { query: gqlQuery } },
  );
  const edges = data?.data?.posts?.edges ?? [];
  return edges.slice(0, opts.limit).map((e, i) => mapPostNode(e.node, i));
}

/** Search Product Hunt topics by keyword. Topics are the only searchable entity. */
async function fetchPhTopics(
  token: string | undefined,
  query: string,
  limit: number,
): Promise<PHTopic[]> {
  const gqlQuery = `query { topics(query: ${JSON.stringify(query)}, first: ${Math.min(limit, 50)}) { edges { node { name slug } } } }`;
  const data = await request<{ data: { topics: { edges: Array<{ node: { name: string; slug: string } }> } } }>(
    PH_API,
    { method: 'POST', headers: phHeaders(token), body: { query: gqlQuery } },
  );
  const edges = data?.data?.topics?.edges ?? [];
  return edges.slice(0, limit).map((e, i) => ({
    rank: i + 1,
    name: String(e.node.name ?? ''),
    slug: String(e.node.slug ?? ''),
  }));
}

const POST_TEMPLATE = '{rank}. {name} — {tagline} votes:{votes} comments:{comments} {url}';
const TOPIC_TEMPLATE = '{rank}. {name} — {slug}';

export function registerProductHunt(program: Command): void {
  const ph = program
    .command('ph')
    .description('Product Hunt — browse top products and find topics');

  ph
    .command('top [limit]')
    .description('Top products by votes (today, or filter with --date / --topic)')
    .option('--date <date>', 'Only posts on/after this date (YYYY-MM-DD)')
    .option('--topic <slug>', 'Only posts in this topic (find slugs with `ph search`)')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--json', 'Output as JSON array')
    .action(async (limitArg: string | undefined, opts: { date?: string; topic?: string; account?: string; dataDir?: string; json?: boolean }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 20;
      try {
        const token = await loadProductHuntToken(opts.account, opts.dataDir, 'top');
        const items = await fetchPhPosts(token, { topic: opts.topic, postedAfter: opts.date, limit });
        printOutput(items as unknown as Record<string, unknown>[], POST_TEMPLATE, 'ph/top', start, { json: opts.json });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        console.error('Note: if this keeps failing, you can set your own token with: crossmind auth login ph --token <your-token>');
        process.exit(1);
      }
    });

  ph
    .command('search <query> [limit]')
    .description('Search Product Hunt TOPICS by keyword (PH has no product free-text search; find a topic here, then run `ph top --topic <slug>` to browse its posts)')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--json', 'Output as JSON array')
    .action(async (query: string, limitArg: string | undefined, opts: { account?: string; dataDir?: string; json?: boolean }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 20;
      try {
        const token = await loadProductHuntToken(opts.account, opts.dataDir, 'search');
        const items = await fetchPhTopics(token, query, limit);
        printOutput(items as unknown as Record<string, unknown>[], TOPIC_TEMPLATE, 'ph/search', start, { json: opts.json });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
