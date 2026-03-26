/**
 * LinkedIn platform adapter.
 * Uses LinkedIn's unofficial API with session cookie auth.
 * Auth: crossmind extract-cookie linkedin
 * Commands: profile, feed, search
 * Note: LinkedIn heavily rate-limits and monitors API usage.
 */

import { Command } from 'commander';
import { request } from '../../http/client.js';
import { printOutput } from '../../output/formatter.js';
import { loadCredential, resolveAccount } from '../../auth/store.js';
import { AuthError } from '../../http/client.js';

const LI_API = 'https://www.linkedin.com/voyager/api';
const LI_OAUTH_API = 'https://api.linkedin.com';

interface LIPost {
  rank: number;
  id: string;
  author: string;
  author_headline: string;
  text: string;
  likes: number;
  comments: number;
  reposts: number;
  created_at: string;
  url: string;
}

interface LIProfile {
  rank: number;
  username: string;
  full_name: string;
  headline: string;
  connections: number;
  followers: number;
  location: string;
  url: string;
}

async function getLiHeaders(account?: string, dataDir?: string): Promise<Record<string, string>> {
  const name = await resolveAccount('linkedin', account, dataDir);
  const cred = await loadCredential('linkedin', name, dataDir);
  if (!cred?.cookie) {
    throw new AuthError('LinkedIn credentials required. Run: crossmind extract-cookie linkedin');
  }

  const jsessionId = cred.cookie.match(/JSESSIONID="?([^";]+)"?/)?.[1] ?? cred.ct0 ?? '';
  return {
    'Cookie': cred.cookie,
    'Csrf-Token': jsessionId,
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'X-Li-Lang': 'en_US',
    'X-Li-Track': JSON.stringify({ clientVersion: '1.13.10040', mpVersion: '1.13.10040' }),
    'X-RestLi-Protocol-Version': '2.0.0',
  };
}

/**
 * Load a LinkedIn OAuth access token.
 * Priority: LINKEDIN_ACCESS_TOKEN env var → stored credential accessToken
 */
async function loadLinkedInOAuthToken(account?: string, dataDir?: string): Promise<string> {
  const envToken = process.env['LINKEDIN_ACCESS_TOKEN'];
  if (envToken) return envToken;

  const name = await resolveAccount('linkedin', account, dataDir);
  const cred = await loadCredential('linkedin', name, dataDir);
  if (cred?.accessToken) return cred.accessToken;

  throw new AuthError(
    'No LinkedIn OAuth token found.\n' +
    '  Set env: export LINKEDIN_ACCESS_TOKEN=<token>\n' +
    '  Or save: crossmind auth login linkedin --access-token <token>'
  );
}

/**
 * Post text content to LinkedIn using the UGC Posts API.
 * Requires an OAuth token with w_member_social scope.
 */
async function postToLinkedIn(
  text: string,
  account?: string,
  dataDir?: string
): Promise<{ id: string; url: string }> {
  const token = await loadLinkedInOAuthToken(account, dataDir);
  const headers = {
    'Authorization': `Bearer ${token}`,
    'X-Restli-Protocol-Version': '2.0.0',
    'LinkedIn-Version': '202401',
  };

  // Resolve author URN via OIDC userinfo
  const userInfo = await request<{ sub: string }>(`${LI_OAUTH_API}/v2/userinfo`, { headers });
  const authorUrn = `urn:li:person:${userInfo.sub}`;

  // Create UGC post — pass body as object; request() handles JSON serialization
  const resp = await request<{ id: string }>(`${LI_OAUTH_API}/v2/ugcPosts`, {
    method: 'POST',
    headers,
    body: {
      author: authorUrn,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text },
          shareMediaCategory: 'NONE',
        },
      },
      visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
      },
    },
  });

  const postId = resp?.id ?? '';
  return {
    id: postId,
    url: `https://www.linkedin.com/feed/update/${postId}/`,
  };
}

