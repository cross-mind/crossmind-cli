/**
 * Shared "public" social accounts for the crossmind CLI.
 *
 * When a command has no personal account for a platform AND the operation is an
 * anonymous public read (see allowlist below), the CLI can fall back to a shared
 * account served by the CrossMind backend. The agent runtime receives only a
 * short-lived session token (CROSSMIND_PUBLIC_TOKEN) + loopback URL
 * (CROSSMIND_API_BASE) — never the raw cookies. At point of use the CLI exchanges
 * the token for the cookies, which are returned AES-256-GCM encrypted under a key
 * derived from the token itself, then uses them IN-MEMORY ONLY (never persisted).
 *
 * Identity-tied operations (home/timeline feed, me, notifications, bookmarks, DMs,
 * saved) and ALL writes are never served by the public account.
 */

import crypto from 'node:crypto';
import { request } from 'undici';
import type { Credential } from './store.js';

const EXCHANGE_INFO = 'crossmind-public-accounts-v1';

/**
 * Per-provider allowlist of operations that may use the shared public account.
 * Anything not listed must NOT fall back to the public account (it is either
 * identity-tied or a write).
 */
const PUBLIC_OPS: Record<string, ReadonlySet<string>> = {
  x: new Set([
    'search', 'mentions', 'timeline', 'profile', 'thread', 'get',
    'user', 'followers', 'following', 'likes',
  ]),
  reddit: new Set([
    'subreddit', 'search', 'popular', 'all', 'sub-info',
    'user-profile', 'user-posts', 'user-comments', 'post', 'comments',
  ]),
  // Product Hunt has no personal identity concept at all in this CLI (a
  // Developer Token is app-level, not user-level), so every read op is
  // account-agnostic and eligible for the shared public account.
  ph: new Set(['top', 'search', 'show']),
};

export function isPublicAllowed(provider: string, op: string | undefined): boolean {
  return !!op && PUBLIC_OPS[provider]?.has(op);
}

function configAvailable(): boolean {
  return !!process.env['CROSSMIND_API_BASE'] && !!process.env['CROSSMIND_PUBLIC_TOKEN'];
}

interface ExchangeEnvelope {
  alg: string;
  kdf: string;
  salt: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}

/** Decrypt the backend exchange envelope under a key derived from the session token. */
export function decryptEnvelope(env: ExchangeEnvelope, token: string, provider: string): string {
  const key = Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(token, 'utf8'), Buffer.from(env.salt, 'base64'), EXCHANGE_INFO, 32),
  );
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.nonce, 'base64'));
  decipher.setAAD(Buffer.from(provider, 'utf8'));
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(env.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return pt.toString('utf8');
}

interface CachedCred {
  cred: Credential | null;
  expiresAt: number;
}
const cache = new Map<string, CachedCred>();
const CACHE_MS = 5 * 60_000; // short; the backend token carries its own TTL

/**
 * Fetch (and in-memory cache) the shared public credential for a provider.
 * Returns null when public accounts are unavailable/not configured. The result is
 * a transient Credential that callers must never saveCredential().
 */
export async function fetchPublicCredential(provider: string): Promise<Credential | null> {
  if (!configAvailable()) return null;
  const cached = cache.get(provider);
  if (cached && cached.expiresAt > Date.now()) return cached.cred;

  const base = process.env['CROSSMIND_API_BASE'] as string;
  const token = process.env['CROSSMIND_PUBLIC_TOKEN'] as string;

  let cred: Credential | null = null;
  try {
    const res = await request(`${base.replace(/\/$/, '')}/internal/public-accounts/exchange`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ provider }),
      headersTimeout: 10_000,
      bodyTimeout: 10_000,
    });
    if (res.statusCode === 200) {
      const env = (await res.body.json()) as ExchangeEnvelope;
      const plaintext = decryptEnvelope(env, token, provider);
      const secrets = JSON.parse(plaintext) as Record<string, string>;
      if (provider === 'x') {
        cred = {
          platform: 'x',
          name: '__public__',
          authToken: secrets['auth_token'],
          ct0: secrets['ct0'],
        };
      } else if (provider === 'reddit') {
        cred = {
          platform: 'reddit',
          name: '__public__',
          redditSession: secrets['session'],
          redditModhash: secrets['modhash'],
        };
      } else if (provider === 'ph') {
        cred = {
          platform: 'ph',
          name: '__public__',
          apiToken: secrets['api_token'],
        };
      }
    }
  } catch {
    cred = null;
  }

  cache.set(provider, { cred, expiresAt: Date.now() + CACHE_MS });
  return cred;
}

/** Test-only: clear the in-memory public-account cache. */
export function _resetPublicCache(): void {
  cache.clear();
}
