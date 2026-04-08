/**
 * Reddit cookie-auth client — subprocess bridge to scripts/reddit-fetch.py.
 *
 * Reddit rejects Node.js TLS fingerprints with 403. The bundled
 * scripts/reddit-fetch.py uses curl_cffi (Chrome impersonation).
 *
 * Python discovery order:
 *   1. python3 (system Python)
 *   2. python
 *
 * Script: <package-root>/scripts/reddit-fetch.py (bundled with the npm package)
 *
 * Install curl_cffi (one-time):
 *   uv pip install curl_cffi
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RedditPost, RedditComment, RedditUserProfile, RedditPostDetail } from '../platforms/reddit/read.js';

const execFileAsync = promisify(execFile);

// scripts/reddit-fetch.py is two levels up from dist/http/
const __dir = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.resolve(__dir, '../../scripts/reddit-fetch.py');

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

/** Returns true if the cookie-auth client (reddit-fetch.py + Python) is available. */
export async function isRedditClientAvailable(): Promise<boolean> {
  return (await resolvePython()) !== null;
}

export interface RedditCookieCreds {
  session: string;
  csrfToken?: string;
  loid?: string;
  modhash?: string;
  proxy?: string;
}

// ── Response shapes ──────────────────────────────────────────────────────────

interface CliPost {
  id: string;
  title: string;
  author: string;
  subreddit: string;
  score: number;
  num_comments: number;
  url: string;
  domain: string;
  created_utc: number;
  link_flair_text?: string;
  selftext?: string;
  permalink?: string;
  name?: string;
}

interface CliComment {
  id: string;
  author: string;
  body: string;
  score: number;
  subreddit: string;
  permalink?: string;
}

interface CliUser {
  name: string;
  link_karma: number;
  comment_karma: number;
  created_utc: number;
  is_mod?: boolean;
}

interface CliPostDetail {
  post: CliPost;
  comments: CliComment[];
}

interface CliResponse<T> {
  ok: boolean;
  data: T;
  error?: { message: string };
}

// ── Mappers ──────────────────────────────────────────────────────────────────

function mapCliPost(p: CliPost, rank: number): RedditPost {
  const post: RedditPost = {
    rank,
    id: String(p.id ?? ''),
    title: String(p.title ?? '').slice(0, 150),
    author: String(p.author ?? ''),
    subreddit: String(p.subreddit ?? ''),
    score: Number(p.score ?? 0),
    comments: Number(p.num_comments ?? 0),
    url: String(p.url ?? ''),
    domain: String(p.domain ?? ''),
    created_utc: Number(p.created_utc ?? 0),
    flair: String(p.link_flair_text ?? ''),
  };
  if (p.selftext) {
    post.selftext = String(p.selftext).replace(/\n{3,}/g, '\n\n').trim().slice(0, 2000);
  }
  return post;
}

function mapCliComment(c: CliComment, rank: number): RedditComment {
  return {
    rank,
    id: String(c.id ?? ''),
    author: String(c.author ?? ''),
    body: String(c.body ?? '').replace(/\n/g, ' ').slice(0, 200),
    score: Number(c.score ?? 0),
    subreddit: String(c.subreddit ?? ''),
    url: c.permalink ? `https://reddit.com${c.permalink}` : '',
  };
}

// ── Core subprocess runner ───────────────────────────────────────────────────

