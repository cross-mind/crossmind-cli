/**
 * Reddit platform commands.
 * Read: subreddit, popular, all, search, comments, post, sub-info, user, user-posts, user-comments, home, saved
 * Write: comment, vote, save, subscribe, post, text-post, crosspost, delete
 */

import { Command } from 'commander';
import {
  getSubreddit, searchReddit, getPostComments,
  getPopular, getAll, getSubredditInfo, getRedditUserProfile,
  getUserPosts, getUserComments, getPost, getHomeFeed, getSaved,
} from './read.js';
import { submitComment, vote, saveItem, deleteItem, subscribeSubreddit, submitPost, submitTextPost, crosspost } from './write.js';
import { printOutput } from '../../output/formatter.js';

const POST_TEMPLATE = '{rank}. r/{subreddit} score:{score} comments:{comments} [{flair}] {title} — {url}';
const COMMENT_TEMPLATE = '{rank}. u/{author} score:{score} — {body} {url}';
const SUBINFO_TEMPLATE = '{name} subscribers:{subscribers} active:{active_users} — {description} {url}';
const USER_TEMPLATE = '{rank}. u/{username} post_karma:{karma_post} comment_karma:{karma_comment} — {url}';

export function registerReddit(program: Command): void {
  const reddit = program
    .command('reddit')
    .description('Reddit — subreddits, search, comment, vote, subscribe, user profiles, home feed')
    .addHelpText('after', `

Auth requirements:
  No auth:               r, search, comments, popular, all, user, user-posts, user-comments, read
  Cookie or OAuth:       home, saved
  OAuth:                 comment, upvote, downvote, save, subscribe, post, text-post, crosspost, delete

  Get cookie:  crossmind extract-cookie reddit
  Get OAuth:   crossmind auth login reddit (requires REDDIT_CLIENT_ID)
`);

  // ── Read commands ──────────────────────────────────────────────

  reddit
    .command('r <subreddit> [limit]')
    .description('Browse a subreddit')
    .option('--sort <sort>', 'Sort: hot, new, top, rising (default: hot)', 'hot')
    .option('--time <time>', 'Time filter for top: hour, day, week, month, year, all (default: day)', 'day')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--json', 'Output as JSON array')
    .action(async (
      subreddit: string,
      limitArg: string | undefined,
      opts: { sort: string; time: string; account?: string; dataDir?: string; json?: boolean }
    ) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 25;
      try {
        const items = await getSubreddit(subreddit, opts.sort as 'hot', limit, opts.time as 'day', opts.account, opts.dataDir);
        printOutput(items as unknown as Record<string, unknown>[], POST_TEMPLATE, `reddit/r/${subreddit}`, start, { json: opts.json });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  reddit
    .command('search <query> [limit]')
    .description('Search Reddit posts')
    .option('--sub <subreddit>', 'Restrict search to a subreddit')
    .option('--sort <sort>', 'Sort: relevance, new, top, comments (default: relevance)', 'relevance')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--json', 'Output as JSON array')
    .action(async (
      query: string,
      limitArg: string | undefined,
      opts: { sub?: string; sort: string; account?: string; dataDir?: string; json?: boolean }
    ) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 25;
      try {
        const items = await searchReddit(query, opts.sub, opts.sort as 'relevance', limit, opts.account, opts.dataDir);
        printOutput(items as unknown as Record<string, unknown>[], POST_TEMPLATE, 'reddit/search', start, { json: opts.json });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  reddit
    .command('comments <subreddit> <post_id> [limit]')
    .description('Get comments for a post (post_id from URL, e.g. abc123)')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--json', 'Output as JSON array')
    .action(async (
      subreddit: string,
      postId: string,
      limitArg: string | undefined,
      opts: { account?: string; dataDir?: string; json?: boolean }
    ) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 25;
      try {
        const items = await getPostComments(subreddit, postId, limit, opts.account, opts.dataDir);
        printOutput(items as unknown as Record<string, unknown>[], COMMENT_TEMPLATE, `reddit/comments/${postId}`, start, { json: opts.json });
      } catch (err) {
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
    .option('--json', 'Output as JSON array')
    .action(async (limitArg: string | undefined, opts: { sort: string; time: string; account?: string; dataDir?: string; json?: boolean }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 25;
      try {
        const items = await getPopular(opts.sort as 'hot', limit, opts.time as 'day', opts.account, opts.dataDir);
        printOutput(items as unknown as Record<string, unknown>[], POST_TEMPLATE, 'reddit/popular', start, { json: opts.json });
      } catch (err) {
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
    .option('--json', 'Output as JSON array')
    .action(async (limitArg: string | undefined, opts: { sort: string; time: string; account?: string; dataDir?: string; json?: boolean }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 25;
      try {
        const items = await getAll(opts.sort as 'hot', limit, opts.time as 'day', opts.account, opts.dataDir);
        printOutput(items as unknown as Record<string, unknown>[], POST_TEMPLATE, 'reddit/all', start, { json: opts.json });
      } catch (err) {
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
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  reddit
    .command('user <username>')
    .description('Get a Reddit user profile')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--json', 'Output as JSON')
    .action(async (username: string, opts: { account?: string; dataDir?: string; json?: boolean }) => {
      const start = Date.now();
      try {
        const profile = await getRedditUserProfile(username, opts.account, opts.dataDir);
        printOutput([profile] as unknown as Record<string, unknown>[], USER_TEMPLATE, `reddit/user/${username}`, start, { json: opts.json });
      } catch (err) {
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
    .option('--json', 'Output as JSON array')
    .action(async (username: string, limitArg: string | undefined, opts: { sort: string; account?: string; dataDir?: string; json?: boolean }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 25;
      try {
        const items = await getUserPosts(username, opts.sort as 'new', limit, opts.account, opts.dataDir);
        printOutput(items as unknown as Record<string, unknown>[], POST_TEMPLATE, `reddit/user-posts/${username}`, start, { json: opts.json });
      } catch (err) {
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
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  reddit
    .command('read <post_id> [limit]')
    .description('Read a post with its top-level comments (post_id: bare ID or t3_xxx)')
    .option('--sort <sort>', 'Comment sort: best, top, new, controversial, old', 'best')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .option('--json', 'Output as JSON')
    .action(async (postId: string, limitArg: string | undefined, opts: { sort: string; account?: string; dataDir?: string; json?: boolean }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 25;
      try {
        const detail = await getPost(postId, opts.sort as 'best', limit, opts.account, opts.dataDir);
        if (opts.json) {
          console.log(JSON.stringify(detail, null, 2));
        } else {
          printOutput([detail.post] as unknown as Record<string, unknown>[], POST_TEMPLATE, `reddit/post/${postId}`, start, {});
          if (detail.comments.length > 0) {
            printOutput(detail.comments as unknown as Record<string, unknown>[], COMMENT_TEMPLATE, '', start, {});
          }
        }
      } catch (err) {
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
    .option('--json', 'Output as JSON array')
    .action(async (limitArg: string | undefined, opts: { sort: string; account?: string; dataDir?: string; json?: boolean }) => {
      const start = Date.now();
      const limit = limitArg ? parseInt(limitArg, 10) : 25;
      try {
        const items = await getHomeFeed(opts.sort as 'hot', limit, opts.account, opts.dataDir);
        printOutput(items as unknown as Record<string, unknown>[], POST_TEMPLATE, 'reddit/home', start, { json: opts.json });
      } catch (err) {
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
    .action(async (parentId: string, text: string, opts: { account?: string; dataDir?: string; force?: boolean }) => {
      try {
        const result = await submitComment(parentId, text, opts.account, opts.dataDir, !!opts.force);
        console.log(result.message);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  reddit
    .command('upvote <id>')
    .description('Upvote a post or comment (fullname: t3_xxx or t1_xxx)')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .action(async (id: string, opts: { account?: string; dataDir?: string }) => {
      try {
        const result = await vote(id, 1, opts.account, opts.dataDir);
        console.log(result.message);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  reddit
    .command('downvote <id>')
    .description('Downvote a post or comment')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .action(async (id: string, opts: { account?: string; dataDir?: string }) => {
      try {
        const result = await vote(id, -1, opts.account, opts.dataDir);
        console.log(result.message);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  reddit
    .command('save <id>')
    .description('Save a post or comment')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .action(async (id: string, opts: { account?: string; dataDir?: string }) => {
      try {
        const result = await saveItem(id, opts.account, opts.dataDir);
        console.log(result.message);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  reddit
    .command('subscribe <subreddit>')
    .description('Subscribe to a subreddit')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .action(async (subreddit: string, opts: { account?: string; dataDir?: string }) => {
      try {
        const result = await subscribeSubreddit(subreddit, 'sub', opts.account, opts.dataDir);
        console.log(result.message);
      } catch (err) {
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
    .action(async (subreddit: string, title: string, url: string, opts: { account?: string; dataDir?: string; force?: boolean }) => {
      try {
        const result = await submitPost(subreddit, title, url, opts.account, opts.dataDir, !!opts.force);
        console.log(result.message);
      } catch (err) {
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
    .action(async (subreddit: string, title: string, text: string, opts: { account?: string; dataDir?: string; force?: boolean }) => {
      try {
        const result = await submitTextPost(subreddit, title, text, opts.account, opts.dataDir, !!opts.force);
        console.log(result.message);
      } catch (err) {
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
    .action(async (targetSub: string, postId: string, title: string, opts: { account?: string; dataDir?: string; force?: boolean }) => {
      try {
        const result = await crosspost(targetSub, postId, title, opts.account, opts.dataDir, !!opts.force);
        console.log(result.message);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  reddit
    .command('delete <fullname>')
    .description('Delete your own post or comment (fullname: t3_<postId> or t1_<commentId>)')
    .option('--account <name>', 'Account to use')
    .option('--data-dir <dir>', 'Data directory override')
    .action(async (fullname: string, opts: { account?: string; dataDir?: string }) => {
      try {
        const result = await deleteItem(fullname, opts.account, opts.dataDir);
        console.log(result.message);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
