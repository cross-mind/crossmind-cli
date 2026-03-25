/**
 * X (Twitter) HTTP client.
 * Uses cookie-based auth (auth_token + ct0) for API calls.
 * Adds the required X-CSRF-Token header and mimics browser User-Agent.
 */

import { request, AuthError, type RequestOptions } from './client.js';

const X_API_BASE = 'https://api.twitter.com';
const X_BEARER = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I4xNp1YjHJj%2BI9m5FkS4bCZ3m0E';

/** Browser-like User-Agent to avoid bot detection */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export interface XCredentials {
  authToken?: string;   // auth_token cookie (full user-context auth)
  ct0?: string;         // ct0 CSRF token cookie
  bearerToken?: string; // Developer app-only bearer token (read-only, no login required)
}

function buildXHeaders(creds?: XCredentials): Record<string, string> {
  // Prefer developer bearer token; fall back to the hardcoded guest token.
  const authorization = creds?.bearerToken
    ? `Bearer ${creds.bearerToken}`
    : X_BEARER;

  const headers: Record<string, string> = {
    'Authorization': authorization,
    'User-Agent': UA,
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://twitter.com/',
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'en',
  };

  if (creds?.authToken && creds?.ct0) {
    headers['Cookie'] = `auth_token=${creds.authToken}; ct0=${creds.ct0}`;
    headers['X-CSRF-Token'] = creds.ct0;
    headers['x-twitter-auth-type'] = 'OAuth2Session';
  }

  return headers;
}

/**
 * Make an X API call.
 * - With creds: cookie-auth session (can access private data, write ops)
 * - Without creds: bearer-only (public read-only)
 */
export async function xRequest<T = unknown>(
  path: string,
  opts: RequestOptions & { creds?: XCredentials } = {}
): Promise<T> {
  const { creds, ...rest } = opts;
  const url = path.startsWith('http') ? path : `${X_API_BASE}${path}`;
  const headers = { ...buildXHeaders(creds), ...(rest.headers ?? {}) };
  return request<T>(url, { ...rest, headers });
}

/**
 * Build X GraphQL API URL.
 */
export function xGraphQL(queryId: string, operationName: string): string {
  return `${X_API_BASE}/graphql/${queryId}/${operationName}`;
}

export { AuthError };