async function getProfile(username: string, account?: string, dataDir?: string): Promise<LIProfile | null> {
  const headers = await getLiHeaders(account, dataDir);
  const data = await request<Record<string, unknown>>(
    `${LI_API}/identity/profiles/${encodeURIComponent(username)}/profileView`,
    { headers }
  );

  if (!data) return null;

  const profile = data['profile'] as Record<string, unknown> | null ?? data;
  const firstName = String((profile['firstName'] as { defaultLocale?: string; localized?: Record<string, string> } | string | null) ?? '');
  const lastName = String((profile['lastName'] as { defaultLocale?: string; localized?: Record<string, string> } | string | null) ?? '');
  const headline = String(profile['headline'] ?? '');

  return {
    rank: 1,
    username,
    full_name: `${firstName} ${lastName}`.trim(),
    headline: headline.slice(0, 120),
    connections: Number((data['connections'] as { paging?: { total?: number } } | null)?.paging?.total ?? 0),
    followers: 0,
    location: String((profile['locationName'] ?? '')),
    url: `https://www.linkedin.com/in/${username}/`,
  };
}

async function getFeed(limit: number, account?: string, dataDir?: string): Promise<LIPost[]> {
  const headers = await getLiHeaders(account, dataDir);
  const data = await request<{
    elements?: Array<Record<string, unknown>>;
    data?: { feedElementUpdates?: { elements?: Array<Record<string, unknown>> } };
  }>(
    `${LI_API}/feed/updatesV2?count=${Math.min(limit, 50)}&q=stories&start=0`,
    { headers }
  );

  const elements = data.elements
    ?? data.data?.feedElementUpdates?.elements
    ?? [];

  return elements.slice(0, limit).map((el, i) => {
    const actor = el['actor'] as Record<string, unknown> | null ?? {};
    const commentary = el['commentary'] as Record<string, unknown> | null ?? {};
    const socialDetail = el['socialDetail'] as Record<string, unknown> | null ?? {};
    const socialCounts = socialDetail['totalSocialActivityCounts'] as Record<string, number> | null ?? {};
    const entityUrn = String(el['updateUrn'] ?? el['entityUrn'] ?? '');
    const ugcPostId = entityUrn.split(':').pop() ?? '';

    return {
      rank: i + 1,
      id: ugcPostId,
      author: String((actor['name'] as { text?: string } | null)?.text ?? ''),
      author_headline: String((actor['description'] as { text?: string } | null)?.text ?? '').slice(0, 80),
      text: String((commentary['text'] as { text?: string } | null)?.text ?? '').replace(/\n/g, ' ').slice(0, 200),
      likes: socialCounts['numLikes'] ?? socialCounts['likeCount'] ?? 0,
      comments: socialCounts['numComments'] ?? 0,
      reposts: socialCounts['numShares'] ?? 0,
      created_at: '',
      url: `https://www.linkedin.com/feed/update/${entityUrn}/`,
    };
  });
}

const FEED_TEMPLATE = '{rank}. {author} ({author_headline}) likes:{likes} comments:{comments} — {text} {url}';
const PROFILE_TEMPLATE = '{rank}. {full_name} ({headline}) connections:{connections} — {location} {url}';

export function registerLinkedIn(program: Command): void {
  const li = program
    .command('li')
    .description('LinkedIn — post, profile, feed');

  li
    .command('profile <username>')
    .description('Get a LinkedIn profile (username from URL: linkedin.com/in/<username>)')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--json', 'Output as JSON array')
    .action(async (username: string, opts: { account?: string; dataDir?: string; json?: boolean }) => {
      const start = Date.now();
      try {
        const profile = await getProfile(username, opts.account, opts.dataDir);
        if (!profile) {
          console.error(`Profile not found: ${username}`);
          process.exit(1);
        }
        printOutput([profile] as unknown as Record<string, unknown>[], PROFILE_TEMPLATE, `li/profile/${username}`, start, { json: opts.json });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  li
    .command('feed [limit]')
    .description('Get LinkedIn home feed')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--json', 'Output as JSON array')
    .action(async (limitArg: string | undefined, opts: { account?: string; dataDir?: string; json?: boolean }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 20;
      try {
        const items = await getFeed(limit, opts.account, opts.dataDir);
        printOutput(items as unknown as Record<string, unknown>[], FEED_TEMPLATE, 'li/feed', start, { json: opts.json });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  li
    .command('post <text>')
    .description('Post to LinkedIn (requires OAuth token: LINKEDIN_ACCESS_TOKEN or auth login linkedin --access-token)')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .action(async (text: string, opts: { account?: string; dataDir?: string }) => {
      try {
        const result = await postToLinkedIn(text, opts.account, opts.dataDir);
        console.log(`Posted: ${result.url}`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
