/**
 * Master-key provider for at-rest profile encryption.
 *
 * The master key is NEVER written into the data dir. It resolves via a chain so
 * both backend-managed (agent) and standalone (local dev) usage work:
 *   1. CROSSMIND_PROFILE_KEY   env (base64 32B)  — injected per-agent by the backend
 *   2. CROSSMIND_PROFILE_PASSPHRASE env          — scrypt(passphrase, salt) for CI/headless
 *   3. ~/.config/crossmind/profile.key           — auto-generated standalone default,
 *                                                  deliberately OUTSIDE the data dir
 *   4. none                                       — legacy plaintext mode (one-time warning)
 *
 * A fixed 16-byte salt is generated once into <data-dir>/config.json (non-secret;
 * KDF domain separation only) — the "fixed salt at init".
 */

import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const LOCAL_KEY_DIR = path.join(os.homedir(), '.config', 'crossmind');
const LOCAL_KEY_FILE = path.join(LOCAL_KEY_DIR, 'profile.key');

const keyCache = new Map<string, Buffer | null>();
let warnedPlaintext = false;

/** Read (or lazily create) the fixed per-install KDF salt from config.json. */
export async function getOrCreateProfileSalt(dataDir: string): Promise<Buffer> {
  const file = path.join(dataDir, 'config.json');
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  } catch { /* fresh config */ }

  const kdf = config['profileKdf'] as { salt?: string } | undefined;
  if (kdf && typeof kdf.salt === 'string' && kdf.salt.length > 0) {
    return Buffer.from(kdf.salt, 'base64');
  }

  const salt = crypto.randomBytes(16);
  config['profileKdf'] = { salt: salt.toString('base64') };
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(file, JSON.stringify(config, null, 2));
  return salt;
}

async function readLocalKeyFile(): Promise<Buffer | null> {
  try {
    const raw = (await fs.readFile(LOCAL_KEY_FILE, 'utf8')).trim();
    const key = Buffer.from(raw, 'base64');
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

async function createLocalKeyFile(): Promise<Buffer | null> {
  try {
    const key = crypto.randomBytes(32);
    await fs.mkdir(LOCAL_KEY_DIR, { recursive: true });
    await fs.writeFile(LOCAL_KEY_FILE, key.toString('base64'), { mode: 0o600 });
    try { await fs.chmod(LOCAL_KEY_FILE, 0o600); } catch { /* non-POSIX */ }
    return key;
  } catch {
    return null;
  }
}

async function resolveMasterKey(salt: Buffer): Promise<Buffer | null> {
  const cacheKey = salt.toString('base64');
  const cached = keyCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let key: Buffer | null = null;

  const envKey = process.env['CROSSMIND_PROFILE_KEY'];
  if (envKey && envKey.trim()) {
    const buf = Buffer.from(envKey.trim(), 'base64');
    if (buf.length === 32) key = buf;
  }

  const passphrase = process.env['CROSSMIND_PROFILE_PASSPHRASE'];
  if (!key && passphrase && passphrase.trim()) {
    key = crypto.scryptSync(passphrase.trim(), salt, 32);
  }

  if (!key) {
    key = (await readLocalKeyFile()) ?? (await createLocalKeyFile());
  }

  keyCache.set(cacheKey, key);
  return key;
}

/** Resolve the master key + salt for a data dir. Returns key=null in plaintext mode. */
export async function getProfileKey(dataDir: string): Promise<{ key: Buffer | null; salt: Buffer }> {
  const salt = await getOrCreateProfileSalt(dataDir);
  try {
    return { key: await resolveMasterKey(salt), salt };
  } catch {
    return { key: null, salt };
  }
}

/** Emit a single stderr warning when profiles are being stored unencrypted. */
export function warnPlaintextOnce(): void {
  if (warnedPlaintext) return;
  warnedPlaintext = true;
  process.stderr.write(
    'crossmind: warning — no profile encryption key available; credentials are stored in plaintext.\n',
  );
}

/** Test-only: reset the in-process key cache. */
export function _resetProfileKeyCache(): void {
  keyCache.clear();
  warnedPlaintext = false;
}
