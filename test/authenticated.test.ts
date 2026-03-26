/**
 * Authenticated integration tests — verifies Phase 2 commands with real credentials.
 *
 * Prerequisites:
 *   - pnpm build (dist/ must exist)
 *   - ~/.crossmind/accounts/x/default.json  with  { authToken, ct0 }
 *   - Optional: bearerToken + accessToken for OAuth v2 tests (likes, DMs)
 *   - twitter-cli installed at standard uv path
 *
 * Run:
 *   pnpm test:auth
 *   node --import tsx/esm --test --test-name-pattern "x/tweet" test/authenticated.test.ts
 *
 * Design:
 *   - Cookie-only tests run against the stored default X account (CestIvan)
 *   - OAuth tests are auto-skipped when only cookie creds are present
 *   - Write tests are idempotent (bookmark → unbookmark the same tweet)
 *   - Footer lines go to stderr; data rows go to stdout
 *   - Rate-limited X calls (429) are skipped gracefully rather than failed
 *   - One API call per tested command to stay within X rate limits
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);
const CLI = path.resolve(process.cwd(), 'dist/main.js');

// ── Credential introspection ─────────────────────────────────────────────

interface XCred {
  authToken?: string;
  ct0?: string;
  bearerToken?: string;
  accessToken?: string;
}

async function loadXCreds(): Promise<XCred | null> {
  const credPath = path.join(os.homedir(), '.crossmind', 'accounts', 'x', 'default.json');
  try {
    const raw = await readFile(credPath, 'utf-8');
    return JSON.parse(raw) as XCred;
  } catch {
    return null;
  }
}

const creds = await loadXCreds();
const hasCookie = !!(
  (creds?.authToken && creds?.ct0) ||
  (process.env['TWITTER_AUTH_TOKEN'] && process.env['TWITTER_CT0'])
);
const hasOAuth = !!(
  creds?.accessToken ||
  process.env['X_ACCESS_TOKEN']   // CrossMind-injected OAuth token
);

// ── Run helper ────────────────────────────────────────────────────────────

async function run(
  args: string[],
  timeoutMs = 60_000,   // generous timeout to allow twitter-cli rate-limit retries
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync('node', [CLI, ...args], {
      timeout: timeoutMs,
      env: { ...process.env },
    });
    return { stdout, stderr, code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

/** Returns true and skips the test if the condition is met. */
function skipIf(cond: boolean, reason: string) {
  return (t: { skip: (r: string) => void }) => { if (cond) t.skip(reason); return cond; };
}

/**
 * Returns true and skips the test when X returns 429 Rate Limited.
 * This prevents a temporary rate-limit from counting as a test failure.
 */
function skipOnRateLimit(
  code: number,
  stderr: string,
  t: { skip: (r: string) => void },
): boolean {
  if (code !== 0 && (stderr.includes('Rate limited') || stderr.includes('429'))) {
    t.skip('X API rate limited (429) — transient, not a code bug');
    return true;
  }
  return false;
}

// Stable fixtures
const FX = {
  tweetId:      '2036657548963840384',   // real thread from CestIvan
  tweetAuthor:  'CestIvan',
  publicHandle: 'CestIvan',
};

// ── x/profile ────────────────────────────────────────────────────────────

describe('x/profile (cookie)', () => {
  test('--json returns object with username/name/followers/following', async (t) => {
    if (skipIf(!hasCookie, 'no cookie creds')(t)) return;
    const { stdout, stderr, code } = await run(['x', 'profile', FX.publicHandle, '--json']);
    if (skipOnRateLimit(code, stderr, t)) return;
    assert.equal(code, 0, `stderr: ${stderr.slice(0, 200)}`);
    const items = JSON.parse(stdout) as Record<string, unknown>[];
    assert.ok(Array.isArray(items) && items.length === 1);
    const p = items[0];
    assert.equal(typeof p['username'], 'string', 'username');
    assert.equal(typeof p['name'],     'string', 'name');
    assert.equal(typeof p['followers'],'number', 'followers');
    assert.equal(typeof p['following'],'number', 'following');
  });
});

// ── x/tweet ──────────────────────────────────────────────────────────────

