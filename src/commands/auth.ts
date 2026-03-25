/**
 * `crossmind auth` command group.
 * Subcommands: login, logout, status
 */

import { Command } from 'commander';
import { loginX, saveCookieAuth, saveBearerToken } from '../auth/x.js';
import { loginReddit } from '../auth/reddit.js';
import { loginBluesky } from '../auth/bluesky.js';
import { saveGitHubToken } from '../auth/github.js';
import { saveCredential, listAccounts, removeCredential, getDefaultAccount } from '../auth/store.js';
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
    .option('--auth-token <authToken>', 'X auth_token cookie value')
    .option('--ct0 <ct0>', 'X ct0 CSRF token')
    .option('--bearer-token <bearerToken>', 'X developer bearer token (read-only, no login required)')
    .option('--handle <handle>', 'Bluesky handle (e.g. user.bsky.social)')
    .option('--app-password <password>', 'Bluesky app password')
    .action(async (
      platform: string,
      account: string | undefined,
      opts: {
        dataDir?: string;
        token?: string;
        cookie?: string;
        authToken?: string;
        ct0?: string;
        bearerToken?: string;
        handle?: string;
        appPassword?: string;
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
            } else if (opts.authToken && opts.ct0) {
              // Direct cookie auth
              await saveCookieAuth(accountName, opts.authToken, opts.ct0, opts.dataDir);
              console.log(`X cookies saved as "${accountName}".`);
            } else {
              // OAuth 2.0 PKCE flow
              await loginX(accountName, opts.dataDir);
            }
            break;
          }

          case 'reddit': {
            await loginReddit(accountName, opts.dataDir);
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

          case 'instagram':
          case 'linkedin': {
            // These require cookie extraction via browser
            console.log(`For ${platform}, use: crossmind extract-cookie ${platform}`);
            process.exit(1);
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
    });

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
    .description('Show authentication status for all platforms')
    .option('--data-dir <dir>', 'Data directory override')
    .action(async (opts: { dataDir?: string }) => {
      const accounts = await listAccounts(undefined, opts.dataDir);
      if (accounts.length === 0) {
        console.log('No accounts stored. Run: crossmind auth login <platform>');
        return;
      }

      const byPlatform: Record<string, string[]> = {};
      for (const a of accounts) {
        (byPlatform[a.platform] ??= []).push(a.name);
      }

      for (const [p, names] of Object.entries(byPlatform)) {
        const def = await getDefaultAccount(p, opts.dataDir);
        const list = names.map((n) => n + (n === def ? '*' : '')).join(', ');
        console.log(`${p}: ${list}`);
      }
    });
}
