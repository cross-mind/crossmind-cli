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

/** Marks one credential tier (cookie or oauth) as known-dead so it isn't silently reused. */
export interface InvalidMarker {
  reason: string;   // short human-readable cause, e.g. "HTTP 401: Could not authenticate you"
  at: string;       // ISO timestamp when detected
  valueHash?: string; // fingerprint of the value that failed, so a later refreshed value auto-clears the marker
}

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
  invalidCookie?: InvalidMarker; // set when authToken/ct0 was confirmed dead by the API
  invalidOAuth?: InvalidMarker;  // set when accessToken was confirmed dead by the API
  /**
   * Bounded history of past invalidCookie/invalidOAuth markers (most recent last),
   * kept even after the tier is fixed or the current marker self-heals, so `auth
   * status` can answer "when did each tier actually go dead, historically" rather
   * than only showing the single most-recent event.
   */
  invalidCookieHistory?: InvalidMarker[];
  invalidOAuthHistory?: InvalidMarker[];
}

/** How many past invalidation events to retain per tier, per account. */
const INVALID_HISTORY_LIMIT = 10;

/**
 * Append a marker to a bounded history, collapsing consecutive entries for the
 * same ongoing failure (same reason + value) into one updated-timestamp entry
 * instead of spamming duplicates on every retry within the same outage.
 */
function appendInvalidHistory(history: InvalidMarker[] | undefined, marker: InvalidMarker): InvalidMarker[] {
  const next = history ? [...history] : [];
  const last = next[next.length - 1];
  if (last && last.reason === marker.reason && last.valueHash === marker.valueHash) {
    next[next.length - 1] = marker; // same ongoing failure — refresh timestamp only
  } else {
    next.push(marker);
  }
  return next.slice(-INVALID_HISTORY_LIMIT);
}

/** Cheap non-reversible fingerprint of a secret value, for marker/refresh comparison only. */
export function fingerprintValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) | 0;
  return `${value.length}:${(hash >>> 0).toString(16)}`;
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

/** Write the exact given record as the account's stored credential (encrypted, or plaintext fallback). */
async function persistCredential(cred: Credential, dir: string): Promise<void> {
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

/**
 * Save (create or update) a credential, encrypted at rest.
 * Merges with any existing stored record for the same platform+name so that
 * saving one credential type (e.g. a bearer token) never wipes previously
 * stored fields of another type (e.g. cookie authToken/ct0) on the same account.
 * Saving a fresh value for a tier also clears any stale invalid-marker for that tier.
 */
export async function saveCredential(cred: Credential, dataDir?: string): Promise<void> {
  const dir = getDataDir(dataDir);
  const existing = await loadCredential(cred.platform, cred.name, dataDir);
  const merged: Credential = { ...existing, ...cred };
  if (cred.authToken || cred.ct0) delete merged.invalidCookie;
  if (cred.accessToken) delete merged.invalidOAuth;
  await persistCredential(merged, dir);
}

/**
 * Mark one credential tier as confirmed-dead: clears its secret fields (so it can
 * never be silently reused) and records a reason + fingerprint of the failed value.
 * Works even for accounts with no prior stored record (e.g. purely env-var-driven),
 * so the account name itself carries a durable "needs re-auth" signal.
 */
export async function markCredentialInvalid(
  platform: string,
  name: string,
  tier: 'cookie' | 'oauth',
  reason: string,
  failedValue: { authToken?: string; ct0?: string; accessToken?: string },
  dataDir?: string,
): Promise<void> {
  const dir = getDataDir(dataDir);
  const existing = (await loadCredential(platform, name, dataDir)) ?? { platform, name };
  const next: Credential = { ...existing };
  const marker: InvalidMarker = { reason, at: new Date().toISOString() };
  if (tier === 'cookie') {
    marker.valueHash = fingerprintValue(`${failedValue.authToken ?? ''}|${failedValue.ct0 ?? ''}`);
    delete next.authToken;
    delete next.ct0;
    next.invalidCookie = marker;
    next.invalidCookieHistory = appendInvalidHistory(existing?.invalidCookieHistory, marker);
  } else {
    marker.valueHash = fingerprintValue(failedValue.accessToken);
    delete next.accessToken;
    next.invalidOAuth = marker;
    next.invalidOAuthHistory = appendInvalidHistory(existing?.invalidOAuthHistory, marker);
  }
  await persistCredential(next, dir);
}

/** Clear a previously-set invalid marker (e.g. once a fresh value for that tier is confirmed). */
export async function clearInvalidMarker(
  platform: string,
  name: string,
  tier: 'cookie' | 'oauth',
  dataDir?: string,
): Promise<void> {
  const dir = getDataDir(dataDir);
  const existing = await loadCredential(platform, name, dataDir);
  if (!existing) return;
  const next = { ...existing };
  if (tier === 'cookie') delete next.invalidCookie; else delete next.invalidOAuth;
  await persistCredential(next, dir);
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
