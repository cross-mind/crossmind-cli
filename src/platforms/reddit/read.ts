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
import {
  bridgeSubreddit, bridgeSearch, bridgeSearchPublic, bridgeUser, bridgeUserPosts, bridgePost as bridgePostFetch,
  bridgeHome, bridgeSaved,
  type RedditCookieCreds,
} from '../../http/reddit-bridge.js';

/** Convert stored cookie credentials to bridge format. */
function cookieCreds(c: { session: string; modhash?: string; csrfToken?: string; loid?: string }, proxy?: string): RedditCookieCreds {
  return { session: c.session, csrfToken: c.csrfToken, loid: c.loid, modhash: c.modhash, proxy };
}

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
  selftext?: string;
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
      headers: redditCookieHeaders(creds.session, creds.modhash, creds.csrfToken, creds.loid),
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
  dataDir?: string,
  proxy?: string
): Promise<RedditPost[]> {
  const creds = await loadRedditCredentials(account, dataDir);
  if (creds?.type === 'cookie') {
    return bridgeSubreddit(subreddit, sort, limit, cookieCreds(creds, proxy));
  }
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
  dataDir?: string,
  proxy?: string
): Promise<RedditPost[]> {
  const creds = await loadRedditCredentials(account, dataDir);
  if (creds?.type === 'cookie') {
    return bridgeSearch(query, subreddit, sort, limit, cookieCreds(creds, proxy));
  }
  // OAuth: use authenticated API directly (oauth.reddit.com, no TLS issues)
  if (creds?.type === 'oauth') {
    const { baseUrl, headers } = await resolveAuth(account, dataDir);
    const subredditPath = subreddit ? `/r/${subreddit}` : '';
    const url = `${baseUrl}${subredditPath}/search.json?q=${encodeURIComponent(query)}&sort=${sort}&limit=${Math.min(limit, 100)}&restrict_sr=${subreddit ? 'true' : 'false'}`;
    const data = await request<{ data: { children: Record<string, unknown>[] } }>(url, { headers });
    return (data.data.children ?? []).slice(0, limit).map((child, i) => mapPost(child, i));
  }
  // No auth: use Python bridge for Chrome TLS impersonation (www.reddit.com blocks Node.js TLS with 403)
  return bridgeSearchPublic(query, subreddit, sort, limit);
}

// ── Phase 2 additional interfaces ─────────────────────────────────────────

export interface RedditSubInfo {
  name: string;
  title: string;
  subscribers: number;
  active_users: number;
  description: string;
  url: string;
  nsfw: boolean;
}

export interface RedditUserProfile {
  rank: number;
  username: string;
  karma_post: number;
  karma_comment: number;
  created_utc: number;
  is_mod: boolean;
  url: string;
}

export interface RedditPostDetail {
  post: RedditPost;
  comments: RedditComment[];
}

// ── Phase 2 read additions ─────────────────────────────────────────────────

/** Browse /r/popular */
export async function getPopular(
  sort: 'hot' | 'new' | 'top' | 'rising',
  limit: number,
  time: 'hour' | 'day' | 'week' | 'month' | 'year' | 'all',
  account?: string,
  dataDir?: string,
  proxy?: string
): Promise<RedditPost[]> {
  return getSubreddit('popular', sort, limit, time, account, dataDir, proxy);
}

/** Browse /r/all */
export async function getAll(
  sort: 'hot' | 'new' | 'top' | 'rising',
  limit: number,
  time: 'hour' | 'day' | 'week' | 'month' | 'year' | 'all',
  account?: string,
  dataDir?: string,
  proxy?: string
): Promise<RedditPost[]> {
  return getSubreddit('all', sort, limit, time, account, dataDir, proxy);
}

