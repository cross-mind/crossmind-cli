/**
 * LinkedIn platform adapter.
 * Uses LinkedIn's unofficial API with session cookie auth.
 * Auth: crossmind extract-cookie linkedin
 * Commands: profile, feed, search
 * Note: LinkedIn heavily rate-limits and monitors API usage.
 */

import { Command } from 'commander';
import { request } from '../../http/client.js';
import { printOutput, printJsonResult, printJsonError } from '../../output/formatter.js';
import { loadCredential, resolveAccount } from '../../auth/store.js';
import { AuthError } from '../../http/client.js';
import { checkWriteDuplicate, recordWrite } from '../../http/write-history.js';
import { makeUser, type UnifiedUser } from '../../types/identity.js';

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

interface LIProfile extends UnifiedUser {
  rank: number;
  /** first+last, kept for template back-compat (== unified `name`). */
  full_name: string;
  headline: string;
  connections: number;
  location: string;
  /** Same as profile_url; kept for template back-compat. */
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
  dataDir?: string,
  force?: boolean
): Promise<{ id: string; url: string }> {
  if (!force) {
    const dup = await checkWriteDuplicate('linkedin', 'post', text, undefined, dataDir);
    if (dup.blocked) throw new Error(dup.reason);
  }
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
  await recordWrite('linkedin', 'post', text, undefined, dataDir);
  return {
    id: postId,
    url: `https://www.linkedin.com/feed/update/${postId}/`,
  };
}

/**
 * Delete a LinkedIn UGC post.
 * postId: bare numeric ID or full URN (urn:li:ugcPost:123456)
 */
async function deleteLinkedInPost(postId: string, account?: string, dataDir?: string): Promise<void> {
  const token = await loadLinkedInOAuthToken(account, dataDir);
  const fullUrn = postId.startsWith('urn:') ? postId : `urn:li:ugcPost:${postId}`;
  await request(`${LI_OAUTH_API}/v2/ugcPosts/${encodeURIComponent(fullUrn)}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-Restli-Protocol-Version': '2.0.0',
    },
  });
}

async function getProfile(username: string, account?: string, dataDir?: string): Promise<LIProfile | null> {
  const headers = await getLiHeaders(account, dataDir);
  const data = await request<Record<string, unknown>>(
    `${LI_API}/identity/profiles/${encodeURIComponent(username)}/profileView`,
    { headers }
  );

  if (!data) return null;

  const profile = data['profile'] as Record<string, unknown> | null ?? data;
  const mini = (profile['miniProfile'] ?? {}) as Record<string, unknown>;
  const firstName = String((profile['firstName'] as { defaultLocale?: string; localized?: Record<string, string> } | string | null) ?? '');
  const lastName = String((profile['lastName'] as { defaultLocale?: string; localized?: Record<string, string> } | string | null) ?? '');
  const headline = String(profile['headline'] ?? '');
  const fullName = `${firstName} ${lastName}`.trim();

  // Stable id: prefer miniProfile.objectUrn trailing segment (e.g. ACoAA…), else entityUrn.
  const objectUrn = String(mini['objectUrn'] ?? profile['entityUrn'] ?? '');
  const liId = objectUrn.split(':').pop() || null;
  // Best-effort avatar: LinkedIn serves a rootUrl + per-size artifact path.
  const picture = (mini['picture'] ?? profile['picture']) as
    | { rootUrl?: string; artifacts?: Array<{ fileIdentifyingUrlPathSegment?: string }> }
    | undefined;
  let avatarUrl: string | null = null;
  if (picture?.rootUrl && picture.artifacts?.length) {
    const seg = picture.artifacts[0]?.fileIdentifyingUrlPathSegment;
    if (seg) avatarUrl = `${picture.rootUrl}${seg}`;
  }

  return {
    ...makeUser({
      id: liId,
      username,
      name: fullName || null,
      avatar_url: avatarUrl,
      profile_url: `https://www.linkedin.com/in/${username}/`,
      bio: headline ? headline.slice(0, 300) : null,
      followers: 0, // LinkedIn API does not expose follower counts here — documented gap
      verified: false,
    }),
    rank: 1,
    full_name: fullName,
    headline: headline.slice(0, 120),
    connections: Number((data['connections'] as { paging?: { total?: number } } | null)?.paging?.total ?? 0),
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
    .description('LinkedIn — post, profile, feed')
    .addHelpText('after', `

Auth requirements:
  Cookie:            profile, feed (read operations)
  OAuth (access_token):  post, delete (write operations)

  Get cookie:  crossmind extract-cookie linkedin
  Get OAuth:   crossmind auth login linkedin --access-token <token>
`);

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
          if (opts.json) printJsonError(new Error(`Profile not found: ${username}`), `li/profile/${username}`);
          console.error(`Profile not found: ${username}`);
          process.exit(1);
        }
        printOutput([profile] as unknown as Record<string, unknown>[], PROFILE_TEMPLATE, `li/profile/${username}`, start, { json: opts.json });
      } catch (err) {
        if (opts.json) printJsonError(err, `li/profile/${username}`);
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
        if (opts.json) printJsonError(err, 'li/feed');
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  li
    .command('post <text>')
    .description('Post to LinkedIn (requires OAuth token: LINKEDIN_ACCESS_TOKEN or auth login linkedin --access-token)')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('-f, --force', 'Skip duplicate content check')
    .option('--json', 'Output structured result as JSON')
    .action(async (text: string, opts: { account?: string; dataDir?: string; force?: boolean; json?: boolean }) => {
      try {
        const result = await postToLinkedIn(text, opts.account, opts.dataDir, !!opts.force);
        if (opts.json) printJsonResult({ success: true, result: { id: result.id, url: result.url } }, 'li/post');
        else console.log(`Posted: ${result.url}`);
      } catch (err) {
        if (opts.json) printJsonError(err, 'li/post');
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  li
    .command('delete <post_id>')
    .description('Delete a LinkedIn post (post_id from li post output, or full URN urn:li:ugcPost:…)')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--json', 'Output structured result as JSON')
    .action(async (postId: string, opts: { account?: string; dataDir?: string; json?: boolean }) => {
      try {
        await deleteLinkedInPost(postId, opts.account, opts.dataDir);
        if (opts.json) printJsonResult({ success: true, result: { id: postId, deleted: true } }, 'li/delete');
        else console.log(`deleted:${postId}`);
      } catch (err) {
        if (opts.json) printJsonError(err, 'li/delete');
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
