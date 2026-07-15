/**
 * Reddit platform commands.
 * Read: subreddit, popular, all, search, comments, post, sub-info, user, user-posts, user-comments, home, saved
 * Write: comment, vote, save, subscribe, unsubscribe, post, text-post, crosspost, delete
 */

import { Command } from 'commander';
import {
  getSubreddit, searchReddit, getPostComments,
  getPopular, getAll, getSubredditInfo, getRedditUserProfile,
  getUserPosts, getUserComments, getPost, getHomeFeed, getSaved,
} from './read.js';
import { submitComment, vote, saveItem, deleteItem, subscribeSubreddit, submitPost, submitTextPost, crosspost } from './write.js';
import type { RedditWriteResult } from './write.js';
import { printOutput, printJsonResult, printJsonError } from '../../output/formatter.js';

const POST_TEMPLATE = '{rank}. r/{subreddit} score:{score} comments:{comments} [{flair}] {title} — {url}';
const COMMENT_TEMPLATE = '{rank}. u/{author.username} score:{score} — {body} {url}';
const SUBINFO_TEMPLATE = '{name} subscribers:{subscribers} active:{active_users} — {description} {url}';
const USER_TEMPLATE = '{rank}. u/{username} post_karma:{karma_post} comment_karma:{karma_comment} — {url}';

/** Drop the human-readable `message` line so it doesn't leak into --json output. */
function stripMessage(r: RedditWriteResult): Omit<RedditWriteResult, 'message'> {
  const { message, ...rest } = r; // eslint-disable-line @typescript-eslint/no-unused-vars
  return rest;
}

