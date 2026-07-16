/**
 * Product Hunt authentication.
 *
 * Product Hunt's own API has no per-user OAuth identity for this CLI's use
 * case — a single app-level Developer Token authenticates all requests via
 * `Authorization: Bearer <token>`. So unlike X/Reddit there is no cookie vs.
 * OAuth distinction here, just two tiers:
 *   1. The caller's own stored token (`crossmind auth login ph --token ...`).
 *   2. The shared public account (allowlisted ops only) — a Developer Token
 *      the platform holds centrally so agents don't each need their own.
 */

import { loadCredential, resolveAccount } from './store.js';
import { fetchPublicCredential, isPublicAllowed } from './public-accounts.js';

/**
 * Resolve the Product Hunt API token to use, highest priority first.
 * Returns undefined when neither tier has a token — callers should fall
 * back to an unauthenticated request (Product Hunt's API rate-limits but
 * does not hard-reject anonymous requests for some fields).
 */
export async function loadProductHuntToken(
  account?: string,
  dataDir?: string,
  op?: string,
): Promise<string | undefined> {
  const name = await resolveAccount('ph', account, dataDir);
  const cred = await loadCredential('ph', name, dataDir);

  // Tier 1: the caller's own stored token.
  if (cred?.apiToken) return cred.apiToken;

  // Tier 2: the shared public account, for allowlisted ops only.
  if (isPublicAllowed('ph', op)) {
    const pub = await fetchPublicCredential('ph');
    if (pub?.apiToken) return pub.apiToken;
  }

  return undefined;
}
