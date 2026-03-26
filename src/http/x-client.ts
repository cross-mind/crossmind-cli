/**
 * X (Twitter) HTTP client.
 *
 * Auth priority (highest to lowest):
 *   1. Cookie (auth_token + ct0)  → x.com/i/api/graphql/* (GraphQL API)
 *   2. Stored bearer token        → api.twitter.com/2/*   (v2 REST, read-only)
 *   3. No-auth / public           → api.twitter.com/2/*   (v2 REST, public bearer)
 *   4. OAuth access token         → api.twitter.com/2/*   (v2 REST, user context)
 */

import { request, AuthError, type RequestOptions } from './client.js';

const X_API_BASE = 'https://api.twitter.com';

// Twitter internal app bearer — used for public v2 REST calls
const X_BEARER_REST = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I4xNp1YjHJj%2BI9m5FkS4bCZ3m0E';

// Twitter/X internal GraphQL bearer — required when calling x.com/i/api/graphql
const X_BEARER_GQL = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const X_GQL_BASE = 'https://x.com/i/api/graphql';

// Fallback queryIds — periodically updated by Twitter; these match twitter-cli's defaults
export const X_GQL_IDS = {
  SearchTimeline:  'MJpyQGqgklrVl_0X9gNy3A',
  HomeTimeline:    'HCosKfLNW1AcOo3la3mMgg',
  UserByScreenName:'qRednkZG-rn1P6b48NINmQ',
  UserTweets:      'E3opETHurmVJflFsUBVuUQ',
};

// Minimal feature flags required for most GraphQL read operations
const GQL_FEATURES: Record<string, boolean> = {
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  responsive_web_enhance_cards_enabled: false,
};

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

export interface XCredentials {
  authToken?: string;   // auth_token cookie (cookie-based auth → GraphQL)
  ct0?: string;         // ct0 CSRF token   (required with authToken)
  bearerToken?: string; // Developer app-only bearer token (v2 REST, read-only)
  accessToken?: string; // OAuth 2.0 user access token (v2 REST, user context)
}

/** Build headers for v2 REST API calls (api.twitter.com). */
function buildRestHeaders(creds?: XCredentials): Record<string, string> {
  // Auth priority: stored developer bearer > OAuth access token > public bearer
  let authorization: string;
  if (creds?.bearerToken) {
    authorization = `Bearer ${creds.bearerToken}`;
  } else if (creds?.accessToken) {
    authorization = `Bearer ${creds.accessToken}`;
  } else {
    authorization = X_BEARER_REST;
  }

  return {
    'Authorization': authorization,
    'User-Agent': UA,
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://twitter.com/',
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'en',
  };
}

/** Build headers for GraphQL API calls (x.com/i/api/graphql). Requires cookie auth. */
function buildGqlHeaders(creds: XCredentials): Record<string, string> {
  return {
    'Authorization': X_BEARER_GQL,
    'Cookie': `auth_token=${creds.authToken}; ct0=${creds.ct0}`,
    'X-Csrf-Token': creds.ct0!,
    'x-twitter-active-user': 'yes',
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-client-language': 'en',
    'User-Agent': UA,
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://x.com',
    'Referer': 'https://x.com/',
    'sec-ch-ua': '"Chromium";v="133", "Not(A:Brand";v="99", "Google Chrome";v="133"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
  };
}

/**
 * Make an X v2 REST API call.
 * - With creds.authToken+ct0: not used here (use xGqlGet instead)
 * - With creds.bearerToken or creds.accessToken: token auth
 * - Without creds: public bearer
 *
 * Translates generic 401/403 HTTP errors into actionable X OAuth guidance.
 */
export async function xRequest<T = unknown>(
  path: string,
  opts: RequestOptions & { creds?: XCredentials } = {}
): Promise<T> {
  const { creds, ...rest } = opts;
  const url = path.startsWith('http') ? path : `${X_API_BASE}${path}`;
  const headers = { ...buildRestHeaders(creds), ...(rest.headers ?? {}) };
  try {
    return await request<T>(url, { ...rest, headers });
  } catch (err) {
    // Only remap 401 as an auth guidance error.
    // 403 from Twitter often means a policy/permission denial (e.g. Free tier reply restriction),
    // not a missing token — surface the actual API message instead of a misleading auth hint.
    if (err instanceof AuthError && /HTTP 401/.test(err.message)) {
      throw new AuthError(
        'X OAuth token missing or expired.\n' +
        '  Set X_ACCESS_TOKEN, or run: crossmind auth login x --access-token <token>'
      );
    }
    throw err;
  }
}

/**
 * Make an X GraphQL GET call (cookie auth required).
 * Uses x.com/i/api/graphql/{queryId}/{operation}.
 */
export async function xGqlGet<T = unknown>(
  operation: keyof typeof X_GQL_IDS,
  variables: Record<string, unknown>,
  creds: XCredentials,
  featureOverrides?: Record<string, boolean>
): Promise<T> {
  const queryId = X_GQL_IDS[operation];
  const features = featureOverrides ? { ...GQL_FEATURES, ...featureOverrides } : GQL_FEATURES;
  // Only include true-valued features to keep URL short
  const compact = Object.fromEntries(Object.entries(features).filter(([, v]) => v !== false));
  const params = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(compact),
  });
  const url = `${X_GQL_BASE}/${queryId}/${operation}?${params}`;
  const headers = buildGqlHeaders(creds);
  return request<T>(url, { headers });
}

/**
 * Build X GraphQL API URL (legacy helper for external use).
 */
export function xGraphQL(queryId: string, operationName: string): string {
  return `${X_API_BASE}/graphql/${queryId}/${operationName}`;
}

export { AuthError };
