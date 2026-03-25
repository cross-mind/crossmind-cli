/**
 * X (Twitter) read operations.
 * Timeline, search, user profile, followers, following, likes.
 */

import { xRequest } from '../../http/x-client.js';
import { loadXCredentials } from '../../auth/x.js';

export interface XTweet {
  rank: number;
  id: string;
  text: string;
  author: string;
  likes: number;
  retweets: number;
  replies: number;
  views: number;
  created_at: string;
  url: string;
}

export interface XUser {
  rank: number;
  username: string;
  name: string;
  followers: number;
  following: number;
  tweets: number;
  bio: string;
  verified: string;
  url: string;
}

function buildTweetUrl(username: string, tweetId: string): string {
  return `https://twitter.com/${username}/status/${tweetId}`;
}

function mapTweet(tweet: Record<string, unknown>, author: Record<string, unknown>, index: number): XTweet {
  const metrics = tweet['public_metrics'] as Record<string, number> | null ?? {};
  const username = String(author['username'] ?? '');
  const id = String(tweet['id'] ?? '');
  return {
    rank: index + 1,
    id,
    text: String(tweet['text'] ?? '').replace(/\n/g, ' ').slice(0, 200),
    author: username,
    likes: metrics['like_count'] ?? 0,
    retweets: metrics['retweet_count'] ?? 0,
    replies: metrics['reply_count'] ?? 0,
    views: (tweet['non_public_metrics'] as Record<string, number> | null)?.['impression_count'] ?? 0,
    created_at: String(tweet['created_at'] ?? '').slice(0, 10),
    url: buildTweetUrl(username, id),
  };
}

/** Search recent tweets (last 7 days) */
export async function searchTweets(
  query: string,
  limit: number,
  account?: string,
  dataDir?: string
): Promise<XTweet[]> {
  const creds = await loadXCredentials(account, dataDir);
  const params = new URLSearchParams({
    query,
    max_results: String(Math.min(limit, 100)),
    'tweet.fields': 'created_at,public_metrics,author_id',
    'user.fields': 'username,name',
    'expansions': 'author_id',
  });

  const data = await xRequest<{
    data?: Record<string, unknown>[];
    includes?: { users?: Record<string, unknown>[] };
  }>(`/2/tweets/search/recent?${params}`, {
    creds: creds ?? undefined,
  });

  const tweets = data.data ?? [];
  const users = data.includes?.users ?? [];
  const userMap: Record<string, Record<string, unknown>> = {};
  for (const u of users) {
    userMap[String(u['id'])] = u;
  }

  return tweets.slice(0, limit).map((t, i) => {
    const author = userMap[String(t['author_id'])] ?? {};
    return mapTweet(t, author, i);
  });
}

/** Get a user's timeline (most recent tweets) */
export async function getUserTimeline(
  username: string,
  limit: number,
  account?: string,
  dataDir?: string
): Promise<XTweet[]> {
  const creds = await loadXCredentials(account, dataDir);

  // First get user ID
  const userResp = await xRequest<{ data: { id: string; username: string } }>(
    `/2/users/by/username/${username}?user.fields=id,username`,
    { creds: creds ? { authToken: creds.authToken!, ct0: creds.ct0! } : undefined }
  );
  const userId = userResp.data.id;

  const params = new URLSearchParams({
    max_results: String(Math.min(limit, 100)),
    'tweet.fields': 'created_at,public_metrics',
    exclude: 'retweets,replies',
  });

  const data = await xRequest<{ data?: Record<string, unknown>[] }>(
    `/2/users/${userId}/tweets?${params}`,
    { creds: creds ? { authToken: creds.authToken!, ct0: creds.ct0! } : undefined }
  );

  const tweets = data.data ?? [];
  return tweets.slice(0, limit).map((t, i) => mapTweet(t, { username }, i));
}

/** Get a user's profile */
export async function getUserProfile(
  username: string,
  account?: string,
  dataDir?: string
): Promise<XUser | null> {
  const creds = await loadXCredentials(account, dataDir);
  const params = 'user.fields=description,public_metrics,verified,entities';

  const data = await xRequest<{ data?: Record<string, unknown> }>(
    `/2/users/by/username/${username}?${params}`,
    { creds: creds ? { authToken: creds.authToken!, ct0: creds.ct0! } : undefined }
  );

  const u = data.data;
  if (!u) return null;

  const metrics = u['public_metrics'] as Record<string, number> | null ?? {};
  return {
    rank: 1,
    username: String(u['username'] ?? ''),
    name: String(u['name'] ?? ''),
    followers: metrics['followers_count'] ?? 0,
    following: metrics['following_count'] ?? 0,
    tweets: metrics['tweet_count'] ?? 0,
    bio: String(u['description'] ?? '').slice(0, 160),
    verified: String(u['verified'] ?? false),
    url: `https://twitter.com/${u['username']}`,
  };
}

/** Get home timeline (requires auth) */
export async function getHomeTimeline(
  limit: number,
  account?: string,
  dataDir?: string
): Promise<XTweet[]> {
  const creds = await loadXCredentials(account, dataDir);
  if (!creds?.authToken) {
    throw new Error('Home timeline requires X authentication. Run: crossmind auth login x');
  }

  const params = new URLSearchParams({
    max_results: String(Math.min(limit, 100)),
    'tweet.fields': 'created_at,public_metrics,author_id',
    'user.fields': 'username,name',
    'expansions': 'author_id',
  });

  const data = await xRequest<{
    data?: Record<string, unknown>[];
    includes?: { users?: Record<string, unknown>[] };
  }>(`/2/timelines/home?${params}`, {
    creds: { authToken: creds.authToken!, ct0: creds.ct0! },
  });

  const tweets = data.data ?? [];
  const users = data.includes?.users ?? [];
  const userMap: Record<string, Record<string, unknown>> = {};
  for (const u of users) {
    userMap[String(u['id'])] = u;
  }

  return tweets.slice(0, limit).map((t, i) => {
    const author = userMap[String(t['author_id'])] ?? {};
    return mapTweet(t, author, i);
  });
}
