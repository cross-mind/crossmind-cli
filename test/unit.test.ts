/**
 * Unit tests for core modules.
 * Uses Node.js built-in test runner (node:test).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';

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

// ── Extract-cookie profile lock ──────────────────────────────────────────

describe('auth/extract-cookie (profile lock)', () => {
  const LOCK_TEST_DIR = `/tmp/crossmind-lock-test-${Date.now()}`;

  // Real Chromium SingletonLock symlinks point at a dangling "<hostname>-<pid>"
  // target that never exists as a real file — but Node's fs.existsSync follows
  // symlinks and requires the target to resolve, so to exercise isProfileLocked
  // in a test we point the symlink at a dummy file with that exact name instead.
  // (isProfileLocked only ever reads the pid back out of the link text itself,
  // via readlinkSync, so the target's contents are irrelevant to the pid logic
  // under test — only its existence, which existsSync requires.)
  function writeLockSymlink(profileDir: string, pid: number): void {
    const targetName = `test-host-${pid}`;
    fs.writeFileSync(path.join(profileDir, targetName), '');
    fs.symlinkSync(targetName, path.join(profileDir, 'SingletonLock'));
  }

  test('isProfileLocked: false when no lock file exists', async () => {
    const { isProfileLocked } = await import('../src/auth/extract-cookie.js');
    const profileDir = path.join(LOCK_TEST_DIR, 'no-lock');
    fs.mkdirSync(profileDir, { recursive: true });

    assert.equal(isProfileLocked(profileDir), false);
  });

  test('isProfileLocked: true when the owning process is alive', async () => {
    const { isProfileLocked } = await import('../src/auth/extract-cookie.js');
    const profileDir = path.join(LOCK_TEST_DIR, 'live-lock');
    fs.mkdirSync(profileDir, { recursive: true });
    // Our own process is definitely alive.
    writeLockSymlink(profileDir, process.pid);

    assert.equal(isProfileLocked(profileDir), true);
  });

  test('isProfileLocked: stale lock (dead pid) is auto-cleaned and reports free', async () => {
    const { isProfileLocked } = await import('../src/auth/extract-cookie.js');
    const profileDir = path.join(LOCK_TEST_DIR, 'stale-lock');
    fs.mkdirSync(profileDir, { recursive: true });
    // PID 1 is `init`/launchd — always running but never owned by us, so we'd
    // hit EPERM there. Use a very high, essentially-guaranteed-unused PID
    // instead to reliably hit ESRCH (no such process).
    const deadPid = 999999;
    writeLockSymlink(profileDir, deadPid);
    fs.writeFileSync(path.join(profileDir, 'SingletonCookie'), '');
    fs.writeFileSync(path.join(profileDir, 'SingletonSocket'), '');

    assert.equal(isProfileLocked(profileDir), false);
    assert.equal(fs.existsSync(path.join(profileDir, 'SingletonLock')), false);
    assert.equal(fs.existsSync(path.join(profileDir, 'SingletonCookie')), false);
    assert.equal(fs.existsSync(path.join(profileDir, 'SingletonSocket')), false);
  });
});

// ── Credential priority: own cookie > public account > own OAuth ──────────

describe('auth/credential priority (public account over own OAuth)', () => {
  const TEST_DIR = `/tmp/crossmind-priority-test-${Date.now()}`;
  const originalDispatcher = getGlobalDispatcher();
  const originalApiBase = process.env['CROSSMIND_API_BASE'];
  const originalPublicToken = process.env['CROSSMIND_PUBLIC_TOKEN'];

  function clearPublicAccountEnv(): void {
    delete process.env['CROSSMIND_API_BASE'];
    delete process.env['CROSSMIND_PUBLIC_TOKEN'];
  }

  function restorePublicAccountEnv(): void {
    if (originalApiBase !== undefined) process.env['CROSSMIND_API_BASE'] = originalApiBase;
    else delete process.env['CROSSMIND_API_BASE'];
    if (originalPublicToken !== undefined) process.env['CROSSMIND_PUBLIC_TOKEN'] = originalPublicToken;
    else delete process.env['CROSSMIND_PUBLIC_TOKEN'];
  }

  // Mirrors the backend's encryption side of decryptEnvelope() in
  // src/auth/public-accounts.ts, so the mocked exchange response is a
  // genuine envelope the CLI's own decrypt path will accept.
  function buildExchangeEnvelope(token: string, provider: string, secrets: Record<string, string>) {
    const salt = crypto.randomBytes(16);
    const key = Buffer.from(
      crypto.hkdfSync('sha256', Buffer.from(token, 'utf8'), salt, 'crossmind-public-accounts-v1', 32),
    );
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(provider, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      alg: 'AES-256-GCM',
      kdf: 'hkdf-sha256',
      salt: salt.toString('base64'),
      nonce: nonce.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: tag.toString('base64'),
    };
  }

  test('x: own cookie session wins outright, no public/OAuth fields leak in', async () => {
    clearPublicAccountEnv();
    const { saveCredential } = await import('../src/auth/store.js');
    const { loadXCredentials } = await import('../src/auth/x.js');
    await saveCredential(
      { platform: 'x', name: 'own-cookie', authToken: 'own-auth', ct0: 'own-ct0', accessToken: 'own-oauth' },
      TEST_DIR,
    );

    const result = await loadXCredentials('own-cookie', TEST_DIR, 'search');
    assert.deepEqual(result, { authToken: 'own-auth', ct0: 'own-ct0' });
  });

  test('x: no own cookie, allowlisted op — public account preferred over own OAuth', async () => {
    const { saveCredential } = await import('../src/auth/store.js');
    const { loadXCredentials } = await import('../src/auth/x.js');
    await saveCredential({ platform: 'x', name: 'own-oauth-only', accessToken: 'own-oauth-token' }, TEST_DIR);

    process.env['CROSSMIND_API_BASE'] = 'http://crossmind-test.local';
    process.env['CROSSMIND_PUBLIC_TOKEN'] = 'test-public-token-x';
    const { _resetPublicCache } = await import('../src/auth/public-accounts.js');
    _resetPublicCache();

    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    mockAgent
      .get('http://crossmind-test.local')
      .intercept({ path: '/internal/public-accounts/exchange', method: 'POST' })
      .reply(200, buildExchangeEnvelope('test-public-token-x', 'x', { auth_token: 'pub-auth', ct0: 'pub-ct0' }));

    try {
      const result = await loadXCredentials('own-oauth-only', TEST_DIR, 'search');
      assert.deepEqual(result, { authToken: 'pub-auth', ct0: 'pub-ct0' });
    } finally {
      setGlobalDispatcher(originalDispatcher);
      _resetPublicCache();
      restorePublicAccountEnv();
    }
  });

  test('x: no own cookie, public unavailable — falls back to own OAuth', async () => {
    clearPublicAccountEnv();
    const { saveCredential } = await import('../src/auth/store.js');
    const { loadXCredentials } = await import('../src/auth/x.js');
    await saveCredential({ platform: 'x', name: 'oauth-fallback', accessToken: 'fallback-oauth' }, TEST_DIR);

    const result = await loadXCredentials('oauth-fallback', TEST_DIR, 'search');
    assert.equal(result?.accessToken, 'fallback-oauth');
    assert.equal(result?.authToken, undefined);
  });

  test('reddit: own cookie session wins outright', async () => {
    clearPublicAccountEnv();
    const { saveCredential } = await import('../src/auth/store.js');
    const { loadRedditCredentials } = await import('../src/auth/reddit.js');
    await saveCredential(
      { platform: 'reddit', name: 'own-cookie', redditSession: 'own-session', accessToken: 'own-oauth' },
      TEST_DIR,
    );

    const result = await loadRedditCredentials('own-cookie', TEST_DIR, 'search');
    assert.deepEqual(result, { type: 'cookie', session: 'own-session', modhash: undefined, csrfToken: undefined, loid: undefined });
  });

  test('reddit: no own cookie, allowlisted op — public account preferred over own OAuth', async () => {
    const { saveCredential } = await import('../src/auth/store.js');
    const { loadRedditCredentials } = await import('../src/auth/reddit.js');
    await saveCredential({ platform: 'reddit', name: 'own-oauth-only', accessToken: 'own-oauth-token' }, TEST_DIR);

    process.env['CROSSMIND_API_BASE'] = 'http://crossmind-test.local';
    process.env['CROSSMIND_PUBLIC_TOKEN'] = 'test-public-token-reddit';
    const { _resetPublicCache } = await import('../src/auth/public-accounts.js');
    _resetPublicCache();

    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    mockAgent
      .get('http://crossmind-test.local')
      .intercept({ path: '/internal/public-accounts/exchange', method: 'POST' })
      .reply(
        200,
        buildExchangeEnvelope('test-public-token-reddit', 'reddit', { session: 'pub-session', modhash: 'pub-modhash' }),
      );

    try {
      const result = await loadRedditCredentials('own-oauth-only', TEST_DIR, 'search');
      assert.deepEqual(result, { type: 'cookie', session: 'pub-session', modhash: 'pub-modhash' });
    } finally {
      setGlobalDispatcher(originalDispatcher);
      _resetPublicCache();
      restorePublicAccountEnv();
    }
  });

  test('reddit: no own cookie, public unavailable — falls back to own OAuth', async () => {
    clearPublicAccountEnv();
    const { saveCredential } = await import('../src/auth/store.js');
    const { loadRedditCredentials } = await import('../src/auth/reddit.js');
    await saveCredential({ platform: 'reddit', name: 'oauth-fallback', accessToken: 'fallback-oauth' }, TEST_DIR);

    const result = await loadRedditCredentials('oauth-fallback', TEST_DIR, 'search');
    assert.deepEqual(result, { type: 'oauth', token: 'fallback-oauth' });
  });

  test('ph: own token wins outright, public account never consulted', async () => {
    clearPublicAccountEnv();
    const { saveCredential } = await import('../src/auth/store.js');
    const { loadProductHuntToken } = await import('../src/auth/producthunt.js');
    await saveCredential({ platform: 'ph', name: 'own-token', apiToken: 'own-ph-token' }, TEST_DIR);

    const result = await loadProductHuntToken('own-token', TEST_DIR, 'top');
    assert.equal(result, 'own-ph-token');
  });

  test('ph: no own token, allowlisted op — falls back to the shared public account', async () => {
    const { loadProductHuntToken } = await import('../src/auth/producthunt.js');

    process.env['CROSSMIND_API_BASE'] = 'http://crossmind-test.local';
    process.env['CROSSMIND_PUBLIC_TOKEN'] = 'test-public-token-ph';
    const { _resetPublicCache } = await import('../src/auth/public-accounts.js');
    _resetPublicCache();

    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    mockAgent
      .get('http://crossmind-test.local')
      .intercept({ path: '/internal/public-accounts/exchange', method: 'POST' })
      .reply(200, buildExchangeEnvelope('test-public-token-ph', 'ph', { api_token: 'pub-ph-token' }));

    try {
      const result = await loadProductHuntToken('no-such-account', TEST_DIR, 'top');
      assert.equal(result, 'pub-ph-token');
    } finally {
      setGlobalDispatcher(originalDispatcher);
      _resetPublicCache();
      restorePublicAccountEnv();
    }
  });

  test('ph: no own token, public unavailable — no third tier, returns undefined', async () => {
    // Unlike x/reddit, ph has no OAuth fallback tier at all.
    clearPublicAccountEnv();
    const { loadProductHuntToken } = await import('../src/auth/producthunt.js');

    const result = await loadProductHuntToken('no-such-account-either', TEST_DIR, 'top');
    assert.equal(result, undefined);
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