/** Get subreddit metadata */
export async function getSubredditInfo(
  subreddit: string,
  account?: string,
  dataDir?: string
): Promise<RedditSubInfo> {
  const { baseUrl, headers } = await resolveAuth(account, dataDir);
  const data = await request<{ data: Record<string, unknown> }>(
    `${baseUrl}/r/${subreddit}/about.json`,
    { headers }
  );
  const d = data.data;
  return {
    name: String(d['display_name'] ?? subreddit),
    title: String(d['title'] ?? ''),
    subscribers: Number(d['subscribers'] ?? 0),
    active_users: Number(d['active_user_count'] ?? 0),
    description: String(d['public_description'] ?? '').slice(0, 300).replace(/\n/g, ' '),
    url: `https://reddit.com/r/${subreddit}`,
    nsfw: Boolean(d['over18'] ?? false),
  };
}

/** Get a Reddit user's profile */
export async function getRedditUserProfile(
  username: string,
  account?: string,
  dataDir?: string,
  proxy?: string
): Promise<RedditUserProfile> {
  const creds = await loadRedditCredentials(account, dataDir);
  if (creds?.type === 'cookie') {
    return bridgeUser(username, cookieCreds(creds, proxy));
  }
  const { baseUrl, headers } = await resolveAuth(account, dataDir);
  const data = await request<{ data: Record<string, unknown> }>(
    `${baseUrl}/user/${username}/about.json`,
    { headers }
  );
  const d = data.data;
  return {
    rank: 1,
    username: String(d['name'] ?? username),
    karma_post: Number(d['link_karma'] ?? 0),
    karma_comment: Number(d['comment_karma'] ?? 0),
    created_utc: Number(d['created_utc'] ?? 0),
    is_mod: Boolean(d['is_mod'] ?? false),
    url: `https://reddit.com/u/${username}`,
  };
}

/** Get a user's submitted posts */
export async function getUserPosts(
  username: string,
  sort: 'hot' | 'new' | 'top',
  limit: number,
  account?: string,
  dataDir?: string,
  proxy?: string
): Promise<RedditPost[]> {
  const creds = await loadRedditCredentials(account, dataDir);
  if (creds?.type === 'cookie') {
    return bridgeUserPosts(username, limit, cookieCreds(creds, proxy));
  }
  const { baseUrl, headers } = await resolveAuth(account, dataDir);
  const url = `${baseUrl}/user/${username}/submitted.json?sort=${sort}&limit=${Math.min(limit, 100)}`;
  const data = await request<{ data: { children: Record<string, unknown>[] } }>(url, { headers });
  return (data.data.children ?? []).slice(0, limit).map((child, i) => mapPost(child, i));
}

