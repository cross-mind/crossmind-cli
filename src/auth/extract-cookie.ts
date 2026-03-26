/**
 * Cookie extraction helper using Playwright.
 * Launches a browser, navigates to a login page,
 * and extracts session cookies after the user logs in.
 */

import { chromium } from 'playwright';
import { saveCredential } from './store.js';

export interface CookieTarget {
  platform: string;
  loginUrl: string;
  /** Cookie names to extract */
  cookieNames: string[];
  /** Detection: URL or path that indicates successful login */
  successUrlPattern?: RegExp;
}

export const COOKIE_TARGETS: Record<string, CookieTarget> = {
  x: {
    platform: 'x',
    loginUrl: 'https://twitter.com/login',
    cookieNames: ['auth_token', 'ct0'],
    successUrlPattern: /twitter\.com\/(home|[a-z_]+\/status)/,
  },
  instagram: {
    platform: 'instagram',
    loginUrl: 'https://www.instagram.com/accounts/login/',
    cookieNames: ['sessionid', 'csrftoken'],
    successUrlPattern: /instagram\.com\/(?!accounts)/,
  },
  linkedin: {
    platform: 'linkedin',
    loginUrl: 'https://www.linkedin.com/login',
    cookieNames: ['li_at', 'JSESSIONID'],
    successUrlPattern: /linkedin\.com\/feed/,
  },
  reddit: {
    platform: 'reddit',
    loginUrl: 'https://www.reddit.com/login',
    // reddit_session (older accounts) or token_v2 (newer OAuth-based sessions)
    cookieNames: ['reddit_session', 'token_v2'],
    successUrlPattern: /reddit\.com\/(home|user\/|r\/|saved)/,
  },
};

/**
 * Launch Playwright browser, let user log in manually,
 * extract and save the session cookies.
 */
export async function extractAndSaveCookies(
  platformKey: string,
  accountName: string,
  dataDir?: string
): Promise<void> {
  const target = COOKIE_TARGETS[platformKey];
  if (!target) {
    throw new Error(`No cookie target defined for platform "${platformKey}". Available: ${Object.keys(COOKIE_TARGETS).join(', ')}`);
  }

  console.log(`Launching browser for ${platformKey} login...`);
  console.log(`Please log in when the browser opens. The session will be saved automatically.`);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(target.loginUrl);

  // Wait for the user to log in
  await new Promise<void>((resolve, reject) => {
    const interval = setInterval(async () => {
      try {
        const url = page.url();
        if (target.successUrlPattern && target.successUrlPattern.test(url)) {
          clearInterval(interval);
          resolve();
        }
      } catch {
        clearInterval(interval);
        reject(new Error('Browser closed unexpectedly'));
      }
    }, 2000);

    // Also resolve after 5 minutes if pattern never matches
    setTimeout(() => {
      clearInterval(interval);
      resolve();
    }, 300_000);
  });

  const cookies = await context.cookies();
  const extracted: Record<string, string> = {};

  for (const name of target.cookieNames) {
    const cookie = cookies.find((c) => c.name === name);
    if (cookie) {
      extracted[name] = cookie.value;
    }
  }

  await browser.close();

  if (Object.keys(extracted).length === 0) {
    throw new Error(`No session cookies found for ${platformKey}. Please ensure you completed login.`);
  }

  // Save according to platform
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
      ct0: extracted['JSESSIONID'], // Used as CSRF token
    }, dataDir);
  } else if (platformKey === 'reddit') {
    // Prefer reddit_session; fall back to token_v2 (newer OAuth-based sessions)
    const session = extracted['reddit_session'] ?? extracted['token_v2'];
    if (!session) throw new Error('No Reddit session cookie found after login.');
    await saveCredential({
      platform: 'reddit',
      name: accountName,
      redditSession: session,
    }, dataDir);
  }

  const savedKeys = Object.keys(extracted).join(', ');
  console.log(`Cookies saved for ${platformKey} account "${accountName}": ${savedKeys}`);
}
