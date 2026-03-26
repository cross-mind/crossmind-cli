/**
 * Reddit write operations.
 * Comment, vote, save, subscribe.
 * Requires OAuth authentication.
 */

import { request } from '../../http/client.js';
import { getRedditToken, REDDIT_API, redditHeaders } from '../../auth/reddit.js';
import { checkWriteLimit, writeDelay } from '../../http/rate-limiter.js';

export interface RedditWriteResult {
  success: boolean;
  id?: string;
  message: string;
}

/** Submit a comment on a post or reply to a comment */
export async function submitComment(
  parentId: string,   // t3_<postId> or t1_<commentId>
  text: string,
  account?: string,
  dataDir?: string
): Promise<RedditWriteResult> {
  await checkWriteLimit('reddit', 'comment', dataDir);
  const token = await getRedditToken(account, dataDir);
  await writeDelay();

  const body = new URLSearchParams({
    api_type: 'json',
    thing_id: parentId,
    text,
  });

  const data = await request<{ json: { data: { things: Array<{ data: { id: string; name: string } }> } } }>(
    `${REDDIT_API}/api/comment`,
    {
      method: 'POST',
      headers: {
        ...redditHeaders(token),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString() as unknown,
    }
  );

  const commentId = data?.json?.data?.things?.[0]?.data?.id ?? '';
  return {
    success: true,
    id: commentId,
    message: `commented:${commentId} on:${parentId}`,
  };
}

/** Vote on a post or comment */
export async function vote(
  id: string,           // fullname: t1_ or t3_
  direction: 1 | 0 | -1,
  account?: string,
  dataDir?: string
): Promise<RedditWriteResult> {
  await checkWriteLimit('reddit', 'upvote', dataDir);
  const token = await getRedditToken(account, dataDir);
  await writeDelay();

  const body = new URLSearchParams({
    id,
    dir: String(direction),
  });

  await request(`${REDDIT_API}/api/vote`, {
    method: 'POST',
    headers: {
      ...redditHeaders(token),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString() as unknown,
  });

  const dirLabel = direction === 1 ? 'upvoted' : direction === -1 ? 'downvoted' : 'unvoted';
  return { success: true, message: `${dirLabel}:${id}` };
}

/** Save a post or comment */
export async function saveItem(
  id: string,
  account?: string,
  dataDir?: string
): Promise<RedditWriteResult> {
  await checkWriteLimit('reddit', 'save', dataDir);
  const token = await getRedditToken(account, dataDir);
  await writeDelay();

  const body = new URLSearchParams({ id });
  await request(`${REDDIT_API}/api/save`, {
    method: 'POST',
    headers: {
      ...redditHeaders(token),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString() as unknown,
  });

  return { success: true, message: `saved:${id}` };
}

/** Subscribe or unsubscribe from a subreddit */
export async function subscribeSubreddit(
  subreddit: string,
  action: 'sub' | 'unsub',
  account?: string,
  dataDir?: string
): Promise<RedditWriteResult> {
  await checkWriteLimit('reddit', 'subscribe', dataDir);
  const token = await getRedditToken(account, dataDir);
  await writeDelay();

  // Need subreddit fullname
  const infoData = await request<{ data: { children: Array<{ data: { name: string } }> } }>(
    `${REDDIT_API}/r/${subreddit}/about.json`,
    { headers: redditHeaders(token) }
  );
  const subredditName = (infoData as unknown as { data: { name: string } }).data?.name ?? '';

  const body = new URLSearchParams({
    action,
    sr: subredditName,
  });

  await request(`${REDDIT_API}/api/subscribe`, {
    method: 'POST',
    headers: {
      ...redditHeaders(token),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString() as unknown,
  });

  const label = action === 'sub' ? 'subscribed to' : 'unsubscribed from';
  return { success: true, message: `${label}:r/${subreddit}` };
}

/** Submit a new text (self) post */
export async function submitTextPost(
  subreddit: string,
  title: string,
  text: string,
  account?: string,
  dataDir?: string
): Promise<RedditWriteResult> {
  await checkWriteLimit('reddit', 'comment', dataDir);
  const token = await getRedditToken(account, dataDir);
  await writeDelay();

  const body = new URLSearchParams({
    api_type: 'json',
    kind: 'self',
    sr: subreddit,
    title,
    text,
  });

  const data = await request<{ json: { data: { id: string; name: string } } }>(
    `${REDDIT_API}/api/submit`,
    {
      method: 'POST',
      headers: {
        ...redditHeaders(token),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString() as unknown,
    }
  );

  const postId = data?.json?.data?.id ?? '';
  return {
    success: true,
    id: postId,
    message: `text_post:${postId} to:r/${subreddit}`,
  };
}

/** Crosspost to another subreddit */
export async function crosspost(
  targetSubreddit: string,
  postId: string,
  title: string,
  account?: string,
  dataDir?: string
): Promise<RedditWriteResult> {
  await checkWriteLimit('reddit', 'comment', dataDir);
  const token = await getRedditToken(account, dataDir);
  await writeDelay();

  // Strip t3_ prefix if present, Reddit needs the bare ID
  const bareId = postId.replace(/^t3_/, '');

  const body = new URLSearchParams({
    api_type: 'json',
    kind: 'crosspost',
    sr: targetSubreddit,
    title,
    crosspost_fullname: `t3_${bareId}`,
    resubmit: 'true',
  });

  const data = await request<{ json: { data: { id: string; name: string } } }>(
    `${REDDIT_API}/api/submit`,
    {
      method: 'POST',
      headers: {
        ...redditHeaders(token),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString() as unknown,
    }
  );

  const newId = data?.json?.data?.id ?? '';
  return {
    success: true,
    id: newId,
    message: `crossposted:t3_${bareId} to:r/${targetSubreddit} new_id:${newId}`,
  };
}

/** Submit a new link post */
export async function submitPost(
  subreddit: string,
  title: string,
  url: string,
  account?: string,
  dataDir?: string
): Promise<RedditWriteResult> {
  await checkWriteLimit('reddit', 'comment', dataDir); // reuse comment limit for posts
  const token = await getRedditToken(account, dataDir);
  await writeDelay();

  const body = new URLSearchParams({
    api_type: 'json',
    kind: 'link',
    sr: subreddit,
    title,
    url,
    resubmit: 'true',
  });

  const data = await request<{ json: { data: { id: string; name: string } } }>(
    `${REDDIT_API}/api/submit`,
    {
      method: 'POST',
      headers: {
        ...redditHeaders(token),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString() as unknown,
    }
  );

  const postId = data?.json?.data?.id ?? '';
  return {
    success: true,
    id: postId,
    message: `submitted:${postId} to:r/${subreddit}`,
  };
}
