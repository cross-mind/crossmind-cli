/**
 * Cookie extraction helper using Playwright.
 *
 * Three modes (tried in order):
 *   1. CDP (automatic) — connects to an already-running Chrome via CDP
 *      (PLAYWRIGHT_MCP_CDP_ENDPOINT or derived from STEEL_LOCAL_URLS).
 *      Reads cookies directly from the running browser's in-memory state.
 *      Tried regardless of --headed, since it's strictly lock-free:
 *        - No profile lock conflicts
 *        - No SQLite encryption to deal with
 *        - Reads live in-memory cookies immediately after user login
 *   2. Headless (default) — reuses an existing persistent browser profile.
 *      Extracts cookies silently if the session is still valid.
 *      Fails fast (throws ExtractCookieLoginRequired) when not logged in.
 *   3. Headed — opens a visible browser window for first-time / re-login.
 *      Waits for the user to complete login, then saves cookies.
 *      Still tries CDP first (see 1); only falls through to opening a
 *      profile-backed browser window when CDP is unavailable or the running
 *      browser isn't logged in to this platform yet.
 *
 * Profile directory: ~/.config/crossmind/browser-profiles/<platform>/
 * Keeping a persistent profile means the user only needs to log in once;
 * subsequent headless runs reuse the saved session.
 */

import { chromium } from 'playwright';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { saveCredential } from './store.js';

/**
 * Locate a usable Chrome/Chromium executable.
 * Prefers system Chrome to avoid large Playwright browser downloads.
 */
function findChrome(): string | undefined {
  const candidates = [
    process.env['CHROME_PATH'],
    '/opt/google/chrome/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return undefined; // Fall back to Playwright's bundled browser
}

/** Chrome flags safe for containerized / sandboxless environments.
 *  Matches the flags used by playwright-mcp for stability. */
const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--enable-unsafe-swiftshader',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=AutomationControlled,MediaRouter,GlobalMediaControls,Translate',
  '--disable-background-networking',
  '--disable-extensions',
  '--metrics-recording-only',
];

export interface CookieTarget {
  platform: string;
  loginUrl: string;
  /** Cookie names to extract */
  cookieNames: string[];
  /** URL or path that indicates successful login */
  successUrlPattern?: RegExp;
  /** URL pattern that indicates we are still on the login/auth page */
  loginUrlPattern?: RegExp;
}

export const COOKIE_TARGETS: Record<string, CookieTarget> = {
  x: {
    platform: 'x',
    loginUrl: 'https://x.com/login',
    cookieNames: ['auth_token', 'ct0'],
    successUrlPattern: /(twitter|x)\.com\/(home|[a-z_]+\/status)/,
    loginUrlPattern: /(twitter|x)\.com\/(login|i\/flow|oauth)/,
  },
  instagram: {
    platform: 'instagram',
    loginUrl: 'https://www.instagram.com/accounts/login/',
    cookieNames: ['sessionid', 'csrftoken'],
    successUrlPattern: /instagram\.com\/(?!accounts)/,
    loginUrlPattern: /instagram\.com\/accounts\/login/,
  },
  linkedin: {
    platform: 'linkedin',
    loginUrl: 'https://www.linkedin.com/login',
    cookieNames: ['li_at', 'JSESSIONID'],
    successUrlPattern: /linkedin\.com\/feed/,
    loginUrlPattern: /linkedin\.com\/(login|checkpoint|authwall)/,
  },
  reddit: {
    platform: 'reddit',
    loginUrl: 'https://www.reddit.com/login',
    cookieNames: ['reddit_session', 'csrf_token', 'loid'],
    successUrlPattern: /reddit\.com\/(home|user\/|r\/|saved)/,
    loginUrlPattern: /reddit\.com\/login/,
  },
};

/**
 * Resolve the CDP WebSocket endpoint for the running MCP browser.
 *
 * Resolution order:
 *   1. PLAYWRIGHT_MCP_CDP_ENDPOINT env var (set explicitly by the runtime)
 *   2. Derived from STEEL_LOCAL_URLS (first URL → ws://.../browser/1/)
 *   3. undefined — CDP path not available, fall back to profile mode
 */
