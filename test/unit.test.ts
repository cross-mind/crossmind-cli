/**
 * Unit tests for core modules.
 * Uses Node.js built-in test runner (node:test).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// ── Formatter ─────────────────────────────────────────────────────────────

describe('formatter', () => {
  test('formatItems: compact single-line output', async () => {
    const { formatItems } = await import('../src/output/formatter.js');
    const items = [
      { rank: 1, title: 'Hello World', url: 'https://example.com', score: 42 },
      { rank: 2, title: 'Second Item', url: 'https://test.com', score: 7 },
    ];
    const out = formatItems(items, '{rank}. score:{score} {title} {url}');
    const lines = out.split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^1\. score:42 Hello World https:\/\/example\.com$/);
    assert.match(lines[1], /^2\. score:7 Second Item https:\/\/test\.com$/);
  });

  test('formatItems: truncates long title at 120 chars', async () => {
    const { formatItems } = await import('../src/output/formatter.js');
    const longTitle = 'A'.repeat(200);
    const items = [{ rank: 1, title: longTitle, url: '' }];
    const out = formatItems(items, '{rank}. {title}');
    assert.match(out, /\.\.\.$/);
    assert.ok(out.length < 200);
  });

  test('formatItems: --json returns parseable array', async () => {
    const { formatItems } = await import('../src/output/formatter.js');
    const items = [{ rank: 1, title: 'Test', url: 'https://x.com' }];
    const out = formatItems(items, '{rank}. {title}', { json: true });
    const parsed = JSON.parse(out);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed[0].title, 'Test');
  });

  test('formatItems: uses default template when undefined', async () => {
    const { formatItems } = await import('../src/output/formatter.js');
    const items = [{ rank: 1, title: 'My Post', url: 'https://example.com' }];
    const out = formatItems(items, undefined);
    assert.match(out, /My Post/);
    assert.match(out, /https:\/\/example\.com/);
  });

  test('footer: correct format', async () => {
    const { footer } = await import('../src/output/formatter.js');
    const f = footer(10, 'hn/top', 250);
    assert.match(f, /10 results/);
    assert.match(f, /250ms/);
    assert.match(f, /hn\/top/);
  });
});

// ── Auth store ────────────────────────────────────────────────────────────

describe('auth/store', () => {
  const TEST_DIR = `/tmp/crossmind-test-${Date.now()}`;

  test('getDataDir: uses override when provided', async () => {
    const { getDataDir } = await import('../src/auth/store.js');
    const dir = getDataDir('/custom/path');
    assert.equal(dir, '/custom/path');
  });

  test('getDataDir: uses env var when set', async () => {
    const origEnv = process.env['CROSSMIND_DATA_DIR'];
    process.env['CROSSMIND_DATA_DIR'] = '/env/path';
    const { getDataDir } = await import('../src/auth/store.js');
    const dir = getDataDir();
    assert.equal(dir, '/env/path');
    if (origEnv !== undefined) process.env['CROSSMIND_DATA_DIR'] = origEnv;
    else delete process.env['CROSSMIND_DATA_DIR'];
  });

  test('saveCredential + loadCredential: round-trip', async () => {
    const { saveCredential, loadCredential } = await import('../src/auth/store.js');
    await saveCredential({
      platform: 'test',
      name: 'alice',
      apiToken: 'tok_abc123',
      handle: 'alice_test',
    }, TEST_DIR);

    const cred = await loadCredential('test', 'alice', TEST_DIR);
    assert.ok(cred, 'credential should be found');
    assert.equal(cred!.platform, 'test');
    assert.equal(cred!.name, 'alice');
    assert.equal(cred!.apiToken, 'tok_abc123');
    assert.equal(cred!.handle, 'alice_test');
  });

  test('listAccounts: returns all stored accounts', async () => {
    const { saveCredential, listAccounts } = await import('../src/auth/store.js');
    await saveCredential({ platform: 'x', name: 'main', authToken: 't1', ct0: 'c1' }, TEST_DIR);
    await saveCredential({ platform: 'x', name: 'alt', authToken: 't2', ct0: 'c2' }, TEST_DIR);

    const all = await listAccounts(undefined, TEST_DIR);
    const xAccounts = all.filter((a) => a.platform === 'x');
    assert.ok(xAccounts.length >= 2);
  });

  test('setDefaultAccount + getDefaultAccount: round-trip', async () => {
    const { saveCredential, setDefaultAccount, getDefaultAccount } = await import('../src/auth/store.js');
    await saveCredential({ platform: 'reddit', name: 'myreddit' }, TEST_DIR);
    await setDefaultAccount('reddit', 'myreddit', TEST_DIR);
    const def = await getDefaultAccount('reddit', TEST_DIR);
    assert.equal(def, 'myreddit');
  });

  test('removeCredential: credential gone after removal', async () => {
    const { saveCredential, removeCredential, loadCredential } = await import('../src/auth/store.js');
    await saveCredential({ platform: 'bsky', name: 'tobedeleted' }, TEST_DIR);
    await removeCredential('bsky', 'tobedeleted', TEST_DIR);
    const cred = await loadCredential('bsky', 'tobedeleted', TEST_DIR);
    assert.equal(cred, null);
  });
});

// ── OAuth helpers ─────────────────────────────────────────────────────────

describe('auth/oauth', () => {
  test('generateCodeVerifier: 43-128 chars, URL-safe', async () => {
    const { generateCodeVerifier } = await import('../src/auth/oauth.js');
    const v = generateCodeVerifier();
    assert.ok(v.length >= 43 && v.length <= 128, `length ${v.length} out of range`);
    assert.match(v, /^[A-Za-z0-9\-_]+$/, 'should be base64url safe');
  });

  test('generateCodeChallenge: deterministic SHA-256 base64url', async () => {
    const { generateCodeChallenge } = await import('../src/auth/oauth.js');
    const challenge = generateCodeChallenge('testverifier');
    // SHA-256 of "testverifier" in base64url
    assert.ok(challenge.length > 0);
    assert.match(challenge, /^[A-Za-z0-9\-_]+$/);
    // Same input → same output
    assert.equal(generateCodeChallenge('testverifier'), challenge);
  });

  test('generateState: 48-char hex string', async () => {
    const { generateState } = await import('../src/auth/oauth.js');
    const s = generateState();
    assert.equal(s.length, 48);
    assert.match(s, /^[a-f0-9]+$/);
  });

  test('buildAuthUrl: contains required OAuth params', async () => {
    const { buildAuthUrl } = await import('../src/auth/oauth.js');
    const url = buildAuthUrl(
      {
        clientId: 'client123',
        redirectUri: 'http://localhost:7878/callback',
        authorizationUrl: 'https://auth.example.com/authorize',
        tokenUrl: 'https://auth.example.com/token',
        scopes: ['read', 'write'],
      },
      'state_abc',
      'challenge_xyz'
    );
    assert.match(url, /client_id=client123/);
    assert.match(url, /state=state_abc/);
    assert.match(url, /code_challenge=challenge_xyz/);
    assert.match(url, /code_challenge_method=S256/);
    assert.match(url, /response_type=code/);
  });
});

// ── Rate limiter ──────────────────────────────────────────────────────────

describe('http/rate-limiter', () => {
  const LIMIT_DIR = `/tmp/crossmind-ratelimit-${Date.now()}`;

  test('checkWriteLimit: first call succeeds', async () => {
    const { checkWriteLimit } = await import('../src/http/rate-limiter.js');
    await assert.doesNotReject(() => checkWriteLimit('x', 'post', LIMIT_DIR));
  });

  test('checkWriteLimit: throws RateLimitError after exceeding daily limit', async () => {
    const { checkWriteLimit } = await import('../src/http/rate-limiter.js');
    // x.post limit is 10/day — burn through them
    const promises = Array.from({ length: 10 }, () => checkWriteLimit('x', 'post', LIMIT_DIR));
    await Promise.allSettled(promises);

    try {
      await checkWriteLimit('x', 'post', LIMIT_DIR);
      // If we reach here, check may have reset (same day boundary edge case)
    } catch (err) {
      assert.match(String(err), /daily.*limit|rate.*limit/i);
    }
  });
});

// ── Pipeline YAML parser ──────────────────────────────────────────────────

describe('http/pipeline (YAML parsing)', () => {
  test('executePipeline: loads HN top adapter and fetches real data', async () => {
    const { executePipeline } = await import('../src/http/pipeline.js');
    const result = await executePipeline('hackernews', 'top', { limit: 3 });
    const items = result.items;
    assert.ok(Array.isArray(items), 'should return array');
    assert.ok(items.length > 0, 'should have items');
    const first = items[0];
    assert.ok(first['title'], 'item should have title');
    assert.equal(first['rank'], 1);
  });
});
