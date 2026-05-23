/**
 * Write-history dedup — prevents duplicate or near-duplicate write operations
 * within a configurable time window to avoid bot-detection patterns.
 *
 * Storage: <data-dir>/write-history.json
 * Config:  <data-dir>/config.json (dedup section)
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../auth/store.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface WriteEntry {
  platform: string;   // x, reddit, bsky, linkedin
  action: string;     // tweet, reply, dm, comment, post, ...
  text: string;       // the content that was written
  target?: string;    // optional context (tweet_id, username, subreddit)
  author?: string;    // for replies: the tweet author's handle (e.g. "ardent__dev")
  ts: number;         // Unix timestamp ms
}

export interface DedupConfig {
  enabled: boolean;
  windowHours: number;
  thresholdLong: number;        // Jaccard threshold for text >= 30 chars
  thresholdShort: number;       // Jaccard threshold for text <  30 chars
  dmWindowHours: number;        // block window for DMs to same user (default: 168h = 7 days)
  replyAuthorWindowHours: number; // block window for replies to same author (default: 336h = 14 days)
}

const DEFAULT_DEDUP_CONFIG: DedupConfig = {
  enabled: true,
  windowHours: 48,
  thresholdLong: 0.7,
  thresholdShort: 0.6,
  dmWindowHours: 168,         // 7 days — never re-DM unless they replied
  replyAuthorWindowHours: 336, // 14 days — never reply to same person twice within 2 weeks
};

// ── Config load/save ─────────────────────────────────────────────────────────

interface AppConfig {
  defaults?: Record<string, string>;
  dedup?: Partial<DedupConfig>;
}

export async function loadDedupConfig(dataDir?: string): Promise<DedupConfig> {
  const dir = getDataDir(dataDir);
  const file = path.join(dir, 'config.json');
  try {
    const raw = await fs.readFile(file, 'utf8');
    const config = JSON.parse(raw) as AppConfig;
    if (config.dedup && config.dedup.enabled === false) {
      return { ...DEFAULT_DEDUP_CONFIG, ...config.dedup, enabled: false };
    }
    return { ...DEFAULT_DEDUP_CONFIG, ...config.dedup };
  } catch {
    return { ...DEFAULT_DEDUP_CONFIG };
  }
}

export async function saveDedupConfig(config: Partial<DedupConfig>, dataDir?: string): Promise<void> {
  const dir = getDataDir(dataDir);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  let appConfig: AppConfig = {};
  try {
    const raw = await fs.readFile(file, 'utf8');
    appConfig = JSON.parse(raw) as AppConfig;
  } catch { /* start fresh */ }
  appConfig.dedup = { ...DEFAULT_DEDUP_CONFIG, ...appConfig.dedup, ...config };
  await fs.writeFile(file, JSON.stringify(appConfig, null, 2));
}

// ── History load/save ────────────────────────────────────────────────────────

const HISTORY_FILE = 'write-history.json';

async function loadHistory(dataDir?: string): Promise<WriteEntry[]> {
  const dir = getDataDir(dataDir);
  const file = path.join(dir, HISTORY_FILE);
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as WriteEntry[];
  } catch {
    return [];
  }
}

async function saveHistory(entries: WriteEntry[], dataDir?: string): Promise<void> {
  const dir = getDataDir(dataDir);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, HISTORY_FILE);
  await fs.writeFile(file, JSON.stringify(entries, null, 2));
}

// ── Prune ────────────────────────────────────────────────────────────────────

async function pruneHistory(windowMs: number, dataDir?: string): Promise<WriteEntry[]> {
  const entries = await loadHistory(dataDir);
  const cutoff = Date.now() - windowMs;
  const pruned = entries.filter((e) => e.ts >= cutoff);
  // Only write if something was pruned (avoid unnecessary I/O)
  if (pruned.length < entries.length) {
    await saveHistory(pruned, dataDir);
  }
  return pruned;
}

async function loadAllHistory(dataDir?: string): Promise<WriteEntry[]> {
  return loadHistory(dataDir);
}

// ── Jaccard similarity ───────────────────────────────────────────────────────

