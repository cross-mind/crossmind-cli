/**
 * Output formatter — agent-friendly compact single-line format (default) or JSON.
 * No emoji, no abbreviations, key:value labels, full integers only.
 *
 * JSON mode emits a versioned envelope (see types/identity.ts JsonEnvelope):
 *   { ok, schema_version, source, count?, data?, error? }
 * so resolvers can gate parsing on schema_version and branch on ok.
 */

import { SCHEMA_VERSION, type JsonEnvelope } from '../types/identity.js';
import { RateLimitError, AuthError, NetworkError } from '../http/client.js';

export interface FormatOptions {
  json?: boolean;
  quiet?: boolean;
}

/** Resolve a dotted key path (e.g. "author.username") against an item. */
function getPath(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Render a template string with {field} / {a.b} substitution and truncation. */
function renderTemplate(template: string, item: Record<string, unknown>): string {
  return template.replace(/\{([\w.]+)\}/g, (_, key) => {
    const val = getPath(item, key);
    if (val === undefined || val === null) return '';
    if (typeof val === 'object') return ''; // don't stringify nested objects
    const str = String(val).replace(/\n/g, ' ');
    if (['title', 'tagline', 'headline', 'bio'].includes(key) && str.length > 120) {
      return str.slice(0, 117) + '...';
    }
    return str;
  });
}

const DEFAULT_TEMPLATE = '{rank}. {title} {url}';

/**
 * Format a list of items as compact single-line strings.
 * @param items - Array of data objects
 * @param template - Template like "{rank}. [{score}] {title} {url}"
 * @param opts - Format options
 */
export function formatItems(
  items: Record<string, unknown>[],
  template: string | undefined,
  opts: FormatOptions = {}
): string {
  if (opts.json) {
    return formatJSON(items);
  }
  return items.map((item) => renderTemplate(template ?? DEFAULT_TEMPLATE, item)).join('\n');
}

/** Format as clean JSON array, no wrapper. */
export function formatJSON(items: Record<string, unknown>[]): string {
  return JSON.stringify(items, null, 2);
}

/** Footer line printed to stderr. */
function footer(count: number, source: string, elapsedMs: number): string {
  return `\n${count} results · ${elapsedMs}ms · ${source}`;
}

/** Print formatted output + optional footer. */
export function printOutput(
  items: Record<string, unknown>[],
  template: string | undefined,
  source: string,
  startTime: number,
  opts: FormatOptions = {}
): void {
  if (opts.json) {
    printJsonResult(items, source, { startTime });
    return;
  }
  console.log(formatItems(items, template ?? DEFAULT_TEMPLATE, opts));
  if (!opts.quiet) {
    const elapsed = Date.now() - startTime;
    process.stderr.write(footer(items.length, source, elapsed) + '\n');
  }
}

// ── Versioned JSON envelope helpers ────────────────────────────────────────

/** Emit a versioned success envelope to stdout. */
export function printJsonResult<T>(
  data: T,
  source: string,
  opts: { count?: number; quiet?: boolean; startTime?: number } = {}
): void {
  const env: JsonEnvelope<T> = {
    ok: true,
    schema_version: SCHEMA_VERSION,
    source,
    data,
  };
  if (opts.count !== undefined) env.count = opts.count;
  else if (Array.isArray(data)) env.count = data.length;
  console.log(JSON.stringify(env, null, 2));
  if (!opts.quiet && opts.startTime !== undefined) {
    const elapsed = Date.now() - opts.startTime;
    const count = opts.count ?? (Array.isArray(data) ? data.length : 1);
    process.stderr.write(footer(count, source, elapsed) + '\n');
  }
}

/** Map a thrown error to a stable `code` string for the error envelope. */
export function errorCode(err: unknown): string {
  if (err instanceof AuthError) return 'auth';
  if (err instanceof RateLimitError) return 'rate_limit';
  if (err instanceof NetworkError) return 'network';
  return 'error';
}

/** Emit a versioned error envelope to stdout and exit non-zero. Never returns. */
export function printJsonError(
  err: unknown,
  source: string
): never {
  const env: JsonEnvelope = {
    ok: false,
    schema_version: SCHEMA_VERSION,
    source,
    error: {
      code: errorCode(err),
      message: err instanceof Error ? err.message : String(err),
    },
  };
  if (err instanceof RateLimitError && err.retryAfter !== undefined) {
    env.error!.retry_after = err.retryAfter;
  }
  console.log(JSON.stringify(env, null, 2));
  process.exit(1);
}
