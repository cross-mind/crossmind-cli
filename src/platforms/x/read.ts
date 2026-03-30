/**
 * X (Twitter) read operations.
 *
 * Auth priority:
 *   1. Cookie (auth_token + ct0) → x-fetch.py bridge (curl_cffi Chrome TLS)
 *   2. Bearer / OAuth token      → v2 REST API (api.twitter.com/2)
 *   3. No credentials            → v2 REST with public bearer (search only)
 *
 * Note: x.com/i/api/graphql requires Chrome TLS fingerprinting. Node.js's
 * fetch() is rejected (404). The bridge delegates to scripts/x-fetch.py which
 * uses curl_cffi for proper Chrome impersonation.
 */

import { xRequest, type XCredentials } from '../../http/x-client.js';
import { loadXCredentials } from '../../auth/x.js';
import {
  isCookieClientAvailable,
  bridgeSearchTweets,
  bridgeFeed,
  bridgeUserTimeline,
  bridgeUserProfile,
  bridgeTweet,
  bridgeFollowers,
  bridgeFollowing,
  bridgeBookmarks,
  bridgeNotifications,
  bridgeListTweets,
} from '../../http/x-bridge.js';
import { AuthError } from '../../http/client.js';

export interface XTweet {
  rank: number;
  id: string;
  text: string;
  author: string;
  likes: number;
  retweets: number;
  replies: number;
  views: number;
  created_at: string;
  url: string;
}

export interface XTweetAnalytics extends XTweet {
  engagements: number;
  profile_clicks: number;
  url_link_clicks: number;
}

export interface XUser {
  rank: number;
  username: string;
  name: string;
  followers: number;
  following: number;
  tweets: number;
  bio: string;
  verified: string;
  url: string;
}

function buildTweetUrl(username: string, tweetId: string): string {
  return `https://twitter.com/${username}/status/${tweetId}`;
}

// ── v2 REST helpers ────────────────────────────────────────────────────────

function mapTweetRest(tweet: Record<string, unknown>, author: Record<string, unknown>, index: number): XTweet {
  const metrics = tweet['public_metrics'] as Record<string, number> | null ?? {};
  const username = String(author['username'] ?? '');
  const id = String(tweet['id'] ?? '');
  return {
    rank: index + 1,
    id,
    text: String(tweet['text'] ?? '').replace(/\n/g, ' ').slice(0, 200),
    author: username,
    likes: metrics['like_count'] ?? 0,
    retweets: metrics['retweet_count'] ?? 0,
    replies: metrics['reply_count'] ?? 0,
    views: (tweet['non_public_metrics'] as Record<string, number> | null)?.['impression_count'] ?? 0,
    created_at: String(tweet['created_at'] ?? '').slice(0, 10),
    url: buildTweetUrl(username, id),
  };
}

// ── Credential resolution ──────────────────────────────────────────────────

