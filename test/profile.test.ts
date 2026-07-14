/**
 * Unit tests for at-rest profile encryption and the public-account fallback.
 * Uses the Node.js built-in test runner (node:test).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const KEY = crypto.randomBytes(32).toString('base64');

describe('profile-crypto', () => {
  test('encrypt/decrypt round-trips and binds AAD to profile id', async () => {
    const { encryptProfile, decryptProfile } = await import('../src/auth/profile-crypto.js');
    const salt = crypto.randomBytes(16);
    const masterKey = crypto.randomBytes(32);
    const plaintext = JSON.stringify({ platform: 'x', name: 'me', authToken: 'secret', ct0: 'csrf' });
    const env = encryptProfile(plaintext, masterKey, salt, 'x:me');
    const back = decryptProfile(env, masterKey, salt, 'x:me');
    assert.equal(back, plaintext);

    // Wrong profile id (AAD) must fail to authenticate
    assert.throws(() => decryptProfile(env, masterKey, salt, 'x:other'));
    // Wrong key must fail
    assert.throws(() => decryptProfile(env, crypto.randomBytes(32), salt, 'x:me'));
  });
});

describe('store: at-rest encryption', () => {
  let dir: string;
  const savedKey = process.env['CROSSMIND_PROFILE_KEY'];

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-store-'));
    process.env['CROSSMIND_DATA_DIR'] = dir;
    process.env['CROSSMIND_PROFILE_KEY'] = KEY;
    const { _resetProfileKeyCache } = await import('../src/auth/profile-key.js');
    _resetProfileKeyCache();
  });

  after(async () => {
    if (savedKey === undefined) delete process.env['CROSSMIND_PROFILE_KEY'];
    else process.env['CROSSMIND_PROFILE_KEY'] = savedKey;
    delete process.env['CROSSMIND_DATA_DIR'];
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('saveCredential writes .enc (no plaintext) and loadCredential round-trips', async () => {
    const { saveCredential, loadCredential } = await import('../src/auth/store.js');
    await saveCredential({ platform: 'x', name: 'me', authToken: 'AUTH', ct0: 'CT0' });
    const enc = path.join(dir, 'accounts', 'x', 'me.enc');
    const json = path.join(dir, 'accounts', 'x', 'me.json');
    assert.ok(await fileExists(enc), '.enc created');
    assert.ok(!(await fileExists(json)), 'no plaintext .json');
    // The .enc must not contain the cleartext cookie
    const raw = await fs.readFile(enc, 'utf8');
    assert.doesNotMatch(raw, /AUTH/);
    const cred = await loadCredential('x', 'me');
    assert.equal(cred?.authToken, 'AUTH');
    assert.equal(cred?.ct0, 'CT0');
  });

  test('legacy plaintext .json is migrated to .enc on load', async () => {
    const { loadCredential } = await import('../src/auth/store.js');
    const legacy = path.join(dir, 'accounts', 'reddit', 'old.json');
    await fs.mkdir(path.dirname(legacy), { recursive: true });
    await fs.writeFile(legacy, JSON.stringify({ platform: 'reddit', name: 'old', redditSession: 'SESS' }));
    const cred = await loadCredential('reddit', 'old');
    assert.equal(cred?.redditSession, 'SESS');
    assert.ok(!(await fileExists(legacy)), 'plaintext removed after migration');
    assert.ok(await fileExists(path.join(dir, 'accounts', 'reddit', 'old.enc')), '.enc created');
  });

  test('different CROSSMIND_PROFILE_KEY cannot read another key\'s profiles', async () => {
    const { saveCredential, loadCredential } = await import('../src/auth/store.js');
    const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-store-'));
    process.env['CROSSMIND_DATA_DIR'] = otherDir;
    process.env['CROSSMIND_PROFILE_KEY'] = crypto.randomBytes(32).toString('base64');
    const { _resetProfileKeyCache } = await import('../src/auth/profile-key.js');
    _resetProfileKeyCache();
    await saveCredential({ platform: 'x', name: 'me', authToken: 'A', ct0: 'C' });
    // Switch to a different key for the same data dir -> cannot decrypt
    process.env['CROSSMIND_PROFILE_KEY'] = crypto.randomBytes(32).toString('base64');
    _resetProfileKeyCache();
    const cred = await loadCredential('x', 'me');
    assert.equal(cred, null);
    await fs.rm(otherDir, { recursive: true, force: true });
    process.env['CROSSMIND_PROFILE_KEY'] = KEY;
    process.env['CROSSMIND_DATA_DIR'] = dir;
    _resetProfileKeyCache();
  });
});

describe('public-accounts gating', () => {
  test('isPublicAllowed allows anonymous reads, denies identity/writes', async () => {
    const { isPublicAllowed } = await import('../src/auth/public-accounts.js');
    assert.ok(isPublicAllowed('x', 'search'));
    assert.ok(isPublicAllowed('x', 'followers'));
    assert.ok(isPublicAllowed('reddit', 'comments'));
    assert.ok(!isPublicAllowed('x', 'home'));
    assert.ok(!isPublicAllowed('x', 'notifications'));
    assert.ok(!isPublicAllowed('reddit', 'home'));
    assert.ok(!isPublicAllowed('x', undefined));
    assert.ok(!isPublicAllowed('x', 'tweet')); // write
  });

  test('fetchPublicCredential returns null when no backend configured', async () => {
    const { fetchPublicCredential, _resetPublicCache } = await import('../src/auth/public-accounts.js');
    _resetPublicCache();
    delete process.env['CROSSMIND_API_BASE'];
    delete process.env['CROSSMIND_PUBLIC_TOKEN'];
    assert.equal(await fetchPublicCredential('x'), null);
  });
});

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}
