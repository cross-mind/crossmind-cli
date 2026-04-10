/**
 * X (Twitter) platform commands.
 * Read: search, mentions, timeline, home, profile, thread, followers, following, bookmarks, notifications, list, likes, dm-list, dm-conversation
 * Write: tweet, article, reply, like, unlike, retweet, unretweet, quote, follow, unfollow, bookmark, unbookmark, dm, delete, delete-batch
 */

import { Command } from 'commander';
import {
  searchTweets, getUserTimeline, getUserProfile, getHomeTimeline,
  getTweet, getFollowers, getFollowing, getBookmarks, getNotifications, getListTweets, getLikes,
  getDMList, getDMConversation, getAnalytics,
} from './read.js';
import {
  postTweet, postArticle, replyToTweet, likeTweet, retweetTweet, followUser, sendDM, deleteTweet,
  deleteTweets,
  quoteTweet, unlikeTweet, unretweetTweet, unfollowUser, bookmarkTweet, unbookmarkTweet,
  uploadMedia,
} from './write.js';
import { printOutput } from '../../output/formatter.js';

const TWEET_TEMPLATE = '{rank}. @{author} likes:{likes} rt:{retweets} replies:{replies} — {text} {url}';
const USER_TEMPLATE = '{rank}. @{username} ({name}) followers:{followers} following:{following} tweets:{tweets} — {bio}';
const DM_TEMPLATE = '{rank}. @{sender} [{created_at}] — {text}';
const DM_CONVO_TEMPLATE = '{rank}. @{sender}→@{recipient} [{created_at}] — {text}';
const ANALYTICS_TEMPLATE = '{rank}. {created_at} imp:{views} eng:{engagements} clk:{profile_clicks} lk:{likes} rp:{replies} — {text}';