function resolveCdpEndpoint(): string | undefined {
  const explicit = process.env['PLAYWRIGHT_MCP_CDP_ENDPOINT'];
  if (explicit) return explicit;

  const steelUrls = process.env['STEEL_LOCAL_URLS'];
  if (steelUrls) {
    const first = steelUrls.split(',')[0]?.trim();
    if (first) {
      // http://browser-1:3000 → ws://browser-1:3000/browser/1/
      return first.replace(/^http/, 'ws') + '/browser/1/';
    }
  }

  return undefined;
}

/**
 * Extract cookies from the currently running Chrome via CDP.
 * Returns extracted cookie values, or undefined if the platform's cookies
 * are not present (e.g. user is not logged in).
 */
async function extractViaCdp(
  target: CookieTarget,
  accountName: string,
  dataDir: string | undefined,
  cdpEndpoint: string,
): Promise<boolean> {
  const browser = await chromium.connectOverCDP(cdpEndpoint, { timeout: 10_000 });
  try {
    const contexts = browser.contexts();
    if (contexts.length === 0) return false;

    // Search all contexts for the target cookies
    for (const ctx of contexts) {
      const cookies = await ctx.cookies();
      const hasCookies = target.cookieNames.some(name =>
        cookies.some(c => c.name === name && c.value)
      );
      if (hasCookies) {
        await savePlatformCookies(target, accountName, dataDir, cookies);
        return true;
      }
    }
    return false;
  } finally {
    // connectOverCDP — close without shutting down the remote browser
    await browser.close();
  }
}

/**
 * Thrown when the browser is not logged in and headed mode is needed.
 * Callers that run autonomously can catch this and trigger a browser takeover.
 */
export class ExtractCookieLoginRequired extends Error {
  constructor(public readonly platformKey: string) {
    super(
      `Not logged in to ${platformKey}. ` +
      'Run "crossmind extract-cookie ' + platformKey + ' --headed" to open a browser window and log in.'
    );
    this.name = 'ExtractCookieLoginRequired';
  }
}

/**
 * Resolve the browser profile directory to use.
 *
 * Resolution order (first match wins):
 *   1. Explicit argument passed by the caller (e.g. from --profile-dir CLI flag)
 *   2. CROSSMIND_BROWSER_PROFILE_DIR env var (CLI-specific; avoids clash with
 *      BROWSER_USER_DATA_DIR which is injected by the CrossMind MCP runtime)
 *   3. ~/.config/crossmind/browser-profiles/<platform>/ — local fallback (auto-created)
 */
