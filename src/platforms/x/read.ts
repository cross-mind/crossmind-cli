/**
 * X (Twitter) read operations.
 *
 * Auth priority:
 *   1. Cookie (auth_token + ct0) → GraphQL API (x.com/i/api/graphql)
 *   2. Bearer / OAuth token      → v2 REST API (api.twitter.com/2)
 *   3. No credentials            → v2 REST with public bearer (search only)
 */

import { xRequest, xGqlGet, type XCredentials } from '../../http/x-client.js';
import { loadXCredentials } from '../../auth/x.js';

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

// ── GraphQL response parsers ───────────────────────────────────────────────

/** Extract tweets from GraphQL timeline instruction entries. */
function parseTweetEntries(entries: unknown[]): XTweet[] {
  const tweets: XTweet[] = [];
  for (const entry of entries) {
    const e = entry as Record<string, unknown>;
    const content = e['content'] as Record<string, unknown> | undefined;
    if (!content) continue;

    const itemContent = content['itemContent'] as Record<string, unknown> | undefined;
    if (!itemContent) continue;

    const tweetResults = itemContent['tweet_results'] as Record<string, unknown> | undefined;
    if (!tweetResults) continue;

    const result = tweetResults['result'] as Record<string, unknown> | undefined;
    if (!result || result['__typename'] !== 'Tweet') continue;

    const legacy = result['legacy'] as Record<string, unknown> | undefined;
    if (!legacy) continue;

    const core = result['core'] as Record<string, unknown> | undefined;
    const userResult = (core?.['user_results'] as Record<string, unknown>)?.['result'] as Record<string, unknown> | undefined;
    const userLegacy = userResult?.['legacy'] as Record<string, unknown> | undefined;
    const username = String(userLegacy?.['screen_name'] ?? '');
    const id = String(result['rest_id'] ?? '');
    const views = (result['views'] as Record<string, unknown>)?.['count'];

    tweets.push({
      rank: tweets.length + 1,
      id,
      text: String(legacy['full_text'] ?? '').replace(/\n/g, ' ').slice(0, 200),
      author: username,
      likes: Number(legacy['favorite_count'] ?? 0),
      retweets: Number(legacy['retweet_count'] ?? 0),
      replies: Number(legacy['reply_count'] ?? 0),
      views: views !== undefined ? Number(views) : 0,
      created_at: String(legacy['created_at'] ?? '').slice(0, 16),
      url: buildTweetUrl(username, id),
    });
  }
  return tweets;
}

/** Extract tweets from GraphQL timeline instructions array. */
function parseTimelineInstructions(instructions: unknown[]): XTweet[] {
  const tweets: XTweet[] = [];
  for (const instruction of instructions) {
    const inst = instruction as Record<string, unknown>;
    if (inst['type'] === 'TimelineAddEntries') {
      const entries = (inst['entries'] as unknown[]) ?? [];
      tweets.push(...parseTweetEntries(entries));
    }
  }
  return tweets;
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

  // Cookie auth → GraphQL SearchTimeline
  if (hasCookieAuth(creds)) {
    const resp = await xGqlGet<Record<string, unknown>>(
      'SearchTimeline',
      {
        rawQuery: query,
        count: Math.min(limit, 20),
        querySource: 'typed_query',
        product: 'Latest',
      },
      creds
    );
    const instructions = (
      (((resp['data'] as Record<string, unknown>)
        ?.['search_by_raw_query'] as Record<string, unknown>)
        ?.['search_timeline'] as Record<string, unknown>)
        ?.['timeline'] as Record<string, unknown>)
        ?.['instructions'] as unknown[] ?? [];
    return parseTimelineInstructions(instructions).slice(0, limit);
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

  // Cookie auth → GraphQL UserTweets
  if (hasCookieAuth(creds)) {
    // First, resolve userId via UserByScreenName
    const profileResp = await xGqlGet<Record<string, unknown>>(
      'UserByScreenName',
      { screen_name: username, withSafetyModeUserFields: true },
      creds
    );
    const userResult = ((profileResp['data'] as Record<string, unknown>)
      ?.['user'] as Record<string, unknown>)
      ?.['result'] as Record<string, unknown> | undefined;
    const userId = String(userResult?.['rest_id'] ?? '');

    if (!userId) return [];

    const resp = await xGqlGet<Record<string, unknown>>(
      'UserTweets',
      {
        userId,
        count: Math.min(limit, 20),
        includePromotedContent: false,
        withQuotedTweets: false,
      },
      creds
    );

    const instructions = (
      ((((resp['data'] as Record<string, unknown>)
        ?.['user'] as Record<string, unknown>)
        ?.['result'] as Record<string, unknown>)
        ?.['timeline_v2'] as Record<string, unknown>)
        ?.['timeline'] as Record<string, unknown>)
        ?.['instructions'] as unknown[] ?? [];
    return parseTimelineInstructions(instructions).slice(0, limit);
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

  // Cookie auth → GraphQL UserByScreenName
  if (hasCookieAuth(creds)) {
    const resp = await xGqlGet<Record<string, unknown>>(
      'UserByScreenName',
      { screen_name: username, withSafetyModeUserFields: true },
      creds
    );
    const result = ((resp['data'] as Record<string, unknown>)
      ?.['user'] as Record<string, unknown>)
      ?.['result'] as Record<string, unknown>;
    if (!result) return null;
    const legacy = result['legacy'] as Record<string, unknown> ?? {};
    const screen_name = String(legacy['screen_name'] ?? username);
    return {
      rank: 1,
      username: screen_name,
      name: String(legacy['name'] ?? ''),
      followers: Number(legacy['followers_count'] ?? 0),
      following: Number(legacy['friends_count'] ?? 0),
      tweets: Number(legacy['statuses_count'] ?? 0),
      bio: String(legacy['description'] ?? '').slice(0, 160),
      verified: String(legacy['verified'] ?? false),
      url: `https://twitter.com/${screen_name}`,
    };
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

  // Cookie auth → GraphQL HomeTimeline
  if (hasCookieAuth(creds)) {
    const resp = await xGqlGet<Record<string, unknown>>(
      'HomeTimeline',
      {
        count: Math.min(limit, 20),
        includePromotedContent: false,
        latestControlAvailable: true,
        requestContext: 'launch',
        withCommunity: false,
        seenTweetCount: 0,
      },
      creds
    );
    const instructions = (
      (((resp['data'] as Record<string, unknown>)
        ?.['home'] as Record<string, unknown>)
        ?.['home_timeline_urt'] as Record<string, unknown>)
        ?.['instructions'] as unknown[] ?? []);
    return parseTimelineInstructions(instructions).slice(0, limit);
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