/** Run reddit-fetch.py with cookie credentials injected via env. */
async function runFetch<T>(
  creds: RedditCookieCreds,
  args: string[]
): Promise<T> {
  const python = await resolvePython();
  if (!python) {
    throw new Error(
      'Python not found. Cookie-auth Reddit features require Python 3.\n' +
      '  Install Python: https://python.org/downloads\n' +
      '  Then install curl_cffi: uv pip install curl_cffi\n' +
      '  Or use OAuth: crossmind auth login reddit --token <token>'
    );
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    REDDIT_SESSION: creds.session,
    ...(creds.csrfToken ? { REDDIT_CSRF: creds.csrfToken } : {}),
    ...(creds.loid ? { REDDIT_LOID: creds.loid } : {}),
    ...(creds.modhash ? { REDDIT_MODHASH: creds.modhash } : {}),
    ...(creds.proxy ? { REDDIT_PROXY: creds.proxy } : {}),
  };

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(python, [SCRIPT_PATH, ...args], {
      env,
      timeout: 30_000,
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

// ── Public API — Read ────────────────────────────────────────────────────────

export async function bridgeHome(
  limit: number,
  creds: RedditCookieCreds
): Promise<RedditPost[]> {
  const result = await runFetch<CliResponse<CliPost[]>>(creds, ['home', '--count', String(limit)]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Home feed failed');
  return (result.data ?? []).slice(0, limit).map((p, i) => mapCliPost(p, i + 1));
}

export async function bridgeSaved(
  limit: number,
  creds: RedditCookieCreds
): Promise<RedditPost[]> {
  const result = await runFetch<CliResponse<CliPost[]>>(creds, ['saved', '--count', String(limit)]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Saved failed');
  return (result.data ?? []).slice(0, limit).map((p, i) => mapCliPost(p, i + 1));
}

export async function bridgeSubreddit(
  name: string,
  sort: string,
  limit: number,
  creds: RedditCookieCreds
): Promise<RedditPost[]> {
  const result = await runFetch<CliResponse<CliPost[]>>(
    creds, ['subreddit', name, '--sort', sort, '--count', String(limit)]
  );
  if (!result.ok) throw new Error(result.error?.message ?? `Subreddit r/${name} failed`);
  return (result.data ?? []).slice(0, limit).map((p, i) => mapCliPost(p, i + 1));
}

export async function bridgeUser(
  username: string,
  creds: RedditCookieCreds
): Promise<RedditUserProfile> {
  const result = await runFetch<CliResponse<CliUser>>(creds, ['user', username]);
  if (!result.ok) throw new Error(result.error?.message ?? `User ${username} fetch failed`);
  const u = result.data;
  return {
    rank: 1,
    username: String(u.name ?? username),
    karma_post: Number(u.link_karma ?? 0),
    karma_comment: Number(u.comment_karma ?? 0),
    created_utc: Number(u.created_utc ?? 0),
    is_mod: Boolean(u.is_mod ?? false),
    url: `https://reddit.com/u/${username}`,
  };
}

export async function bridgeUserPosts(
  username: string,
  limit: number,
  creds: RedditCookieCreds
): Promise<RedditPost[]> {
  const result = await runFetch<CliResponse<CliPost[]>>(
    creds, ['user-posts', username, '--count', String(limit)]
  );
  if (!result.ok) throw new Error(result.error?.message ?? `User posts for ${username} failed`);
  return (result.data ?? []).slice(0, limit).map((p, i) => mapCliPost(p, i + 1));
}

export async function bridgePost(
  subreddit: string,
  postId: string,
  limit: number,
  creds: RedditCookieCreds
): Promise<RedditPostDetail> {
  const result = await runFetch<CliResponse<CliPostDetail>>(
    creds, ['read-post', subreddit, postId, '--count', String(limit)]
  );
  if (!result.ok) throw new Error(result.error?.message ?? 'Post fetch failed');
  const d = result.data ?? { post: {} as CliPost, comments: [] };
  return {
    post: mapCliPost(d.post, 1),
    comments: (d.comments ?? []).slice(0, limit).map((c, i) => mapCliComment(c, i + 1)),
  };
}

export async function bridgeSearch(
  query: string,
  subreddit: string | undefined,
  sort: string,
  limit: number,
  creds: RedditCookieCreds
): Promise<RedditPost[]> {
  const args = ['search', query, '--sort', sort, '--count', String(limit)];
  if (subreddit) args.push('--subreddit', subreddit);
  const result = await runFetch<CliResponse<CliPost[]>>(creds, args);
  if (!result.ok) throw new Error(result.error?.message ?? 'Search failed');
  return (result.data ?? []).slice(0, limit).map((p, i) => mapCliPost(p, i + 1));
}

/** Search Reddit without session credentials (Chrome TLS impersonation only). */
export async function bridgeSearchPublic(
  query: string,
  subreddit: string | undefined,
  sort: string,
  limit: number
): Promise<RedditPost[]> {
  return bridgeSearch(query, subreddit, sort, limit, { session: '' });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract id from Reddit's `{ json: { errors, data } }` response.
 * Throws if the errors array is non-empty.
 */
function extractJsonId(data: Record<string, unknown> | null, op: string): string {
  const json = data?.['json'] as { errors?: [string, string, string][]; data?: { id?: string; things?: Array<{ data?: { id?: string } }> } } | undefined;
  const errors = json?.errors;
  if (errors && errors.length > 0) {
    const [code, msg] = errors[0];
    throw new Error(`Reddit ${op} error [${code}]: ${msg}`);
  }
  // submit returns json.data.id; comment returns json.data.things[0].data.id
  return json?.data?.id ?? json?.data?.things?.[0]?.data?.id ?? '';
}

// ── Public API — Write ───────────────────────────────────────────────────────

export async function bridgeComment(
  parentId: string,
  text: string,
  creds: RedditCookieCreds
): Promise<{ id: string }> {
  const result = await runFetch<CliResponse<Record<string, unknown>>>(
    creds, ['comment', parentId, text]
  );
  if (!result.ok) throw new Error(result.error?.message ?? 'Comment failed');
  const id = extractJsonId(result.data as Record<string, unknown> | null, 'comment');
  return { id };
}

export async function bridgeVote(
  fullname: string,
  direction: 1 | 0 | -1,
  creds: RedditCookieCreds
): Promise<void> {
  const cmd = direction === 1 ? 'upvote' : direction === -1 ? 'downvote' : 'upvote';
  const result = await runFetch<CliResponse<unknown>>(creds, [cmd, fullname]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Vote failed');
}

export async function bridgeSaveItem(
  fullname: string,
  creds: RedditCookieCreds
): Promise<void> {
  const result = await runFetch<CliResponse<unknown>>(creds, ['save', fullname]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Save failed');
}

export async function bridgeSubscribe(
  subreddit: string,
  creds: RedditCookieCreds
): Promise<void> {
  const result = await runFetch<CliResponse<unknown>>(creds, ['subscribe', subreddit]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Subscribe failed');
}

export async function bridgeSubmitPost(
  subreddit: string,
  title: string,
  body: string,
  creds: RedditCookieCreds
): Promise<{ id: string }> {
  const result = await runFetch<CliResponse<Record<string, unknown>>>(
    creds, ['post', subreddit, title, body]
  );
  if (!result.ok) throw new Error(result.error?.message ?? 'Submit post failed');
  const id = extractJsonId(result.data as Record<string, unknown> | null, 'text-post');
  return { id };
}

export async function bridgeLinkPost(
  subreddit: string,
  title: string,
  url: string,
  creds: RedditCookieCreds
): Promise<{ id: string }> {
  const result = await runFetch<CliResponse<Record<string, unknown>>>(
    creds, ['link-post', subreddit, title, url]
  );
  if (!result.ok) throw new Error(result.error?.message ?? 'Submit link post failed');
  const id = extractJsonId(result.data as Record<string, unknown> | null, 'link-post');
  return { id };
}

export async function bridgeCrosspost(
  subreddit: string,
  title: string,
  crosspostFullname: string,
  creds: RedditCookieCreds
): Promise<{ id: string }> {
  const result = await runFetch<CliResponse<Record<string, unknown>>>(
    creds, ['crosspost', subreddit, title, crosspostFullname]
  );
  if (!result.ok) throw new Error(result.error?.message ?? 'Crosspost failed');
  const id = extractJsonId(result.data as Record<string, unknown> | null, 'crosspost');
  return { id };
}

export async function bridgeDelete(
  fullname: string,
  creds: RedditCookieCreds
): Promise<void> {
  const result = await runFetch<CliResponse<unknown>>(creds, ['delete', fullname]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Delete failed');
}

export async function bridgeUnsubscribe(
  subreddit: string,
  creds: RedditCookieCreds
): Promise<void> {
  const result = await runFetch<CliResponse<unknown>>(creds, ['unsubscribe', subreddit]);
  if (!result.ok) throw new Error(result.error?.message ?? 'Unsubscribe failed');
}
