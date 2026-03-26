/**
 * X (Twitter) write operations.
 * Post, reply, like, retweet, follow, dm, delete.
 *
 * Auth strategy:
 *   - OAuth access token (X_ACCESS_TOKEN or stored accessToken) → v2 REST write ops
 *   - Cookie auth (authToken + ct0)  → bridge-based ops (bookmark, unbookmark)
 *   Either credential type satisfies getXCreds; specific ops check what they need.
 */

import { xRequest } from '../../http/x-client.js';
import { loadXCredentials } from '../../auth/x.js';
import { checkWriteLimit, writeDelay } from '../../http/rate-limiter.js';
import { AuthError } from '../../http/client.js';
import {
  isCookieClientAvailable,
  bridgeReply,
  bridgeBookmark,
  bridgeUnbookmark,
} from '../../http/x-bridge.js';

/** Load and validate X credentials. Accepts OAuth OR cookie auth. */
async function getXCreds(account?: string, dataDir?: string) {
  const creds = await loadXCredentials(account, dataDir);
  if (!creds?.accessToken && (!creds?.authToken || !creds?.ct0)) {
    throw new AuthError(
      'X write operations require OAuth or cookie auth.\n' +
      '  OAuth: Set X_ACCESS_TOKEN, or run: crossmind auth login x --access-token <token>\n' +
      '  Cookie: crossmind auth extract-cookie x'
    );
  }
  return creds!;
}

/** Assert cookie credentials are present (required for bridge write ops). */
function requireCookie(creds: { authToken?: string; ct0?: string }): void {
  if (!creds.authToken || !creds.ct0) {
    throw new AuthError(
      'This operation requires X cookie auth. Run: crossmind auth login x --auth-token <token> --ct0 <ct0>'
    );
  }
}

export interface WriteResult {
  success: boolean;
  id?: string;
  message: string;
}

/** Post a new tweet */
export async function postTweet(
  text: string,
  account?: string,
  dataDir?: string
): Promise<WriteResult> {
  await checkWriteLimit('x', 'post', dataDir);
  const creds = await getXCreds(account, dataDir);
  await writeDelay();

  const data = await xRequest<{ data: { id: string; text: string } }>(
    '/2/tweets',
    { method: 'POST', creds, body: { text } }
  );

  return {
    success: true,
    id: data.data.id,
    message: `posted:${data.data.id} text:${text.slice(0, 50)}${text.length > 50 ? '...' : ''}`,
  };
}

/** Reply to a tweet */
export async function replyToTweet(
  text: string,
  tweetId: string,
  account?: string,
  dataDir?: string
): Promise<WriteResult> {
  await checkWriteLimit('x', 'reply', dataDir);
  const creds = await getXCreds(account, dataDir);
  await writeDelay();

  try {
    const data = await xRequest<{ data: { id: string } }>(
      '/2/tweets',
      {
        method: 'POST',
        creds,
        body: { text, reply: { in_reply_to_tweet_id: tweetId } },
      }
    );
    return {
      success: true,
      id: data.data.id,
      message: `replied:${data.data.id} to:${tweetId}`,
    };
  } catch (err) {
    // Free tier API often returns 403 for cold replies (no prior engagement).
    // Fallback to cookie auth via GraphQL, which has no such restriction.
    if (err instanceof AuthError && /HTTP 403/.test(err.message)) {
      if (!creds.authToken || !creds.ct0) {
        throw new AuthError(
          `X Free tier API blocked this reply (${err.message.split(' — ')[1] ?? 'policy restriction'}).\n` +
          '  Add cookie auth for unrestricted replies: crossmind auth extract-cookie x'
        );
      }
      if (!await isCookieClientAvailable()) {
        throw new Error(
          'X Free tier API blocked this reply. Cookie fallback needs Python 3 + curl_cffi.\n' +
          '  Install: uv pip install curl_cffi'
        );
      }
      const result = await bridgeReply(tweetId, text, creds as { authToken: string; ct0: string });
      return {
        success: true,
        id: result.id,
        message: `replied:${result.id} to:${tweetId} (cookie)`,
      };
    }
    throw err;
  }
}

/** Like a tweet */
export async function likeTweet(
  tweetId: string,
  account?: string,
  dataDir?: string
): Promise<WriteResult> {
  await checkWriteLimit('x', 'like', dataDir);
  const creds = await getXCreds(account, dataDir);
  await writeDelay();

  // Need authenticated user's ID first
  const meData = await xRequest<{ data: { id: string } }>(
    '/2/users/me',
    { creds }
  );
  const userId = meData.data.id;

  await xRequest(
    `/2/users/${userId}/likes`,
    { method: 'POST', creds, body: { tweet_id: tweetId } }
  );

  return { success: true, message: `liked:${tweetId}` };
}

/** Retweet */
export async function retweetTweet(
  tweetId: string,
  account?: string,
  dataDir?: string
): Promise<WriteResult> {
  await checkWriteLimit('x', 'retweet', dataDir);
  const creds = await getXCreds(account, dataDir);
  await writeDelay();

  const meData = await xRequest<{ data: { id: string } }>(
    '/2/users/me',
    { creds }
  );
  const userId = meData.data.id;

  await xRequest(
    `/2/users/${userId}/retweets`,
    { method: 'POST', creds, body: { tweet_id: tweetId } }
  );

  return { success: true, message: `retweeted:${tweetId}` };
}