describe('x/tweet (cookie)', () => {
  // x tweet --json returns a flat array: [mainTweet, ...replies]
  test('--json returns flat array with main tweet and replies', async (t) => {
    if (skipIf(!hasCookie, 'no cookie creds')(t)) return;
    const { stdout, stderr, code } = await run(['x', 'tweet', FX.tweetId, '3', '--json']);
    if (skipOnRateLimit(code, stderr, t)) return;
    assert.equal(code, 0, `stderr: ${stderr.slice(0, 200)}`);
    const items = JSON.parse(stdout) as Record<string, unknown>[];
    assert.ok(Array.isArray(items) && items.length >= 1, 'non-empty array');
    const first = items[0];
    assert.equal(typeof first['id'],     'string', 'id');
    assert.equal(typeof first['text'],   'string', 'text');
    assert.equal(typeof first['author'], 'string', 'author');
    assert.equal(typeof first['rank'],   'number', 'rank');
    // If thread returned, reply tweets should also be present
    if (items.length > 1) {
      assert.equal(typeof items[1]['id'], 'string', 'reply id');
    }
  });
});

// ── x/followers ──────────────────────────────────────────────────────────

describe('x/followers (cookie)', () => {
  test('--json returns array of user objects with username/followers', async (t) => {
    if (skipIf(!hasCookie, 'no cookie creds')(t)) return;
    const { stdout, stderr, code } = await run(['x', 'followers', FX.publicHandle, '5', '--json']);
    if (skipOnRateLimit(code, stderr, t)) return;
    assert.equal(code, 0, `stderr: ${stderr.slice(0, 200)}`);
    const items = JSON.parse(stdout) as Record<string, unknown>[];
    assert.ok(Array.isArray(items) && items.length >= 1);
    assert.equal(typeof items[0]['username'], 'string');
    assert.equal(typeof items[0]['followers'], 'number');
  });


});

// ── x/following ──────────────────────────────────────────────────────────

describe('x/following (cookie)', () => {
  test('--json returns array of user objects', async (t) => {
    if (skipIf(!hasCookie, 'no cookie creds')(t)) return;
    const { stdout, stderr, code } = await run(['x', 'following', FX.publicHandle, '5', '--json']);
    if (skipOnRateLimit(code, stderr, t)) return;
    assert.equal(code, 0, `stderr: ${stderr.slice(0, 200)}`);
    const items = JSON.parse(stdout) as Record<string, unknown>[];
    assert.ok(Array.isArray(items));
    if (items.length > 0) {
      assert.equal(typeof (items[0] as Record<string, unknown>)['username'], 'string');
    }
  });
});

// ── x/home ───────────────────────────────────────────────────────────────

describe('x/home (cookie)', () => {
  test('returns home timeline rows with x/home footer on stderr', async (t) => {
    if (skipIf(!hasCookie, 'no cookie creds')(t)) return;
    const { stdout, stderr, code } = await run(['x', 'home', '5']);
    if (skipOnRateLimit(code, stderr, t)) return;
    assert.equal(code, 0, `stderr: ${stderr.slice(0, 200)}`);
    const rows = stdout.trim().split('\n').filter(l => /^\d+\./.test(l));
    assert.ok(rows.length >= 1, `expected ≥1 tweet in home timeline`);
    assert.match(stderr, /x\/home/);
  });
});

// ── x/bookmarks ──────────────────────────────────────────────────────────

describe('x/bookmarks (cookie)', () => {
  test('exits 0 and returns valid JSON array (may be empty)', async (t) => {
    if (skipIf(!hasCookie, 'no cookie creds')(t)) return;
    const { stdout, stderr, code } = await run(['x', 'bookmarks', '10', '--json']);
    if (skipOnRateLimit(code, stderr, t)) return;
    assert.equal(code, 0, `stderr: ${stderr.slice(0, 300)}`);
    const items = JSON.parse(stdout) as unknown[];
    assert.ok(Array.isArray(items), 'should be JSON array (can be empty)');
    if (items.length > 0) {
      const first = items[0] as Record<string, unknown>;
      assert.equal(typeof first['id'], 'string');
      assert.equal(typeof first['text'], 'string');
      assert.equal(typeof first['author'], 'string');
    }
  });
});

// ── x/search ─────────────────────────────────────────────────────────────

