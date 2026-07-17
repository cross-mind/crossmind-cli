/**
 * X cookie-auth client — subprocess bridge to scripts/x-fetch.py.
 *
 * X's GraphQL endpoints require Chrome TLS fingerprinting (JA3/JA4).
 * Node.js fetch() has a different fingerprint → X returns 404.
 * The bundled scripts/x-fetch.py uses curl_cffi (Chrome impersonation).
 *
 * Python discovery order:
 *   1. python3 (system Python)
 *   2. python
 *
 * Script: <package-root>/scripts/x-fetch.py (bundled with the npm package)
 *
 * Install curl_cffi (one-time):
 *   uv pip install curl_cffi
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { XTweet, XUser } from '../platforms/x/read.js';
import { makeUser, type UnifiedUser } from '../types/identity.js';
import { markCredentialInvalid } from '../auth/store.js';

const execFileAsync = promisify(execFile);

/** Cookie creds for the bridge, plus optional account context for invalid-marker bookkeeping. */
export interface BridgeCreds {
  authToken: string;
  ct0: string;
  _account?: string;
  _dataDir?: string;
  /** Which credential tier this cookie was resolved from — see auth/x.ts loadXCredentials(). */
  _credSource?: 'own' | 'public' | 'oauth';
}

// scripts/x-fetch.py is two levels up from dist/http/
const __dir = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.resolve(__dir, '../../scripts/x-fetch.py');

const PYTHON_CANDIDATES = ['python3', 'python'];

/** Matches x-fetch.py's auth-failure messages: raw HTTP 401s and X's own "Could not authenticate you" (code 32). */
const AUTH_FAILURE_RE = /HTTP Error 401|Could not authenticate you/i;

/**
 * Pseudo-account name used to record local observations about the shared
 * public account's health. It is never resolved as a real credential (see
 * loadXCredentials/fetchPublicCredential) — this is purely a local history
 * log so `crossmind auth status` can show "the shared account was last seen
 * dead at T" without misattributing a shared-infra outage to the caller's
 * own login. Matches the `name: '__public__'` convention already used by
 * fetchPublicCredential's transient Credential object.
 */
export const PUBLIC_TIER_ACCOUNT = '__public__';

/**
 * Persist a local "this cookie is dead" marker. The user's own credential is
 * marked directly against their account. The shared public account is
 * backend-managed infrastructure the CLI can't fix, so its failures are
 * recorded separately under PUBLIC_TIER_ACCOUNT — a local *observation* log,
 * not a claim about a locally-fixable credential — so degradation history
 * stays queryable without conflating it with the caller's own account state.
 */
async function markCookieInvalid(creds: BridgeCreds, reason: string): Promise<void> {
  if (creds._credSource === 'public') {
    try {
      await markCredentialInvalid(
        'x', PUBLIC_TIER_ACCOUNT, 'cookie', reason,
        { authToken: creds.authToken, ct0: creds.ct0 }, creds._dataDir,
      );
    } catch { /* best-effort */ }
    return;
  }
  if (!creds._account) return; // no account context to attach the marker to
  try {
    await markCredentialInvalid(
      'x', creds._account, 'cookie', reason,
      { authToken: creds.authToken, ct0: creds.ct0 }, creds._dataDir,
    );
  } catch { /* best-effort — never let marker bookkeeping mask the real error */ }
}

/**
 * Rewrite an auth-failure message so it's unambiguous which credential tier
 * died. Own-cookie failures are locally fixable (re-login); the shared
 * public account is backend-managed and re-login on the CLI side can't fix
 * it — surfacing the same generic message for both would send users down
 * the wrong remediation path.
 */
function contextualizeAuthError(creds: BridgeCreds, message: string): string {
  if (creds._credSource === 'public') {
    return (
      'The shared public X account session has expired (backend-managed credential — ' +
      'not fixable by re-logging in locally). Original error: ' + message
    );
  }
  return message;
}

let _resolvedPython: string | null | undefined = undefined;

/** Resolve Python binary. Returns null if not found. */
async function resolvePython(): Promise<string | null> {
  if (_resolvedPython !== undefined) return _resolvedPython;

  try {
    await access(SCRIPT_PATH, constants.R_OK);
  } catch {
    return (_resolvedPython = null);
  }

  for (const candidate of PYTHON_CANDIDATES) {
    try {
      await execFileAsync(candidate, ['--version'], { timeout: 3_000 });
      return (_resolvedPython = candidate);
    } catch { /* try next */ }
  }

  return (_resolvedPython = null);
}