function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean)
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) {
    if (b.has(w)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

// ── Check ────────────────────────────────────────────────────────────────────

export interface DedupResult {
  blocked: boolean;
  reason?: string;
  similarTo?: WriteEntry;
}

/**
 * Check if a write operation would be a duplicate.
 * Returns { blocked } for hard blocks, { warning } for soft reminders.
 *
 * Call this BEFORE performing the write. If not blocked, call recordWrite() after success.
 *
 * @param author - For replies: the tweet author's handle. Enables per-author reply dedup
 *                 across different tweet IDs from the same person (anti-harassment guard).
 */
export async function checkWriteDuplicate(
  platform: string,
  action: string,
  text: string,
  target?: string,
  dataDir?: string,
  author?: string,
): Promise<DedupResult> {
  const config = await loadDedupConfig(dataDir);
  if (!config.enabled) return { blocked: false };

  // Load full history without pruning so we can apply different windows per action type
  const allEntries = await loadAllHistory(dataDir);
  const now = Date.now();

  // ── Per-author reply dedup (hardest guard) ────────────────────────────────
  // If we know the tweet author, block any reply to them within replyAuthorWindowHours,
  // regardless of which tweet ID we're replying to. This prevents the pattern of
  // replying to the same account repeatedly across different threads.
  if (action === 'reply' && author) {
    const authorHandle = author.replace(/^@/, '').toLowerCase();
    const replyAuthorWindowMs = config.replyAuthorWindowHours * 3600_000;
    const replyAuthorCutoff = now - replyAuthorWindowMs;

    const priorReply = allEntries.find(
      (e) =>
        e.platform === platform &&
        e.action === 'reply' &&
        e.author?.toLowerCase() === authorHandle &&
        e.ts >= replyAuthorCutoff,
    );
    if (priorReply) {
      const ageHours = ((now - priorReply.ts) / 3600_000).toFixed(1);
      return {
        blocked: true,
        reason: `Already replied to @${authorHandle} ${ageHours}h ago (${config.replyAuthorWindowHours}h cooldown per author). Use --force to override.`,
        similarTo: priorReply,
      };
    }
  }

  // ── DM dedup: block re-contact within dmWindowHours ───────────────────────
  if (action === 'dm' && target) {
    const dmWindowMs = config.dmWindowHours * 3600_000;
    const dmCutoff = now - dmWindowMs;
    const priorDm = allEntries.find(
      (e) =>
        e.platform === platform &&
        e.action === 'dm' &&
        e.target === target &&
        e.ts >= dmCutoff,
    );
    if (priorDm) {
      const ageHours = ((now - priorDm.ts) / 3600_000).toFixed(1);
      return {
        blocked: true,
        reason: `Already DM'd @${target} ${ageHours}h ago (${config.dmWindowHours}h cooldown). Use --force to override.\nPrevious message: ${priorDm.text}`,
        similarTo: priorDm,
      };
    }
  }

  // ── Content similarity dedup (general window) ─────────────────────────────
  const windowMs = config.windowHours * 3600_000;
  const entries = allEntries.filter((e) => e.ts >= now - windowMs);

  const relevant = entries.filter(
    (e) => e.platform === platform && e.action === action,
  );

  const threshold = text.length >= 30 ? config.thresholdLong : config.thresholdShort;
  const tokens = tokenize(text);

  for (const entry of relevant) {
    // Skip if target is different (e.g. reply to different tweet, DM different user)
    // unless it's a broadcast action (tweet, post) where target doesn't differentiate
    const broadcastActions = ['tweet', 'post', 'text-post', 'quote'];
    const isBroadcast = broadcastActions.includes(action);
    if (!isBroadcast && target && entry.target && target !== entry.target) continue;

    const entryTokens = tokenize(entry.text);
    const similarity = jaccard(tokens, entryTokens);

    if (similarity >= threshold) {
      const ageHours = ((Date.now() - entry.ts) / 3600_000).toFixed(1);
      return {
        blocked: true,
        reason: `Similar content written ${ageHours}h ago (${(similarity * 100).toFixed(0)}% match). Use --force to override.`,
        similarTo: entry,
      };
    }
  }

  return { blocked: false };
}

// ── Record ───────────────────────────────────────────────────────────────────

/**
 * Record a successful write operation. Call after the write succeeds.
 *
 * @param author - For replies: the tweet author's handle (enables per-author dedup).
 */
export async function recordWrite(
  platform: string,
  action: string,
  text: string,
  target?: string,
  dataDir?: string,
  author?: string,
): Promise<void> {
  const config = await loadDedupConfig(dataDir);
  if (!config.enabled) return;

  const entries = await loadHistory(dataDir);
  const entry: WriteEntry = {
    platform,
    action,
    text,
    target,
    ts: Date.now(),
  };
  if (author) {
    entry.author = author.replace(/^@/, '').toLowerCase();
  }
  entries.push(entry);
  await saveHistory(entries, dataDir);
}
