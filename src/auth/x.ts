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
 */
export async function loginX(accountName: string, dataDir?: string): Promise<void> {
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
 * Returns null if not found.
 */
export async function loadXCredentials(
  account?: string,
  dataDir?: string
): Promise<{ authToken?: string; ct0?: string; accessToken?: string; bearerToken?: string } | null> {
  const name = await resolveAccount('x', account, dataDir);
  const cred = await loadCredential('x', name, dataDir);
  if (!cred) return null;
  return {
    authToken: cred.authToken,
    ct0: cred.ct0,
    accessToken: cred.accessToken,
    bearerToken: cred.bearerToken,
  };
}