/** Get a user's comments */
export async function getUserComments(
  username: string,
  sort: 'hot' | 'new' | 'top',
  limit: number,
  account?: string,
  dataDir?: string
): Promise<RedditComment[]> {
  const { baseUrl, headers } = await resolveAuth(account, dataDir);
  const url = `${baseUrl}/user/${username}/comments.json?sort=${sort}&limit=${Math.min(limit, 100)}`;
  const data = await request<{ data: { children: Record<string, unknown>[] } }>(url, { headers });
  const children = data.data.children ?? [];
  const results: RedditComment[] = [];
  for (const child of children) {
    const d = (child as { data?: Record<string, unknown> }).data ?? {};
    if (d['body'] && d['body'] !== '[deleted]') {
      results.push({
        rank: results.length + 1,
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

/** Fetch a post with its top-level comments (by post ID, subreddit auto-resolved) */
export async function getPost(
  postId: string,
  sort: 'best' | 'top' | 'new' | 'controversial' | 'old',
  limit: number,
  account?: string,
  dataDir?: string,
  proxy?: string
): Promise<RedditPostDetail> {
  const creds = await loadRedditCredentials(account, dataDir);
  if (creds?.type === 'cookie') {
    // bridge uses subreddit='' — reddit-fetch.py fetches from /comments/<id>.json
    const id = postId.replace(/^t3_/, '');
    return bridgePostFetch('', id, limit, cookieCreds(creds, proxy));
  }
  const { baseUrl, headers } = await resolveAuth(account, dataDir);
  // Strip t3_ prefix if present
  const id = postId.replace(/^t3_/, '');
  const url = `${baseUrl}/comments/${id}.json?sort=${sort}&limit=${Math.min(limit, 100)}`;
  const data = await request<[
    { data: { children: Record<string, unknown>[] } },
    { data: { children: Record<string, unknown>[] } }
  ]>(url, { headers });

  const postChildren = data[0]?.data?.children ?? [];
  const postData = (postChildren[0] as { data?: Record<string, unknown> })?.data ?? {};
  const post = mapPost(postChildren[0] ?? {}, 0);
  if (postData['selftext'] && String(postData['selftext']).length > 0) {
    post.selftext = String(postData['selftext']).replace(/\n{3,}/g, '\n\n').trim().slice(0, 2000);
  }

  const commentChildren = data[1]?.data?.children ?? [];
  const comments: RedditComment[] = [];
  let rank = 1;
  for (const child of commentChildren) {
    const d = (child as { data?: Record<string, unknown> }).data ?? {};
    if (d['body'] && d['body'] !== '[deleted]') {
      comments.push({
        rank: rank++,
        id: String(d['id'] ?? ''),
        author: String(d['author'] ?? ''),
        body: String(d['body'] ?? '').replace(/\n/g, ' ').slice(0, 200),
        score: Number(d['score'] ?? 0),
        subreddit: String(d['subreddit'] ?? ''),
        url: `https://reddit.com${d['permalink'] ?? ''}`,
      });
      if (comments.length >= limit) break;
    }
  }

  return { post, comments };
}

/** Get authenticated home feed */
export async function getHomeFeed(
  sort: 'hot' | 'new' | 'top' | 'rising',
  limit: number,
  account?: string,
  dataDir?: string,
  proxy?: string
): Promise<RedditPost[]> {
  const creds = await loadRedditCredentials(account, dataDir);
  if (creds?.type === 'cookie') {
    return bridgeHome(limit, cookieCreds(creds, proxy));
  }
  const { baseUrl, headers } = await resolveAuth(account, dataDir);
  if (baseUrl === 'https://www.reddit.com' && !headers['Cookie'] && !headers['Authorization']) {
    throw new Error('Home feed requires Reddit auth. Run: crossmind auth login reddit');
  }
  const timeParam = sort === 'top' ? '&t=day' : '';
  const url = `${baseUrl}/${sort}.json?limit=${Math.min(limit, 100)}${timeParam}`;
  const data = await request<{ data: { children: Record<string, unknown>[] } }>(url, { headers });
  return (data.data.children ?? []).slice(0, limit).map((child, i) => mapPost(child, i));
}

/** Get authenticated user's saved posts/comments */
export async function getSaved(
  limit: number,
  account?: string,
  dataDir?: string,
  proxy?: string
): Promise<RedditPost[]> {
  const creds = await loadRedditCredentials(account, dataDir);
  if (creds?.type === 'cookie') {
    return bridgeSaved(limit, cookieCreds(creds, proxy));
  }
  const { baseUrl, headers } = await resolveAuth(account, dataDir);
  if (baseUrl === 'https://www.reddit.com' && !headers['Cookie'] && !headers['Authorization']) {
    throw new Error('Saved requires Reddit auth. Run: crossmind auth login reddit');
  }
  // Get username first from /api/v1/me
  const meBase = baseUrl === REDDIT_API ? REDDIT_API : 'https://www.reddit.com';
  const meData = await request<{ name: string }>(
    `${meBase}/api/v1/me`,
    { headers }
  );
  const username = meData.name;
  const url = `${baseUrl}/user/${username}/saved.json?limit=${Math.min(limit, 100)}`;
  const data = await request<{ data: { children: Record<string, unknown>[] } }>(url, { headers });
  return (data.data.children ?? []).slice(0, limit).map((child, i) => mapPost(child, i));
}

/** Get post comments. */
export async function getPostComments(
  subreddit: string,
  postId: string,
  limit: number,
  account?: string,
  dataDir?: string,
  proxy?: string
): Promise<RedditComment[]> {
  const creds = await loadRedditCredentials(account, dataDir);
  if (creds?.type === 'cookie') {
    const detail = await bridgePostFetch(subreddit, postId, limit, cookieCreds(creds, proxy));
    return detail.comments;
  }
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
