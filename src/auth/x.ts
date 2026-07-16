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
import { fetchPublicCredential, isPublicAllowed } from './public-accounts.js';

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
      'X_CLIENT_ID is not set.\n\n' +
      'Recommended: extract session from your logged-in browser (no Developer App needed):\n' +
      '  crossmind extract-cookie x'
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
  dataDir?: string,
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
 *
 * Resolution order (highest priority first):
 *   1. Cookie session — the caller's own stored/env-injected auth_token+ct0.
 *      Env var overrides: X_AUTH_TOKEN → authToken, X_CT0 → ct0.
 *   2. Shared public account cookie session — only for allowlisted anonymous
 *      public reads (see isPublicAllowed), and only when tier 1 is absent.
 *      This keeps OAuth quota reserved for identity-tied/write operations
 *      instead of spending it on account-agnostic queries.
 *   3. OAuth — accessToken (file or X_ACCESS_TOKEN env var) or bearerToken.
 *      Lowest priority; used only when neither cookie tier is available.
 */
export async function loadXCredentials(
  account?: string,
  dataDir?: string,
  op?: string
): Promise<{ authToken?: string; ct0?: string; accessToken?: string; bearerToken?: string } | null> {
  const name = await resolveAccount('x', account, dataDir);
  const cred = await loadCredential('x', name, dataDir);

  // Tier 1: the caller's own cookie session.
  const ownCookie = {
    authToken: cred?.authToken ?? process.env['X_AUTH_TOKEN'],
    ct0:       cred?.ct0       ?? process.env['X_CT0'],
  };
  if (ownCookie.authToken && ownCookie.ct0) {
    return ownCookie;
  }

  // Tier 2: the shared public account, for allowlisted anonymous public
  // reads only.
  if (isPublicAllowed('x', op)) {
    const pub = await fetchPublicCredential('x');
    if (pub?.authToken && pub?.ct0) {
      return { authToken: pub.authToken, ct0: pub.ct0 };
    }
  }

  // Tier 3: OAuth-derived credentials.
  const oauth = {
    accessToken: cred?.accessToken ?? process.env['X_ACCESS_TOKEN'],
    bearerToken: cred?.bearerToken,
  };
  if (oauth.accessToken || oauth.bearerToken) {
    return oauth;
  }

  return null;
}