describe('x/search (cookie)', () => {
  test('--json returns array with id/text/author/rank', async (t) => {
    if (skipIf(!hasCookie, 'no cookie creds')(t)) return;
    const { stdout, stderr, code } = await run(['x', 'search', 'crossmind', '3', '--json']);
    if (skipOnRateLimit(code, stderr, t)) return;
    assert.equal(code, 0, `stderr: ${stderr.slice(0, 200)}`);
    const items = JSON.parse(stdout) as Record<string, unknown>[];
    assert.ok(Array.isArray(items) && items.length >= 1);
    const f = items[0];
    assert.equal(typeof f['id'],     'string');
    assert.equal(typeof f['text'],   'string');
    assert.equal(typeof f['author'], 'string');
    assert.equal(typeof f['rank'],   'number');
  });
});

// ── x writes — reversible idempotent ──────────────────────────────────────

describe('x/bookmark + unbookmark (cookie write)', () => {
  test('bookmark a known tweet then unbookmark it', async (t) => {
    if (skipIf(!hasCookie, 'no cookie creds')(t)) return;

    const { stdout: bOut, stderr: bErr, code: bCode } = await run(['x', 'bookmark', FX.tweetId]);
    if (skipOnRateLimit(bCode, bErr, t)) return;
    assert.equal(bCode, 0, `bookmark failed: ${bErr.slice(0, 200)}`);
    assert.match(bOut, /bookmarked/i);

    const { stdout: ubOut, stderr: ubErr, code: ubCode } = await run(['x', 'unbookmark', FX.tweetId]);
    if (skipOnRateLimit(ubCode, ubErr, t)) return;
    assert.equal(ubCode, 0, `unbookmark failed: ${ubErr.slice(0, 200)}`);
    assert.match(ubOut, /unbookmarked/i);
  });
});

// ── x OAuth-required (skipped when no OAuth creds) ───────────────────────

describe('x/likes (OAuth v2)', () => {
  test('returns liked tweets via OAuth accessToken', async (t) => {
    if (skipIf(!hasOAuth, 'no OAuth accessToken in credentials')(t)) return;
    const { stdout, stderr, code } = await run(['x', 'likes', FX.publicHandle, '5', '--json']);
    if (skipOnRateLimit(code, stderr, t)) return;
    assert.equal(code, 0, `stderr: ${stderr.slice(0, 200)}`);
    const items = JSON.parse(stdout) as Record<string, unknown>[];
    assert.ok(Array.isArray(items) && items.length >= 1, 'expected ≥1 liked tweet');
    assert.equal(typeof items[0]['id'], 'string');
    assert.equal(typeof items[0]['text'], 'string');
  });
});

describe('x/dm-list (OAuth dm.read)', () => {
  test('returns DM events with sender→recipient format', async (t) => {
    if (skipIf(!hasOAuth, 'needs OAuth with dm.read scope')(t)) return;
    const { stdout, stderr, code } = await run(['x', 'dm-list', '5']);
    if (skipOnRateLimit(code, stderr, t)) return;
    assert.equal(code, 0, `stderr: ${stderr.slice(0, 200)}`);
    const rows = stdout.trim().split('\n').filter(l => /^\d+\./.test(l));
    assert.ok(rows.length >= 1, 'expected ≥1 DM event');
    // Format: "1. @sender→@recipient [date] — text"
    assert.match(rows[0], /→/);
  });
});

describe('x/dm-conversation (OAuth dm.read)', () => {
  test('returns DM conversation messages', async (t) => {
    if (skipIf(!hasOAuth, 'needs OAuth with dm.read scope')(t)) return;
    // TimothySolinger has a known DM conversation with CestIvan
    const { stdout, stderr, code } = await run(['x', 'dm-conversation', 'TimothySolinger', '5']);
    if (skipOnRateLimit(code, stderr, t)) return;
    assert.equal(code, 0, `stderr: ${stderr.slice(0, 200)}`);
    const rows = stdout.trim().split('\n').filter(l => /^\d+\./.test(l));
    assert.ok(rows.length >= 1, 'expected ≥1 DM message');
  });
});

// ── Reddit public API ─────────────────────────────────────────────────────

describe('reddit/popular', () => {
  test('returns popular posts as JSON array', async () => {
    const { stdout, code } = await run(['reddit', 'popular', '5', '--json']);
    assert.equal(code, 0);
    const items = JSON.parse(stdout) as unknown[];
    assert.ok(Array.isArray(items) && items.length >= 1);
  });
});

describe('reddit/all', () => {
  test('returns r/all post rows', async () => {
    const { stdout, code } = await run(['reddit', 'all', '5']);
    assert.equal(code, 0);
    const rows = stdout.trim().split('\n').filter(l => /^\d+\./.test(l));
    assert.ok(rows.length >= 1);
  });
});

