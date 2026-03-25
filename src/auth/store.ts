/**
 * Multi-account credential store.
 * Storage: <data-dir>/accounts/<platform>/<name>.json
 * Config:  <data-dir>/config.json (default account per platform)
 * Priority: --data-dir > CROSSMIND_DATA_DIR > ~/.crossmind/
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface Credential {
  platform: string;
  name: string;
  cookie?: string;
  authToken?: string;    // X auth_token cookie value
  ct0?: string;          // X ct0 CSRF token
  bearerToken?: string;  // X developer app-only bearer token (read-only)
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;    // Unix timestamp ms
  appPassword?: string;  // Bluesky app password
  apiToken?: string;     // GitHub or generic token
  did?: string;          // Bluesky DID
  handle?: string;       // handle / username
}

interface Config {
  defaults: Record<string, string>; // platform -> account name
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

/** Save (create or overwrite) a credential. */
export async function saveCredential(cred: Credential, dataDir?: string): Promise<void> {
  const dir = getDataDir(dataDir);
  const file = credPath(cred.platform, cred.name, dir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(cred, null, 2));
}

/** Load a credential by platform + name. Returns null if not found. */
export async function loadCredential(
  platform: string,
  name: string,
  dataDir?: string
): Promise<Credential | null> {
  const dir = getDataDir(dataDir);
  const file = credPath(platform, name, dir);
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as Credential;
  } catch {
    return null;
  }
}

/** List all stored accounts, optionally filtered by platform. */
export async function listAccounts(platform?: string, dataDir?: string): Promise<Credential[]> {
  const dir = getDataDir(dataDir);
  const base = path.join(dir, 'accounts');
  const results: Credential[] = [];

  try {
    const platforms = platform ? [platform] : await fs.readdir(base);
    for (const p of platforms) {
      const pDir = path.join(base, p);
      try {
        const files = await fs.readdir(pDir);
        for (const f of files) {
          if (!f.endsWith('.json')) continue;
          try {
            const raw = await fs.readFile(path.join(pDir, f), 'utf8');
            results.push(JSON.parse(raw) as Credential);
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
  dataDir?: string
): Promise<void> {
  const dir = getDataDir(dataDir);
  const file = credPath(platform, name, dir);
  await fs.rm(file, { force: true });
}

/** Get the default account name for a platform. */
export async function getDefaultAccount(platform: string, dataDir?: string): Promise<string | null> {
  const dir = getDataDir(dataDir);
  const file = path.join(dir, 'config.json');
  try {
    const raw = await fs.readFile(file, 'utf8');
    const config = JSON.parse(raw) as Config;
    return config.defaults[platform] ?? null;
  } catch {
    return null;
  }
}

/** Set the default account for a platform. */
export async function setDefaultAccount(
  platform: string,
  name: string,
  dataDir?: string
): Promise<void> {
  const dir = getDataDir(dataDir);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  let config: Config = { defaults: {} };
  try {
    const raw = await fs.readFile(file, 'utf8');
    config = JSON.parse(raw) as Config;
  } catch { /* start fresh */ }
  config.defaults[platform] = name;
  await fs.writeFile(file, JSON.stringify(config, null, 2));
}

/**
 * Resolve which account name to use.
 * Priority: explicit --account flag > stored default > 'default'
 */
export async function resolveAccount(
  platform: string,
  explicit?: string,
  dataDir?: string
): Promise<string> {
  if (explicit) return explicit;
  const def = await getDefaultAccount(platform, dataDir);
  return def ?? 'default';
}
