/**
 * twitter-cli subprocess bridge.
 *
 * x.com's GraphQL API requires Chrome TLS fingerprinting (JA3/JA4).
 * Node.js's fetch() has a different fingerprint → x.com returns 404.
 * twitter-cli uses curl_cffi (Chrome impersonation) and works correctly.
 *
 * When cookie credentials (auth_token + ct0) are available AND twitter-cli
 * is installed, we delegate to twitter-cli via subprocess.
 *
 * Binary discovery order:
 *   1. TWITTER_CLI_PATH env var
 *   2. /root/.local/share/uv/tools/twitter-cli/bin/twitter (uv-installed)
 *   3. Not available → caller falls back to v2 REST
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, constants } from 'node:fs/promises';
import type { XTweet, XUser } from '../platforms/x/read.js';

const execFileAsync = promisify(execFile);

const KNOWN_PATHS = [
  '/root/.local/share/uv/tools/twitter-cli/bin/twitter',
  '/home/.local/share/uv/tools/twitter-cli/bin/twitter',
];

let _resolvedPath: string | null | undefined = undefined; // undefined = not yet checked

/** Resolve twitter-cli binary path. Returns null if not found. */
async function resolveTwitterCli(): Promise<string | null> {
  if (_resolvedPath !== undefined) return _resolvedPath;

  // Explicit override
  const envPath = process.env['TWITTER_CLI_PATH'];
  if (envPath) {
    try {
      await access(envPath, constants.X_OK);
      return (_resolvedPath = envPath);
    } catch { /* not found */ }
  }

  // Known install locations
  for (const p of KNOWN_PATHS) {
    try {
      await access(p, constants.X_OK);
      return (_resolvedPath = p);
    } catch { /* not found */ }
  }

  return (_resolvedPath = null);
}

/** Returns true if twitter-cli is available. */
export async function isTwitterCliAvailable(): Promise<boolean> {
  return (await resolveTwitterCli()) !== null;
}

/** Run twitter-cli with env-injected cookies and return parsed JSON. */
async function runCli<T>(
  creds: { authToken: string; ct0: string },
  args: string[]
): Promise<T> {
  const bin = await resolveTwitterCli();
  if (!bin) throw new Error('twitter-cli not found');

  const env = {
    ...process.env,
    TWITTER_AUTH_TOKEN: creds.authToken,
    TWITTER_CT0: creds.ct0,
  };

  const { stdout } = await execFileAsync(bin, [...args, '--json'], {
    env,
    timeout: 20_000,
    maxBuffer: 10 * 1024 * 1024,
  });

  return JSON.parse(stdout) as T;
}

// ── twitter-cli JSON shapes ──────────────────────────────────────────────────

interface CliTweet {
  id: string;
  text: string;
  author: { screenName: string; name: string; id?: string };
  metrics: { likes: number; retweets: number; replies: number; views?: number; quotes?: number };
  createdAtISO?: string;
  createdAt?: string;
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
    text: (t.text ?? '').replace(/\n/g, ' ').slice(0, 200),
    author: username,
    likes: t.metrics?.likes ?? 0,
    retweets: t.metrics?.retweets ?? 0,
    replies: t.metrics?.replies ?? 0,
    views: t.metrics?.views ?? 0,
    created_at: (t.createdAtISO ?? t.createdAt ?? '').slice(0, 10),
    url: `https://twitter.com/${username}/status/${t.id}`,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Search tweets via twitter-cli. */
export async function bridgeSearchTweets(
  query: string,
  limit: number,
  creds: { authToken: string; ct0: string }
): Promise<XTweet[]> {
  const result = await runCli<CliResponse<CliTweet[]>>(creds, ['search', query]);
  if (!result.ok) throw new Error(result.error?.message ?? 'twitter-cli search failed');
  const tweets = (result.data ?? []).slice(0, limit);
  return tweets.map((t, i) => mapCliTweet(t, i + 1));
}

/** Get home feed via twitter-cli. */
export async function bridgeFeed(
  limit: number,
  creds: { authToken: string; ct0: string }
): Promise<XTweet[]> {
  const result = await runCli<CliResponse<CliTweet[]>>(creds, ['feed']);
  if (!result.ok) throw new Error(result.error?.message ?? 'twitter-cli feed failed');
  const tweets = (result.data ?? []).slice(0, limit);
  return tweets.map((t, i) => mapCliTweet(t, i + 1));
}

/** Get user timeline via twitter-cli. */
export async function bridgeUserTimeline(
  username: string,
  limit: number,
  creds: { authToken: string; ct0: string }
): Promise<XTweet[]> {
  const result = await runCli<CliResponse<CliTweet[]>>(creds, ['user-posts', username]);
  if (!result.ok) throw new Error(result.error?.message ?? 'twitter-cli user-posts failed');
  const tweets = (result.data ?? []).slice(0, limit);
  return tweets.map((t, i) => mapCliTweet(t, i + 1));
}

/** Get user profile via twitter-cli. */
export async function bridgeUserProfile(
  username: string,
  creds: { authToken: string; ct0: string }
): Promise<XUser | null> {
  const result = await runCli<CliResponse<CliUser>>(creds, ['user', username]);
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
