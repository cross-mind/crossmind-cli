/**
 * `crossmind auth` command group.
 * Subcommands: login, logout, status
 */

import { Command } from 'commander';
import { loginX, saveCookieAuth, saveBearerToken, saveAccessToken, loadXCredentials } from '../auth/x.js';
import { loginReddit, saveRedditCookies, loadRedditCredentials } from '../auth/reddit.js';
import { loginBluesky } from '../auth/bluesky.js';
import { saveGitHubToken } from '../auth/github.js';
import { saveCredential, listAccounts, removeCredential, getDefaultAccount, loadCredential, resolveAccount } from '../auth/store.js';
import { isCookieClientAvailable } from '../http/x-bridge.js';
import { isRedditClientAvailable } from '../http/reddit-bridge.js';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

async function promptSecret(label: string): Promise<string> {
  // Node readline/promises API — same as prompt but with a "secret" label
  const rl = readline.createInterface({ input, output });
  const answer = await rl.question(`${label}: `);
  rl.close();
  return answer.trim();
}

export function registerAuthCommands(program: Command): void {
  const auth = program
    .command('auth')
    .description('Authenticate with social platforms');

  // auth login <platform> [account]
  auth
    .command('login <platform> [account]')
    .description('Log in to a platform and save credentials')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--token <token>', 'Provide token/API key directly (github, generic)')
    .option('--cookie <cookie>', 'Provide raw cookie string directly')
    .option('--auth-token <authToken>', 'X: auth_token cookie value. Use with --ct0. Enables: home feed, bookmarks, notifications.')
    .option('--ct0 <ct0>', 'X: CSRF token (required with --auth-token)')
    .option('--kdt <kdt>', 'X: kdt cookie (optional, improves follow/unfollow cookie coverage)')
    .option('--att <att>', 'X: att cookie (optional, improves follow/unfollow cookie coverage)')
    .option('--access-token <accessToken>', 'X/LinkedIn: OAuth access token. X enables: tweet, reply, DM, like, follow, analytics, dm-list.')
    .option('--bearer-token <bearerToken>', 'X: developer bearer token. Read-only, search only. No user context.')
    .option('--handle <handle>', 'Bluesky handle (e.g. user.bsky.social)')
    .option('--app-password <password>', 'Bluesky app password')
    .option('--session-cookie <session>', 'Reddit: reddit_session cookie. Enables: home, saved.')
    .option('--modhash <modhash>', 'Reddit: modhash for write operations (optional)')
    .action(async (
      platform: string,
      account: string | undefined,
      opts: {
        dataDir?: string;
        token?: string;
        cookie?: string;
        authToken?: string;
        ct0?: string;
        kdt?: string;
        att?: string;
        accessToken?: string;
        bearerToken?: string;
        handle?: string;
        appPassword?: string;
        sessionCookie?: string;
        modhash?: string;
      }
    ) => {
      const accountName = account ?? 'default';

      try {
        switch (platform) {
          case 'x':
          case 'twitter': {
            if (opts.bearerToken) {
              // App-only bearer token — read-only, no account login needed
              await saveBearerToken(accountName, opts.bearerToken, opts.dataDir);
            } else if (opts.accessToken) {
              // Direct OAuth access token injection — skips browser flow
              await saveAccessToken(accountName, opts.accessToken, opts.dataDir);
              console.log(`X OAuth token saved as "${accountName}".`);
            } else if (opts.authToken && opts.ct0) {
              // Direct cookie auth
              await saveCookieAuth(accountName, opts.authToken, opts.ct0, opts.dataDir, opts.kdt, opts.att);
              console.log(`X cookies saved as "${accountName}".`);
            } else {
              // OAuth 2.0 PKCE flow — requires X_CLIENT_ID
              await loginX(accountName, opts.dataDir);
            }
            break;
          }

          case 'reddit': {
            if (opts.sessionCookie) {
              // Direct cookie auth (extracted from browser)
              await saveRedditCookies(accountName, opts.sessionCookie, opts.modhash, opts.dataDir);
            } else {
              // OAuth 2.0 PKCE flow
              await loginReddit(accountName, opts.dataDir);
            }
            break;
          }

          case 'bsky':
          case 'bluesky': {
            const handle = opts.handle ?? await prompt('Bluesky handle (e.g. user.bsky.social): ');
            const appPassword = opts.appPassword ?? await promptSecret('App password');
            await loginBluesky(accountName, handle, appPassword, opts.dataDir);
            break;
          }

          case 'gh':
          case 'github': {
            const token = opts.token ?? await promptSecret('GitHub personal access token');
            await saveGitHubToken(accountName, token, opts.dataDir);
            break;
          }

          case 'instagram': {
            console.log(`For instagram, use: crossmind extract-cookie instagram`);
            process.exit(1);
            break;
          }

          case 'linkedin': {
            if (opts.accessToken) {
              // Store OAuth access token for li post / future OAuth operations
              await saveCredential({
                platform: 'linkedin',
                name: accountName,
                accessToken: opts.accessToken,
              }, opts.dataDir);
              console.log(`LinkedIn OAuth token saved as "${accountName}".`);
            } else {
              // Cookie extraction for read operations (profile, feed)
              console.log(`For LinkedIn cookie auth (profile/feed): crossmind extract-cookie linkedin`);
              console.log(`For LinkedIn posting: crossmind auth login linkedin --access-token <token>`);
              process.exit(1);
            }
            break;
          }

          default: {
            // Generic token-based platform
            if (opts.token) {
              await saveCredential({
                platform,
                name: accountName,
                apiToken: opts.token,
              }, opts.dataDir);
              console.log(`Token saved for ${platform} as "${accountName}".`);
            } else if (opts.cookie) {
              await saveCredential({
                platform,
                name: accountName,
                cookie: opts.cookie,
              }, opts.dataDir);
              console.log(`Cookie saved for ${platform} as "${accountName}".`);
            } else {
              console.error(`Unknown platform "${platform}". Supported: x, reddit, bsky, gh, instagram, linkedin`);
              process.exit(1);
            }
          }
        }
      } catch (err) {
        console.error(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    })
    .addHelpText('after', `

How to get credentials:

  X (Twitter):
    crossmind extract-cookie x
    (Headless if session exists, --headed for first-time login)

    Or copy manually from DevTools:
      Browser → DevTools → Application → Cookies → x.com

    Or provide OAuth token directly:
      crossmind auth login x --access-token <token>

  Reddit:
    crossmind extract-cookie reddit

    Or copy manually from DevTools:
      Browser → DevTools → Application → Cookies → reddit.com

Examples:
  crossmind extract-cookie x
  crossmind extract-cookie x --headed
  crossmind auth login x --auth-token <val> --ct0 <val>
  crossmind auth login x --access-token <val>

  crossmind extract-cookie reddit
  crossmind auth login reddit --session-cookie <val>
`);

  // auth logout <platform> [account]
  auth
    .command('logout <platform> [account]')
    .description('Remove stored credentials for a platform account')
    .option('--data-dir <dir>', 'Data directory override')
    .action(async (platform: string, account: string | undefined, opts: { dataDir?: string }) => {
      const accountName = account ?? (await getDefaultAccount(platform, opts.dataDir)) ?? 'default';
      await removeCredential(platform, accountName, opts.dataDir);
      console.log(`Logged out ${platform}/${accountName}.`);
    });

  // auth status
  auth
    .command('status')
    .description('Show auth status and available operations for each platform')
    .option('--data-dir <dir>', 'Data directory override')
    .action(async (opts: { dataDir?: string }) => {
      const tick  = '✓';
      const cross = '✗';
      const warn  = '⚠';
      const sep   = '─'.repeat(60);

      function credLine(label: string, ok: boolean, detail: string): string {
        const mark = ok ? tick : cross;
        const pad = ' '.repeat(Math.max(0, 28 - label.length));
        return `  ${mark}  ${label}${pad}${detail}`;
      }

      function opList(ops: string[]): string[] {
        // Wrap at ~70 chars
        const lines: string[] = [];
        let cur = '     ';
        for (const op of ops) {
          const add = (cur === '     ' ? '' : ', ') + op;
          if (cur.length + add.length > 70) {
            lines.push(cur);
            cur = '     ' + op;
          } else {
            cur += add;
          }
        }
        if (cur.trim()) lines.push(cur);
        return lines;
      }

      // ── X (Twitter) ──────────────────────────────────────────────────────

      const xAccountName = await resolveAccount('x', undefined, opts.dataDir);
      const xCred = await loadCredential('x', xAccountName, opts.dataDir);

      const xCookieStored = !!(xCred?.authToken && xCred?.ct0);
      const xCookieEnv    = !!(process.env['X_AUTH_TOKEN'] && process.env['X_CT0']);
      const hasCookie     = xCookieStored || xCookieEnv;
      const cookieSrc     = xCookieStored ? 'stored' : xCookieEnv ? 'env var' : '';

      const xOAuthStored = !!xCred?.accessToken;
      const xOAuthEnv    = !!process.env['X_ACCESS_TOKEN'];
      const hasOAuth     = xOAuthStored || xOAuthEnv;
      const oauthSrc     = xOAuthStored ? 'stored' : xOAuthEnv ? 'env var' : '';

      const xBridgeOk = hasCookie && await isCookieClientAvailable();

      console.log(`\nX (Twitter)  ·  account: ${xAccountName}`);
      console.log(credLine('Cookie (auth_token + ct0)', hasCookie,
        hasCookie ? `${cookieSrc}` : 'not configured'));
      console.log(credLine('OAuth (access_token)', hasOAuth,
        hasOAuth ? `${oauthSrc}` : 'not configured'));
      if (hasCookie) {
        console.log(credLine('Bridge (Python + curl_cffi)', xBridgeOk,
          xBridgeOk ? 'available' : 'not found — install: uv pip install curl_cffi'));
      }

      if (!hasCookie && !hasOAuth) {
        console.log(`\n  ${cross}  No credentials. Run: crossmind auth login x`);
      } else {
        // Compute available ops
        const canRead: string[] = [];
        const canWrite: string[] = [];
        const limited: string[] = [];

        // Read ops — all require at least one auth method for user context
        canRead.push('search', 'profile', 'timeline', 'thread', 'followers', 'following', 'likes', 'list');
        if (hasCookie || hasOAuth) canRead.push('home');
        if (hasCookie && xBridgeOk) canRead.push('bookmarks', 'notifications');
        if (hasOAuth) canRead.push('dm-list', 'analytics');

        // Write ops
        if ((hasCookie && xBridgeOk) || hasOAuth) {
          canWrite.push('tweet', 'reply', 'like', 'unlike', 'retweet', 'unretweet', 'quote', 'delete');
        }
        if (hasCookie && xBridgeOk) canWrite.push('bookmark', 'unbookmark');
        if (hasOAuth) {
          canWrite.push('follow', 'unfollow', 'dm');
        } else if (hasCookie && xBridgeOk) {
          // follow/unfollow attempt cookie first but need OAuth for success
          limited.push('follow/unfollow (requires OAuth or full browser cookie — not available with auth_token + ct0 only)');
        }

        console.log(`\n  Read   ${opList(canRead).join('\n         ')}`);
        if (canWrite.length > 0) {
          console.log(`  Write  ${opList(canWrite).join('\n         ')}`);
        }
        if (limited.length > 0) {
          for (const l of limited) {
            console.log(`  ${warn}  ${l}`);
          }
        }

        // Recommendations
        const recs: string[] = [];
        if (hasCookie && !xBridgeOk) {
          recs.push('Install Python + curl_cffi to unlock cookie-auth ops: uv pip install curl_cffi');
        }
        if (hasOAuth && !hasCookie) {
          recs.push('Extract session cookies to unlock bookmarks, notifications, and remove API tier limits:');
          recs.push('  crossmind extract-cookie x');
        }
        if (!hasOAuth && hasCookie) {
          recs.push('No OAuth — follow/unfollow, dm, dm-list, analytics require OAuth access token');
        }
        if (recs.length > 0) {
          console.log('');
          for (const r of recs) console.log(`  ${warn}  ${r}`);
        }
      }

      // ── LinkedIn ──────────────────────────────────────────────────────────

      console.log(`\n${sep}`);

      const liAccountName = await resolveAccount('linkedin', undefined, opts.dataDir);
      const liCred = await loadCredential('linkedin', liAccountName, opts.dataDir);

      const liCookieStored = !!liCred?.cookie;
      const liCookieEnv    = !!process.env['LI_COOKIE'];
      const hasLiCookie    = liCookieStored || liCookieEnv;
      const liCookieSrc    = liCookieStored ? 'stored' : liCookieEnv ? 'env var' : '';

      const liOAuthStored = !!liCred?.accessToken;
      const liOAuthEnv    = !!process.env['LINKEDIN_ACCESS_TOKEN'];
      const hasLiOAuth    = liOAuthStored || liOAuthEnv;
      const liOAuthSrc    = liOAuthStored ? 'stored' : liOAuthEnv ? 'env var' : '';

      console.log(`\nLinkedIn  ·  account: ${liAccountName}`);
      console.log(credLine('Cookie (session)', hasLiCookie,
        hasLiCookie ? `${liCookieSrc}` : 'not configured'));
      console.log(credLine('OAuth (access_token)', hasLiOAuth,
        hasLiOAuth ? `${liOAuthSrc}` : 'not configured'));

      if (!hasLiCookie && !hasLiOAuth) {
        console.log(`\n  ${cross}  No credentials. Run: crossmind extract-cookie linkedin`);
      } else {
        const liRead: string[] = [];
        const liWrite: string[] = [];

        if (hasLiCookie) {
          liRead.push('profile', 'feed');
        }
        if (hasLiOAuth) {
          liWrite.push('post', 'delete');
        }

        if (liRead.length > 0) {
          console.log(`\n  Read   ${opList(liRead).join('\n         ')}`);
        }
        if (liWrite.length > 0) {
          console.log(`  Write  ${opList(liWrite).join('\n         ')}`);
        }

        const liRecs: string[] = [];
        if (hasLiOAuth && !hasLiCookie) {
          liRecs.push('Extract session cookies to unlock profile/feed browsing:');
          liRecs.push('  crossmind extract-cookie linkedin');
        }
        if (hasLiCookie && !hasLiOAuth) {
          liRecs.push('Add OAuth token to enable posting:');
          liRecs.push('  crossmind auth login linkedin --access-token <token>');
        }
        if (liRecs.length > 0) {
          console.log('');
          for (const r of liRecs) console.log(`  ${warn}  ${r}`);
        }
      }

      // ── Reddit ────────────────────────────────────────────────────────────

      console.log(`\n${sep}`);

      const redditAccountName = await resolveAccount('reddit', undefined, opts.dataDir);
      let redditCreds: Awaited<ReturnType<typeof loadRedditCredentials>> = null;
      try { redditCreds = await loadRedditCredentials(undefined, opts.dataDir); } catch { /* no creds */ }

      const hasRedditCookie = redditCreds?.type === 'cookie';
      const hasRedditOAuth  = redditCreds?.type === 'oauth';
      const redditBridgeOk  = hasRedditCookie && await isRedditClientAvailable();

      console.log(`\nReddit  ·  account: ${redditAccountName}`);
      console.log(credLine('Cookie (reddit_session)', hasRedditCookie,
        hasRedditCookie ? 'stored' : 'not configured'));
      console.log(credLine('OAuth (access_token)', hasRedditOAuth,
        hasRedditOAuth ? 'stored' : 'not configured'));
      if (hasRedditCookie) {
        console.log(credLine('Bridge (Python + curl_cffi)', redditBridgeOk,
          redditBridgeOk ? 'available' : 'not found — install: uv pip install curl_cffi'));
      }

      if (!hasRedditCookie && !hasRedditOAuth) {
        console.log(`\n  ${cross}  No credentials. Run: crossmind extract-cookie reddit`);
      } else {
        const redditRead: string[] = ['subreddit', 'search', 'comments', 'popular', 'all',
          'user', 'user-posts', 'user-comments', 'read', 'sub-info'];
        const redditWrite: string[] = [];

        if (hasRedditCookie && redditBridgeOk) {
          redditRead.push('home', 'saved');
          redditWrite.push('comment', 'upvote', 'downvote', 'save', 'subscribe', 'unsubscribe',
            'text-post', 'link-post', 'crosspost', 'delete');
        } else if (hasRedditOAuth) {
          redditRead.push('home', 'saved');
          redditWrite.push('comment', 'upvote', 'downvote', 'save', 'subscribe', 'unsubscribe',
            'text-post', 'link-post', 'crosspost', 'delete');
        }

        console.log(`\n  Read   ${opList(redditRead).join('\n         ')}`);
        if (redditWrite.length > 0) {
          console.log(`  Write  ${opList(redditWrite).join('\n         ')}`);
        }

        const redditRecs: string[] = [];
        if (hasRedditCookie && !redditBridgeOk) {
          redditRecs.push('Install Python + curl_cffi to unlock write ops: uv pip install curl_cffi');
        }
        if (hasRedditOAuth && !hasRedditCookie) {
          redditRecs.push('Extract session cookies for better coverage (no OAuth rate limits):');
          redditRecs.push('  crossmind extract-cookie reddit');
        }
        if (redditRecs.length > 0) {
          console.log('');
          for (const r of redditRecs) console.log(`  ${warn}  ${r}`);
        }
      }

      console.log('');
    });
}