export function registerReddit(program: Command): void {
  const reddit = program
    .command('reddit')
    .description('Reddit — subreddits, search, comment, vote, subscribe, user profiles, home feed')
    .addHelpText('after', `

Auth requirements:
  No auth:          r, search, comments, popular, all, user, user-posts, user-comments, read
  Cookie:           home, saved, comment, upvote, downvote, save, subscribe, unsubscribe, post, text-post, crosspost, delete

  Get cookie:  crossmind extract-cookie reddit
`);

  // ── Read commands ──────────────────────────────────────────────

  reddit
    .command('r <subreddit> [limit]')
    .description('Browse a subreddit')
    .option('--sort <sort>', 'Sort: hot, new, top, rising (default: hot)', 'hot')
    .option('--time <time>', 'Time filter for top: hour, day, week, month, year, all (default: day)', 'day')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--proxy <url>', 'SOCKS5/HTTP proxy URL (e.g. socks5h://user:pass@host:port)')
    .option('--json', 'Output as JSON array')
    .action(async (
      subreddit: string,
      limitArg: string | undefined,
      opts: { sort: string; time: string; account?: string; dataDir?: string; proxy?: string; json?: boolean }
    ) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 25;
      try {
        const items = await getSubreddit(subreddit, opts.sort as 'hot', limit, opts.time as 'day', opts.account, opts.dataDir, opts.proxy);
        printOutput(items as unknown as Record<string, unknown>[], POST_TEMPLATE, `reddit/r/${subreddit}`, start, { json: opts.json });
      } catch (err) {
        if (opts.json) printJsonError(err, `reddit/r/${subreddit}`);
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  reddit
    .command('search <query> [limit]')
    .description('Search Reddit posts')
    .option('--sub, --subreddit <subreddit>', 'Restrict search to a subreddit')
    .option('--sort <sort>', 'Sort: relevance, new, top, comments (default: relevance)', 'relevance')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--proxy <url>', 'SOCKS5/HTTP proxy URL (e.g. socks5h://user:pass@host:port)')
    .option('--json', 'Output as JSON array')
    .action(async (
      query: string,
      limitArg: string | undefined,
      opts: { sub?: string; sort: string; account?: string; dataDir?: string; proxy?: string; json?: boolean }
    ) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 25;
      try {
        const items = await searchReddit(query, opts.sub, opts.sort as 'relevance', limit, opts.account, opts.dataDir, opts.proxy);
        printOutput(items as unknown as Record<string, unknown>[], POST_TEMPLATE, 'reddit/search', start, { json: opts.json });
      } catch (err) {
        if (opts.json) printJsonError(err, "reddit/search");
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  reddit
    .command('comments <subreddit> <post_id> [limit]')
    .description('Get comments for a post (post_id from URL, e.g. abc123)')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--proxy <url>', 'SOCKS5/HTTP proxy URL (e.g. socks5h://user:pass@host:port)')
    .option('--json', 'Output as JSON array')
    .action(async (
      subreddit: string,
      postId: string,
      limitArg: string | undefined,
      opts: { account?: string; dataDir?: string; proxy?: string; json?: boolean }
    ) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 25;
      try {
        const items = await getPostComments(subreddit, postId, limit, opts.account, opts.dataDir, opts.proxy);
        printOutput(items as unknown as Record<string, unknown>[], COMMENT_TEMPLATE, `reddit/comments/${postId}`, start, { json: opts.json });
      } catch (err) {
        if (opts.json) printJsonError(err, `reddit/comments/${postId}`);
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  reddit
    .command('popular [limit]')
    .description('Browse /r/popular')
    .option('--sort <sort>', 'Sort: hot, new, top, rising', 'hot')
    .option('--time <time>', 'Time filter for top', 'day')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--proxy <url>', 'SOCKS5/HTTP proxy URL (e.g. socks5h://user:pass@host:port)')
    .option('--json', 'Output as JSON array')
    .action(async (limitArg: string | undefined, opts: { sort: string; time: string; account?: string; dataDir?: string; proxy?: string; json?: boolean }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 25;
      try {
        const items = await getPopular(opts.sort as 'hot', limit, opts.time as 'day', opts.account, opts.dataDir, opts.proxy);
        printOutput(items as unknown as Record<string, unknown>[], POST_TEMPLATE, 'reddit/popular', start, { json: opts.json });
      } catch (err) {
        if (opts.json) printJsonError(err, "reddit/popular");
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  reddit
    .command('all [limit]')
    .description('Browse /r/all')
    .option('--sort <sort>', 'Sort: hot, new, top, rising', 'hot')
    .option('--time <time>', 'Time filter for top', 'day')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--proxy <url>', 'SOCKS5/HTTP proxy URL (e.g. socks5h://user:pass@host:port)')
    .option('--json', 'Output as JSON array')
    .action(async (limitArg: string | undefined, opts: { sort: string; time: string; account?: string; dataDir?: string; proxy?: string; json?: boolean }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 25;
      try {
        const items = await getAll(opts.sort as 'hot', limit, opts.time as 'day', opts.account, opts.dataDir, opts.proxy);
        printOutput(items as unknown as Record<string, unknown>[], POST_TEMPLATE, 'reddit/all', start, { json: opts.json });
      } catch (err) {
        if (opts.json) printJsonError(err, "reddit/all");
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  reddit
    .command('sub-info <subreddit>')
    .description('Get subreddit metadata (subscribers, description)')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--json', 'Output as JSON')
    .action(async (subreddit: string, opts: { account?: string; dataDir?: string; json?: boolean }) => {
      const start = Date.now();
      try {
        const info = await getSubredditInfo(subreddit, opts.account, opts.dataDir);
        printOutput([info] as unknown as Record<string, unknown>[], SUBINFO_TEMPLATE, `reddit/sub-info/${subreddit}`, start, { json: opts.json });
      } catch (err) {
        if (opts.json) printJsonError(err, `reddit/sub-info/${subreddit}`);
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  reddit
    .command('user <username>')
    .description('Get a Reddit user profile')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--proxy <url>', 'SOCKS5/HTTP proxy URL (e.g. socks5h://user:pass@host:port)')
    .option('--json', 'Output as JSON')
    .action(async (username: string, opts: { account?: string; dataDir?: string; proxy?: string; json?: boolean }) => {
      const start = Date.now();
      try {
        const profile = await getRedditUserProfile(username, opts.account, opts.dataDir, opts.proxy);
        printOutput([profile] as unknown as Record<string, unknown>[], USER_TEMPLATE, `reddit/user/${username}`, start, { json: opts.json });
      } catch (err) {
        if (opts.json) printJsonError(err, `reddit/user/${username}`);
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  reddit
    .command('user-posts <username> [limit]')
    .description("Get a user's submitted posts")
    .option('--sort <sort>', 'Sort: hot, new, top', 'new')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--proxy <url>', 'SOCKS5/HTTP proxy URL (e.g. socks5h://user:pass@host:port)')
    .option('--json', 'Output as JSON array')
    .action(async (username: string, limitArg: string | undefined, opts: { sort: string; account?: string; dataDir?: string; proxy?: string; json?: boolean }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 25;
      try {
        const items = await getUserPosts(username, opts.sort as 'new', limit, opts.account, opts.dataDir, opts.proxy);
        printOutput(items as unknown as Record<string, unknown>[], POST_TEMPLATE, `reddit/user-posts/${username}`, start, { json: opts.json });
      } catch (err) {
        if (opts.json) printJsonError(err, `reddit/user-posts/${username}`);
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  reddit
    .command('user-comments <username> [limit]')
    .description("Get a user's comments")
    .option('--sort <sort>', 'Sort: hot, new, top', 'new')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--json', 'Output as JSON array')
    .action(async (username: string, limitArg: string | undefined, opts: { sort: string; account?: string; dataDir?: string; json?: boolean }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 25;
      try {
        const items = await getUserComments(username, opts.sort as 'new', limit, opts.account, opts.dataDir);
        printOutput(items as unknown as Record<string, unknown>[], COMMENT_TEMPLATE, `reddit/user-comments/${username}`, start, { json: opts.json });
      } catch (err) {
        if (opts.json) printJsonError(err, `reddit/user-comments/${username}`);
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  reddit
    .command('read <post_id> [limit]')
    .description('Read a post with its top-level comments (post_id: bare ID or t3_xxx)')
    .option('--sort <sort>', 'Comment sort: best, top, new, controversial, old', 'best')
    .option('--full', 'Return full post body and complete comment text without truncation')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--proxy <url>', 'SOCKS5/HTTP proxy URL (e.g. socks5h://user:pass@host:port)')
    .option('--json', 'Output as JSON')
    .action(async (postId: string, limitArg: string | undefined, opts: { sort: string; full?: boolean; account?: string; dataDir?: string; proxy?: string; json?: boolean }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 25;
      try {
        const detail = await getPost(postId, opts.sort as 'best', limit, opts.account, opts.dataDir, opts.proxy, opts.full);
        if (opts.json) {
          printJsonResult(detail, `reddit/read/${postId}`, { startTime: start });
        } else {
          printOutput([detail.post] as unknown as Record<string, unknown>[], POST_TEMPLATE, `reddit/post/${postId}`, start, {});
          if (detail.post.selftext) {
            console.log(`\n${detail.post.selftext}\n`);
          }
          if (detail.comments.length > 0) {
            printOutput(detail.comments as unknown as Record<string, unknown>[], COMMENT_TEMPLATE, '', start, {});
          }
        }
      } catch (err) {
        if (opts.json) printJsonError(err, `reddit/read/${postId}`);
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  reddit
    .command('home [limit]')
    .description('Get authenticated home feed (requires auth)')
    .option('--sort <sort>', 'Sort: hot, new, top, rising', 'hot')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--proxy <url>', 'SOCKS5/HTTP proxy URL (e.g. socks5h://user:pass@host:port)')
    .option('--json', 'Output as JSON array')
    .action(async (limitArg: string | undefined, opts: { sort: string; account?: string; dataDir?: string; proxy?: string; json?: boolean }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 25;
      try {
        const items = await getHomeFeed(opts.sort as 'hot', limit, opts.account, opts.dataDir, opts.proxy);
        printOutput(items as unknown as Record<string, unknown>[], POST_TEMPLATE, 'reddit/home', start, { json: opts.json });
      } catch (err) {
        if (opts.json) printJsonError(err, "reddit/home");
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  reddit
    .command('saved [limit]')
    .description("Get your saved posts (requires auth)")
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--json', 'Output as JSON array')
    .action(async (limitArg: string | undefined, opts: { account?: string; dataDir?: string; json?: boolean }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 25;
      try {
        const items = await getSaved(limit, opts.account, opts.dataDir);
        printOutput(items as unknown as Record<string, unknown>[], POST_TEMPLATE, 'reddit/saved', start, { json: opts.json });
      } catch (err) {
        if (opts.json) printJsonError(err, "reddit/saved");
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  // ── Write commands ─────────────────────────────────────────────

  reddit
    .command('comment <parent_id> <text>')
    .description('Submit a comment (parent_id: t3_<post_id> or t1_<comment_id>)')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('-f, --force', 'Skip duplicate content check')
    .option('--proxy <url>', 'HTTP proxy URL (e.g. http://user:pass@host:port)')
    .option('--json', 'Output structured result as JSON')
    .action(async (parentId: string, text: string, opts: { account?: string; dataDir?: string; force?: boolean; proxy?: string; json?: boolean }) => {
      try {
        const result = await submitComment(parentId, text, opts.account, opts.dataDir, !!opts.force, opts.proxy);
        if (opts.json) printJsonResult(stripMessage(result), 'reddit/comment');
        else console.log(result.message);
      } catch (err) {
        if (opts.json) printJsonError(err, 'reddit/comment');
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  reddit
    .command('upvote <id>')
    .description('Upvote a post or comment (fullname: t3_xxx or t1_xxx)')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--proxy <url>', 'HTTP proxy URL (e.g. http://user:pass@host:port)')
    .option('--json', 'Output structured result as JSON')
    .action(async (id: string, opts: { account?: string; dataDir?: string; proxy?: string; json?: boolean }) => {
      try {
        const result = await vote(id, 1, opts.account, opts.dataDir, opts.proxy);
        if (opts.json) printJsonResult(stripMessage(result), 'reddit/upvote');
        else console.log(result.message);
      } catch (err) {
        if (opts.json) printJsonError(err, 'reddit/upvote');
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  reddit
    .command('downvote <id>')
    .description('Downvote a post or comment')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--proxy <url>', 'HTTP proxy URL (e.g. http://user:pass@host:port)')
    .option('--json', 'Output structured result as JSON')
    .action(async (id: string, opts: { account?: string; dataDir?: string; proxy?: string; json?: boolean }) => {
      try {
        const result = await vote(id, -1, opts.account, opts.dataDir, opts.proxy);
        if (opts.json) printJsonResult(stripMessage(result), 'reddit/downvote');
        else console.log(result.message);
      } catch (err) {
        if (opts.json) printJsonError(err, 'reddit/downvote');
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  reddit
    .command('save <id>')
    .description('Save a post or comment')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--proxy <url>', 'HTTP proxy URL (e.g. http://user:pass@host:port)')
    .option('--json', 'Output structured result as JSON')
    .action(async (id: string, opts: { account?: string; dataDir?: string; proxy?: string; json?: boolean }) => {
      try {
        const result = await saveItem(id, opts.account, opts.dataDir, opts.proxy);
        if (opts.json) printJsonResult(stripMessage(result), 'reddit/save');
        else console.log(result.message);
      } catch (err) {
        if (opts.json) printJsonError(err, 'reddit/save');
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  reddit
    .command('subscribe <subreddit>')
    .description('Subscribe to a subreddit')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--proxy <url>', 'HTTP proxy URL (e.g. http://user:pass@host:port)')
    .option('--json', 'Output structured result as JSON')
    .action(async (subreddit: string, opts: { account?: string; dataDir?: string; proxy?: string; json?: boolean }) => {
      try {
        const result = await subscribeSubreddit(subreddit, 'sub', opts.account, opts.dataDir, opts.proxy);
        if (opts.json) printJsonResult(stripMessage(result), 'reddit/subscribe');
        else console.log(result.message);
      } catch (err) {
        if (opts.json) printJsonError(err, 'reddit/subscribe');
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  reddit
    .command('unsubscribe <subreddit>')
    .description('Unsubscribe from a subreddit')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--proxy <url>', 'HTTP proxy URL (e.g. http://user:pass@host:port)')
    .option('--json', 'Output structured result as JSON')
    .action(async (subreddit: string, opts: { account?: string; dataDir?: string; proxy?: string; json?: boolean }) => {
      try {
        const result = await subscribeSubreddit(subreddit, 'unsub', opts.account, opts.dataDir, opts.proxy);
        if (opts.json) printJsonResult(stripMessage(result), 'reddit/unsubscribe');
        else console.log(result.message);
      } catch (err) {
        if (opts.json) printJsonError(err, 'reddit/unsubscribe');
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  reddit
    .command('post <subreddit> <title> <url>')
    .description('Submit a link post to a subreddit')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('-f, --force', 'Skip duplicate content check')
    .option('--proxy <url>', 'HTTP proxy URL (e.g. http://user:pass@host:port)')
    .option('--json', 'Output structured result as JSON')
    .action(async (subreddit: string, title: string, url: string, opts: { account?: string; dataDir?: string; force?: boolean; proxy?: string; json?: boolean }) => {
      try {
        const result = await submitPost(subreddit, title, url, opts.account, opts.dataDir, !!opts.force, opts.proxy);
        if (opts.json) printJsonResult(stripMessage(result), 'reddit/post');
        else console.log(result.message);
      } catch (err) {
        if (opts.json) printJsonError(err, 'reddit/post');
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  reddit
    .command('text-post <subreddit> <title> <text>')
    .description('Submit a text (self) post to a subreddit')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('-f, --force', 'Skip duplicate content check')
    .option('--proxy <url>', 'HTTP proxy URL (e.g. http://user:pass@host:port)')
    .option('--json', 'Output structured result as JSON')
    .action(async (subreddit: string, title: string, text: string, opts: { account?: string; dataDir?: string; force?: boolean; proxy?: string; json?: boolean }) => {
      try {
        const result = await submitTextPost(subreddit, title, text, opts.account, opts.dataDir, !!opts.force, opts.proxy);
        if (opts.json) printJsonResult(stripMessage(result), 'reddit/text-post');
        else console.log(result.message);
      } catch (err) {
        if (opts.json) printJsonError(err, 'reddit/text-post');
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  reddit
    .command('crosspost <target_sub> <post_id> <title>')
    .description('Crosspost to another subreddit (post_id: bare ID or t3_xxx)')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('-f, --force', 'Skip duplicate content check')
    .option('--proxy <url>', 'HTTP proxy URL (e.g. http://user:pass@host:port)')
    .option('--json', 'Output structured result as JSON')
    .action(async (targetSub: string, postId: string, title: string, opts: { account?: string; dataDir?: string; force?: boolean; proxy?: string; json?: boolean }) => {
      try {
        const result = await crosspost(targetSub, postId, title, opts.account, opts.dataDir, !!opts.force, opts.proxy);
        if (opts.json) printJsonResult(stripMessage(result), 'reddit/crosspost');
        else console.log(result.message);
      } catch (err) {
        if (opts.json) printJsonError(err, 'reddit/crosspost');
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  reddit
    .command('delete <fullname>')
    .description('Delete your own post or comment (fullname: t3_<postId> or t1_<commentId>)')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--proxy <url>', 'HTTP proxy URL (e.g. http://user:pass@host:port)')
    .option('--json', 'Output structured result as JSON')
    .action(async (fullname: string, opts: { account?: string; dataDir?: string; proxy?: string; json?: boolean }) => {
      try {
        const result = await deleteItem(fullname, opts.account, opts.dataDir, opts.proxy);
        if (opts.json) printJsonResult(stripMessage(result), 'reddit/delete');
        else console.log(result.message);
      } catch (err) {
        if (opts.json) printJsonError(err, 'reddit/delete');
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
