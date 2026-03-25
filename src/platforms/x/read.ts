/**
 * X (Twitter) read operations.
 *
 * Auth priority:
 *   1. Cookie (auth_token + ct0) → twitter-cli bridge (curl_cffi Chrome TLS)
 *   2. Bearer / OAuth token      → v2 REST API (api.twitter.com/2)
 *   3. No credentials            → v2 REST with public bearer (search only)
 *
 * Note: x.com/i/api/graphql requires Chrome TLS fingerprinting. Node.js's
 * fetch() is rejected (404). The bridge delegates to twitter-cli which uses
 * curl_cffi for proper Chrome impersonation.
 */

import { xRequest, type XCredentials } from '../../http/x-client.js';
import { loadXCredentials } from '../../auth/x.js';
import {
  isTwitterCliAvailable,
  bridgeSearchTweets,
  bridgeFeed,
  bridgeUserTimeline,
  bridgeUserProfile,
} from '../../http/x-bridge.js';

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

  // Cookie auth → twitter-cli bridge (Chrome TLS via curl_cffi)
  if (hasCookieAuth(creds) && await isTwitterCliAvailable()) {
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

  // Cookie auth → twitter-cli bridge
  if (hasCookieAuth(creds) && await isTwitterCliAvailable()) {
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

  // Cookie auth → twitter-cli bridge
  if (hasCookieAuth(creds) && await isTwitterCliAvailable()) {
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

  // Cookie auth → twitter-cli bridge
  if (hasCookieAuth(creds) && await isTwitterCliAvailable()) {
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
