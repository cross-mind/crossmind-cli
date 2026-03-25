/**
 * Reddit authentication.
 *
 * Auth priority:
 *   1. Cookie (reddit_session)  → www.reddit.com JSON API with session cookie
 *   2. OAuth 2.0 access token   → oauth.reddit.com with Bearer token
 *   3. No credentials           → www.reddit.com public JSON API
 */

import open from 'open';
import {
  generateCodeVerifier, generateCodeChallenge, generateState,
  buildAuthUrl, exchangeCode, refreshToken, captureCallback, type OAuthConfig,
} from './oauth.js';
import { saveCredential, loadCredential, resolveAccount } from './store.js';
import { AuthError } from '../http/client.js';

export const REDDIT_CLIENT_ID = process.env['REDDIT_CLIENT_ID'] ?? 'YOUR_REDDIT_CLIENT_ID';
const REDDIT_REDIRECT_PORT = 7879;
const REDDIT_REDIRECT_URI = `http://127.0.0.1:${REDDIT_REDIRECT_PORT}/callback`;
const REDDIT_UA = 'crossmind-cli/1.0 (crossmind.io)';

const REDDIT_OAUTH_CONFIG: OAuthConfig = {
  clientId: REDDIT_CLIENT_ID,
  redirectUri: REDDIT_REDIRECT_URI,
  authorizationUrl: 'https://www.reddit.com/api/v1/authorize',
  tokenUrl: 'https://www.reddit.com/api/v1/access_token',
  scopes: ['read', 'submit', 'vote', 'save', 'subscribe', 'history', 'identity', 'mysubreddits'],
};

/** Unified credential type — tells callers which auth strategy is available. */
export type RedditCredentials =
  | { type: 'oauth'; token: string }
  | { type: 'cookie'; session: string; modhash?: string }
  | null;

/**
 * Run the Reddit OAuth 2.0 PKCE flow.
 */
export async function loginReddit(accountName: string, dataDir?: string): Promise<void> {
  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  const state = generateState();

  const authUrl = buildAuthUrl(REDDIT_OAUTH_CONFIG, state, challenge) + '&duration=permanent';
  console.log(`Opening browser for Reddit authorization...`);
  console.log(`If browser does not open, visit:\n${authUrl}`);
  await open(authUrl);

  console.log(`Waiting for OAuth callback on port ${REDDIT_REDIRECT_PORT}...`);
  const code = await captureCallback(REDDIT_REDIRECT_PORT, state);

  const tokens = await exchangeCode(REDDIT_OAUTH_CONFIG, code, verifier);
  const expiresAt = tokens.expires_in
    ? Date.now() + tokens.expires_in * 1000
    : undefined;

  await saveCredential({
    platform: 'reddit',
    name: accountName,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt,
  }, dataDir);

  console.log(`Reddit account saved as "${accountName}".`);
}

/**
 * Save Reddit session cookie credentials (extracted from browser).
 */
export async function saveRedditCookies(
  accountName: string,
  session: string,
  modhash?: string,
  dataDir?: string
): Promise<void> {
  await saveCredential({
    platform: 'reddit',
    name: accountName,
    redditSession: session,
    redditModhash: modhash,
  }, dataDir);
  console.log(`Reddit session cookie saved as "${accountName}".`);
}

/**
 * Load Reddit credentials, returning the highest-priority auth method available.
 * Priority: cookie (reddit_session) > OAuth access token > null (no-auth)
 */
export async function loadRedditCredentials(
  account?: string,
  dataDir?: string
): Promise<RedditCredentials> {
  const name = await resolveAccount('reddit', account, dataDir);
  const cred = await loadCredential('reddit', name, dataDir);
  if (!cred) return null;

  // Cookie auth wins if present
  if (cred.redditSession) {
    return { type: 'cookie', session: cred.redditSession, modhash: cred.redditModhash };
  }

  // OAuth access token
  if (cred.accessToken) {
    // Refresh if expired (with 60s buffer)
    if (cred.expiresAt && Date.now() > cred.expiresAt - 60_000 && cred.refreshToken) {
      const tokens = await refreshToken(REDDIT_OAUTH_CONFIG, cred.refreshToken);
      const updated = {
        ...cred,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? cred.refreshToken,
        expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : cred.expiresAt,
      };
      await saveCredential(updated, dataDir);
      return { type: 'oauth', token: updated.accessToken! };
    }
    return { type: 'oauth', token: cred.accessToken };
  }

  return null;
}

/**
 * Get a valid Reddit access token, refreshing if expired.
 * @deprecated Prefer loadRedditCredentials() for the full auth chain.
 */
export async function getRedditToken(account?: string, dataDir?: string): Promise<string> {
  const name = await resolveAccount('reddit', account, dataDir);
  const cred = await loadCredential('reddit', name, dataDir);
  if (!cred?.accessToken) {
    throw new AuthError('No Reddit credentials. Run: crossmind auth login reddit');
  }

  // Refresh if expired (with 60s buffer)
  if (cred.expiresAt && Date.now() > cred.expiresAt - 60_000 && cred.refreshToken) {
    const tokens = await refreshToken(REDDIT_OAUTH_CONFIG, cred.refreshToken);
    const updated = {
      ...cred,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? cred.refreshToken,
      expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : cred.expiresAt,
    };
    await saveCredential(updated, dataDir);
    return updated.accessToken!;
  }

  return cred.accessToken;
}

/** Reddit OAuth API base URL */
export const REDDIT_API = 'https://oauth.reddit.com';

/** Build headers for Reddit OAuth API calls */
export function redditHeaders(token: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${token}`,
    'User-Agent': REDDIT_UA,
  };
}

/** Build headers for Reddit cookie-based API calls */
export function redditCookieHeaders(session: string, modhash?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Cookie': `reddit_session=${encodeURIComponent(session)}`,
    'User-Agent': REDDIT_UA,
    'Accept': 'application/json',
    'sec-ch-ua': '"Chromium";v="133", "Not(A:Brand";v="99", "Google Chrome";v="133"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
  };
  if (modhash) {
    headers['x-modhash'] = modhash;
  }
  return headers;
}

/** Build headers for anonymous Reddit API calls */
export function redditPublicHeaders(): Record<string, string> {
  return { 'User-Agent': REDDIT_UA };
}