/** Returns true if cookie auth is available. */
function hasCookieAuth(creds: XCredentials | null): creds is XCredentials & { authToken: string; ct0: string } {
  return !!(creds?.authToken && creds?.ct0);
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Search recent tweets (last 7 days). */
export async function searchTweets(
  query: string,
  limit: number,
  account?: string,
  dataDir?: string
): Promise<XTweet[]> {
  const creds = await loadXCredentials(account, dataDir);

  // Cookie auth → x-fetch.py bridge (Chrome TLS via curl_cffi)
  if (hasCookieAuth(creds) && await isCookieClientAvailable()) {
    return bridgeSearchTweets(query, limit, creds);
  }

  // Token / no-auth → v2 REST
  const params = new URLSearchParams({
    query,
    max_results: String(Math.min(limit, 100)),
    'tweet.fields': 'created_at,public_metrics,author_id',
    'user.fields': 'username,name',
    expansions: 'author_id',
  });

  const data = await xRequest<{
    data?: Record<string, unknown>[];
    includes?: { users?: Record<string, unknown>[] };
  }>(`/2/tweets/search/recent?${params}`, {
    creds: creds ?? undefined,
  });

  const tweets = data.data ?? [];
  const users = data.includes?.users ?? [];
  const userMap: Record<string, Record<string, unknown>> = {};
  for (const u of users) userMap[String(u['id'])] = u;

  return tweets.slice(0, limit).map((t, i) => {
    const author = userMap[String(t['author_id'])] ?? {};
    return mapTweetRest(t, author, i);
  });
}

/** Get a user's timeline (most recent tweets). */
export async function getUserTimeline(
  username: string,
  limit: number,
  account?: string,
  dataDir?: string
): Promise<XTweet[]> {
  const creds = await loadXCredentials(account, dataDir);

  // Cookie auth → x-fetch.py bridge
  if (hasCookieAuth(creds) && await isCookieClientAvailable()) {
    return bridgeUserTimeline(username, limit, creds);
  }

  // v2 REST path
  const userResp = await xRequest<{ data: { id: string; username: string } }>(
    `/2/users/by/username/${username}?user.fields=id,username`,
    { creds: creds ?? undefined }
  );
  const userId = userResp.data.id;

  const params = new URLSearchParams({
    max_results: String(Math.min(limit, 100)),
    'tweet.fields': 'created_at,public_metrics',
    exclude: 'retweets,replies',
  });

  const data = await xRequest<{ data?: Record<string, unknown>[] }>(
    `/2/users/${userId}/tweets?${params}`,
    { creds: creds ?? undefined }
  );

  return (data.data ?? []).slice(0, limit).map((t, i) => mapTweetRest(t, { username }, i));
}

/** Get a user's profile. */
export async function getUserProfile(
  username: string,
  account?: string,
  dataDir?: string
): Promise<XUser | null> {
  const creds = await loadXCredentials(account, dataDir);

  // Cookie auth → x-fetch.py bridge
  if (hasCookieAuth(creds) && await isCookieClientAvailable()) {
    return bridgeUserProfile(username, creds);
  }

  // v2 REST path
  const params = 'user.fields=description,public_metrics,verified,entities';
  const data = await xRequest<{ data?: Record<string, unknown> }>(
    `/2/users/by/username/${username}?${params}`,
    { creds: creds ?? undefined }
  );

  const u = data.data;
  if (!u) return null;

  const metrics = u['public_metrics'] as Record<string, number> | null ?? {};
  return {
    rank: 1,
    username: String(u['username'] ?? ''),
    name: String(u['name'] ?? ''),
    followers: metrics['followers_count'] ?? 0,
    following: metrics['following_count'] ?? 0,
    tweets: metrics['tweet_count'] ?? 0,
    bio: String(u['description'] ?? '').slice(0, 160),
    verified: String(u['verified'] ?? false),
    url: `https://twitter.com/${u['username']}`,
  };
}

/** Get home timeline (cookie or OAuth required). */
export async function getHomeTimeline(
  limit: number,
  account?: string,
  dataDir?: string
): Promise<XTweet[]> {
  const creds = await loadXCredentials(account, dataDir);

  // Cookie auth → x-fetch.py bridge
  if (hasCookieAuth(creds) && await isCookieClientAvailable()) {
    return bridgeFeed(limit, creds);
  }

  // OAuth access token → v2 REST home timeline
  if (creds?.accessToken) {
    const params = new URLSearchParams({
      max_results: String(Math.min(limit, 100)),
      'tweet.fields': 'created_at,public_metrics,author_id',
      'user.fields': 'username,name',
      expansions: 'author_id',
    });

    const data = await xRequest<{
      data?: Record<string, unknown>[];
      includes?: { users?: Record<string, unknown>[] };
    }>(`/2/timelines/home?${params}`, {
      creds,
    });

    const tweets = data.data ?? [];
    const users = data.includes?.users ?? [];
    const userMap: Record<string, Record<string, unknown>> = {};
    for (const u of users) userMap[String(u['id'])] = u;

    return tweets.slice(0, limit).map((t, i) => {
      const author = userMap[String(t['author_id'])] ?? {};
      return mapTweetRest(t, author, i);
    });
  }

  throw new Error('Home timeline requires X authentication. Run: crossmind auth login x');
}

// ── Phase 2 read additions ─────────────────────────────────────────────────

export interface XTweetThread {
  tweet: XTweet;
  thread: XTweet[];
}

export interface XDMEvent {
  rank: number;
  id: string;
  sender: string;
  recipient: string;
  text: string;
  created_at: string;
}

/** Fetch a single tweet plus its reply thread. */
export async function getTweet(
  tweetId: string,
  limit: number,
  account?: string,
  dataDir?: string
): Promise<XTweetThread> {
  const creds = await loadXCredentials(account, dataDir);

  // Cookie auth → x-fetch.py bridge
  if (hasCookieAuth(creds) && await isCookieClientAvailable()) {
    return bridgeTweet(tweetId, limit, creds);
  }

  // REST v2 fallback: fetch tweet only (no thread traversal without elevated access)
  const params = 'tweet.fields=created_at,public_metrics,author_id&expansions=author_id&user.fields=username';
  const data = await xRequest<{
    data: Record<string, unknown>;
    includes?: { users?: Record<string, unknown>[] };
  }>(`/2/tweets/${tweetId}?${params}`, { creds: creds ?? undefined });

  const users = data.includes?.users ?? [];
  const userMap: Record<string, Record<string, unknown>> = {};
  for (const u of users) userMap[String(u['id'])] = u;
  const author = userMap[String(data.data['author_id'])] ?? {};
  return { tweet: mapTweetRest(data.data, author, 0), thread: [] };
}

/** Get a user's followers. */
export async function getFollowers(
  username: string,
  limit: number,
  account?: string,
  dataDir?: string
): Promise<XUser[]> {
  const creds = await loadXCredentials(account, dataDir);

  if (hasCookieAuth(creds) && await isCookieClientAvailable()) {
    return bridgeFollowers(username, limit, creds);
  }

  // REST v2
  const userResp = await xRequest<{ data: { id: string } }>(
    `/2/users/by/username/${username}`,
    { creds: creds ?? undefined }
  );
  const userId = userResp.data.id;
  const params = new URLSearchParams({
    max_results: String(Math.min(limit, 1000)),
    'user.fields': 'username,name,public_metrics,description,verified',
  });
  const data = await xRequest<{ data?: Record<string, unknown>[] }>(
    `/2/users/${userId}/followers?${params}`,
    { creds: creds ?? undefined }
  );
  return (data.data ?? []).slice(0, limit).map((u, i) => mapUserRest(u, i));
}

/** Get accounts a user follows. */
export async function getFollowing(
  username: string,
  limit: number,
  account?: string,
  dataDir?: string
): Promise<XUser[]> {
  const creds = await loadXCredentials(account, dataDir);

  if (hasCookieAuth(creds) && await isCookieClientAvailable()) {
    return bridgeFollowing(username, limit, creds);
  }

  const userResp = await xRequest<{ data: { id: string } }>(
    `/2/users/by/username/${username}`,
    { creds: creds ?? undefined }
  );
  const userId = userResp.data.id;
  const params = new URLSearchParams({
    max_results: String(Math.min(limit, 1000)),
    'user.fields': 'username,name,public_metrics,description,verified',
  });
  const data = await xRequest<{ data?: Record<string, unknown>[] }>(
    `/2/users/${userId}/following?${params}`,
    { creds: creds ?? undefined }
  );
  return (data.data ?? []).slice(0, limit).map((u, i) => mapUserRest(u, i));
}

/** Get bookmarks (cookie required). */
export async function getBookmarks(
  limit: number,
  account?: string,
  dataDir?: string
): Promise<XTweet[]> {
  const creds = await loadXCredentials(account, dataDir);
  if (!hasCookieAuth(creds)) {
    throw new AuthError('Bookmarks require cookie auth. Run: crossmind auth login x --auth-token <token> --ct0 <ct0>');
  }
  if (!await isCookieClientAvailable()) {
    throw new Error(
      'Bookmarks require Python 3 with curl_cffi.\n' +
      '  Install: uv pip install curl_cffi\n' +
      '  Or: pip install curl_cffi'
    );
  }
  return bridgeBookmarks(limit, creds);
}

/** Get notification timeline (tweet-containing notifications: replies, mentions, likes, retweets). */
export async function getNotifications(
  limit: number,
  account?: string,
  dataDir?: string
): Promise<XTweet[]> {
  const creds = await loadXCredentials(account, dataDir);
  if (!hasCookieAuth(creds)) {
    throw new AuthError('Notifications require cookie auth. Run: crossmind auth login x --auth-token <token> --ct0 <ct0>');
  }
  if (!await isCookieClientAvailable()) {
    throw new Error(
      'Notifications require Python 3 with curl_cffi.\n' +
      '  Install: uv pip install curl_cffi'
    );
  }
  return bridgeNotifications(limit, creds);
}

/** Get tweets from a Twitter List. */
export async function getListTweets(
  listId: string,
  limit: number,
  account?: string,
  dataDir?: string
): Promise<XTweet[]> {
  const creds = await loadXCredentials(account, dataDir);

  if (hasCookieAuth(creds) && await isCookieClientAvailable()) {
    return bridgeListTweets(listId, limit, creds);
  }

  // REST v2 fallback
  const params = new URLSearchParams({
    max_results: String(Math.min(limit, 100)),
    'tweet.fields': 'created_at,public_metrics,author_id',
    'user.fields': 'username,name',
    expansions: 'author_id',
  });
  const data = await xRequest<{
    data?: Record<string, unknown>[];
    includes?: { users?: Record<string, unknown>[] };
  }>(`/2/lists/${listId}/tweets?${params}`, { creds: creds ?? undefined });

  const users = data.includes?.users ?? [];
  const userMap: Record<string, Record<string, unknown>> = {};
  for (const u of users) userMap[String(u['id'])] = u;
  return (data.data ?? []).slice(0, limit).map((t, i) => {
    const author = userMap[String(t['author_id'])] ?? {};
    return mapTweetRest(t, author, i);
  });
}

/** Get a user's liked tweets. */
export async function getLikes(
  username: string,
  limit: number,
  account?: string,
  dataDir?: string
): Promise<XTweet[]> {
  const creds = await loadXCredentials(account, dataDir);
  if (!creds?.accessToken) {
    throw new AuthError('Likes require OAuth. Set X_ACCESS_TOKEN or run: crossmind auth login x');
  }
  const userResp = await xRequest<{ data: { id: string } }>(
    `/2/users/by/username/${username}`,
    { creds: creds ?? undefined }
  );
  const userId = userResp.data.id;
  const params = new URLSearchParams({
    max_results: String(Math.min(limit, 100)),
    'tweet.fields': 'created_at,public_metrics,author_id',
    'user.fields': 'username,name',
    expansions: 'author_id',
  });
  const data = await xRequest<{
    data?: Record<string, unknown>[];
    includes?: { users?: Record<string, unknown>[] };
  }>(`/2/users/${userId}/liked_tweets?${params}`, { creds: creds ?? undefined });

  const users = data.includes?.users ?? [];
  const userMap: Record<string, Record<string, unknown>> = {};
  for (const u of users) userMap[String(u['id'])] = u;
  return (data.data ?? []).slice(0, limit).map((t, i) => {
    const author = userMap[String(t['author_id'])] ?? {};
    return mapTweetRest(t, author, i);
  });
}

/** Get DM events list (requires OAuth with dm.read scope). */
export async function getDMList(
  limit: number,
  account?: string,
  dataDir?: string
): Promise<XDMEvent[]> {
  const creds = await loadXCredentials(account, dataDir);
  if (!creds?.accessToken) {
    throw new AuthError(
      'DM read requires OAuth.\n' +
      '  Set X_ACCESS_TOKEN, or run: crossmind auth login x --access-token <token>\n' +
      '  No Developer App? Get a token at https://crossmind.io\n' +
      '  Setup guide: https://crossmind.io/docs/x-setup'
    );
  }
  const params = new URLSearchParams({
    max_results: String(Math.min(limit, 100)),
    event_types: 'MessageCreate',
    'dm_event.fields': 'sender_id,created_at,text,dm_conversation_id',
    expansions: 'sender_id',
    'user.fields': 'username',
  });
  const data = await xRequest<{
    data?: Record<string, unknown>[];
    includes?: { users?: Record<string, unknown>[] };
  }>(`/2/dm_events?${params}`, { creds });

  const users = data.includes?.users ?? [];
  const userMap: Record<string, string> = {};
  for (const u of users) userMap[String(u['id'])] = String(u['username'] ?? '');

  return (data.data ?? []).slice(0, limit).map((e, i) => ({
    rank: i + 1,
    id: String(e['id'] ?? ''),
    sender: userMap[String(e['sender_id'])] ?? String(e['sender_id'] ?? ''),
    recipient: '',
    text: String(e['text'] ?? '').replace(/\n/g, ' ').slice(0, 200),
    created_at: String(e['created_at'] ?? '').slice(0, 10),
  }));
}

/** Get DM conversation with a specific user (requires OAuth with dm.read scope). */
export async function getDMConversation(
  participantUsername: string,
  limit: number,
  account?: string,
  dataDir?: string
): Promise<XDMEvent[]> {
  const creds = await loadXCredentials(account, dataDir);
  if (!creds?.accessToken) {
    throw new AuthError(
      'DM read requires OAuth.\n' +
      '  Set X_ACCESS_TOKEN, or run: crossmind auth login x --access-token <token>\n' +
      '  No Developer App? Get a token at https://crossmind.io\n' +
      '  Setup guide: https://crossmind.io/docs/x-setup'
    );
  }
  const targetData = await xRequest<{ data: { id: string } }>(
    `/2/users/by/username/${participantUsername}`,
    { creds }
  );
  const participantId = targetData.data.id;

  const params = new URLSearchParams({
    max_results: String(Math.min(limit, 100)),
    'dm_event.fields': 'sender_id,created_at,text',
    expansions: 'sender_id',
    'user.fields': 'username',
  });
  const data = await xRequest<{
    data?: Record<string, unknown>[];
    includes?: { users?: Record<string, unknown>[] };
  }>(`/2/dm_conversations/with/${participantId}/dm_events?${params}`, { creds });

  const users = data.includes?.users ?? [];
  const userMap: Record<string, string> = {};
  for (const u of users) userMap[String(u['id'])] = String(u['username'] ?? '');

  return (data.data ?? []).slice(0, limit).map((e, i) => ({
    rank: i + 1,
    id: String(e['id'] ?? ''),
    sender: userMap[String(e['sender_id'])] ?? String(e['sender_id'] ?? ''),
    recipient: participantUsername,
    text: String(e['text'] ?? '').replace(/\n/g, ' ').slice(0, 200),
    created_at: String(e['created_at'] ?? '').slice(0, 10),
  }));
}

// ── Analytics (requires OAuth for organic_metrics + non_public_metrics) ─────

function mapTweetAnalytics(tweet: Record<string, unknown>, author: Record<string, unknown>, index: number): XTweetAnalytics {
  const base = mapTweetRest(tweet, author, index);
  const organic = (tweet['organic_metrics'] as Record<string, number> | null) ?? {};
  const nonPublic = (tweet['non_public_metrics'] as Record<string, number> | null) ?? {};
  return {
    ...base,
    engagements: nonPublic['engagements'] ?? 0,
    profile_clicks: organic['user_profile_clicks'] ?? 0,
    url_link_clicks: organic['url_link_clicks'] ?? 0,
  };
}

/**
 * Get tweets with full analytics (organic_metrics + non_public_metrics).
 * Requires OAuth — cookie auth does not expose these fields via GraphQL.
 *
 * Default: own tweets excluding replies (original content performance).
 * Use --include-replies to also fetch reply engagement.
 * Supports pagination up to ~800 recent tweets via next_token.
 */
export async function getAnalytics(
  username: string,
  limit: number,
  includeReplies: boolean,
  account?: string,
  dataDir?: string
): Promise<XTweetAnalytics[]> {
  const creds = await loadXCredentials(account, dataDir);
  if (!creds?.accessToken) {
    throw new AuthError(
      'Analytics requires OAuth access token (organic_metrics + non_public_metrics are OAuth-only).\n' +
      '  Set X_ACCESS_TOKEN, or run: crossmind auth login x'
    );
  }

  // X API requires min 5 when requesting organic_metrics / non_public_metrics
  const MIN_PAGE_SIZE = 5;
  const clampedLimit = Math.max(limit, MIN_PAGE_SIZE);

  // Resolve username → user ID
  const userResp = await xRequest<{ data: { id: string; username: string } }>(
    `/2/users/by/username/${username}?user.fields=id,username`,
    { creds }
  );
  const userId = userResp.data.id;

  const fields = 'created_at,public_metrics,organic_metrics,non_public_metrics';
  const results: XTweetAnalytics[] = [];
  let remaining = Math.min(clampedLimit, 800);
  let nextToken: string | undefined;

  while (remaining > 0) {
    const pageSize = Math.min(remaining, 100);
    const params = new URLSearchParams({
      max_results: String(pageSize),
      'tweet.fields': fields,
    });
    if (!includeReplies) {
      params.set('exclude', 'retweets,replies');
    }
    if (nextToken) {
      params.set('pagination_token', nextToken);
    }

    const data = await xRequest<{
      data?: Record<string, unknown>[];
      meta?: { next_token?: string; result_count: number };
    }>(`/2/users/${userId}/tweets?${params}`, { creds });

    const tweets = data.data ?? [];
    for (let i = 0; i < tweets.length; i++) {
      results.push(mapTweetAnalytics(tweets[i], { username }, results.length));
    }
    remaining -= tweets.length;

    // Stop if fewer than pageSize results or no next_token
    if (tweets.length < pageSize || !data.meta?.next_token) break;
    nextToken = data.meta.next_token;
  }

  return results.slice(0, limit);
}

// ── REST helpers for user objects ──────────────────────────────────────────

function mapUserRest(u: Record<string, unknown>, index: number): XUser {
  const metrics = u['public_metrics'] as Record<string, number> | null ?? {};
  const username = String(u['username'] ?? '');
  return {
    rank: index + 1,
    username,
    name: String(u['name'] ?? ''),
    followers: metrics['followers_count'] ?? 0,
    following: metrics['following_count'] ?? 0,
    tweets: metrics['tweet_count'] ?? 0,
    bio: String(u['description'] ?? '').slice(0, 160),
    verified: String(u['verified'] ?? false),
    url: `https://twitter.com/${username}`,
  };
}
