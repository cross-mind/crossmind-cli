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
 * `ph show <slug>` deep-dives a single product (the `post(slug:)` query
 * surfaces richer fields — reviews, ranks, launch date, makers — than the list
 * queries).
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
  rating: string;
  daily_rank: string;
  launched: string;
  url: string;
  topics: string;
}

interface PHShow {
  name: string;
  tagline: string;
  description: string;
  rating: string;
  votes: number;
  ranks: string;
  launched: string;
  website: string;
  url: string;
  topics: string;
  makers: string;
}

const POST_LIST_FIELDS = `
  id name tagline votesCount commentsCount
  reviewsRating reviewsCount dailyRank featuredAt
  url createdAt
  topics { edges { node { name } } }
`;

const POST_SHOW_FIELDS = `
  name tagline description
  votesCount commentsCount
  reviewsRating reviewsCount
  dailyRank weeklyRank monthlyRank
  featuredAt
  website url
  topics { edges { node { name slug } } }
  makers { name headline }
`;

function fmtRating(rating: unknown, count: unknown): string {
  const n = typeof count === 'number' ? count : Number(count ?? 0);
  if (!n) return 'no reviews';
  const r = typeof rating === 'number' ? rating : Number(rating ?? 0);
  return `${r.toFixed(1)} (${n})`;
}

function fmtDate(value: unknown): string {
  return typeof value === 'string' && value ? value.slice(0, 10) : '—';
}

function fmtRank(label: string, value: unknown): string {
  return value != null ? `${label} #${value}` : '';
}

function phHeaders(token: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

function mapPostNode(node: Record<string, unknown>, index: number): PHPost {
  const topicEdges = (node['topics'] as { edges: Array<{ node: { name: string } }> } | null)?.edges ?? [];
  const dailyRank = node['dailyRank'];
  return {
    rank: index + 1,
    name: String(node['name'] ?? ''),
    tagline: String(node['tagline'] ?? '').slice(0, 100),
    votes: Number(node['votesCount'] ?? 0),
    comments: Number(node['commentsCount'] ?? 0),
    rating: fmtRating(node['reviewsRating'], node['reviewsCount']),
    daily_rank: dailyRank != null ? `day #${dailyRank}` : '—',
    launched: fmtDate(node['featuredAt']),
    url: String(node['url'] ?? ''),
    topics: topicEdges.map((t) => t.node.name).join(','),
  };
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

  const gqlQuery = `query { posts(${args.join(', ')}) { edges { node { ${POST_LIST_FIELDS} } } } }`;
  const data = await request<{ data: { posts: { edges: Array<{ node: Record<string, unknown> }> } } }>(
    PH_API,
    { method: 'POST', headers: phHeaders(token), body: { query: gqlQuery } },
  );
  const edges = data?.data?.posts?.edges ?? [];
  return edges.slice(0, opts.limit).map((e, i) => mapPostNode(e.node, i));
}

/** Deep-dive a single product by slug (richer fields than the list queries). */
async function fetchPhPost(
  token: string | undefined,
  slug: string,
): Promise<PHShow | null> {
  const gqlQuery = `query { post(slug: ${JSON.stringify(slug)}) { ${POST_SHOW_FIELDS} } }`;
  const data = await request<{ data: { post: Record<string, unknown> | null } }>(
    PH_API,
    { method: 'POST', headers: phHeaders(token), body: { query: gqlQuery } },
  );
  const node = data?.data?.post;
  if (!node) return null;

  const topicEdges = (node['topics'] as { edges: Array<{ node: { name: string; slug: string } }> } | null)?.edges ?? [];
  const makers = (node['makers'] as Array<{ name: string; headline?: string | null }> | null) ?? [];
  const rankParts = [
    fmtRank('day', node['dailyRank']),
    fmtRank('week', node['weeklyRank']),
    fmtRank('month', node['monthlyRank']),
  ].filter(Boolean);

  return {
    name: String(node['name'] ?? ''),
    tagline: String(node['tagline'] ?? ''),
    description: String(node['description'] ?? '').replace(/\s+/g, ' ').trim(),
    rating: fmtRating(node['reviewsRating'], node['reviewsCount']),
    votes: Number(node['votesCount'] ?? 0),
    ranks: rankParts.length ? rankParts.join(' · ') : '—',
    launched: fmtDate(node['featuredAt']),
    website: String(node['website'] ?? ''),
    url: String(node['url'] ?? ''),
    topics: topicEdges.map((t) => t.node.name).join(', ') || '—',
    makers: makers.map((m) => (m.headline ? `${m.name} (${m.headline})` : m.name)).join(', ') || '—',
  };
}

/** Search Product Hunt topics by keyword. Topics are the only searchable entity. */
async function fetchPhTopics(
  token: string | undefined,
  query: string,
  limit: number,
): Promise<Array<{ rank: number; name: string; slug: string }>> {
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

const LIST_TEMPLATE = '{rank}. {name} — {tagline} ★{rating} · votes:{votes} · {daily_rank} · {launched} · {url}';
const TOPIC_TEMPLATE = '{rank}. {name} — {slug}';
const SHOW_TEMPLATE = [
  '{name} — {tagline}',
  '  {description}',
  '  ★{rating} · votes:{votes} · {ranks} · launched {launched}',
  '  website: {website}',
  '  url: {url}',
  '  topics: {topics}',
  '  makers: {makers}',
].join('\n');

export function registerProductHunt(program: Command): void {
  const ph = program
    .command('ph')
    .description('Product Hunt — browse top products, find topics, look up a product');

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
        printOutput(items as unknown as Record<string, unknown>[], LIST_TEMPLATE, 'ph/top', start, { json: opts.json });
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

  ph
    .command('show <slug>')
    .description('Deep-dive one product by its slug (reviews, launch ranks, date, makers, topics)')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--json', 'Output as JSON')
    .action(async (slug: string, opts: { account?: string; dataDir?: string; json?: boolean }) => {
      const start = Date.now();
      try {
        const token = await loadProductHuntToken(opts.account, opts.dataDir, 'show');
        const item = await fetchPhPost(token, slug);
        if (!item) {
          console.error(`No Product Hunt product found for slug: ${slug}`);
          process.exit(1);
        }
        printOutput([item] as unknown as Record<string, unknown>[], SHOW_TEMPLATE, 'ph/show', start, { json: opts.json });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