function resolveProfileDir(platformKey: string, explicit?: string): string {
  if (explicit) {
    fs.mkdirSync(explicit, { recursive: true });
    return explicit;
  }
  if (process.env['CROSSMIND_BROWSER_PROFILE_DIR']) {
    const dir = process.env['CROSSMIND_BROWSER_PROFILE_DIR'];
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  const dir = path.join(os.homedir(), '.config', 'crossmind', 'browser-profiles', platformKey);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Check if profile is locked by another *live* browser instance.
 *
 * A SingletonLock left behind by a crashed/killed Chrome (SIGKILL, container
 * restart, etc.) is indistinguishable from a genuine lock by existence alone.
 * This inspects the PID encoded in the lock symlink and treats a dead PID as
 * stale: it auto-cleans the leftover Singleton* files and reports the profile
 * as free. Returns true only when the owning process is confirmed alive.
 */
export function isProfileLocked(profileDir: string): boolean {
  const lockFile = path.join(profileDir, 'SingletonLock');
  if (!fs.existsSync(lockFile)) return false;

  const pid = readLockOwnerPid(lockFile);
  // Can't determine the owning PID (unexpected lock format) — be
  // conservative and treat it as locked rather than risk clobbering a live
  // browser's profile.
  if (pid === undefined) return true;
  if (isPidAlive(pid)) return true;

  // Owning process is dead — the lock is stale. Clean it up and report free.
  cleanStaleLockFiles(profileDir);
  return false;
}

/** Chromium's SingletonLock is a symlink whose target ends in "-<pid>". */
function readLockOwnerPid(lockFile: string): number | undefined {
  try {
    const target = fs.readlinkSync(lockFile);
    const match = target.match(/-(\d+)$/);
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

/** Signal-probe a PID without actually sending a signal (kill(pid, 0)). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process (dead). Anything else (e.g. EPERM = alive but
    // owned by another user) is treated conservatively as still alive.
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Best-effort removal of Chromium's Singleton* lock files for a stale profile. */
function cleanStaleLockFiles(profileDir: string): void {
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try {
      fs.rmSync(path.join(profileDir, name), { force: true });
    } catch {
      // Best-effort — a failed removal just falls back to the existing
      // "locked by another browser instance" error on the next attempt.
    }
  }
}

/** Chrome's cookie DB lives at Default/Cookies, or Default/Network/Cookies on newer versions. */
function findCookiesFile(profileDir: string): string | undefined {
  const candidates = [
    path.join(profileDir, 'Default', 'Network', 'Cookies'),
    path.join(profileDir, 'Default', 'Cookies'),
  ];
  return candidates.find((p) => fs.existsSync(p));
}

/**
 * Check if profile has a cookies database.
 * Returns true if cookies file exists.
 */
function hasCookiesDatabase(profileDir: string): boolean {
  return findCookiesFile(profileDir) !== undefined;
}

/**
 * Snapshot just the cookies database of a profile that's locked by another
 * live browser process into an isolated, unlocked directory, so extraction
 * can proceed against the copy without touching (or needing to close) the
 * live browser. Caller is responsible for removing the returned directory
 * once done.
 */
function snapshotProfileCookies(platformKey: string, profileDir: string): string {
  const src = findCookiesFile(profileDir);
  if (!src) {
    throw new Error(
      `Profile is locked by another browser instance and has no cookies database to snapshot.\n` +
      `  Profile: ${profileDir}\n` +
      `  Close the browser using this profile and try again.`
    );
  }
  const snapshotDir = path.join(
    os.tmpdir(), 'crossmind-cookie-snapshot', `${platformKey}-${Date.now()}-${process.pid}`
  );
  const destDir = path.join(snapshotDir, 'Default');
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, path.join(destDir, 'Cookies'));
  return snapshotDir;
}

/**
 * Extract and save session cookies for a platform.
 *
 * @param platformKey  - Platform key (x, instagram, linkedin, reddit)
 * @param accountName  - Account name to save under
 * @param dataDir      - Optional credential store directory
 * @param headed       - When true, open a visible browser for manual login.
 *                       When false (default), fail fast if not logged in.
 * @param profileDir   - Explicit browser profile directory. Falls back to
 *                       BROWSER_USER_DATA_DIR env var, then a default local path.
 *                       If this directory is locked by another live browser
 *                       process (headless mode only), its cookies database is
 *                       automatically snapshotted into a temporary unlocked
 *                       copy and extraction proceeds from there.
 */
export async function extractAndSaveCookies(
  platformKey: string,
  accountName: string,
  dataDir?: string,
  headed = false,
  profileDir?: string,
): Promise<void> {
  const target = COOKIE_TARGETS[platformKey];
  if (!target) {
    throw new Error(
      `No cookie target defined for platform "${platformKey}". ` +
      `Available: ${Object.keys(COOKIE_TARGETS).join(', ')}`
    );
  }

  // ── CDP path: preferred in CrossMind agent runtime ───────────────────────
  // When a running Chrome is accessible via CDP (PLAYWRIGHT_MCP_CDP_ENDPOINT
  // or STEEL_LOCAL_URLS), read cookies directly from its in-memory state.
  // This avoids profile lock conflicts and SQLite encryption entirely — and
  // is tried regardless of --headed, because the profile directory a headed
  // launch would open is frequently the very same profile the CDP-connected
  // browser already has locked (e.g. after a request_browser_takeover login),
  // which is what produces the "profile is locked" failure this path exists
  // to avoid.
  const cdpEndpoint = resolveCdpEndpoint();
  if (cdpEndpoint) {
    try {
      const found = await extractViaCdp(target, accountName, dataDir, cdpEndpoint);
      if (found) return;
      // Cookies not present in the running browser yet. In headless mode
      // there is no other path to a fresh login, so this is fatal, same as
      // before. In headed mode, fall through to open a visible browser for
      // login instead of throwing straight back the same "try --headed"
      // error the caller already satisfied.
      if (!headed) throw new ExtractCookieLoginRequired(platformKey);
    } catch (err) {
      if (err instanceof ExtractCookieLoginRequired) {
        if (!headed) throw err;
        // headed=true: fall through to the profile-based headed flow below.
      }
      // CDP connection failed (e.g. not in CrossMind runtime) — fall through
      // to the profile-based path below.
    }
  }


  // ── Profile path: local Chrome with persistent profile ───────────────────
  const profile = resolveProfileDir(platformKey, profileDir);
  const runner = headed ? extractHeaded : extractHeadless;
  const lockedUpfront = isProfileLocked(profile);

  if (!headed && !lockedUpfront && !hasCookiesDatabase(profile)) {
    throw new Error(
      `No cookies database found in profile.\n` +
      `  Profile: ${profile}\n` +
      `  Please log in to ${platformKey} first using a browser with this profile.`
    );
  }

  // Two ways a lock conflict can surface:
  //  1. Our own pre-flight PID probe (isProfileLocked) catches it upfront —
  //     skip straight to the snapshot fallback, no point launching a guaranteed
  //     failure.
  //  2. Chrome's own process-singleton check only catches it at launch time —
  //     this is the only reliable signal when the lock-owning process lives in
  //     a different PID namespace than this CLI (e.g. an MCP-managed browser
  //     container), where kill(pid, 0) can't see it and falsely reports "not
  //     locked" upfront.
  // Either way, don't fail: snapshot just the cookies database into an
  // isolated, unlocked directory and extract from that copy instead — the
  // live browser's own profile is never touched and never needs closing.
  if (!lockedUpfront) {
    try {
      await runner(target, accountName, dataDir, profile);
      return;
    } catch (err) {
      if (!isProfileLockLaunchError(err)) throw err;
    }
  }

  const snapshot = snapshotProfileCookies(platformKey, profile);
  try {
    await runner(target, accountName, dataDir, snapshot);
  } finally {
    fs.rmSync(snapshot, { recursive: true, force: true });
  }
}

/**
 * Detects Chrome's own "profile already in use" launch failure text. Playwright
 * embeds the launched browser's captured stderr into the thrown error message,
 * so Chrome's process-singleton log line is reliably present here even though
 * the top-level Playwright error text itself is a generic "target closed".
 */
function isProfileLockLaunchError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /profile appears to be in use by another/i.test(msg)
    || /ProcessSingleton/i.test(msg);
}

// ── Headless extraction (reuses existing session) ──────────────────────────

async function extractHeadless(
  target: CookieTarget,
  accountName: string,
  dataDir: string | undefined,
  profile: string,
): Promise<void> {
  // Reddit requires headed mode (headless is blocked by bot detection)
  if (target.platform === 'reddit') {
    throw new ExtractCookieLoginRequired(target.platform);
  }

  const executablePath = findChrome();
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath,
    args: CHROME_ARGS,
  });

  try {
    const page = await context.newPage();
    await page.goto(target.loginUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });

    // Wait briefly for any redirects
    await page.waitForTimeout(3000);

    const currentUrl = page.url();

    // If we end up on a login page, the session has expired
    if (target.loginUrlPattern && target.loginUrlPattern.test(currentUrl)) {
      throw new ExtractCookieLoginRequired(target.platform);
    }

    // If no successUrlPattern is defined, just try to grab cookies anyway
    if (target.successUrlPattern && !target.successUrlPattern.test(currentUrl)) {
      // Could be an intermediate page — wait a bit more
      await page.waitForTimeout(3000);
      const urlAfterWait = page.url();
      if (target.loginUrlPattern && target.loginUrlPattern.test(urlAfterWait)) {
        throw new ExtractCookieLoginRequired(target.platform);
      }
    }

    const cookies = await context.cookies();
    await savePlatformCookies(target, accountName, dataDir, cookies, page);
  } finally {
    await context.close();
  }
}

