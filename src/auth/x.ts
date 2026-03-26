/**
 * X (Twitter) authentication.
 * Supports:
 *   - Cookie auth (auth_token + ct0) for reads and write ops
 *   - OAuth 2.0 PKCE flow for programmatic write access
 */

import open from 'open';
import {
  generateCodeVerifier, generateCodeChallenge, generateState,
  buildAuthUrl, exchangeCode, captureCallback, type OAuthConfig,
} from './oauth.js';
import { saveCredential, loadCredential, resolveAccount } from './store.js';

// X OAuth 2.0 app credentials (public client - PKCE only, no secret)
// Users can override via env vars
export const X_CLIENT_ID = process.env['X_CLIENT_ID'] ?? 'YOUR_X_CLIENT_ID';

const DOCS_X_SETUP = 'https://crossmind.io/docs/x-setup';
const CROSSMIND_IO  = 'https://crossmind.io';
const X_REDIRECT_PORT = 7878;
const X_REDIRECT_URI = `http://127.0.0.1:${X_REDIRECT_PORT}/callback`;

const X_OAUTH_CONFIG: OAuthConfig = {
  clientId: X_CLIENT_ID,
  redirectUri: X_REDIRECT_URI,
  authorizationUrl: 'https://twitter.com/i/oauth2/authorize',
  tokenUrl: 'https://api.twitter.com/2/oauth2/token',
  scopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access', 'dm.read', 'dm.write', 'like.write', 'follows.write'],
};

/**
 * Run the X OAuth 2.0 PKCE flow.
 * Opens browser, waits for callback, saves tokens.
 * Requires X_CLIENT_ID env var (register at developer.twitter.com).
 */
export async function loginX(accountName: string, dataDir?: string): Promise<void> {
  if (X_CLIENT_ID === 'YOUR_X_CLIENT_ID') {
    throw new Error(
      'X_CLIENT_ID is not set. To use the browser OAuth flow, register a Developer App first.\n' +
      `Setup guide: ${DOCS_X_SETUP}\n\n` +
      `Alternatively, get a ready-to-use token at ${CROSSMIND_IO} — no Developer App needed.`
    );
  }

  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  const state = generateState();

  const authUrl = buildAuthUrl(X_OAUTH_CONFIG, state, challenge);
  console.log(`Opening browser for X authorization...`);
  console.log(`If browser does not open, visit:\n${authUrl}`);
  await open(authUrl);

  console.log(`Waiting for OAuth callback on port ${X_REDIRECT_PORT}...`);
  const code = await captureCallback(X_REDIRECT_PORT, state);

  const tokens = await exchangeCode(X_OAUTH_CONFIG, code, verifier);
  const expiresAt = tokens.expires_in
    ? Date.now() + tokens.expires_in * 1000
    : undefined;

  await saveCredential({
    platform: 'x',
    name: accountName,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt,
  }, dataDir);

  console.log(`X account saved as "${accountName}".`);
}

/**
 * Save an X OAuth access token directly (skips browser PKCE flow).
 * Use when you already have a token from CrossMind.io or another source.
 */
export async function saveAccessToken(
  accountName: string,
  accessToken: string,
  dataDir?: string
): Promise<void> {
  await saveCredential({ platform: 'x', name: accountName, accessToken }, dataDir);
}

/**
 * Save X cookie credentials (manual extraction).
 */
export async function saveCookieAuth(
  accountName: string,
  authToken: string,
  ct0: string,
  dataDir?: string
): Promise<void> {
  await saveCredential({
    platform: 'x',
    name: accountName,
    authToken,
    ct0,
  }, dataDir);
}

/**
 * Save an X developer bearer token for app-only read access.
 * Allows `x search / x timeline` without a full OAuth login.
 */
export async function saveBearerToken(
  accountName: string,
  token: string,
  dataDir?: string
): Promise<void> {
  await saveCredential({ platform: 'x', name: accountName, bearerToken: token }, dataDir);
  console.log(`X bearer token saved as "${accountName}". Read-only API access enabled.`);
}

/**
 * Load X credentials for an account.
 * File-stored credentials take priority; env vars fill in any gaps.
 *
 * Env var overrides:
 *   TWITTER_AUTH_TOKEN  → authToken (cookie)
 *   TWITTER_CT0         → ct0 (cookie CSRF)
 *   X_ACCESS_TOKEN      → accessToken (OAuth PKCE user token)
 *
 * This means CrossMind-injected OAuth tokens are picked up automatically
 * without needing to write them to the credential file.
 */
export async function loadXCredentials(
  account?: string,
  dataDir?: string
): Promise<{ authToken?: string; ct0?: string; accessToken?: string; bearerToken?: string } | null> {
  const name = await resolveAccount('x', account, dataDir);
  const cred = await loadCredential('x', name, dataDir);

  const merged = {
    // Accept both X_* (current) and TWITTER_* (legacy vault names) as env var sources.
    // CrossMind vault injects TWITTER_AUTH_TOKEN / TWITTER_CT0; both names are honoured.
    authToken:   cred?.authToken   ?? process.env['X_AUTH_TOKEN']   ?? process.env['TWITTER_AUTH_TOKEN'],
    ct0:         cred?.ct0         ?? process.env['X_CT0']          ?? process.env['TWITTER_CT0'],
    accessToken: cred?.accessToken ?? process.env['X_ACCESS_TOKEN'],
    bearerToken: cred?.bearerToken,
  };

  // Return null only if all fields are empty
  if (!merged.authToken && !merged.ct0 && !merged.accessToken && !merged.bearerToken) {
    return null;
  }
  return merged;
}