/** Follow a user by username */
export async function followUser(
  username: string,
  account?: string,
  dataDir?: string
): Promise<WriteResult> {
  await checkWriteLimit('x', 'follow', dataDir);
  const creds = await getXCreds(account, dataDir);
  await writeDelay();

  const meData = await xRequest<{ data: { id: string } }>(
    '/2/users/me',
    { creds }
  );
  const myId = meData.data.id;

  const targetData = await xRequest<{ data: { id: string } }>(
    `/2/users/by/username/${username}`,
    { creds }
  );
  const targetId = targetData.data.id;

  await xRequest(
    `/2/users/${myId}/following`,
    { method: 'POST', creds, body: { target_user_id: targetId } }
  );

  return { success: true, message: `following:@${username}` };
}

/** Send a DM */
export async function sendDM(
  username: string,
  text: string,
  account?: string,
  dataDir?: string
): Promise<WriteResult> {
  await checkWriteLimit('x', 'dm', dataDir);
  const creds = await getXCreds(account, dataDir);
  await writeDelay();

  const targetData = await xRequest<{ data: { id: string } }>(
    `/2/users/by/username/${username}`,
    { creds }
  );
  const targetId = targetData.data.id;

  const data = await xRequest<{ data: { dm_conversation_id: string } }>(
    '/2/dm_conversations',
    {
      method: 'POST',
      creds,
      body: {
        participant_id: targetId,
        message: { text },
      },
    }
  );

  return {
    success: true,
    id: data.data.dm_conversation_id,
    message: `dm_sent to:@${username} text:${text.slice(0, 50)}`,
  };
}

/** Delete a tweet */
export async function deleteTweet(
  tweetId: string,
  account?: string,
  dataDir?: string
): Promise<WriteResult> {
  await checkWriteLimit('x', 'delete', dataDir);
  const creds = await getXCreds(account, dataDir);
  await writeDelay();

  await xRequest(
    `/2/tweets/${tweetId}`,
    { method: 'DELETE', creds }
  );

  return { success: true, message: `deleted:${tweetId}` };
}

// ── Phase 2 write additions ────────────────────────────────────────────────

/** Quote-tweet */
export async function quoteTweet(
  tweetId: string,
  text: string,
  account?: string,
  dataDir?: string
): Promise<WriteResult> {
  await checkWriteLimit('x', 'post', dataDir);
  const creds = await getXCreds(account, dataDir);
  await writeDelay();

  const data = await xRequest<{ data: { id: string } }>(
    '/2/tweets',
    { method: 'POST', creds, body: { text, quote_tweet_id: tweetId } }
  );

  return {
    success: true,
    id: data.data.id,
    message: `quoted:${tweetId} new_id:${data.data.id}`,
  };
}

/** Unlike a tweet */
export async function unlikeTweet(
  tweetId: string,
  account?: string,
  dataDir?: string
): Promise<WriteResult> {
  const creds = await getXCreds(account, dataDir);
  await writeDelay();

  const meData = await xRequest<{ data: { id: string } }>('/2/users/me', { creds });
  const userId = meData.data.id;

  await xRequest(`/2/users/${userId}/likes/${tweetId}`, { method: 'DELETE', creds });
  return { success: true, message: `unliked:${tweetId}` };
}

/** Undo a retweet */
export async function unretweetTweet(
  tweetId: string,
  account?: string,
  dataDir?: string
): Promise<WriteResult> {
  const creds = await getXCreds(account, dataDir);
  await writeDelay();

  const meData = await xRequest<{ data: { id: string } }>('/2/users/me', { creds });
  const userId = meData.data.id;

  await xRequest(`/2/users/${userId}/retweets/${tweetId}`, { method: 'DELETE', creds });
  return { success: true, message: `unretweeted:${tweetId}` };
}

/** Unfollow a user */
export async function unfollowUser(
  username: string,
  account?: string,
  dataDir?: string
): Promise<WriteResult> {
  const creds = await getXCreds(account, dataDir);
  await writeDelay();

  const meData = await xRequest<{ data: { id: string } }>('/2/users/me', { creds });
  const myId = meData.data.id;

  const targetData = await xRequest<{ data: { id: string } }>(
    `/2/users/by/username/${username}`,
    { creds }
  );
  const targetId = targetData.data.id;

  await xRequest(`/2/users/${myId}/following/${targetId}`, { method: 'DELETE', creds });
  return { success: true, message: `unfollowed:@${username}` };
}

/** Bookmark a tweet (cookie auth + curl_cffi required) */
export async function bookmarkTweet(
  tweetId: string,
  account?: string,
  dataDir?: string
): Promise<WriteResult> {
  const creds = await getXCreds(account, dataDir);
  requireCookie(creds);
  if (!await isCookieClientAvailable()) {
    throw new Error(
      'Bookmarks require Python 3 with curl_cffi.\n' +
      '  Install: uv pip install curl_cffi\n' +
      '  Or: pip install curl_cffi'
    );
  }
  await bridgeBookmark(tweetId, creds as { authToken: string; ct0: string });
  return { success: true, message: `bookmarked:${tweetId}` };
}

/** Remove a bookmark (cookie auth + curl_cffi required) */
export async function unbookmarkTweet(
  tweetId: string,
  account?: string,
  dataDir?: string
): Promise<WriteResult> {
  const creds = await getXCreds(account, dataDir);
  requireCookie(creds);
  if (!await isCookieClientAvailable()) {
    throw new Error(
      'Bookmarks require Python 3 with curl_cffi.\n' +
      '  Install: uv pip install curl_cffi\n' +
      '  Or: pip install curl_cffi'
    );
  }
  await bridgeUnbookmark(tweetId, creds as { authToken: string; ct0: string });
  return { success: true, message: `unbookmarked:${tweetId}` };
}