// ── Headed extraction (manual login flow) ──────────────────────────────────

async function extractHeaded(
  target: CookieTarget,
  accountName: string,
  dataDir: string | undefined,
  profile: string,
): Promise<void> {
  console.log(`Launching browser for ${target.platform} login...`);
  console.log(`Profile directory: ${profile}`);

  const executablePath = findChrome();
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    executablePath,
    args: CHROME_ARGS,
  });

  const page = await context.newPage();
  await page.goto(target.loginUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await page.waitForTimeout(3000);

  // Check if already logged in by checking for session cookies
  const existingCookies = await context.cookies();
  const hasSession = target.cookieNames.some(name =>
    existingCookies.some(c => c.name === name && c.value)
  );

  if (hasSession) {
    console.log(`Already logged in to ${target.platform}. Extracting session...`);
  } else {
    console.log(`Please log in when the browser opens. The session will be saved automatically.`);

    // Wait for successful login (check for session cookies)
    await new Promise<void>((resolve, reject) => {
      const interval = setInterval(async () => {
        try {
          const cookies = await context.cookies();
          const hasCookie = target.cookieNames.some(name =>
            cookies.some(c => c.name === name && c.value)
          );
          if (hasCookie) {
            clearInterval(interval);
            resolve();
          }
        } catch {
          clearInterval(interval);
          reject(new Error('Browser closed unexpectedly'));
        }
      }, 2000);

      // Resolve after 5 minutes regardless
      setTimeout(() => {
        clearInterval(interval);
        resolve();
      }, 300_000);
    });
  }

  const cookies = await context.cookies();
  await savePlatformCookies(target, accountName, dataDir, cookies, page);
  await context.close();
}

