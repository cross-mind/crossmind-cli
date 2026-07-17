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
import { loadXCredentials, loadXCredentialCandidates, type ResolvedXCredential } from '../../auth/x.js';
import {
  isCookieClientAvailable,
  bridgeSearchTweets,
  bridgeFeed,
  bridgeUserTimeline,
  bridgeUserProfile,
  bridgeUserById,
  bridgeTweet,
  bridgeFollowers,
  bridgeFollowing,
  bridgeBookmarks,
  bridgeNotifications,
  bridgeListTweets,
} from '../../http/x-bridge.js';
import { AuthError } from '../../http/client.js';
import type { UnifiedUser } from '../../types/identity.js';
import { makeUser } from '../../types/identity.js';

export interface XTweet {
  rank: number;
  id: string;
  text: string;
  author: UnifiedUser;
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

export interface XUser extends UnifiedUser {
  rank: number;
  /** Following count (X-specific extra; null elsewhere). */
  following: number;
  /** Total tweet count (X-specific extra). */
  tweets: number;
}

function buildTweetUrl(username: string, tweetId: string): string {
  return `https://twitter.com/${username}/status/${tweetId}`;
}

// ── v2 REST helpers ────────────────────────────────────────────────────────

/** Build a UnifiedUser from a v2 REST user object. */
function userFromRest(u: Record<string, unknown>): UnifiedUser {
  const metrics = (u['public_metrics'] as Record<string, number> | null) ?? {};
  const username = String(u['username'] ?? '');
  return {
    id: u['id'] ? String(u['id']) : null,
    username: username || null,
    name: u['name'] ? String(u['name']) : null,
    avatar_url: u['profile_image_url'] ? String(u['profile_image_url']) : null,
    profile_url: username ? `https://twitter.com/${username}` : null,
    bio: u['description'] ? String(u['description']).slice(0, 160) : null,
    followers: metrics['followers_count'] ?? null,
    verified: u['verified'] === true ? true : (u['verified'] === false ? false : null),
  };
}

function mapTweetRest(tweet: Record<string, unknown>, author: Record<string, unknown>, index: number): XTweet {
  const metrics = tweet['public_metrics'] as Record<string, number> | null ?? {};
  const authorUser = userFromRest(author);
  const username = authorUser.username ?? '';
  const id = String(tweet['id'] ?? '');
  return {
    rank: index + 1,
    id,
    text: String(tweet['text'] ?? ''),
    author: authorUser,
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

// ── Progressive credential cascade ("逐级降权") ──────────────────────────────

/** Matches auth-failure messages surfaced by the bridge or REST layer, so a
 *  failure of one credential tier can trigger a fallback to the next instead
 *  of being reported as a hard stop. */
const AUTH_FAILURE_RE = /HTTP Error 401|HTTP 401|Could not authenticate you|session invalid or expired|X OAuth token missing or expired/i;

function isAuthFailure(err: unknown): boolean {
  return err instanceof AuthError || AUTH_FAILURE_RE.test((err as Error)?.message ?? '');
}

const TIER_LABEL: Record<ResolvedXCredential['_credSource'], string> = {
  own: 'your X account session',
  public: 'the shared public X account',
  oauth: 'your X OAuth token',
};

/**
 * First-trigger-per-process notification: the first time a given tier→tier
 * degradation is observed in this CLI invocation, tell the caller which
 * account/tier failed and which one it's falling back to, instead of
 * silently swallowing the failure. Deduped so a paginated loop hitting the
 * same dead tier repeatedly doesn't spam the same line.
 */
const _degradeNotified = new Set<string>();
function notifyDegrade(from: ResolvedXCredential['_credSource'], to: ResolvedXCredential['_credSource'] | undefined, reason: string): void {
  const key = `${from}->${to ?? 'none'}`;
  if (_degradeNotified.has(key)) return;
  _degradeNotified.add(key);
  const fromLabel = TIER_LABEL[from];
  if (to) {
    console.error(`[x] ${fromLabel} is invalid (${reason}) — degrading to ${TIER_LABEL[to]}.`);
  } else {
    console.error(`[x] ${fromLabel} is invalid (${reason}) — no further fallback credential available.`);
  }
}

/**
 * Try each resolved credential candidate in priority order (own cookie →
 * public cookie → OAuth). For each candidate: use the bridge if it's a
 * cookie and the bridge is available, otherwise use the REST path. On an
 * auth failure, notify once and move to the next candidate rather than
 * stopping at whichever tier happened to resolve first. Non-auth errors
 * (network, rate limit, etc.) are not cascaded — they propagate immediately.
 * Once candidates are exhausted, makes one final unauthenticated/public REST
 * attempt (matches the pre-cascade behavior of always having a public
 * fallback available for search-like ops).
 */
type CookieCred = ResolvedXCredential & { authToken: string; ct0: string };

async function cascadeRead<T>(
  candidates: ResolvedXCredential[],
  bridgeFn: ((c: CookieCred) => Promise<T>) | null,
  restFn: (c: ResolvedXCredential | null) => Promise<T>,
): Promise<T> {
  const bridgeAvailable = bridgeFn ? await isCookieClientAvailable() : false;
  let lastErr: unknown;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const isCookie = !!(c.authToken && c.ct0);
    try {
      if (isCookie && bridgeAvailable) {
        return await bridgeFn!(c as CookieCred);
      } else if (c.accessToken || c.bearerToken) {
        return await restFn(c);
      } else {
        continue;
      }
    } catch (err) {
      lastErr = err;
      if (!isAuthFailure(err)) throw err;
      const next = candidates[i + 1];
      notifyDegrade(c._credSource, next?._credSource, (err as Error).message ?? String(err));
    }
  }
  try {
    return await restFn(null);
  } catch (err) {
    throw lastErr ?? err;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Search recent tweets (last 7 days). */
export async function searchTweets(
  query: string,
  limit: number,
  account?: string,
  dataDir?: string
): Promise<XTweet[]> {
  const candidates = await loadXCredentialCandidates(account, dataDir, 'search');

  return cascadeRead(
    candidates,
    (c) => bridgeSearchTweets(query, limit, c),
    async (c) => {
      // Token / no-auth → v2 REST (uses env X_BEARER_TOKEN or public fallback)
      const params = new URLSearchParams({
        query,
        max_results: String(Math.min(limit, 100)),
        'tweet.fields': 'created_at,public_metrics,author_id',
        'user.fields': 'id,username,name,profile_image_url',
        expansions: 'author_id',
      });

      const data = await xRequest<{
        data?: Record<string, unknown>[];
        includes?: { users?: Record<string, unknown>[] };
      }>(`/2/tweets/search/recent?${params}`, {
        creds: c ?? undefined,
      });

      const tweets = data.data ?? [];
      const users = data.includes?.users ?? [];
      const userMap: Record<string, Record<string, unknown>> = {};
      for (const u of users) userMap[String(u['id'])] = u;

      return tweets.slice(0, limit).map((t, i) => {
        const author = userMap[String(t['author_id'])] ?? {};
        return mapTweetRest(t, author, i);
      });
    },
  );
}

/** Get a user's timeline (most recent tweets). */
export async function getUserTimeline(
  username: string,
  limit: number,
  account?: string,
  dataDir?: string
): Promise<XTweet[]> {
  const candidates = await loadXCredentialCandidates(account, dataDir, 'timeline');

  return cascadeRead(
    candidates,
    (c) => bridgeUserTimeline(username, limit, c),
    async (c) => {
      const userResp = await xRequest<{ data: { id: string; username: string } }>(
        `/2/users/by/username/${username}?user.fields=id,username`,
        { creds: c ?? undefined }
      );
      const userId = userResp.data.id;

      const params = new URLSearchParams({
        max_results: String(Math.min(limit, 100)),
        'tweet.fields': 'created_at,public_metrics',
        exclude: 'retweets,replies',
      });

      const data = await xRequest<{ data?: Record<string, unknown>[] }>(
        `/2/users/${userId}/tweets?${params}`,
        { creds: c ?? undefined }
      );

      return (data.data ?? []).slice(0, limit).map((t, i) => mapTweetRest(t, { username }, i));
    },
  );
}

/** Get a user's profile. */
export async function getUserProfile(
  username: string,
  account?: string,
  dataDir?: string
): Promise<XUser | null> {
  const candidates = await loadXCredentialCandidates(account, dataDir, 'profile');

  return cascadeRead(
    candidates,
    (c) => bridgeUserProfile(username, c),
    async (c) => {
      const params = 'user.fields=id,description,public_metrics,verified,entities,profile_image_url';
      const data = await xRequest<{ data?: Record<string, unknown> }>(
        `/2/users/by/username/${username}?${params}`,
        { creds: c ?? undefined }
      );

      const u = data.data;
      if (!u) return null;
      return mapUserRest(u, 1);
    },
  );
}

/** Resolve a numeric rest_id → profile (P1 bidirectional lookup). */
export async function getUserById(
  restId: string,
  account?: string,
  dataDir?: string
): Promise<XUser | null> {
  const candidates = await loadXCredentialCandidates(account, dataDir, 'user');

  return cascadeRead(
    candidates,
    (c) => bridgeUserById(restId, c),
    async (c) => {
      const params = 'user.fields=id,description,public_metrics,verified,profile_image_url';
      const data = await xRequest<{ data?: Record<string, unknown> }>(
        `/2/users/${restId}?${params}`,
        { creds: c ?? undefined }
      );
      const u = data.data;
      if (!u) return null;
      return mapUserRest(u, 1);
    },
  );
}

/** Get home timeline (cookie or OAuth required). */
export async function getHomeTimeline(
  limit: number,
  account?: string,
  dataDir?: string
): Promise<XTweet[]> {
  // Home is identity-tied (never eligible for the shared public account) —
  // candidates here are own-cookie then OAuth only.
  const candidates = await loadXCredentialCandidates(account, dataDir);

  return cascadeRead(
    candidates,
    (c) => bridgeFeed(limit, c),
    async (c) => {
      if (!c?.accessToken) {
        throw new Error('Home timeline requires X authentication. Run: crossmind auth login x');
      }
      const params = new URLSearchParams({
        max_results: String(Math.min(limit, 100)),
        'tweet.fields': 'created_at,public_metrics,author_id',
        'user.fields': 'id,username,name,profile_image_url',
        expansions: 'author_id',
      });

      const data = await xRequest<{
        data?: Record<string, unknown>[];
        includes?: { users?: Record<string, unknown>[] };
      }>(`/2/timelines/home?${params}`, {
        creds: c,
      });

      const tweets = data.data ?? [];
      const users = data.includes?.users ?? [];
      const userMap: Record<string, Record<string, unknown>> = {};
      for (const u of users) userMap[String(u['id'])] = u;

      return tweets.slice(0, limit).map((t, i) => {
        const author = userMap[String(t['author_id'])] ?? {};
        return mapTweetRest(t, author, i);
      });
    },
  );
}

// ── Phase 2 read additions ─────────────────────────────────────────────────

export interface XTweetThread {
  tweet: XTweet;
  thread: XTweet[];
}

export interface XDMEvent {
  rank: number;
  id: string;
  sender: UnifiedUser;
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
  const candidates = await loadXCredentialCandidates(account, dataDir, 'thread');

  return cascadeRead(
    candidates,
    (c) => bridgeTweet(tweetId, limit, c),
    async (c) => {
      // REST v2 fallback: fetch tweet only (no thread traversal without elevated access)
      const params = 'tweet.fields=created_at,public_metrics,author_id&expansions=author_id&user.fields=id,username,name,profile_image_url';
      const data = await xRequest<{
        data: Record<string, unknown>;
        includes?: { users?: Record<string, unknown>[] };
      }>(`/2/tweets/${tweetId}?${params}`, { creds: c ?? undefined });

      const users = data.includes?.users ?? [];
      const userMap: Record<string, Record<string, unknown>> = {};
      for (const u of users) userMap[String(u['id'])] = u;
      const author = userMap[String(data.data['author_id'])] ?? {};
      return { tweet: mapTweetRest(data.data, author, 0), thread: [] };
    },
  );
}

/** Get a user's followers. */
export async function getFollowers(
  username: string,
  limit: number,
  account?: string,
  dataDir?: string
): Promise<XUser[]> {
  const candidates = await loadXCredentialCandidates(account, dataDir, 'followers');

  return cascadeRead(
    candidates,
    (c) => bridgeFollowers(username, limit, c),
    async (c) => {
      const userResp = await xRequest<{ data: { id: string } }>(
        `/2/users/by/username/${username}`,
        { creds: c ?? undefined }
      );
      const userId = userResp.data.id;
      const params = new URLSearchParams({
        max_results: String(Math.min(limit, 1000)),
        'user.fields': 'id,username,name,public_metrics,description,verified,profile_image_url',
      });
      const data = await xRequest<{ data?: Record<string, unknown>[] }>(
        `/2/users/${userId}/followers?${params}`,
        { creds: c ?? undefined }
      );
      return (data.data ?? []).slice(0, limit).map((u, i) => mapUserRest(u, i));
    },
  );
}

/** Get accounts a user follows. */
export async function getFollowing(
  username: string,
  limit: number,
  account?: string,
  dataDir?: string
): Promise<XUser[]> {
  const candidates = await loadXCredentialCandidates(account, dataDir, 'following');

  return cascadeRead(
    candidates,
    (c) => bridgeFollowing(username, limit, c),
    async (c) => {
      const userResp = await xRequest<{ data: { id: string } }>(
        `/2/users/by/username/${username}`,
        { creds: c ?? undefined }
      );
      const userId = userResp.data.id;
      const params = new URLSearchParams({
        max_results: String(Math.min(limit, 1000)),
        'user.fields': 'id,username,name,public_metrics,description,verified,profile_image_url',
      });
      const data = await xRequest<{ data?: Record<string, unknown>[] }>(
        `/2/users/${userId}/following?${params}`,
        { creds: c ?? undefined }
      );
      return (data.data ?? []).slice(0, limit).map((u, i) => mapUserRest(u, i));
    },
  );
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
  const candidates = await loadXCredentialCandidates(account, dataDir);

  return cascadeRead(
    candidates,
    (c) => bridgeListTweets(listId, limit, c),
    async (c) => {
      const params = new URLSearchParams({
        max_results: String(Math.min(limit, 100)),
        'tweet.fields': 'created_at,public_metrics,author_id',
        'user.fields': 'id,username,name,profile_image_url',
        expansions: 'author_id',
      });
      const data = await xRequest<{
        data?: Record<string, unknown>[];
        includes?: { users?: Record<string, unknown>[] };
      }>(`/2/lists/${listId}/tweets?${params}`, { creds: c ?? undefined });

      const users = data.includes?.users ?? [];
      const userMap: Record<string, Record<string, unknown>> = {};
      for (const u of users) userMap[String(u['id'])] = u;
      return (data.data ?? []).slice(0, limit).map((t, i) => {
        const author = userMap[String(t['author_id'])] ?? {};
        return mapTweetRest(t, author, i);
      });
    },
  );
}

/** Get a user's liked tweets. */
export async function getLikes(
  username: string,
  limit: number,
  account?: string,
  dataDir?: string
): Promise<XTweet[]> {
  const creds = await loadXCredentials(account, dataDir, 'likes');
  if (!creds?.accessToken) {
    throw new AuthError('Likes require OAuth. Set X_ACCESS_TOKEN or run: crossmind auth login x');
  }
  const userResp = await xRequest<{ data: { id: string } }>(
    `/2/users/by/username/${username}`,
    { creds: creds ?? undefined }
  );
  const userId = userResp.data.id;
  const params = new URLSearchParams({
    max_results: String(Math.min(Math.max(limit, 5), 100)), // X requires 5-100
    'tweet.fields': 'created_at,public_metrics,author_id',
    'user.fields': 'id,username,name,profile_image_url',
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

/**
 * Parse a --since value into an ISO 8601 string.
 * Accepts: relative shorthand ("24h", "7d", "30m"), date-only ("2026-04-10"), or full ISO.
 */
function parseSince(since: string): string {
  const rel = since.match(/^(\d+)(m|h|d|w)$/);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2];
    const ms = unit === 'm' ? n * 60_000
      : unit === 'h' ? n * 3_600_000
      : unit === 'd' ? n * 86_400_000
      : n * 7 * 86_400_000;
    return new Date(Date.now() - ms).toISOString();
  }
  // date-only → start of that day in UTC
  if (/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    return new Date(since + 'T00:00:00Z').toISOString();
  }
  // assume already ISO
  const d = new Date(since);
  if (isNaN(d.getTime())) throw new Error(`Invalid --since value: "${since}"`);
  return d.toISOString();
}

/** Get DM events list (requires OAuth with dm.read scope). */
export async function getDMList(
  limit: number,
  since?: string,
  until?: string,
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

  // X v2 /2/dm_events does not support start_time/end_time — paginate and filter client-side.
  // API returns newest-first, so: skip events newer than untilMs, collect until sinceMs.
  const sinceMs = since ? new Date(parseSince(since)).getTime() : undefined;
  const untilMs = until ? new Date(parseSince(until)).getTime() : undefined;
  const hasFilter = sinceMs !== undefined || untilMs !== undefined;
  const pageSize = Math.min(hasFilter ? 100 : limit, 100);
  const hardCap = hasFilter ? 500 : limit;
  const allEvents: Record<string, unknown>[] = [];
  const allUsers: Record<string, unknown>[] = [];
  let nextToken: string | undefined;
  let reachedCutoff = false;

  do {
    const params = new URLSearchParams({
      max_results: String(pageSize),
      event_types: 'MessageCreate',
      'dm_event.fields': 'sender_id,created_at,text,dm_conversation_id',
      expansions: 'sender_id',
      'user.fields': 'id,username,name,profile_image_url',
    });
    if (nextToken) params.set('pagination_token', nextToken);

    const data = await xRequest<{
      data?: Record<string, unknown>[];
      includes?: { users?: Record<string, unknown>[] };
      meta?: { next_token?: string };
    }>(`/2/dm_events?${params}`, { creds });

    const page = data.data ?? [];
    allUsers.push(...(data.includes?.users ?? []));

    if (hasFilter) {
      for (const e of page) {
        const ts = new Date(String(e['created_at'] ?? '')).getTime();
        if (isNaN(ts)) continue;
        if (untilMs !== undefined && ts > untilMs) continue; // too recent, skip
        if (sinceMs !== undefined && ts < sinceMs) { reachedCutoff = true; break; } // too old, stop
        allEvents.push(e);
      }
    } else {
      allEvents.push(...page);
    }

    nextToken = data.meta?.next_token;
  } while (nextToken && !reachedCutoff && allEvents.length < hardCap);

  const userMap: Record<string, UnifiedUser> = {};
  for (const u of allUsers) userMap[String(u['id'])] = userFromRest(u);

  return allEvents.slice(0, hardCap).map((e, i) => {
    const sid = String(e['sender_id'] ?? '');
    return {
      rank: i + 1,
      id: String(e['id'] ?? ''),
      sender: userMap[sid] ?? { ...makeUser({}), id: sid || null },
      recipient: '',
      text: String(e['text'] ?? ''),
      created_at: String(e['created_at'] ?? '').slice(0, 16).replace('T', ' '),
    };
  });
}

/** In-process cache for username → user ID lookups (avoids redundant API calls). */
const _usernameIdCache = new Map<string, string>();

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

  const cacheKey = participantUsername.toLowerCase();
  let participantId = _usernameIdCache.get(cacheKey);
  if (!participantId) {
    const targetData = await xRequest<{ data: { id: string } }>(
      `/2/users/by/username/${participantUsername}`,
      { creds }
    );
    participantId = targetData.data.id;
    _usernameIdCache.set(cacheKey, participantId);
  }

  const params = new URLSearchParams({
    max_results: String(Math.min(limit, 100)),
    'dm_event.fields': 'sender_id,created_at,text',
    expansions: 'sender_id',
    'user.fields': 'id,username,name,profile_image_url',
  });
  const data = await xRequest<{
    data?: Record<string, unknown>[];
    includes?: { users?: Record<string, unknown>[] };
  }>(`/2/dm_conversations/with/${participantId}/dm_events?${params}`, { creds });

  const users = data.includes?.users ?? [];
  const userMap: Record<string, UnifiedUser> = {};
  for (const u of users) userMap[String(u['id'])] = userFromRest(u);

  return (data.data ?? []).slice(0, limit).map((e, i) => {
    const sid = String(e['sender_id'] ?? '');
    return {
      rank: i + 1,
      id: String(e['id'] ?? ''),
      sender: userMap[sid] ?? { ...makeUser({}), id: sid || null },
      recipient: participantUsername,
      text: String(e['text'] ?? ''),
      created_at: String(e['created_at'] ?? '').slice(0, 16).replace('T', ' '),
    };
  });
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
  const base = userFromRest(u);
  const metrics = u['public_metrics'] as Record<string, number> | null ?? {};
  return {
    ...base,
    rank: index + 1,
    following: metrics['following_count'] ?? 0,
    tweets: metrics['tweet_count'] ?? 0,
  };
}