/** Returns true if the cookie-auth client (x-fetch.py + Python) is available. */
export async function isCookieClientAvailable(): Promise<boolean> {
  return (await resolvePython()) !== null;
}

/** Run x-fetch.py with cookie credentials injected via env. */
async function runFetch<T>(
  creds: BridgeCreds,
  args: string[]
): Promise<T> {
  const python = await resolvePython();
  if (!python) {
    throw new Error(
      'Python not found. Cookie-auth X features require Python 3.\n' +
      '  Install Python: https://python.org/downloads\n' +
      '  Then install curl_cffi: uv pip install curl_cffi\n' +
      '  Or use OAuth: crossmind auth login x --access-token <token>'
    );
  }

  const env = {
    ...process.env,
    X_AUTH_TOKEN: creds.authToken,
    X_CT0: creds.ct0,
  };

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(python, [SCRIPT_PATH, ...args], {
      env,
      timeout: 20_000,
      maxBuffer: 10 * 1024 * 1024,
    }));
  } catch (err: unknown) {
    // execFileAsync rejects on non-zero exit; the Python script may have written
    // a JSON error object to stdout before exiting — try to surface it.
    const execErr = err as { stdout?: string; message?: string };
    const raw = execErr.stdout ?? '';
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as CliResponse<T>;
        if (!parsed.ok && parsed.error?.message) {
          const isAuthFailure = AUTH_FAILURE_RE.test(parsed.error.message);
          if (isAuthFailure) {
            await markCookieInvalid(creds, parsed.error.message);
          }
          throw new Error(isAuthFailure ? contextualizeAuthError(creds, parsed.error.message) : parsed.error.message);
        }
      } catch (jsonErr) {
        if (jsonErr instanceof SyntaxError) { /* ignore, fall through */ } else { throw jsonErr; }
      }
    }
    if (AUTH_FAILURE_RE.test(execErr.message ?? '')) {
      const msg = execErr.message ?? 'HTTP Error 401';
      await markCookieInvalid(creds, msg);
      throw new Error(contextualizeAuthError(creds, msg));
    }
    throw err;
  }

  return JSON.parse(stdout) as T;
}

// ── Response shapes ────────────────────────────────────────────────────────

interface CliTweet {
  id: string;
  text: string;
  author: { screenName: string; name: string; id?: string; avatarUrl?: string };
  metrics: { likes: number; retweets: number; replies: number; views?: number; quotes?: number };
  createdAtISO?: string;
  createdAt?: string;
  replies?: CliTweet[];
}

interface CliUser {
  id: string;
  name: string;
  screenName: string;
  bio?: string;
  description?: string;
  avatarUrl?: string;
  followers: number;
  following: number;
  tweets: number;
  verified?: boolean;
}

interface CliResponse<T> {
  ok: boolean;
  data: T;
  error?: { message: string };
}

/** Build a UnifiedUser-shaped author from a CliTweet's author block. */
function authorFromCli(a: CliTweet['author']): import('../types/identity.js').UnifiedUser {
  const username = a?.screenName ?? '';
  return {
    id: a?.id || null,
    username: username || null,
    name: a?.name || null,
    avatar_url: a?.avatarUrl || null,
    profile_url: username ? `https://twitter.com/${username}` : null,
    bio: null,
    followers: null,
    verified: null,
  };
}

function mapCliTweet(t: CliTweet, rank: number): XTweet {
  const username = t.author?.screenName ?? '';
  return {
    rank,
    id: t.id,
    text: (t.text ?? ''),
    author: authorFromCli(t.author),
    likes: t.metrics?.likes ?? 0,
    retweets: t.metrics?.retweets ?? 0,
    replies: t.metrics?.replies ?? 0,
    views: t.metrics?.views ?? 0,
    created_at: (t.createdAtISO ?? t.createdAt ?? '').slice(0, 10),
    url: `https://twitter.com/${username}/status/${t.id}`,
  };
}