// ── Save cookies by platform ───────────────────────────────────────────────

async function savePlatformCookies(
  target: CookieTarget,
  accountName: string,
  dataDir: string | undefined,
  cookies: Array<{ name: string; value: string }>,
  page?: import('playwright').Page,
): Promise<void> {
  const extracted: Record<string, string> = {};
  for (const name of target.cookieNames) {
    const cookie = cookies.find((c) => c.name === name);
    if (cookie) extracted[name] = cookie.value;
  }

  if (Object.keys(extracted).length === 0) {
    throw new Error(
      `No session cookies found for ${target.platform}. Please ensure you completed login.`
    );
  }

  const platformKey = target.platform;

  if (platformKey === 'x') {
    await saveCredential({
      platform: 'x',
      name: accountName,
      authToken: extracted['auth_token'],
      ct0: extracted['ct0'],
    }, dataDir);
  } else if (platformKey === 'instagram') {
    await saveCredential({
      platform: 'instagram',
      name: accountName,
      cookie: `sessionid=${extracted['sessionid']}; csrftoken=${extracted['csrftoken']}`,
    }, dataDir);
  } else if (platformKey === 'linkedin') {
    await saveCredential({
      platform: 'linkedin',
      name: accountName,
      cookie: `li_at=${extracted['li_at']}; JSESSIONID=${extracted['JSESSIONID']}`,
      ct0: extracted['JSESSIONID'],
    }, dataDir);
  } else if (platformKey === 'reddit') {
    const session = extracted['reddit_session'];
    if (!session) throw new Error('No Reddit session cookie found after login.');

    // Get modhash via API (requires headed browser for Reddit)
    let modhash: string | undefined;
    if (page) {
      try {
        const meData = await page.evaluate(async () => {
          const resp = await fetch('https://www.reddit.com/api/me.json', {credentials: 'include'});
          const data = await resp.json() as { data?: { name?: string; modhash?: string } };
          return { name: data?.data?.name, modhash: data?.data?.modhash };
        });
        modhash = meData.modhash;
        if (meData.name) console.log(`Reddit user: ${meData.name}`);
      } catch (e) {
        console.warn('Failed to fetch modhash (write operations may fail):', e);
      }
    }

    await saveCredential({
      platform: 'reddit',
      name: accountName,
      redditSession: session,
      redditModhash: modhash,
      redditCsrftoken: extracted['csrf_token'],
      redditLoid: extracted['loid'],
    }, dataDir);
  }

  const savedKeys = Object.keys(extracted).join(', ');
  console.log(`Cookies saved for ${platformKey} account "${accountName}": ${savedKeys}`);
}
