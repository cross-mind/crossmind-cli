/**
 * Bluesky (ATProto) write operations.
 * Post, reply, like, repost, follow, delete.
 */

import { request } from '../../http/client.js';
import { getBskyToken, bskyHeaders, BSKY_API } from '../../auth/bluesky.js';
import { writeDelay } from '../../http/rate-limiter.js';
import { checkWriteDuplicate, recordWrite } from '../../http/write-history.js';

const BSKY_XRPC = `${BSKY_API}/xrpc`;

export interface BskyWriteResult {
  success: boolean;
  uri?: string;
  cid?: string;
  message: string;
}

/** Create a post record */
export async function createPost(
  text: string,
  account?: string,
  dataDir?: string,
  force?: boolean
): Promise<BskyWriteResult> {
  if (!force) {
    const dup = await checkWriteDuplicate('bsky', 'post', text, undefined, dataDir);
    if (dup.blocked) throw new Error(dup.reason);
  }
  const { token, did } = await getBskyToken(account, dataDir);
  await writeDelay();

  const data = await request<{ uri: string; cid: string }>(
    `${BSKY_XRPC}/com.atproto.repo.createRecord`,
    {
      method: 'POST',
      headers: bskyHeaders(token),
      body: {
        repo: did,
        collection: 'app.bsky.feed.post',
        record: {
          $type: 'app.bsky.feed.post',
          text,
          createdAt: new Date().toISOString(),
        },
      },
    }
  );

  await recordWrite('bsky', 'post', text, undefined, dataDir);
  return {
    success: true,
    uri: data.uri,
    cid: data.cid,
    message: `posted:${data.uri} text:${text.slice(0, 50)}`,
  };
}

/** Reply to a post */
export async function replyToPost(
  text: string,
  rootUri: string,
  rootCid: string,
  parentUri: string,
  parentCid: string,
  account?: string,
  dataDir?: string,
  force?: boolean
): Promise<BskyWriteResult> {
  if (!force) {
    const dup = await checkWriteDuplicate('bsky', 'reply', text, parentUri, dataDir);
    if (dup.blocked) throw new Error(dup.reason);
  }
  const { token, did } = await getBskyToken(account, dataDir);
  await writeDelay();

  const data = await request<{ uri: string; cid: string }>(
    `${BSKY_XRPC}/com.atproto.repo.createRecord`,
    {
      method: 'POST',
      headers: bskyHeaders(token),
      body: {
        repo: did,
        collection: 'app.bsky.feed.post',
        record: {
          $type: 'app.bsky.feed.post',
          text,
          createdAt: new Date().toISOString(),
          reply: {
            root: { uri: rootUri, cid: rootCid },
            parent: { uri: parentUri, cid: parentCid },
          },
        },
      },
    }
  );

  await recordWrite('bsky', 'reply', text, parentUri, dataDir);
  return {
    success: true,
    uri: data.uri,
    message: `replied:${data.uri} to:${parentUri}`,
  };
}

/** Like a post */
export async function likePost(
  postUri: string,
  postCid: string,
  account?: string,
  dataDir?: string
): Promise<BskyWriteResult> {
  const { token, did } = await getBskyToken(account, dataDir);
  await writeDelay();

  const data = await request<{ uri: string }>(
    `${BSKY_XRPC}/com.atproto.repo.createRecord`,
    {
      method: 'POST',
      headers: bskyHeaders(token),
      body: {
        repo: did,
        collection: 'app.bsky.feed.like',
        record: {
          $type: 'app.bsky.feed.like',
          subject: { uri: postUri, cid: postCid },
          createdAt: new Date().toISOString(),
        },
      },
    }
  );

  return { success: true, uri: data.uri, message: `liked:${postUri}` };
}

/** Repost */
export async function repost(
  postUri: string,
  postCid: string,
  account?: string,
  dataDir?: string
): Promise<BskyWriteResult> {
  const { token, did } = await getBskyToken(account, dataDir);
  await writeDelay();

  const data = await request<{ uri: string }>(
    `${BSKY_XRPC}/com.atproto.repo.createRecord`,
    {
      method: 'POST',
      headers: bskyHeaders(token),
      body: {
        repo: did,
        collection: 'app.bsky.feed.repost',
        record: {
          $type: 'app.bsky.feed.repost',
          subject: { uri: postUri, cid: postCid },
          createdAt: new Date().toISOString(),
        },
      },
    }
  );

  return { success: true, uri: data.uri, message: `reposted:${postUri}` };
}

/** Follow a user by DID or handle */
export async function followUser(
  actorHandle: string,
  account?: string,
  dataDir?: string
): Promise<BskyWriteResult> {
  const { token, did } = await getBskyToken(account, dataDir);
  await writeDelay();

  // Resolve handle to DID
  const resolved = await request<{ did: string }>(
    `${BSKY_XRPC}/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(actorHandle)}`,
    { headers: bskyHeaders(token) }
  );
  const targetDid = resolved.did;

  const data = await request<{ uri: string }>(
    `${BSKY_XRPC}/com.atproto.repo.createRecord`,
    {
      method: 'POST',
      headers: bskyHeaders(token),
      body: {
        repo: did,
        collection: 'app.bsky.graph.follow',
        record: {
          $type: 'app.bsky.graph.follow',
          subject: targetDid,
          createdAt: new Date().toISOString(),
        },
      },
    }
  );

  return { success: true, uri: data.uri, message: `following:${actorHandle}` };
}

/** Delete a record (post, like, repost, follow) */
export async function deleteRecord(
  uri: string,
  account?: string,
  dataDir?: string
): Promise<BskyWriteResult> {
  const { token, did } = await getBskyToken(account, dataDir);

  // Parse collection and rkey from URI: at://did/collection/rkey
  const parts = uri.replace('at://', '').split('/');
  const collection = parts[1];
  const rkey = parts[2];

  await request(
    `${BSKY_XRPC}/com.atproto.repo.deleteRecord`,
    {
      method: 'POST',
      headers: bskyHeaders(token),
      body: { repo: did, collection, rkey },
    }
  );

  return { success: true, message: `deleted:${uri}` };
}
