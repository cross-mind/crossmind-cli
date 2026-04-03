/**
 * Reddit write operations.
 * Comment, vote, save, subscribe, post.
 *
 * Auth priority: session cookie (www.reddit.com) → OAuth (oauth.reddit.com)
 * Both are supported — session cookie is the default after extract-cookie reddit.
 */

import { request, AuthError } from '../../http/client.js';
import {
  loadRedditCredentials, REDDIT_API, redditHeaders, redditCookieHeaders,
} from '../../auth/reddit.js';
import { checkWriteLimit, writeDelay } from '../../http/rate-limiter.js';
import { checkWriteDuplicate, recordWrite } from '../../http/write-history.js';

export interface RedditWriteResult {
  success: boolean;
  id?: string;
  message: string;
}

interface WriteConfig {
  baseUrl: string;
  headers: Record<string, string>;
}

/**
 * Resolve the appropriate base URL and auth headers based on stored credentials.
 * Cookie auth uses www.reddit.com; OAuth uses oauth.reddit.com.
 * Fetches modhash on-demand when cookie auth is used and modhash is not stored.
 */
async function getWriteConfig(account?: string, dataDir?: string): Promise<WriteConfig> {
  const creds = await loadRedditCredentials(account, dataDir);

  if (!creds) {
    throw new AuthError(
      'Reddit auth required.\n' +
      '  Cookie (recommended): crossmind extract-cookie reddit\n' +
      '  OAuth: crossmind auth login reddit'
    );
  }

  if (creds.type === 'cookie') {
    let modhash = creds.modhash;

    if (!modhash) {
      // Fetch modhash from me.json — required for most write endpoints
      const meData = await request<{ data: { modhash: string } }>(
        'https://www.reddit.com/api/me.json',
        { headers: redditCookieHeaders(creds.session, undefined, creds.csrfToken, creds.loid) }
      );
      modhash = meData?.data?.modhash;
    }

    return {
      baseUrl: 'https://www.reddit.com',
      headers: redditCookieHeaders(creds.session, modhash, creds.csrfToken, creds.loid),
    };
  }

  return {
    baseUrl: REDDIT_API,
    headers: redditHeaders(creds.token),
  };
}

/** Submit a comment on a post or reply to a comment */
export async function submitComment(
  parentId: string,   // t3_<postId> or t1_<commentId>
  text: string,
  account?: string,
  dataDir?: string,
  force?: boolean
): Promise<RedditWriteResult> {
  await checkWriteLimit('reddit', 'comment', dataDir);
  if (!force) {
    const dup = await checkWriteDuplicate('reddit', 'comment', text, parentId, dataDir);
    if (dup.blocked) throw new Error(dup.reason);
  }
  const { baseUrl, headers } = await getWriteConfig(account, dataDir);
  await writeDelay();

  const body = new URLSearchParams({
    api_type: 'json',
    thing_id: parentId,
    text,
  });

  const data = await request<{ json: { data: { things: Array<{ data: { id: string; name: string } }> } } }>(
    `${baseUrl}/api/comment`,
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString() as unknown,
    }
  );

  const commentId = data?.json?.data?.things?.[0]?.data?.id ?? '';
  await recordWrite('reddit', 'comment', text, parentId, dataDir);
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
  const { baseUrl, headers } = await getWriteConfig(account, dataDir);
  await writeDelay();

  const body = new URLSearchParams({
    id,
    dir: String(direction),
  });

  await request(`${baseUrl}/api/vote`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString() as unknown,
  });

  const dirLabel = direction === 1 ? 'upvoted' : direction === -1 ? 'downvoted' : 'unvoted';
  return { success: true, message: `${dirLabel}:${id}` };
}

/** Delete a post or comment you authored */
export async function deleteItem(
  id: string,   // fullname: t3_<postId> or t1_<commentId>
  account?: string,
  dataDir?: string
): Promise<RedditWriteResult> {
  const { baseUrl, headers } = await getWriteConfig(account, dataDir);
  await writeDelay();

  const body = new URLSearchParams({ id });
  await request(`${baseUrl}/api/del`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString() as unknown,
  });

  return { success: true, message: `deleted:${id}` };
}

