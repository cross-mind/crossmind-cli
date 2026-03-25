/**
 * Reddit read operations.
 *
 * Auth priority:
 *   1. Cookie (reddit_session) → www.reddit.com JSON API with session cookie
 *   2. OAuth access token      → oauth.reddit.com with Bearer token
 *   3. No credentials          → www.reddit.com public JSON API
 */

import { request } from '../../http/client.js';
import {
  loadRedditCredentials, REDDIT_API,
  redditHeaders, redditCookieHeaders, redditPublicHeaders,
} from '../../auth/reddit.js';

export interface RedditPost {
  rank: number;
  id: string;
  title: string;
  author: string;
  subreddit: string;
  score: number;
  comments: number;
  url: string;
  domain: string;
  created_utc: number;
  flair: string;
}

export interface RedditComment {
  rank: number;
  id: string;
  author: string;
  body: string;
  score: number;
  subreddit: string;
  url: string;
}

function mapPost(child: Record<string, unknown>, index: number): RedditPost {
  const data = child['data'] as Record<string, unknown> ?? child;
  return {
    rank: index + 1,
    id: String(data['id'] ?? ''),
    title: String(data['title'] ?? '').slice(0, 150),
    author: String(data['author'] ?? ''),
    subreddit: String(data['subreddit'] ?? ''),
    score: Number(data['score'] ?? 0),
    comments: Number(data['num_comments'] ?? 0),
    url: String(data['url'] ?? ''),
    domain: String(data['domain'] ?? ''),
    created_utc: Number(data['created_utc'] ?? 0),
    flair: String(data['link_flair_text'] ?? ''),
  };
}

/** Resolve base URL and headers based on available credentials. */
async function resolveAuth(account?: string, dataDir?: string): Promise<{
  baseUrl: string;
  headers: Record<string, string>;
}> {
  const creds = await loadRedditCredentials(account, dataDir);
  if (creds?.type === 'cookie') {
    return {
      baseUrl: 'https://www.reddit.com',
      headers: redditCookieHeaders(creds.session, creds.modhash),
    };
  }
  if (creds?.type === 'oauth') {
    return {
      baseUrl: REDDIT_API,
      headers: redditHeaders(creds.token),
    };
  }
  return {
    baseUrl: 'https://www.reddit.com',
    headers: redditPublicHeaders(),
  };
}

/** Fetch subreddit listing (hot/new/top/rising). */
export async function getSubreddit(
  subreddit: string,
  sort: 'hot' | 'new' | 'top' | 'rising',
  limit: number,
  time: 'hour' | 'day' | 'week' | 'month' | 'year' | 'all',
  account?: string,
  dataDir?: string
): Promise<RedditPost[]> {
  const { baseUrl, headers } = await resolveAuth(account, dataDir);
  const timeParam = sort === 'top' ? `&t=${time}` : '';
  const url = `${baseUrl}/r/${subreddit}/${sort}.json?limit=${Math.min(limit, 100)}${timeParam}`;
  const data = await request<{ data: { children: Record<string, unknown>[] } }>(url, { headers });
  return (data.data.children ?? []).slice(0, limit).map((child, i) => mapPost(child, i));
}

/** Search Reddit. */
export async function searchReddit(
  query: string,
  subreddit: string | undefined,
  sort: 'relevance' | 'new' | 'top' | 'comments',
  limit: number,
  account?: string,
  dataDir?: string
): Promise<RedditPost[]> {
  const { baseUrl, headers } = await resolveAuth(account, dataDir);
  const subredditPath = subreddit ? `/r/${subreddit}` : '';
  const url = `${baseUrl}${subredditPath}/search.json?q=${encodeURIComponent(query)}&sort=${sort}&limit=${Math.min(limit, 100)}&restrict_sr=${subreddit ? 'true' : 'false'}`;
  const data = await request<{ data: { children: Record<string, unknown>[] } }>(url, { headers });
  return (data.data.children ?? []).slice(0, limit).map((child, i) => mapPost(child, i));
}

/** Get post comments. */
export async function getPostComments(
  subreddit: string,
  postId: string,
  limit: number,
  account?: string,
  dataDir?: string
): Promise<RedditComment[]> {
  const { baseUrl, headers } = await resolveAuth(account, dataDir);
  const url = `${baseUrl}/r/${subreddit}/comments/${postId}.json?limit=${Math.min(limit, 100)}`;
  const data = await request<[unknown, { data: { children: Record<string, unknown>[] } }]>(url, { headers });

  const children = data[1]?.data?.children ?? [];
  const results: RedditComment[] = [];
  let rank = 1;

  for (const child of children) {
    const d = (child as { data?: Record<string, unknown> }).data ?? {};
    if (d['body'] && d['body'] !== '[deleted]') {
      results.push({
        rank: rank++,
        id: String(d['id'] ?? ''),
        author: String(d['author'] ?? ''),
        body: String(d['body'] ?? '').replace(/\n/g, ' ').slice(0, 200),
        score: Number(d['score'] ?? 0),
        subreddit: String(d['subreddit'] ?? ''),
        url: `https://reddit.com${d['permalink'] ?? ''}`,
      });
      if (results.length >= limit) break;
    }
  }

  return results;
}
