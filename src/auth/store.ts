/**
 * Multi-account credential store.
 * Storage: <data-dir>/accounts/<platform>/<name>.enc   (AES-256-GCM encrypted envelope)
 * Legacy:  <data-dir>/accounts/<platform>/<name>.json  (plaintext, auto-migrated)
 * Config:  <data-dir>/config.json (default account per platform + fixed KDF salt)
 * Priority: --data-dir > CROSSMIND_DATA_DIR > ~/.crossmind/
 *
 * Credentials are never persisted in plaintext: saveCredential encrypts via the
 * profile-key provider chain (see profile-key.ts / profile-crypto.ts). When no key
 * is resolvable the store falls back to plaintext with a one-time warning.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { encryptProfile, decryptProfile } from './profile-crypto.js';
import { getProfileKey, warnPlaintextOnce } from './profile-key.js';

export interface Credential {
  platform: string;
  name: string;
  cookie?: string;
  authToken?: string;      // X auth_token cookie value
  ct0?: string;            // X ct0 CSRF token
  bearerToken?: string;    // X developer app-only bearer token (read-only)
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;      // Unix timestamp ms
  appPassword?: string;    // Bluesky app password
  apiToken?: string;       // GitHub or generic token
  did?: string;            // Bluesky DID
  handle?: string;         // handle / username
  redditSession?: string;  // reddit_session cookie (cookie-based auth)
  redditModhash?: string;  // modhash for Reddit write ops
  redditCsrftoken?: string; // csrf_token cookie for Reddit
  redditLoid?: string;     // loid cookie for Reddit
}

interface Config {
  defaults?: Record<string, string>; // platform -> account name
  profileKdf?: { salt?: string };
}

/** Resolve data directory from override > env > default. */
export function getDataDir(overrideDir?: string): string {
  if (overrideDir) return overrideDir;
  if (process.env['CROSSMIND_DATA_DIR']) return process.env['CROSSMIND_DATA_DIR'];
  return path.join(os.homedir(), '.crossmind');
}

function credPath(platform: string, name: string, dataDir: string): string {
  return path.join(dataDir, 'accounts', platform, `${name}.json`);
}

function encPath(platform: string, name: string, dataDir: string): string {
  return path.join(dataDir, 'accounts', platform, `${name}.enc`);
}

function profileIdOf(platform: string, name: string): string {
  return `${platform}:${name}`;
}

async function readConfig(dataDir: string): Promise<Config> {
  try {
    return JSON.parse(await fs.readFile(path.join(dataDir, 'config.json'), 'utf8')) as Config;
  } catch {
    return {};
  }
}

/** Save (create or overwrite) a credential, encrypted at rest. */
export async function saveCredential(cred: Credential, dataDir?: string): Promise<void> {
  const dir = getDataDir(dataDir);
  const encFile = encPath(cred.platform, cred.name, dir);
  await fs.mkdir(path.dirname(encFile), { recursive: true });

  const { key, salt } = await getProfileKey(dir);
  if (!key) {
    warnPlaintextOnce();
    // Plaintext fallback: write .json, remove any stale .enc
    await fs.writeFile(credPath(cred.platform, cred.name, dir), JSON.stringify(cred, null, 2));
    await fs.rm(encFile, { force: true });
    return;
  }

  const profileId = profileIdOf(cred.platform, cred.name);
  const envelope = encryptProfile(JSON.stringify(cred), key, salt, profileId);
  await fs.writeFile(encFile, envelope, { mode: 0o600 });
  try { await fs.chmod(encFile, 0o600); } catch { /* non-POSIX */ }
  // Drop any legacy plaintext file for this account
  await fs.rm(credPath(cred.platform, cred.name, dir), { force: true });
}

/** Load a credential by platform + name. Returns null if not found. */
export async function loadCredential(
  platform: string,
  name: string,
  dataDir?: string,
): Promise<Credential | null> {
  const dir = getDataDir(dataDir);
  const profileId = profileIdOf(platform, name);
  const { key, salt } = await getProfileKey(dir);

  // Encrypted profile wins when a key is available
  if (key) {
    try {
      const raw = await fs.readFile(encPath(platform, name, dir), 'utf8');
      return JSON.parse(decryptProfile(raw, key, salt, profileId)) as Credential;
    } catch { /* fall through to legacy */ }
  }

  // Legacy plaintext file (also the path used in plaintext mode)
  try {
    const raw = await fs.readFile(credPath(platform, name, dir), 'utf8');
    const cred = JSON.parse(raw) as Credential;
    // Opportunistic migration to encrypted-at-rest
    if (key) {
      try {
        await fs.writeFile(
          encPath(platform, name, dir),
          encryptProfile(JSON.stringify(cred), key, salt, profileId),
          { mode: 0o600 },
        );
        await fs.rm(credPath(platform, name, dir), { force: true });
      } catch { /* migration is best-effort */ }
    }
    return cred;
  } catch {
    return null;
  }
}

/** List all stored accounts, optionally filtered by platform. */
export async function listAccounts(platform?: string, dataDir?: string): Promise<Credential[]> {
  const dir = getDataDir(dataDir);
  const base = path.join(dir, 'accounts');
  const results: Credential[] = [];
  const { key, salt } = await getProfileKey(dir);

  try {
    const platforms = platform ? [platform] : await fs.readdir(base);
    for (const p of platforms) {
      const pDir = path.join(base, p);
      try {
        const files = await fs.readdir(pDir);
        for (const f of files) {
          try {
            if (f.endsWith('.enc')) {
              if (!key) continue; // cannot read encrypted without key
              const raw = await fs.readFile(path.join(pDir, f), 'utf8');
              const name = f.slice(0, -'.enc'.length);
              results.push(
                JSON.parse(decryptProfile(raw, key, salt, profileIdOf(p, name))) as Credential,
              );
            } else if (f.endsWith('.json')) {
              const raw = await fs.readFile(path.join(pDir, f), 'utf8');
              results.push(JSON.parse(raw) as Credential);
            }
          } catch { /* skip malformed */ }
        }
      } catch { /* platform dir missing */ }
    }
  } catch { /* accounts dir missing */ }

  return results;
}

/** Remove a stored credential. */
export async function removeCredential(
  platform: string,
  name: string,
  dataDir?: string,
): Promise<void> {
  const dir = getDataDir(dataDir);
  await fs.rm(encPath(platform, name, dir), { force: true });
  await fs.rm(credPath(platform, name, dir), { force: true });
}

/** Get the default account name for a platform. */
export async function getDefaultAccount(platform: string, dataDir?: string): Promise<string | null> {
  const dir = getDataDir(dataDir);
  const config = await readConfig(dir);
  return config.defaults?.[platform] ?? null;
}

/** Set the default account for a platform. */
export async function setDefaultAccount(
  platform: string,
  name: string,
  dataDir?: string,
): Promise<void> {
  const dir = getDataDir(dataDir);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  const config = await readConfig(dir);
  (config.defaults ??= {})[platform] = name;
  await fs.writeFile(file, JSON.stringify(config, null, 2));
}

/**
 * Resolve which account name to use.
 * Priority: explicit --account flag > stored default > 'default'
 */
export async function resolveAccount(
  platform: string,
  explicit?: string,
  dataDir?: string,
): Promise<string> {
  if (explicit) return explicit;
  const def = await getDefaultAccount(platform, dataDir);
  return def ?? 'default';
}
