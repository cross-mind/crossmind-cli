/**
 * Product Hunt platform adapter.
 * Uses the Product Hunt GraphQL API v2.
 * Prefers the platform-provided shared Developer Token (no setup needed);
 * falls back to your own token if you've configured one:
 * crossmind auth login ph --token <your-token>
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

async function fetchPhPosts(
  token: string | undefined,
  query: string,
  limit: number
): Promise<PHPost[]> {
  const gqlQuery = `
    query {
      posts(first: ${Math.min(limit, 50)}, order: VOTES, after: "${query}") {
        edges {
          node {
            id name tagline votesCount commentsCount
            url
            createdAt
            topics { edges { node { name } } }
          }
        }
      }
    }
  `;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const data = await request<{ data: { posts: { edges: Array<{ node: Record<string, unknown> }> } } }>(
    PH_API,
    { method: 'POST', headers, body: { query: gqlQuery } }
  );

  const edges = data?.data?.posts?.edges ?? [];
  return edges.slice(0, limit).map((e, i) => {
    const node = e.node;
    const topicEdges = (node['topics'] as { edges: Array<{ node: { name: string } }> } | null)?.edges ?? [];
    return {
      rank: i + 1,
      name: String(node['name'] ?? ''),
      tagline: String(node['tagline'] ?? '').slice(0, 100),
      votes: Number(node['votesCount'] ?? 0),
      comments: Number(node['commentsCount'] ?? 0),
      url: String(node['url'] ?? ''),
      topics: topicEdges.map((t) => t.node.name).join(','),
      created_at: String(node['createdAt'] ?? '').slice(0, 10),
    };
  });
}

async function fetchPhPostsByDate(
  token: string | undefined,
  postedAfter: string | undefined,
  limit: number
): Promise<PHPost[]> {
  // Product Hunt API: fetch by date (featured posts)
  const dateFilter = postedAfter ? `, postedAfter: "${postedAfter}"` : '';
  const gqlQuery = `
    query {
      posts(first: ${Math.min(limit, 50)}, order: VOTES${dateFilter}) {
        edges {
          node {
            id name tagline votesCount commentsCount
            url
            createdAt
            topics { edges { node { name } } }
          }
        }
      }
    }
  `;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const data = await request<{ data: { posts: { edges: Array<{ node: Record<string, unknown> }> } } }>(
    PH_API,
    { method: 'POST', headers, body: { query: gqlQuery } }
  );

  const edges = data?.data?.posts?.edges ?? [];
  return edges.slice(0, limit).map((e, i) => {
    const node = e.node;
    const topicEdges = (node['topics'] as { edges: Array<{ node: { name: string } }> } | null)?.edges ?? [];
    return {
      rank: i + 1,
      name: String(node['name'] ?? ''),
      tagline: String(node['tagline'] ?? '').slice(0, 100),
      votes: Number(node['votesCount'] ?? 0),
      comments: Number(node['commentsCount'] ?? 0),
      url: String(node['url'] ?? ''),
      topics: topicEdges.map((t) => t.node.name).join(','),
      created_at: String(node['createdAt'] ?? '').slice(0, 10),
    };
  });
}

const TEMPLATE = '{rank}. {name} — {tagline} votes:{votes} comments:{comments} {url}';

export function registerProductHunt(program: Command): void {
  const ph = program
    .command('ph')
    .description('Product Hunt — top products and launches');

  ph
    .command('top [limit]')
    .description('Top products today (by votes)')
    .option('--date <date>', 'Date to fetch (YYYY-MM-DD, default: today)')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--json', 'Output as JSON array')
    .action(async (limitArg: string | undefined, opts: { date?: string; account?: string; dataDir?: string; json?: boolean }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 20;
      try {
        const token = await loadProductHuntToken(opts.account, opts.dataDir, 'top');
        const items = await fetchPhPostsByDate(token, opts.date, limit);
        printOutput(items as unknown as Record<string, unknown>[], TEMPLATE, 'ph/top', start, { json: opts.json });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        console.error('Note: if this keeps failing, you can set your own token with: crossmind auth login ph --token <your-token>');
        process.exit(1);
      }
    });

  ph
    .command('search <query> [limit]')
    .description('Search products by name')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--json', 'Output as JSON array')
    .action(async (query: string, limitArg: string | undefined, opts: { account?: string; dataDir?: string; json?: boolean }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 20;
      try {
        const token = await loadProductHuntToken(opts.account, opts.dataDir, 'search');
        const gqlQuery = `
          query {
            posts(first: ${Math.min(limit, 50)}, query: ${JSON.stringify(query)}) {
              edges {
                node {
                  id name tagline votesCount commentsCount url createdAt
                  topics { edges { node { name } } }
                }
              }
            }
          }
        `;
        const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const data = await request<{ data: { posts: { edges: Array<{ node: Record<string, unknown> }> } } }>(
          PH_API,
          { method: 'POST', headers, body: { query: gqlQuery } }
        );
        const edges = data?.data?.posts?.edges ?? [];
        const items = edges.slice(0, limit).map((e, i) => {
          const node = e.node;
          const topicEdges = (node['topics'] as { edges: Array<{ node: { name: string } }> } | null)?.edges ?? [];
          return {
            rank: i + 1,
            name: String(node['name'] ?? ''),
            tagline: String(node['tagline'] ?? '').slice(0, 100),
            votes: Number(node['votesCount'] ?? 0),
            comments: Number(node['commentsCount'] ?? 0),
            url: String(node['url'] ?? ''),
            topics: topicEdges.map((t) => t.node.name).join(','),
            created_at: String(node['createdAt'] ?? '').slice(0, 10),
          };
        });
        printOutput(items as unknown as Record<string, unknown>[], TEMPLATE, 'ph/search', start, { json: opts.json });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}