export function registerX(program: Command): void {
  const x = program
    .command('x')
    .description('X (Twitter) — search, mentions, notifications, timeline, post, reply, like, follow, dm, bookmarks, lists, DMs')
    .addHelpText('after', `

Auth requirements:
  Cookie (auth_token + ct0):   bookmarks, notifications, bookmark/unbookmark, article, reply (fallback), delete
  OAuth (access_token):        tweet, reply, DM, like, follow, analytics, dm-list, delete (fallback)
  Public bearer:               search only

  article also requires an active X Premium subscription.

  Get cookie:  crossmind extract-cookie x
  Get OAuth:   crossmind auth login x --access-token <token>
`);

  // ── Read commands ──────────────────────────────────────────────

  x
    .command('search <query> [limit]')
    .description('Search recent tweets (last 7 days)')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--json', 'Output as JSON array')
    .action(async (query: string, limitArg: string | undefined, opts: { account?: string; dataDir?: string; json?: boolean }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 20;
      try {
        const items = await searchTweets(query, limit, opts.account, opts.dataDir);
        printOutput(items as unknown as Record<string, unknown>[], TWEET_TEMPLATE, 'x/search', start, { json: opts.json });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  x
    .command('mentions <username> [limit]')
    .description('Get recent @mentions and replies to a user (last 7 days)')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--json', 'Output as JSON array')
    .action(async (username: string, limitArg: string | undefined, opts: { account?: string; dataDir?: string; json?: boolean }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 20;
      try {
        const items = await searchTweets(`to:${username}`, limit, opts.account, opts.dataDir);
        printOutput(items as unknown as Record<string, unknown>[], TWEET_TEMPLATE, `x/mentions/${username}`, start, { json: opts.json });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  x
    .command('timeline <username> [limit]')
    .description("Get a user's recent tweets")
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--json', 'Output as JSON array')
    .action(async (username: string, limitArg: string | undefined, opts: { account?: string; dataDir?: string; json?: boolean }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 20;
      try {
        const items = await getUserTimeline(username, limit, opts.account, opts.dataDir);
        printOutput(items as unknown as Record<string, unknown>[], TWEET_TEMPLATE, `x/timeline/${username}`, start, { json: opts.json });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  x
    .command('home [limit]')
    .description('Home timeline (requires auth)')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--json', 'Output as JSON array')
    .action(async (limitArg: string | undefined, opts: { account?: string; dataDir?: string; json?: boolean }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 20;
      try {
        const items = await getHomeTimeline(limit, opts.account, opts.dataDir);
        printOutput(items as unknown as Record<string, unknown>[], TWEET_TEMPLATE, 'x/home', start, { json: opts.json });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  x
    .command('profile <username>')
    .description("Get a user's profile")
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--json', 'Output as JSON array')
    .action(async (username: string, opts: { account?: string; dataDir?: string; json?: boolean }) => {
      const start = Date.now();
      try {
        const user = await getUserProfile(username, opts.account, opts.dataDir);
        if (!user) {
          console.error(`User @${username} not found.`);
          process.exit(1);
        }
        printOutput([user] as unknown as Record<string, unknown>[], USER_TEMPLATE, `x/profile/${username}`, start, { json: opts.json });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  x
    .command('thread <tweet_id> [limit]')
    .description('Get a tweet and its reply thread')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--json', 'Output as JSON')
    .action(async (tweetId: string, limitArg: string | undefined, opts: { account?: string; dataDir?: string; json?: boolean }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 20;
      try {
        const result = await getTweet(tweetId, limit, opts.account, opts.dataDir);
        const items = [result.tweet, ...result.thread];
        printOutput(items as unknown as Record<string, unknown>[], TWEET_TEMPLATE, `x/tweet/${tweetId}`, start, { json: opts.json });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  x
    .command('followers <username> [limit]')
    .description("Get a user's followers")
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--json', 'Output as JSON array')
    .action(async (username: string, limitArg: string | undefined, opts: { account?: string; dataDir?: string; json?: boolean }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 20;
      try {
        const items = await getFollowers(username, limit, opts.account, opts.dataDir);
        printOutput(items as unknown as Record<string, unknown>[], USER_TEMPLATE, `x/followers/${username}`, start, { json: opts.json });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  x
    .command('following <username> [limit]')
    .description('Get accounts a user follows')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--json', 'Output as JSON array')
    .action(async (username: string, limitArg: string | undefined, opts: { account?: string; dataDir?: string; json?: boolean }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 20;
      try {
        const items = await getFollowing(username, limit, opts.account, opts.dataDir);
        printOutput(items as unknown as Record<string, unknown>[], USER_TEMPLATE, `x/following/${username}`, start, { json: opts.json });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  x
    .command('bookmarks [limit]')
    .description('Get bookmarked tweets (requires cookie auth)')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--json', 'Output as JSON array')
    .action(async (limitArg: string | undefined, opts: { account?: string; dataDir?: string; json?: boolean }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 20;
      try {
        const items = await getBookmarks(limit, opts.account, opts.dataDir);
        printOutput(items as unknown as Record<string, unknown>[], TWEET_TEMPLATE, 'x/bookmarks', start, { json: opts.json });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  x
    .command('notifications [limit]')
    .description('Get notification timeline — replies, mentions, likes, retweets (requires cookie auth)')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--json', 'Output as JSON array')
    .action(async (limitArg: string | undefined, opts: { account?: string; dataDir?: string; json?: boolean }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 20;
      try {
        const items = await getNotifications(limit, opts.account, opts.dataDir);
        printOutput(items as unknown as Record<string, unknown>[], TWEET_TEMPLATE, 'x/notifications', start, { json: opts.json });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  x
    .command('list <list_id> [limit]')
    .description('Get tweets from a Twitter List')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--json', 'Output as JSON array')
    .action(async (listId: string, limitArg: string | undefined, opts: { account?: string; dataDir?: string; json?: boolean }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 20;
      try {
        const items = await getListTweets(listId, limit, opts.account, opts.dataDir);
        printOutput(items as unknown as Record<string, unknown>[], TWEET_TEMPLATE, `x/list/${listId}`, start, { json: opts.json });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  x
    .command('likes <username> [limit]')
    .description("Get a user's liked tweets")
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--json', 'Output as JSON array')
    .action(async (username: string, limitArg: string | undefined, opts: { account?: string; dataDir?: string; json?: boolean }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 20;
      try {
        const items = await getLikes(username, limit, opts.account, opts.dataDir);
        printOutput(items as unknown as Record<string, unknown>[], TWEET_TEMPLATE, `x/likes/${username}`, start, { json: opts.json });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  x
    .command('dm-list [limit]')
    .description('Get recent DM events (requires OAuth with dm.read scope)')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--json', 'Output as JSON array')
    .action(async (limitArg: string | undefined, opts: { account?: string; dataDir?: string; json?: boolean }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 20;
      try {
        const items = await getDMList(limit, opts.account, opts.dataDir);
        printOutput(items as unknown as Record<string, unknown>[], DM_TEMPLATE, 'x/dm-list', start, { json: opts.json });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  x
    .command('dm-conversation <username> [limit]')
    .description('Get DM conversation with a user (requires OAuth with dm.read scope)')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--json', 'Output as JSON array')
    .action(async (username: string, limitArg: string | undefined, opts: { account?: string; dataDir?: string; json?: boolean }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 20;
      try {
        const items = await getDMConversation(username, limit, opts.account, opts.dataDir);
        printOutput(items as unknown as Record<string, unknown>[], DM_CONVO_TEMPLATE, `x/dm/${username}`, start, { json: opts.json });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  // ── Analytics (OAuth only) ─────────────────────────────────────

  x
    .command('analytics <username> [limit]')
    .description('Get tweets with full analytics — impressions, engagements, profile clicks (requires OAuth)')
    .option('--include-replies', 'Include reply engagement (default: own tweets only)')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--json', 'Output as JSON array')
    .action(async (username: string, limitArg: string | undefined, opts: {
      includeReplies?: boolean; account?: string; dataDir?: string; json?: boolean;
    }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 20;
      try {
        const items = await getAnalytics(username, limit, !!opts.includeReplies, opts.account, opts.dataDir);
        printOutput(items as unknown as Record<string, unknown>[], ANALYTICS_TEMPLATE, `x/analytics/${username}`, start, { json: opts.json });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  // ── Write commands ─────────────────────────────────────────────

  x
    .command('tweet <text>')
    .description('Post a new tweet')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--media <paths...>', 'Attach image(s) (path or URL, multiple allowed)')
    .option('-f, --force', 'Skip duplicate content check')
    .action(async (text: string, opts: { account?: string; dataDir?: string; media?: string[]; force?: boolean }) => {
      try {
        let mediaIds: string[] | undefined;
        if (opts.media?.length) {
          mediaIds = [];
          for (const p of opts.media) {
            const id = await uploadMedia(p, opts.account, opts.dataDir);
            mediaIds.push(id);
          }
        }
        const result = await postTweet(text, opts.account, opts.dataDir, mediaIds, !!opts.force);
        console.log(result.message);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  x
    .command('article <text>')
    .description('Post an X Premium long-form article (requires cookie auth + X Premium)')
    .option('--title <title>', 'Article title (optional)')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('-f, --force', 'Skip duplicate content check')
    .action(async (text: string, opts: { title?: string; account?: string; dataDir?: string; force?: boolean }) => {
      try {
        const result = await postArticle(text, opts.account, opts.dataDir, opts.title, !!opts.force);
        console.log(result.message);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  x
    .command('reply <tweet_id> <text>')
    .description('Reply to a tweet')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--media <paths...>', 'Attach image(s) (path or URL, multiple allowed)')
    .option('-f, --force', 'Skip duplicate content check')
    .action(async (tweetId: string, text: string, opts: { account?: string; dataDir?: string; media?: string[]; force?: boolean }) => {
      try {
        let mediaIds: string[] | undefined;
        if (opts.media?.length) {
          mediaIds = [];
          for (const p of opts.media) {
            const id = await uploadMedia(p, opts.account, opts.dataDir);
            mediaIds.push(id);
          }
        }
        const result = await replyToTweet(text, tweetId, opts.account, opts.dataDir, mediaIds, !!opts.force);
        console.log(result.message);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  x
    .command('like <tweet_id>')
    .description('Like a tweet')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .action(async (tweetId: string, opts: { account?: string; dataDir?: string }) => {
      try {
        const result = await likeTweet(tweetId, opts.account, opts.dataDir);
        console.log(result.message);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  x
    .command('retweet <tweet_id>')
    .description('Retweet a tweet')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .action(async (tweetId: string, opts: { account?: string; dataDir?: string }) => {
      try {
        const result = await retweetTweet(tweetId, opts.account, opts.dataDir);
        console.log(result.message);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  x
    .command('follow <username>')
    .description('Follow a user')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .action(async (username: string, opts: { account?: string; dataDir?: string }) => {
      try {
        const result = await followUser(username, opts.account, opts.dataDir);
        console.log(result.message);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  x
    .command('dm <username> <text>')
    .description('Send a direct message')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('-f, --force', 'Skip duplicate content check')
    .action(async (username: string, text: string, opts: { account?: string; dataDir?: string; force?: boolean }) => {
      try {
        const result = await sendDM(username, text, opts.account, opts.dataDir, !!opts.force);
        console.log(result.message);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  x
    .command('delete <tweet_id>')
    .description('Delete a tweet')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .action(async (tweetId: string, opts: { account?: string; dataDir?: string }) => {
      try {
        const result = await deleteTweet(tweetId, opts.account, opts.dataDir);
        console.log(result.message);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  x
    .command('delete-batch <tweet_ids...>')
    .description('Delete multiple tweets (space-separated IDs). Prints a summary.')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--json', 'Output result as JSON')
    .action(async (tweetIds: string[], opts: { account?: string; dataDir?: string; json?: boolean }) => {
      try {
        const result = await deleteTweets(tweetIds, opts.account, opts.dataDir);
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        for (const id of result.deleted) {
          console.log(`deleted:${id}`);
        }
        for (const { id, error } of result.failed) {
          console.error(`failed:${id} — ${error}`);
        }
        console.log(`Summary: ${result.deleted.length} deleted, ${result.failed.length} failed`);
        if (result.failed.length > 0) {
          process.exit(1);
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  x
    .command('quote <tweet_id> <text>')
    .description('Quote-tweet')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('-f, --force', 'Skip duplicate content check')
    .action(async (tweetId: string, text: string, opts: { account?: string; dataDir?: string; force?: boolean }) => {
      try {
        const result = await quoteTweet(tweetId, text, opts.account, opts.dataDir, !!opts.force);
        console.log(result.message);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  x
    .command('unlike <tweet_id>')
    .description('Unlike a tweet')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .action(async (tweetId: string, opts: { account?: string; dataDir?: string }) => {
      try {
        const result = await unlikeTweet(tweetId, opts.account, opts.dataDir);
        console.log(result.message);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  x
    .command('unretweet <tweet_id>')
    .description('Undo a retweet')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .action(async (tweetId: string, opts: { account?: string; dataDir?: string }) => {
      try {
        const result = await unretweetTweet(tweetId, opts.account, opts.dataDir);
        console.log(result.message);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  x
    .command('unfollow <username>')
    .description('Unfollow a user')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .action(async (username: string, opts: { account?: string; dataDir?: string }) => {
      try {
        const result = await unfollowUser(username, opts.account, opts.dataDir);
        console.log(result.message);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  x
    .command('bookmark <tweet_id>')
    .description('Bookmark a tweet (requires cookie auth + Python curl_cffi)')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .action(async (tweetId: string, opts: { account?: string; dataDir?: string }) => {
      try {
        const result = await bookmarkTweet(tweetId, opts.account, opts.dataDir);
        console.log(result.message);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  x
    .command('unbookmark <tweet_id>')
    .description('Remove a bookmark (requires cookie auth + Python curl_cffi)')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .action(async (tweetId: string, opts: { account?: string; dataDir?: string }) => {
      try {
        const result = await unbookmarkTweet(tweetId, opts.account, opts.dataDir);
        console.log(result.message);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
