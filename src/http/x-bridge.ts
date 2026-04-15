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

const execFileAsync = promisify(execFile);

// scripts/x-fetch.py is two levels up from dist/http/
const __dir = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.resolve(__dir, '../../scripts/x-fetch.py');

const PYTHON_CANDIDATES = ['python3', 'python'];

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
  creds: { authToken: string; ct0: string; kdt?: string; att?: string },
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
    ...(creds.kdt ? { X_KDT: creds.kdt } : {}),
    ...(creds.att ? { X_ATT: creds.att } : {}),
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
          throw new Error(parsed.error.message);
        }
      } catch (jsonErr) {
        if (jsonErr instanceof SyntaxError) { /* ignore, fall through */ } else { throw jsonErr; }
      }
    }
    throw err;
  }

  return JSON.parse(stdout) as T;
}

// ── Response shapes ────────────────────────────────────────────────────────

interface CliTweet {
  id: string;
  text: string;
  author: { screenName: string; name: string; id?: string };
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

function mapCliTweet(t: CliTweet, rank: number): XTweet {
  const username = t.author?.screenName ?? '';
  return {
    rank,
    id: t.id,
    text: (t.text ?? ''),
    author: username,
    likes: t.metrics?.likes ?? 0,
    retweets: t.metrics?.retweets ?? 0,
    replies: t.metrics?.replies ?? 0,
    views: t.metrics?.views ?? 0,
    created_at: (t.createdAtISO ?? t.createdAt ?? '').slice(0, 10),
    url: `https://twitter.com/${username}/status/${t.id}`,
  };
}

function mapCliUser(u: CliUser, rank: number): XUser {
  return {
    rank,
    username: u.screenName ?? '',
    name: u.name ?? '',
    followers: u.followers ?? 0,
    following: u.following ?? 0,
    tweets: u.tweets ?? 0,
    bio: (u.bio ?? u.description ?? '').slice(0, 160),
    verified: String(u.verified ?? false),
    url: `https://twitter.com/${u.screenName ?? ''}`,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function bridgeSearchTweets(
  query: string, limit: number, creds: { authToken: string; ct0: string }
): Promise<XTweet[]> {
  const result = await runFetch<CliResponse<CliTweet[]>>(creds, ['search', query, '--count', String(limit)]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Search failed');
  return (result.data ?? []).slice(0, limit).map((t, i) => mapCliTweet(t, i + 1));
}

export async function bridgeFeed(
  limit: number, creds: { authToken: string; ct0: string }
): Promise<XTweet[]> {
  const result = await runFetch<CliResponse<CliTweet[]>>(creds, ['feed', '--count', String(limit)]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Feed failed');
  return (result.data ?? []).slice(0, limit).map((t, i) => mapCliTweet(t, i + 1));
}

export async function bridgeUserTimeline(
  username: string, limit: number, creds: { authToken: string; ct0: string }
): Promise<XTweet[]> {
  const result = await runFetch<CliResponse<CliTweet[]>>(creds, ['user-posts', username, '--count', String(limit)]);
  if (!result.ok) throw new Error(result.error?.message ?? 'User timeline failed');
  return (result.data ?? []).slice(0, limit).map((t, i) => mapCliTweet(t, i + 1));
}

export async function bridgeUserProfile(
  username: string, creds: { authToken: string; ct0: string }
): Promise<XUser | null> {
  const result = await runFetch<CliResponse<CliUser>>(creds, ['user', username]);
  if (!result.ok) return null;
  const u = result.data;
  if (!u) return null;
  return {
    rank: 1,
    username: u.screenName ?? username,
    name: u.name ?? '',
    followers: u.followers ?? 0,
    following: u.following ?? 0,
    tweets: u.tweets ?? 0,
    bio: (u.bio ?? u.description ?? '').slice(0, 160),
    verified: String(u.verified ?? false),
    url: `https://twitter.com/${u.screenName ?? username}`,
  };
}

export async function bridgeTweet(
  tweetId: string, limit: number, creds: { authToken: string; ct0: string }
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
  username: string, limit: number, creds: { authToken: string; ct0: string }
): Promise<XUser[]> {
  const result = await runFetch<CliResponse<CliUser[]>>(creds, ['followers', username, '--count', String(limit)]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Followers failed');
  return (result.data ?? []).slice(0, limit).map((u, i) => mapCliUser(u, i + 1));
}

export async function bridgeFollowing(
  username: string, limit: number, creds: { authToken: string; ct0: string }
): Promise<XUser[]> {
  const result = await runFetch<CliResponse<CliUser[]>>(creds, ['following', username, '--count', String(limit)]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Following failed');
  return (result.data ?? []).slice(0, limit).map((u, i) => mapCliUser(u, i + 1));
}

export async function bridgeBookmarks(
  limit: number, creds: { authToken: string; ct0: string }
): Promise<XTweet[]> {
  const result = await runFetch<CliResponse<CliTweet[]>>(creds, ['bookmarks', '--count', String(limit)]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Bookmarks failed');
  return (result.data ?? []).slice(0, limit).map((t, i) => mapCliTweet(t, i + 1));
}

export async function bridgeNotifications(
  limit: number, creds: { authToken: string; ct0: string }
): Promise<XTweet[]> {
  const result = await runFetch<CliResponse<CliTweet[]>>(creds, ['notifications', '--count', String(limit)]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Notifications failed');
  return (result.data ?? []).slice(0, limit).map((t, i) => mapCliTweet(t, i + 1));
}

export async function bridgeListTweets(
  listId: string, limit: number, creds: { authToken: string; ct0: string }
): Promise<XTweet[]> {
  const result = await runFetch<CliResponse<CliTweet[]>>(creds, ['list', listId, '--count', String(limit)]);
  if (!result.ok) throw new Error(result.error?.message ?? 'List tweets failed');
  return (result.data ?? []).slice(0, limit).map((t, i) => mapCliTweet(t, i + 1));
}

export async function bridgeReply(
  tweetId: string, text: string, creds: { authToken: string; ct0: string }
): Promise<{ id: string }> {
  const result = await runFetch<CliResponse<{ id: string }>>(creds, ['reply', tweetId, text]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Reply failed');
  return result.data;
}

export async function bridgeDelete(
  tweetId: string, creds: { authToken: string; ct0: string }
): Promise<void> {
  const result = await runFetch<CliResponse<unknown>>(creds, ['delete', tweetId]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Delete failed');
}

export async function bridgeBookmark(
  tweetId: string, creds: { authToken: string; ct0: string }
): Promise<void> {
  const result = await runFetch<CliResponse<unknown>>(creds, ['bookmark', tweetId]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Bookmark failed');
}

export async function bridgeUnbookmark(
  tweetId: string, creds: { authToken: string; ct0: string }
): Promise<void> {
  const result = await runFetch<CliResponse<unknown>>(creds, ['unbookmark', tweetId]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Unbookmark failed');
}

export async function bridgePost(
  text: string, creds: { authToken: string; ct0: string }
): Promise<{ id: string }> {
  const result = await runFetch<CliResponse<{ id: string }>>(creds, ['post', text]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Post failed');
  return result.data;
}

export async function bridgeArticle(
  text: string,
  creds: { authToken: string; ct0: string },
  title?: string,
): Promise<{ id: string; url?: string }> {
  const args = ['article', text, ...(title ? ['--title', title] : [])];
  const result = await runFetch<CliResponse<{ id: string; url?: string }>>(creds, args);
  if (!result.ok) throw new Error(result.error?.message ?? 'Article post failed');
  return result.data;
}

export async function bridgeQuote(
  tweetId: string, text: string, creds: { authToken: string; ct0: string }
): Promise<{ id: string }> {
  const result = await runFetch<CliResponse<{ id: string }>>(creds, ['quote', tweetId, text]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Quote failed');
  return result.data;
}

export async function bridgeLike(
  tweetId: string, creds: { authToken: string; ct0: string }
): Promise<void> {
  const result = await runFetch<CliResponse<unknown>>(creds, ['like', tweetId]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Like failed');
}

export async function bridgeUnlike(
  tweetId: string, creds: { authToken: string; ct0: string }
): Promise<void> {
  const result = await runFetch<CliResponse<unknown>>(creds, ['unlike', tweetId]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Unlike failed');
}

export async function bridgeRetweet(
  tweetId: string, creds: { authToken: string; ct0: string }
): Promise<{ id: string }> {
  const result = await runFetch<CliResponse<{ id: string }>>(creds, ['retweet', tweetId]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Retweet failed');
  return result.data;
}

export async function bridgeUnretweet(
  tweetId: string, creds: { authToken: string; ct0: string }
): Promise<void> {
  const result = await runFetch<CliResponse<unknown>>(creds, ['unretweet', tweetId]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Unretweet failed');
}

export async function bridgeFollow(
  username: string, creds: { authToken: string; ct0: string; kdt?: string; att?: string }
): Promise<void> {
  const result = await runFetch<CliResponse<unknown>>(creds, ['follow', username]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Follow failed');
}

export async function bridgeUnfollow(
  username: string, creds: { authToken: string; ct0: string; kdt?: string; att?: string }
): Promise<void> {
  const result = await runFetch<CliResponse<unknown>>(creds, ['unfollow', username]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Unfollow failed');
}
