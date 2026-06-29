/**
 * Unified identity contract — the single `user`/`author` object every
 * person-facing command returns across all platforms.
 *
 * The stable `id` (numeric/platform id, NOT the handle) is the dedup primary
 * key: handles get renamed, ids don't. The resolver keys off `id`.
 *
 * Fields a platform cannot supply are `null` (never a sentinel string).
 * Write commands follow a free-fields-only policy: they surface only identity
 * already present in the action's API response and never fire an extra lookup.
 * The resolver enriches missing fields via the P1 lookup commands.
 */

/** Schema version of the `--json` envelope. Bump on breaking output changes. */
export const SCHEMA_VERSION = 1;

/**
 * The cross-platform user/author object.
 * `null` = platform cannot supply this field; resolver may enrich via lookups.
 */
export interface UnifiedUser {
  /** Stable platform id (e.g. X rest_id, Reddit t2_…). Dedup primary key. */
  id: string | null;
  /** Handle (e.g. "crossmind_io"). null only if genuinely unknown. */
  username: string | null;
  /** Display name. */
  name: string | null;
  /** Avatar / profile image URL. */
  avatar_url: string | null;
  /** Canonical profile URL. */
  profile_url: string | null;
  /** Bio / description / headline. */
  bio: string | null;
  /** Follower count, if the platform exposes it. */
  followers: number | null;
  /** Verification status. */
  verified: boolean | null;
}

/** Build a UnifiedUser from partial fields, defaulting missing ones to null. */
export function makeUser(fields: Partial<UnifiedUser>): UnifiedUser {
  return {
    id: null,
    username: null,
    name: null,
    avatar_url: null,
    profile_url: null,
    bio: null,
    followers: null,
    verified: null,
    ...fields,
  };
}

/**
 * The structured `--json` envelope. Success and error share the same shape
 * apart from `ok` and the payload key, so resolvers gate on `schema_version`
 * then branch on `ok`.
 */
export interface JsonEnvelope<T = unknown> {
  ok: boolean;
  schema_version: typeof SCHEMA_VERSION;
  source: string;
  count?: number;
  data?: T;
  error?: { code: string; message: string; retry_after?: number };
}