describe('reddit/sub-info', () => {
  test('--json returns name/subscribers/description', async () => {
    const { stdout, code } = await run(['reddit', 'sub-info', 'programming', '--json']);
    assert.equal(code, 0);
    const items = JSON.parse(stdout) as Record<string, unknown>[];
    assert.ok(Array.isArray(items) && items.length === 1);
    const sub = items[0];
    assert.equal(typeof sub['name'],        'string');
    assert.equal(typeof sub['subscribers'], 'number');
    assert.equal(typeof sub['description'], 'string');
  });

  test('text output contains subscribers count', async () => {
    const { stdout, code } = await run(['reddit', 'sub-info', 'programming']);
    assert.equal(code, 0);
    assert.match(stdout, /subscribers:\d+/);
  });
});

describe('reddit/user', () => {
  test('--json returns username/karma_post/karma_comment', async () => {
    const { stdout, code } = await run(['reddit', 'user', 'spez', '--json']);
    assert.equal(code, 0);
    const items = JSON.parse(stdout) as Record<string, unknown>[];
    assert.ok(Array.isArray(items) && items.length === 1);
    const u = items[0];
    assert.equal(typeof u['username'],     'string');
    assert.equal(typeof u['karma_post'],   'number');
    assert.equal(typeof u['karma_comment'],'number');
  });

  test('text output contains post_karma count', async () => {
    const { stdout, code } = await run(['reddit', 'user', 'spez']);
    assert.equal(code, 0);
    // Text format: "1. u/spez post_karma:NNN comment_karma:NNN ..."
    assert.match(stdout, /post_karma:\d+/);
  });
});

describe('reddit/user-posts', () => {
  test('returns posts by user', async () => {
    const { stdout, code } = await run(['reddit', 'user-posts', 'spez', '3']);
    assert.equal(code, 0);
    const rows = stdout.trim().split('\n').filter(l => /^\d+\./.test(l));
    assert.ok(rows.length >= 1);
  });
});

describe('reddit/user-comments', () => {
  test('returns comments by user', async () => {
    const { stdout, code } = await run(['reddit', 'user-comments', 'spez', '3']);
    assert.equal(code, 0);
    const rows = stdout.trim().split('\n').filter(l => /^\d+\./.test(l));
    assert.ok(rows.length >= 1);
  });
});

describe('reddit/read (post detail)', () => {
  test('returns post content from a live r/programming post', async () => {
    // Dynamically fetch a fresh post ID
    const { stdout: feedOut } = await run(['reddit', 'sub', 'programming', '3', '--json']);
    let postId = '1j3aks5'; // fallback
    try {
      const posts = JSON.parse(feedOut) as Record<string, unknown>[];
      if (posts.length > 0 && typeof posts[0]['id'] === 'string') {
        postId = posts[0]['id'] as string;
      }
    } catch { /* use fallback */ }

    const { stdout, code } = await run(['reddit', 'read', postId]);
    assert.equal(code, 0, `reddit read ${postId} failed`);
    assert.ok(stdout.trim().length > 0, 'should return non-empty output');
  });
});

describe('reddit/search', () => {
  test('--json returns array with results', async () => {
    const { stdout, code } = await run(['reddit', 'search', 'node.js', '3', '--json']);
    assert.equal(code, 0);
    const items = JSON.parse(stdout) as unknown[];
    assert.ok(Array.isArray(items) && items.length >= 1);
  });
});

// ── Bluesky public API ────────────────────────────────────────────────────

describe('bsky/search (public)', () => {
  test('returns post rows without auth', async () => {
    const { stdout, code } = await run(['bsky', 'search', 'crossmind', '5']);
    assert.equal(code, 0);
    const rows = stdout.trim().split('\n').filter(l => /^\d+\./.test(l));
    assert.ok(rows.length >= 1, `expected ≥1 bsky post row`);
  });

  test('--json returns array', async () => {
    const { stdout, code } = await run(['bsky', 'search', 'crossmind', '3', '--json']);
    assert.equal(code, 0);
    const items = JSON.parse(stdout) as unknown[];
    assert.ok(Array.isArray(items));
  });
});

describe('bsky/profile (public)', () => {
  test('returns profile without auth', async () => {
    const { stdout, code } = await run(['bsky', 'profile', 'bsky.app']);
    assert.equal(code, 0);
    assert.match(stdout, /bsky\.app/i);
  });
});