/** Save a post or comment */
export async function saveItem(
  id: string,
  account?: string,
  dataDir?: string
): Promise<RedditWriteResult> {
  await checkWriteLimit('reddit', 'save', dataDir);
  const { baseUrl, headers } = await getWriteConfig(account, dataDir);
  await writeDelay();

  const body = new URLSearchParams({ id });
  await request(`${baseUrl}/api/save`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
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
  const { baseUrl, headers } = await getWriteConfig(account, dataDir);
  await writeDelay();

  // Need subreddit fullname (sr_name works for cookie auth too)
  const infoData = await request<{ data: { name: string } }>(
    `https://www.reddit.com/r/${subreddit}/about.json`,
    { headers }
  );
  const subredditName = infoData?.data?.name ?? '';

  const body = new URLSearchParams({
    action,
    sr: subredditName,
  });

  await request(`${baseUrl}/api/subscribe`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
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
  dataDir?: string,
  force?: boolean
): Promise<RedditWriteResult> {
  await checkWriteLimit('reddit', 'comment', dataDir);
  if (!force) {
    const dup = await checkWriteDuplicate('reddit', 'text-post', `${title} ${text}`, subreddit, dataDir);
    if (dup.blocked) throw new Error(dup.reason);
  }
  const { baseUrl, headers } = await getWriteConfig(account, dataDir);
  await writeDelay();

  const body = new URLSearchParams({
    api_type: 'json',
    kind: 'self',
    sr: subreddit,
    title,
    text,
  });

  const data = await request<{ json: { data: { id: string; name: string } } }>(
    `${baseUrl}/api/submit`,
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString() as unknown,
    }
  );

  const postId = data?.json?.data?.id ?? '';
  await recordWrite('reddit', 'text-post', `${title} ${text}`, subreddit, dataDir);
  return {
    success: true,
    id: postId,
    message: `text_post:${postId} to:r/${subreddit}`,
  };
}

/** Submit a new link post */
export async function submitPost(
  subreddit: string,
  title: string,
  url: string,
  account?: string,
  dataDir?: string,
  force?: boolean
): Promise<RedditWriteResult> {
  await checkWriteLimit('reddit', 'comment', dataDir);
  if (!force) {
    const dup = await checkWriteDuplicate('reddit', 'post', title, subreddit, dataDir);
    if (dup.blocked) throw new Error(dup.reason);
  }
  const { baseUrl, headers } = await getWriteConfig(account, dataDir);
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
    `${baseUrl}/api/submit`,
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString() as unknown,
    }
  );

  const postId = data?.json?.data?.id ?? '';
  await recordWrite('reddit', 'post', title, subreddit, dataDir);
  return {
    success: true,
    id: postId,
    message: `submitted:${postId} to:r/${subreddit}`,
  };
}

/** Crosspost to another subreddit */
export async function crosspost(
  targetSubreddit: string,
  postId: string,
  title: string,
  account?: string,
  dataDir?: string,
  force?: boolean
): Promise<RedditWriteResult> {
  await checkWriteLimit('reddit', 'comment', dataDir);
  if (!force) {
    const dup = await checkWriteDuplicate('reddit', 'crosspost', title, targetSubreddit, dataDir);
    if (dup.blocked) throw new Error(dup.reason);
  }
  const { baseUrl, headers } = await getWriteConfig(account, dataDir);
  await writeDelay();

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
    `${baseUrl}/api/submit`,
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString() as unknown,
    }
  );

  const newId = data?.json?.data?.id ?? '';
  await recordWrite('reddit', 'crosspost', title, targetSubreddit, dataDir);
  return {
    success: true,
    id: newId,
    message: `crossposted:t3_${bareId} to:r/${targetSubreddit} new_id:${newId}`,
  };
}