function mapCliUser(u: CliUser, rank: number): XUser {
  const username = u.screenName ?? '';
  return {
    rank,
    id: u.id || null,
    username: username || null,
    name: u.name ?? null,
    avatar_url: u.avatarUrl || null,
    profile_url: username ? `https://twitter.com/${username}` : null,
    bio: (u.bio ?? u.description ?? '').slice(0, 160),
    followers: u.followers ?? 0,
    verified: Boolean(u.verified ?? false),
    following: u.following ?? 0,
    tweets: u.tweets ?? 0,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function bridgeSearchTweets(
  query: string, limit: number, creds: BridgeCreds
): Promise<XTweet[]> {
  const result = await runFetch<CliResponse<CliTweet[]>>(creds, ['search', query, '--count', String(limit)]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Search failed');
  return (result.data ?? []).slice(0, limit).map((t, i) => mapCliTweet(t, i + 1));
}

export async function bridgeFeed(
  limit: number, creds: BridgeCreds
): Promise<XTweet[]> {
  const result = await runFetch<CliResponse<CliTweet[]>>(creds, ['feed', '--count', String(limit)]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Feed failed');
  return (result.data ?? []).slice(0, limit).map((t, i) => mapCliTweet(t, i + 1));
}

export async function bridgeUserTimeline(
  username: string, limit: number, creds: BridgeCreds
): Promise<XTweet[]> {
  const result = await runFetch<CliResponse<CliTweet[]>>(creds, ['user-posts', username, '--count', String(limit)]);
  if (!result.ok) throw new Error(result.error?.message ?? 'User timeline failed');
  return (result.data ?? []).slice(0, limit).map((t, i) => mapCliTweet(t, i + 1));
}

export async function bridgeUserProfile(
  username: string, creds: BridgeCreds
): Promise<XUser | null> {
  const result = await runFetch<CliResponse<CliUser>>(creds, ['user', username]);
  if (!result.ok) return null;
  const u = result.data;
  if (!u) return null;
  return mapCliUser(u, 1);
}

/** Resolve a numeric rest_id → full profile (cookie-auth path). */
export async function bridgeUserById(
  restId: string, creds: BridgeCreds
): Promise<XUser | null> {
  const result = await runFetch<CliResponse<CliUser>>(creds, ['user-by-id', restId]);
  if (!result.ok) return null;
  const u = result.data;
  if (!u) return null;
  return mapCliUser(u, 1);
}

export async function bridgeTweet(
  tweetId: string, limit: number, creds: BridgeCreds
): Promise<{ tweet: XTweet; thread: XTweet[] }> {
  const result = await runFetch<CliResponse<CliTweet>>(creds, ['tweet', tweetId, '--count', String(limit)]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Tweet fetch failed');
  const main = result.data;
  return {
    tweet: mapCliTweet(main, 1),
    thread: (main.replies ?? []).map((t, i) => mapCliTweet(t, i + 1)),
  };
}

export async function bridgeFollowers(
  username: string, limit: number, creds: BridgeCreds
): Promise<XUser[]> {
  const result = await runFetch<CliResponse<CliUser[]>>(creds, ['followers', username, '--count', String(limit)]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Followers failed');
  return (result.data ?? []).slice(0, limit).map((u, i) => mapCliUser(u, i + 1));
}

export async function bridgeFollowing(
  username: string, limit: number, creds: BridgeCreds
): Promise<XUser[]> {
  const result = await runFetch<CliResponse<CliUser[]>>(creds, ['following', username, '--count', String(limit)]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Following failed');
  return (result.data ?? []).slice(0, limit).map((u, i) => mapCliUser(u, i + 1));
}

export async function bridgeBookmarks(
  limit: number, creds: BridgeCreds
): Promise<XTweet[]> {
  const result = await runFetch<CliResponse<CliTweet[]>>(creds, ['bookmarks', '--count', String(limit)]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Bookmarks failed');
  return (result.data ?? []).slice(0, limit).map((t, i) => mapCliTweet(t, i + 1));
}

export async function bridgeNotifications(
  limit: number, creds: BridgeCreds
): Promise<XTweet[]> {
  const result = await runFetch<CliResponse<CliTweet[]>>(creds, ['notifications', '--count', String(limit)]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Notifications failed');
  return (result.data ?? []).slice(0, limit).map((t, i) => mapCliTweet(t, i + 1));
}

export async function bridgeListTweets(
  listId: string, limit: number, creds: BridgeCreds
): Promise<XTweet[]> {
  const result = await runFetch<CliResponse<CliTweet[]>>(creds, ['list', listId, '--count', String(limit)]);
  if (!result.ok) throw new Error(result.error?.message ?? 'List tweets failed');
  return (result.data ?? []).slice(0, limit).map((t, i) => mapCliTweet(t, i + 1));
}

export interface BridgeReplyResult {
  id: string;
  result: { tweet_id: string; url: string };
  in_reply_to: {
    tweet_id: string;
    author: { id: string | null; username: string | null };
  };
}

export async function bridgeReply(
  tweetId: string, text: string, creds: BridgeCreds
): Promise<BridgeReplyResult> {
  const result = await runFetch<CliResponse<BridgeReplyResult>>(creds, ['reply', tweetId, text]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Reply failed');
  return result.data;
}

export async function bridgeDelete(
  tweetId: string, creds: BridgeCreds
): Promise<void> {
  const result = await runFetch<CliResponse<unknown>>(creds, ['delete', tweetId]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Delete failed');
}

export async function bridgeBookmark(
  tweetId: string, creds: BridgeCreds
): Promise<void> {
  const result = await runFetch<CliResponse<unknown>>(creds, ['bookmark', tweetId]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Bookmark failed');
}

export async function bridgeUnbookmark(
  tweetId: string, creds: BridgeCreds
): Promise<void> {
  const result = await runFetch<CliResponse<unknown>>(creds, ['unbookmark', tweetId]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Unbookmark failed');
}

export async function bridgePost(
  text: string, creds: BridgeCreds
): Promise<{ id: string; result?: { tweet_id: string; url: string } }> {
  const result = await runFetch<CliResponse<{ id: string; result?: { tweet_id: string; url: string } }>>(creds, ['post', text]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Post failed');
  return result.data;
}

export async function bridgeArticle(
  text: string,
  creds: BridgeCreds,
  title?: string,
): Promise<{ id: string; url?: string }> {
  const args = ['article', text, ...(title ? ['--title', title] : [])];
  const result = await runFetch<CliResponse<{ id: string; url?: string }>>(creds, args);
  if (!result.ok) throw new Error(result.error?.message ?? 'Article post failed');
  return result.data;
}

export async function bridgeQuote(
  tweetId: string, text: string, creds: BridgeCreds
): Promise<{ id: string; result?: { tweet_id: string; url: string } }> {
  const result = await runFetch<CliResponse<{ id: string; result?: { tweet_id: string; url: string } }>>(creds, ['quote', tweetId, text]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Quote failed');
  return result.data;
}

export interface BridgeLikeResult {
  result: { tweet_id: string; liked: boolean };
  author: import('../types/identity.js').UnifiedUser | null;
}

export async function bridgeLike(
  tweetId: string, creds: BridgeCreds
): Promise<BridgeLikeResult> {
  const result = await runFetch<CliResponse<BridgeLikeResult>>(creds, ['like', tweetId]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Like failed');
  return result.data;
}

export async function bridgeUnlike(
  tweetId: string, creds: BridgeCreds
): Promise<void> {
  const result = await runFetch<CliResponse<unknown>>(creds, ['unlike', tweetId]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Unlike failed');
}

export interface BridgeRetweetResult {
  id: string;
  result?: { tweet_id: string; url: string };
  author: import('../types/identity.js').UnifiedUser | null;
}

export async function bridgeRetweet(
  tweetId: string, creds: BridgeCreds
): Promise<BridgeRetweetResult> {
  const result = await runFetch<CliResponse<BridgeRetweetResult>>(creds, ['retweet', tweetId]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Retweet failed');
  return result.data;
}

export async function bridgeUnretweet(
  tweetId: string, creds: BridgeCreds
): Promise<void> {
  const result = await runFetch<CliResponse<unknown>>(creds, ['unretweet', tweetId]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Unretweet failed');
}

/** Unified identity returned by the v1.1 friendships response. */
interface BridgeFollowUser {
  id?: string | null;
  username?: string | null;
  name?: string | null;
  avatar_url?: string | null;
  profile_url?: string | null;
  bio?: string | null;
  followers?: number | null;
  verified?: boolean | null;
}

export async function bridgeFollow(
  username: string, creds: BridgeCreds
): Promise<{ following: boolean; user: UnifiedUser }> {
  const result = await runFetch<CliResponse<{ following: boolean; user: BridgeFollowUser }>>(creds, ['follow', username]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Follow failed');
  return { following: result.data.following, user: makeUser(result.data.user ?? {}) };
}

export async function bridgeUnfollow(
  username: string, creds: BridgeCreds
): Promise<{ following: boolean; user: UnifiedUser }> {
  const result = await runFetch<CliResponse<{ following: boolean; user: BridgeFollowUser }>>(creds, ['unfollow', username]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Unfollow failed');
  return { following: result.data.following, user: makeUser(result.data.user ?? {}) };
}
