/**
 * X (Twitter) write operations.
 * Post, reply, like, retweet, follow, dm, delete.
 *
 * Auth strategy:
 *   - OAuth access token (X_ACCESS_TOKEN or stored accessToken) → v2 REST write ops
 *   - Cookie auth (authToken + ct0)  → bridge-based ops (reply, delete, bookmark, unbookmark)
 *   Either credential type satisfies getXCreds; specific ops check what they need.
 */

import { xRequest } from '../../http/x-client.js';
import { loadXCredentials } from '../../auth/x.js';
import { checkWriteLimit, writeDelay } from '../../http/rate-limiter.js';
import { AuthError } from '../../http/client.js';
import { checkWriteDuplicate, recordWrite } from '../../http/write-history.js';
import {
  isCookieClientAvailable,
  bridgeReply,
  bridgeDelete,
  bridgeBookmark,
  bridgeUnbookmark,
} from '../../http/x-bridge.js';
import fs from 'node:fs';

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

/** Upload a media file (image/gif/video) and return the media_id. Requires OAuth. */
export async function uploadMedia(
  filePath: string,
  account?: string,
  dataDir?: string
): Promise<string> {
  const creds = await getXCreds(account, dataDir);
  if (!creds.accessToken) {
    throw new AuthError('Media upload requires OAuth auth (X_ACCESS_TOKEN).');
  }

  const resolvedPath = filePath.startsWith('http') ? filePath : filePath;
  const buffer = fs.readFileSync(resolvedPath);
  const ext = resolvedPath.split('.').pop()?.toLowerCase() ?? '';
  const mediaType = ext === 'gif' ? 'image/gif' : ext === 'mp4' ? 'video/mp4' : 'image/png';

  const formData = new FormData();
  formData.append('media', new Blob([buffer], { type: mediaType }), resolvedPath.split('/').pop());
  formData.append('media_category', mediaType.startsWith('video') ? 'tweet_video' : 'tweet_image');

  const res = await fetch('https://api.twitter.com/2/media/upload', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${creds.accessToken}`,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Referer': 'https://twitter.com/',
    },
    body: formData,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Media upload failed (${res.status}): ${body}`);
  }

  const data = await res.json() as { data: { media_key: string } };
  return data.data.media_key;
}

/** Post a new tweet */
export async function postTweet(
  text: string,
  account?: string,
  dataDir?: string,
  mediaIds?: string[],
  force?: boolean
): Promise<WriteResult> {
  await checkWriteLimit('x', 'post', dataDir);
  if (!force) {
    const dup = await checkWriteDuplicate('x', 'tweet', text, undefined, dataDir);
    if (dup.blocked) throw new Error(dup.reason);
  }
  const creds = await getXCreds(account, dataDir);
  await writeDelay();

  const body: Record<string, unknown> = { text };
  if (mediaIds?.length) {
    body.media = { media_ids: mediaIds };
  }

  const data = await xRequest<{ data: { id: string; text: string } }>(
    '/2/tweets',
    { method: 'POST', creds, body }
  );

  await recordWrite('x', 'tweet', text, undefined, dataDir);
  return {
    success: true,
    id: data.data.id,
    message: `posted:${data.data.id} text:${text.slice(0, 50)}${text.length > 50 ? '...' : ''}${mediaIds?.length ? ` media:${mediaIds.length}` : ''}`,
  };
}

/** Reply to a tweet */
export async function replyToTweet(
  text: string,
  tweetId: string,
  account?: string,
  dataDir?: string,
  mediaIds?: string[],
  force?: boolean
): Promise<WriteResult> {
  await checkWriteLimit('x', 'reply', dataDir);
  if (!force) {
    const dup = await checkWriteDuplicate('x', 'reply', text, tweetId, dataDir);
    if (dup.blocked) throw new Error(dup.reason);
  }
  const creds = await getXCreds(account, dataDir);
  await writeDelay();

  try {
    const body: Record<string, unknown> = { text, reply: { in_reply_to_tweet_id: tweetId } };
    if (mediaIds?.length) {
      body.media = { media_ids: mediaIds };
    }
    const data = await xRequest<{ data: { id: string } }>(
      '/2/tweets',
      { method: 'POST', creds, body }
    );
    await recordWrite('x', 'reply', text, tweetId, dataDir);
    return {
      success: true,
      id: data.data.id,
      message: `replied:${data.data.id} to:${tweetId}${mediaIds?.length ? ` media:${mediaIds.length}` : ''}`,
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
      await recordWrite('x', 'reply', text, tweetId, dataDir);
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
  dataDir?: string,
  force?: boolean
): Promise<WriteResult> {
  await checkWriteLimit('x', 'dm', dataDir);
  if (!force) {
    const dup = await checkWriteDuplicate('x', 'dm', text, username, dataDir);
    if (dup.blocked) throw new Error(dup.reason);
  }
  const creds = await getXCreds(account, dataDir);
  await writeDelay();

  const targetData = await xRequest<{ data: { id: string } }>(
    `/2/users/by/username/${username}`,
    { creds }
  );
  const targetId = targetData.data.id;

  let data: { data: { dm_conversation_id: string } };
  try {
    data = await xRequest<{ data: { dm_conversation_id: string } }>(
      `/2/dm_conversations/with/${targetId}/messages`,
      {
        method: 'POST',
        creds,
        body: { text },
      }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // code 349: recipient requires sender to follow them first
    if (/\b349\b/.test(msg) || /not following you/i.test(msg)) {
      throw new Error(`DM blocked — @${username} only accepts DMs from followers. Reply publicly instead.`);
    }
    // code 150: you have blocked this user
    if (/\b150\b/.test(msg) || /you've blocked/i.test(msg) || /you have blocked/i.test(msg)) {
      throw new Error(`DM blocked — you have blocked @${username}.`);
    }
    // code 327 / 179: protected account
    if (/\b(327|179)\b/.test(msg) || /protected/i.test(msg)) {
      throw new Error(`DM blocked — @${username}'s account is protected.`);
    }
    // code 226: automated / spam detection
    if (/\b226\b/.test(msg) || /automated/i.test(msg)) {
      throw new Error(`DM blocked — flagged as automated content by X. Wait before retrying.`);
    }
    throw err;
  }

  await recordWrite('x', 'dm', text, username, dataDir);
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

  // Prefer cookie auth (GraphQL) when available; fall back to OAuth v2 REST.
  if (creds.authToken && creds.ct0) {
    await bridgeDelete(tweetId, creds as { authToken: string; ct0: string });
    return { success: true, message: `deleted:${tweetId}` };
  }

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
  dataDir?: string,
  force?: boolean
): Promise<WriteResult> {
  await checkWriteLimit('x', 'post', dataDir);
  if (!force) {
    const dup = await checkWriteDuplicate('x', 'quote', text, tweetId, dataDir);
    if (dup.blocked) throw new Error(dup.reason);
  }
  const creds = await getXCreds(account, dataDir);
  await writeDelay();

  const data = await xRequest<{ data: { id: string } }>(
    '/2/tweets',
    { method: 'POST', creds, body: { text, quote_tweet_id: tweetId } }
  );

  await recordWrite('x', 'quote', text, tweetId, dataDir);
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
