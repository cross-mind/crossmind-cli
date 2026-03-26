# crossmind

[![npm version](https://img.shields.io/npm/v/crossmind)](https://www.npmjs.com/package/crossmind)
[![npm downloads](https://img.shields.io/npm/dm/crossmind)](https://www.npmjs.com/package/crossmind)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Agent-native CLI for 15 social platforms. Token-efficient output, multi-account, built-in safety policies.

```bash
npm install -g crossmind
```

> **Don't want to manage the CLI yourself?** [crossmind.io](https://crossmind.io) runs the full growth strategy autonomously — no setup, no scripts, just results.

## Why crossmind

Most social CLIs are built for humans. crossmind is built for AI agents:

- **Compact output by default** — single-line `key:value` format, no emoji, no decorative whitespace
- **`--json` for structured pipelines** — clean arrays with no outer wrapper
- **No-auth first** — public platforms work out of the box, no configuration required
- **Built-in write safety** — daily limits, random jitter delays, exponential backoff

## Token Benchmark

Measured on `x search "AI agent" 10` against raw X GraphQL JSON output (the format agents would otherwise consume):

| Format | Bytes | Approx tokens | vs raw |
|--------|-------|---------------|--------|
| Raw X GraphQL JSON | 15,568 | ~3,892 | baseline |
| `crossmind x search` (compact) | 2,663 | ~666 | **−83%** |
| `crossmind x search --json` | 4,687 | ~1,172 | **−70%** |

Per tweet: raw GraphQL response averages 1,556 bytes (full JSON object with author, metrics, urls, media, timestamps). crossmind compact line averages 266 bytes — ~5.8× smaller.

The raw JSON is already stripped down from the full v2 REST response (no entities, no referenced_tweets, no full user objects). Against a raw API call with standard field expansions, the reduction is larger.

## Quick Start

```bash
# Public platforms — no auth required
crossmind hn top 10
crossmind reddit r MachineLearning 25 --sort top --time week
crossmind gh trending --lang typescript
crossmind arxiv search "transformer architecture" --cat cs.AI 10

# X (Twitter) — set OAuth token or cookie auth
export X_ACCESS_TOKEN=<your_oauth_token>
crossmind x home 10
crossmind x tweet "Hello from crossmind"

# Or authenticate interactively
crossmind auth login x
crossmind auth login reddit
crossmind auth login bsky --handle user.bsky.social --app-password <password>
```

## Output Format

Default: compact single-line, agent-friendly. No emoji, no abbreviations, full integers.

```
1. score:342 comments:87 Show HN: We built a CLI for 15 social platforms https://...
2. score:198 comments:44 Ask HN: What tools do you use for social data? https://...
```

Add `--json` for structured output:

```bash
crossmind hn top 5 --json
```

```json
[
  { "rank": 1, "score": 342, "comments": 87, "title": "Show HN: ...", "url": "https://..." }
]
```

## Platforms

| Command   | Platform        | Auth                    | Read | Write |
|-----------|-----------------|-------------------------|------|-------|
| `hn`      | Hacker News     | None                    | Yes  | No    |
| `lb`      | Lobsters        | None                    | Yes  | No    |
| `dev`     | DEV.to          | None                    | Yes  | No    |
| `so`      | Stack Overflow  | None                    | Yes  | No    |
| `arxiv`   | arXiv           | None                    | Yes  | No    |
| `gh`      | GitHub          | Optional PAT            | Yes  | No    |
| `ph`      | Product Hunt    | API key                 | Yes  | No    |
| `x`       | X (Twitter)     | Cookie / OAuth 2.0 PKCE | Yes  | Yes   |
| `reddit`  | Reddit          | OAuth 2.0 PKCE          | Yes  | Yes   |
| `bsky`    | Bluesky         | App password            | Yes  | Yes   |
| `yt`      | YouTube         | API key                 | Yes  | No    |
| `med`     | Medium          | None (RSS)              | Yes  | No    |
| `sub`     | Substack        | None (RSS)              | Yes  | No    |
| `ig`      | Instagram       | Cookie                  | Yes  | No    |
| `li`      | LinkedIn        | Cookie                  | Yes  | No    |

## Authentication

### X (Twitter) — How it works

X auth follows a priority chain:

1. **Cookie auth** (`auth_token` + `ct0`) — routes through the built-in `scripts/x-fetch.py` bridge, which uses `curl_cffi` Chrome TLS fingerprint impersonation. Enables full read access including home feed, bookmarks, and DM history.
2. **OAuth 2.0 token** (`X_ACCESS_TOKEN` or stored `accessToken`) — standard v2 REST API. Required for write operations (post, like, retweet, follow, DM send) and for reading likes.
3. **Public bearer** — no config needed. Supports search only.

**Env var overrides** (highest priority, checked before credential file):

| Env var              | Maps to      | Use case                            |
|----------------------|--------------|-------------------------------------|
| `X_ACCESS_TOKEN`     | `accessToken`| OAuth 2.0 token from crossmind.io or manual PKCE flow |
| `X_AUTH_TOKEN` | `authToken`  | Cookie extracted from browser       |
| `X_CT0`        | `ct0`        | CSRF token paired with auth_token   |

If `X_ACCESS_TOKEN` is missing or expired, commands that require OAuth will exit with:
```
Error: X OAuth token missing or expired. Set X_ACCESS_TOKEN or run: crossmind auth login x
```

**Cookie auth** (manual extraction from browser):
```bash
crossmind auth login x --auth-token <auth_token> --ct0 <ct0>
# Get from browser DevTools → Application → Cookies → twitter.com

# Or use automated extraction:
crossmind extract-cookie x
```

**OAuth 2.0 PKCE** (opens browser):
```bash
export X_CLIENT_ID=your_app_client_id
crossmind auth login x
```

### Reddit

OAuth 2.0 PKCE flow (opens browser):
```bash
export REDDIT_CLIENT_ID=your_client_id
crossmind auth login reddit
```

Or extract session cookies directly from browser (no app registration needed):
```bash
crossmind extract-cookie reddit           # opens Playwright browser, saves reddit_session
```

### Bluesky

App password (Settings → Privacy and Security → App Passwords):
```bash
crossmind auth login bsky --handle yourhandle.bsky.social --app-password xxxx-xxxx-xxxx-xxxx
```

### GitHub

Personal access token (optional, increases rate limit from 60 → 5000 req/hr):
```bash
crossmind auth login gh --token ghp_xxxxxxxxxxxx
```

### YouTube

Google API key (console.cloud.google.com → YouTube Data API v3):
```bash
crossmind auth login yt --token AIzaSy...
```

### Instagram

Browser cookie extraction (opens Playwright browser):
```bash
crossmind extract-cookie instagram
```

### LinkedIn

For posting (`li post`), provide an OAuth access token:
```bash
# Inject via env var (agent-friendly):
export LINKEDIN_ACCESS_TOKEN=<token>

# Or save to credential store:
crossmind auth login linkedin --access-token <token>
```

For read operations (profile, feed), extract session cookies:
```bash
crossmind extract-cookie linkedin
```

## Commands Reference

### Hacker News (`hn`)

```bash
crossmind hn top [limit]         # Top stories
crossmind hn new [limit]         # Newest stories
crossmind hn ask [limit]         # Ask HN
crossmind hn show [limit]        # Show HN
crossmind hn jobs [limit]        # Job postings
```

### Lobsters (`lb`)

```bash
crossmind lb top [limit]         # Hottest stories
crossmind lb new [limit]         # Newest stories
crossmind lb hottest [limit]     # Hottest (24h)
```

### DEV.to (`dev`)

```bash
crossmind dev top [limit]                # Top articles (past week)
crossmind dev latest [limit]             # Latest articles
crossmind dev search <query> [limit]     # Search by tag/keyword
```

### Stack Overflow (`so`)

```bash
crossmind so top [limit]                           # Top questions by votes
crossmind so search <query> [limit]                # Search questions
crossmind so trending [limit]                      # Most active today
crossmind so top [limit] --tag javascript          # Filter by tag
```

### arXiv (`arxiv`)

```bash
crossmind arxiv search <query> [limit] --cat cs.AI  # Search papers
crossmind arxiv recent [limit] --cat cs.LG          # Recent by category
```

Categories: `cs.AI`, `cs.LG`, `cs.CL`, `cs.CV`, `stat.ML`, `math.OC`, etc.

### GitHub (`gh`)

```bash
crossmind gh search <query> [limit] --sort stars    # Search repos
crossmind gh trending [limit] --lang python         # Trending repos
crossmind gh issues <owner/repo> [limit]            # List issues
crossmind gh releases <owner/repo> [limit]          # List releases
```

### Product Hunt (`ph`)

```bash
crossmind ph top [limit] --date 2024-01-15   # Top products by date
crossmind ph search <query> [limit]           # Search products
```

### X / Twitter (`x`)

```bash
# Read (cookie auth preferred, falls back to v2 REST)
crossmind x search <query> [limit]              # Search recent tweets
crossmind x timeline <username> [limit]         # User timeline
crossmind x home [limit]                        # Home feed (auth required)
crossmind x profile <username>                  # User profile
crossmind x thread <tweet_id> [limit]           # Tweet + reply thread
crossmind x followers <username> [limit]        # User's followers
crossmind x following <username> [limit]        # Accounts user follows
crossmind x bookmarks [limit]                   # Your bookmarks (cookie)
crossmind x list <list_id> [limit]              # Tweets from a List
crossmind x likes <username> [limit]            # User's liked tweets (OAuth)
crossmind x dm-list [limit]                     # Recent DM events (OAuth)
crossmind x dm-conversation <username> [limit]  # DM history with user (OAuth)

# Write (OAuth required)
crossmind x tweet <text>
crossmind x reply <tweet_id> <text>
crossmind x like <tweet_id>
crossmind x unlike <tweet_id>
crossmind x retweet <tweet_id>
crossmind x unretweet <tweet_id>
crossmind x quote <tweet_id> <text>
crossmind x follow <username>
crossmind x unfollow <username>
crossmind x dm <username> <text>
crossmind x delete <tweet_id>
crossmind x bookmark <tweet_id>     # cookie + curl_cffi required
crossmind x unbookmark <tweet_id>   # cookie + curl_cffi required
```

### Reddit (`reddit`)

```bash
# Read (public API — no auth required)
crossmind reddit r <subreddit> [limit] --sort hot --time day
crossmind reddit search <query> [limit] --sub MachineLearning
crossmind reddit comments <subreddit> <post_id> [limit]
crossmind reddit popular [limit]                 # r/popular feed
crossmind reddit all [limit]                     # r/all feed
crossmind reddit sub-info <subreddit>            # Subreddit metadata
crossmind reddit user <username>                 # User profile
crossmind reddit user-posts <username> [limit]   # User's posts
crossmind reddit user-comments <username> [limit] # User's comments
crossmind reddit read <post_id>                  # Post + top comments

# Read (OAuth required)
crossmind reddit home [limit]                    # Your front page
crossmind reddit saved [limit]                   # Your saved posts

# Write (OAuth required)
crossmind reddit comment <parent_id> <text>      # parent_id: t3_xxx or t1_xxx
crossmind reddit upvote <id>
crossmind reddit downvote <id>
crossmind reddit save <id>
crossmind reddit subscribe <subreddit>
crossmind reddit post <subreddit> <title> <url>       # Link post
crossmind reddit text-post <subreddit> <title> <text>  # Text post
crossmind reddit crosspost <target_sub> <post_id>
```

### Bluesky (`bsky`)

```bash
# Read
crossmind bsky timeline [limit]
crossmind bsky search <query> [limit]
crossmind bsky feed <handle> [limit]
crossmind bsky profile <handle>

# Write (requires app password)
crossmind bsky post <text>
crossmind bsky reply <post_uri> <post_cid> <text>
crossmind bsky like <post_uri> <post_cid>
crossmind bsky repost <post_uri> <post_cid>
crossmind bsky follow <handle>
crossmind bsky delete <uri>
```

### YouTube (`yt`)

```bash
crossmind yt search <query> [limit]     # Search videos (API key required)
crossmind yt channel <channel_id>       # Channel info
```

### Medium (`med`)

```bash
crossmind med feed <publication> [limit]    # Publication feed
crossmind med profile <username> [limit]    # User's posts
crossmind med tag <tag> [limit]             # Posts by tag
```

### Substack (`sub`)

```bash
crossmind sub feed <newsletter> [limit]     # Newsletter posts (e.g. "lenny")
crossmind sub latest <newsletter> [limit]   # Latest posts
```

### Instagram (`ig`)

```bash
crossmind ig profile <username>             # User profile
crossmind ig posts <username> [limit]       # Recent posts
```

### LinkedIn (`li`)

```bash
crossmind li post "text content"            # Post (requires LINKEDIN_ACCESS_TOKEN or stored OAuth token)
crossmind li profile <username>             # Profile (URL username, requires cookie auth)
crossmind li feed [limit]                   # Home feed (requires cookie auth)
```

## Account Management

```bash
crossmind account list [platform]           # List all accounts
crossmind account use <platform> <name>     # Set default account
crossmind account remove <platform> <name>  # Remove credentials
crossmind account show <platform> [name]    # Show credential info

crossmind auth status                       # Auth status for all platforms
crossmind auth logout <platform> [name]     # Remove credentials
```

## Multi-Account Support

```bash
# Save multiple X accounts
crossmind auth login x work --auth-token <token1> --ct0 <ct0_1>
crossmind auth login x personal --auth-token <token2> --ct0 <ct0_2>

# Use a specific account
crossmind x tweet "Work tweet" --account work
crossmind x timeline elonmusk --account personal

# Set default
crossmind account use x work
```

## Data Directory

Credentials and daily write limits are stored in `~/.crossmind/` by default.

Override per-command:
```bash
crossmind x tweet "hello" --data-dir /tmp/crossmind-test
```

Or set globally:
```bash
export CROSSMIND_DATA_DIR=/path/to/data
```

## Migrating from OpenClaw

If you're using OpenClaw and want a lighter path for programmatic social access:

| | crossmind-cli | OpenClaw |
|---|---|---|
| Install | `npm install -g crossmind` | Agent config + workflow setup |
| Output | Token-efficient single-line or `--json` | JSON |
| Write safety | Built-in daily limits + jitter | Manual configuration |
| No-auth platforms | Works out of the box (HN, Reddit read, GitHub, arXiv) | Requires connector setup |
| Managed option | [crossmind.io](https://crossmind.io) — zero config, full strategy | — |

crossmind-cli handles the transport layer. If you want the strategy layer too — deciding what to post, where to engage, how to follow up — [crossmind.io](https://crossmind.io) runs that autonomously on top.

## Safety Policies

Write operations have multi-layer protection to prevent account bans:

| Protection       | Details                                                    |
|------------------|------------------------------------------------------------|
| Daily limits     | Per-operation caps (post: 10/day, reply: 30, like: 100)    |
| Random jitter    | 1.5–4s random delay between write ops                      |
| Exponential backoff | Auto-retry with backoff on 429 rate limit responses     |
| OAuth writes     | All writes use official OAuth API paths, not UI simulation |
| Revocable tokens | OAuth tokens can be revoked independently from the account |

## How X Auth Works Internally

```
crossmind x home
    │
    ├─ loadXCredentials()
    │   ├─ reads ~/.crossmind/accounts/x/<name>.json
    │   └─ merges env vars (X_ACCESS_TOKEN, X_AUTH_TOKEN, X_CT0)
    │
    ├─ hasCookieAuth? (authToken + ct0)
    │   └─ YES → x-fetch.py bridge (Python curl_cffi, Chrome TLS)
    │              └─ x.com/i/api/graphql (GraphQL, full feed)
    │
    └─ accessToken? (OAuth)
        └─ YES → xRequest() → api.twitter.com/2/timelines/home
        └─ NO  → error: "Set X_ACCESS_TOKEN or run: crossmind auth login x"
```

The bundled `scripts/x-fetch.py` handles X's Chrome TLS fingerprint check. Without it, Node.js's native `fetch()` is rejected by X's bot detection. When the bridge is unavailable, the CLI falls back to the v2 REST API.

## Runtime Dependencies

For X cookie-auth commands (home feed, bookmarks, DMs):
```bash
uv pip install curl_cffi
# or: pip install curl_cffi
```

Verify:
```bash
crossmind auth status
```

## Requirements

- Node.js 20+
- pnpm or npm
- For X cookie reads: Python 3 with `curl_cffi` (`uv pip install curl_cffi`)

## License

MIT
