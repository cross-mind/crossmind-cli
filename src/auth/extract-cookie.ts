/**
 * Cookie extraction helper using Playwright.
 *
 * Two modes:
 *   1. Headless (default) — reuses an existing persistent browser profile.
 *      Extracts cookies silently if the session is still valid.
 *      Fails fast (throws ExtractCookieLoginRequired) when not logged in.
 *   2. Headed — opens a visible browser window for first-time / re-login.
 *      Waits for the user to complete login, then saves cookies.
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
 *   2. BROWSER_USER_DATA_DIR env var
 *   3. ~/.config/crossmind/browser-profiles/<platform>/ — local fallback (auto-created)
 */
function resolveProfileDir(platformKey: string, explicit?: string): string {
  if (explicit) {
    fs.mkdirSync(explicit, { recursive: true });
    return explicit;
  }
  if (process.env['BROWSER_USER_DATA_DIR']) {
    const dir = process.env['BROWSER_USER_DATA_DIR'];
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  const dir = path.join(os.homedir(), '.config', 'crossmind', 'browser-profiles', platformKey);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Check if profile is locked by another browser instance.
 * Returns true if locked (in use), false if available.
 */
function isProfileLocked(profileDir: string): boolean {
  const lockFile = path.join(profileDir, 'SingletonLock');
  return fs.existsSync(lockFile);
}

/**
 * Check if profile has a Default/Cookies database.
 * Returns true if cookies file exists.
 */
function hasCookiesDatabase(profileDir: string): boolean {
  const cookiesFile = path.join(profileDir, 'Default', 'Cookies');
  return fs.existsSync(cookiesFile);
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

  const profile = resolveProfileDir(platformKey, profileDir);

  // Pre-flight checks
  if (isProfileLocked(profile)) {
    throw new Error(
      `Profile is locked by another browser instance.\n` +
      `  Profile: ${profile}\n` +
      `  Close the browser using this profile and try again.`
    );
  }

  if (!hasCookiesDatabase(profile)) {
    throw new Error(
      `No cookies database found in profile.\n` +
      `  Profile: ${profile}\n` +
      `  Please log in to ${platformKey} first using a browser with this profile.`
    );
  }

  if (headed) {
    await extractHeaded(target, accountName, dataDir, profile);
  } else {
    await extractHeadless(target, accountName, dataDir, profile);
  }
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
