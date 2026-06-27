#!/usr/bin/env python3
"""
Reddit cookie-auth API client with Chrome TLS fingerprinting.

Uses curl_cffi for JA3/JA4 Chrome impersonation — required because Reddit
rejects Node.js/OpenSSL TLS fingerprints with 403.

Env vars (required):
  REDDIT_SESSION   - reddit_session cookie value
  REDDIT_CSRF      - csrf_token cookie value (optional but recommended)
  REDDIT_LOID      - loid cookie value (optional but recommended)
  REDDIT_MODHASH   - modhash for write operations (optional, fetched from /api/me.json if not provided)
  REDDIT_PROXY     - HTTP/HTTPS proxy URL, e.g. http://user:pass@host:port (optional)

Usage:
  reddit-fetch.py me
  reddit-fetch.py home [--count N]
  reddit-fetch.py saved [--count N]
  reddit-fetch.py subreddit <name> [--sort hot|new|top] [--count N]
  reddit-fetch.py user <username>
  reddit-fetch.py user-posts <username> [--count N]
  reddit-fetch.py post <subreddit> <title> <body>
  reddit-fetch.py comment <parent_id> <text>
  reddit-fetch.py upvote <fullname>
  reddit-fetch.py downvote <fullname>
  reddit-fetch.py save <fullname>
  reddit-fetch.py subscribe <subreddit>

Output: JSON {"ok": true|false, "data": ..., "error": {"message": "..."}}
"""

from __future__ import annotations

import json
import os
import sys
import urllib.parse
from typing import Any, Dict, List, Optional

# ── curl_cffi import (auto-install on first use) ────────────────────────────

try:
    from curl_cffi import requests as cffi_requests
except ImportError:
    import subprocess
    try:
        subprocess.check_call(['uv', 'pip', 'install', 'curl_cffi', '-q'], stderr=sys.stderr)
    except (FileNotFoundError, subprocess.CalledProcessError):
        subprocess.check_call(
            [sys.executable, '-m', 'pip', 'install', 'curl_cffi', '-q'],
            stderr=sys.stderr,
        )
    from curl_cffi import requests as cffi_requests

# ── Constants ────────────────────────────────────────────────────────────────

REDDIT_API = "https://www.reddit.com"
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"

# ── Session Management ───────────────────────────────────────────────────────

_session: Optional[cffi_requests.Session] = None
_modhash: Optional[str] = None
_username: Optional[str] = None


def _get_session() -> cffi_requests.Session:
    """Get or create a curl_cffi session with Chrome impersonation."""
    global _session
    if _session is None:
        proxy = os.environ.get("REDDIT_PROXY")
        kwargs: Dict[str, Any] = {}
        if proxy:
            kwargs["proxies"] = {"http": proxy, "https": proxy}
        _session = cffi_requests.Session(**kwargs)
    return _session


def _get_cookies() -> Dict[str, str]:
    """Build cookies dict from env vars. Session is optional for public read-only requests."""
    cookies = {}

    session = os.environ.get("REDDIT_SESSION")
    if session:
        cookies["reddit_session"] = session

    csrf = os.environ.get("REDDIT_CSRF")
    if csrf:
        cookies["csrf_token"] = csrf

    loid = os.environ.get("REDDIT_LOID")
    if loid:
        cookies["loid"] = loid

    return cookies


def _get_headers() -> Dict[str, str]:
    """Build headers for Reddit API requests."""
    return {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
    }


def _get_modhash() -> Optional[str]:
    """Get modhash from env or fetch from /api/me.json."""
    global _modhash, _username

    # Try env var first
    modhash = os.environ.get("REDDIT_MODHASH")
    if modhash:
        return modhash

    # Fetch from API
    if _modhash is None:
        try:
            me = fetch_me()
            _modhash = me.get("modhash")
            _username = me.get("name")
        except Exception:
            pass

    return _modhash


def _request(method: str, path: str, **kwargs) -> Dict[str, Any]:
    """Make an authenticated request to Reddit API."""
    session = _get_session()
    cookies = _get_cookies()
    headers = _get_headers()

    url = f"{REDDIT_API}{path}"

    # Merge headers
    if "headers" in kwargs:
        headers.update(kwargs["headers"])
    kwargs["headers"] = headers

    # Merge cookies
    if "cookies" in kwargs:
        cookies.update(kwargs["cookies"])
    kwargs["cookies"] = cookies

    # Set timeout
    if "timeout" not in kwargs:
        kwargs["timeout"] = 30

    resp = session.request(method, url, **kwargs)

    # Check for errors
    if resp.status_code >= 400:
        try:
            error_body = resp.text[:500]
        except:
            error_body = "Unknown error"
        raise ValueError(f"HTTP {resp.status_code}: {error_body}")

    return resp.json()


# ── API Functions ────────────────────────────────────────────────────────────

def fetch_me() -> Dict[str, Any]:
    """Get current user info including modhash."""
    data = _request("GET", "/api/me.json")
    return data.get("data", {})


def fetch_home(count: int = 25) -> List[Dict[str, Any]]:
    """Get home feed."""
    data = _request("GET", f"/hot.json?limit={count}")
    children = data.get("data", {}).get("children", [])
    return [c.get("data", {}) for c in children]


def fetch_saved(count: int = 25) -> List[Dict[str, Any]]:
    """Get saved posts."""
    # First get username
    me = fetch_me()
    username = me.get("name")
    if not username:
        raise ValueError("Could not determine username")

    data = _request("GET", f"/user/{username}/saved.json?limit={count}")
    children = data.get("data", {}).get("children", [])
    return [c.get("data", {}) for c in children]


def fetch_subreddit(name: str, sort: str = "hot", count: int = 25) -> List[Dict[str, Any]]:
    """Get posts from a subreddit."""
    data = _request("GET", f"/r/{name}/{sort}.json?limit={count}")
    children = data.get("data", {}).get("children", [])
    return [c.get("data", {}) for c in children]


def fetch_user(username: str) -> Dict[str, Any]:
    """Get user profile."""
    data = _request("GET", f"/user/{username}/about.json")
    return data.get("data", {})


def fetch_user_posts(username: str, count: int = 25) -> List[Dict[str, Any]]:
    """Get user's posts."""
    data = _request("GET", f"/user/{username}/submitted.json?limit={count}")
    children = data.get("data", {}).get("children", [])
    return [c.get("data", {}) for c in children]


def fetch_search(query: str, subreddit: Optional[str] = None, sort: str = "relevance", count: int = 25) -> List[Dict[str, Any]]:
    """Search Reddit posts. Optionally scoped to a subreddit."""
    encoded = urllib.parse.quote(query)
    if subreddit:
        path = f"/r/{subreddit}/search.json?q={encoded}&sort={sort}&limit={count}&restrict_sr=true"
    else:
        path = f"/search.json?q={encoded}&sort={sort}&limit={count}&restrict_sr=false"
    data = _request("GET", path)
    children = data.get("data", {}).get("children", [])
    return [c.get("data", {}) for c in children]


def fetch_post(subreddit: str, post_id: str, count: int = 25) -> Dict[str, Any]:
    """Get post with comments. Subreddit can be empty to use /comments/<id> directly."""
    if subreddit:
        path = f"/r/{subreddit}/comments/{post_id}.json?limit={count}"
    else:
        path = f"/comments/{post_id}.json?limit={count}"
    data = _request("GET", path)
    if isinstance(data, list) and len(data) >= 1:
        post = data[0].get("data", {}).get("children", [{}])[0].get("data", {})
        comments = []
        if len(data) >= 2:
            comments = [c.get("data", {}) for c in data[1].get("data", {}).get("children", [])]
        return {"post": post, "comments": comments}
    return {"post": {}, "comments": []}


# ── Write Operations ──────────────────────────────────────────────────────────

def post_text(subreddit: str, title: str, body: str) -> Dict[str, Any]:
    """Submit a text post."""
    modhash = _get_modhash()
    if not modhash:
        raise ValueError("Modhash required for posting. Set REDDIT_MODHASH or ensure session has write access.")

    data = _request(
        "POST",
        "/api/submit",
        data={
            "api_type": "json",
            "sr": subreddit,
            "title": title,
            "text": body,
            "kind": "self",
            "uh": modhash,
        }
    )
    return data


def post_comment(parent_id: str, text: str) -> Dict[str, Any]:
    """Submit a comment."""
    modhash = _get_modhash()
    if not modhash:
        raise ValueError("Modhash required for commenting.")

    data = _request(
        "POST",
        "/api/comment",
        data={
            "api_type": "json",
            "parent": parent_id,
            "text": text,
            "uh": modhash,
        }
    )
    return data


def vote(fullname: str, direction: int) -> Dict[str, Any]:
    """Vote on a post or comment. direction: 1=up, -1=down, 0=unvote."""
    modhash = _get_modhash()
    if not modhash:
        raise ValueError("Modhash required for voting.")

    data = _request(
        "POST",
        "/api/vote",
        data={
            "id": fullname,
            "dir": str(direction),
            "uh": modhash,
        }
    )
    return data


def save_item(fullname: str) -> Dict[str, Any]:
    """Save a post or comment."""
    modhash = _get_modhash()
    if not modhash:
        raise ValueError("Modhash required for saving.")

    data = _request(
        "POST",
        "/api/save",
        data={
            "id": fullname,
            "uh": modhash,
        }
    )
    return data


def subscribe_subreddit(subreddit: str) -> Dict[str, Any]:
    """Subscribe to a subreddit."""
    modhash = _get_modhash()
    if not modhash:
        raise ValueError("Modhash required for subscribing.")

    data = _request(
        "POST",
        "/api/subscribe",
        data={
            "sr_name": subreddit,
            "action": "sub",
            "uh": modhash,
        }
    )
    return data


def unsubscribe_subreddit(subreddit: str) -> Dict[str, Any]:
    """Unsubscribe from a subreddit."""
    modhash = _get_modhash()
    if not modhash:
        raise ValueError("Modhash required for unsubscribing.")

    data = _request(
        "POST",
        "/api/subscribe",
        data={
            "sr_name": subreddit,
            "action": "unsub",
            "uh": modhash,
        }
    )
    return data


def delete_item(fullname: str) -> Dict[str, Any]:
    """Delete a post or comment authored by the current user."""
    modhash = _get_modhash()
    if not modhash:
        raise ValueError("Modhash required for deleting.")

    data = _request(
        "POST",
        "/api/del",
        data={
            "id": fullname,
            "uh": modhash,
        }
    )
    return data


def post_link(subreddit: str, title: str, url: str) -> Dict[str, Any]:
    """Submit a link post."""
    modhash = _get_modhash()
    if not modhash:
        raise ValueError("Modhash required for posting.")

    data = _request(
        "POST",
        "/api/submit",
        data={
            "api_type": "json",
            "sr": subreddit,
            "title": title,
            "url": url,
            "kind": "link",
            "resubmit": "true",
            "uh": modhash,
        }
    )
    return data


def crosspost_item(subreddit: str, title: str, crosspost_fullname: str) -> Dict[str, Any]:
    """Crosspost to another subreddit."""
    modhash = _get_modhash()
    if not modhash:
        raise ValueError("Modhash required for crossposting.")

    data = _request(
        "POST",
        "/api/submit",
        data={
            "api_type": "json",
            "sr": subreddit,
            "title": title,
            "crosspost_fullname": crosspost_fullname,
            "kind": "crosspost",
            "resubmit": "true",
            "uh": modhash,
        }
    )
    return data


# ── CLI Entry Point ───────────────────────────────────────────────────────────

def _output(data: Any, ok: bool = True) -> None:
    """Print JSON output."""
    print(json.dumps({"ok": ok, "data": data}))


def _error(message: str) -> None:
    """Print error JSON."""
    print(json.dumps({"ok": False, "error": {"message": message}}))


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]
    args = sys.argv[2:]

    try:
        if cmd == "me":
            me = fetch_me()
            _output(me)

        elif cmd == "home":
            count = 25
            if "--count" in args:
                idx = args.index("--count")
                count = int(args[idx + 1])
            posts = fetch_home(count)
            _output(posts)

        elif cmd == "saved":
            count = 25
            if "--count" in args:
                idx = args.index("--count")
                count = int(args[idx + 1])
            posts = fetch_saved(count)
            _output(posts)

        elif cmd == "subreddit":
            if len(args) < 1:
                _error("Usage: reddit-fetch.py subreddit <name> [--sort hot|new|top] [--count N]")
                sys.exit(1)
            name = args[0]
            sort = "hot"
            count = 25
            if "--sort" in args:
                idx = args.index("--sort")
                sort = args[idx + 1]
            if "--count" in args:
                idx = args.index("--count")
                count = int(args[idx + 1])
            posts = fetch_subreddit(name, sort, count)
            _output(posts)

        elif cmd == "user":
            if len(args) < 1:
                _error("Usage: reddit-fetch.py user <username>")
                sys.exit(1)
            user = fetch_user(args[0])
            _output(user)

        elif cmd == "user-posts":
            if len(args) < 1:
                _error("Usage: reddit-fetch.py user-posts <username> [--count N]")
                sys.exit(1)
            username = args[0]
            count = 25
            if "--count" in args:
                idx = args.index("--count")
                count = int(args[idx + 1])
            posts = fetch_user_posts(username, count)
            _output(posts)

        elif cmd == "search":
            if len(args) < 1:
                _error("Usage: reddit-fetch.py search <query> [--subreddit NAME] [--sort relevance|new|top|comments] [--count N]")
                sys.exit(1)
            query = args[0]
            subreddit = None
            sort = "relevance"
            count = 25
            if "--subreddit" in args:
                idx = args.index("--subreddit")
                subreddit = args[idx + 1]
            if "--sort" in args:
                idx = args.index("--sort")
                sort = args[idx + 1]
            if "--count" in args:
                idx = args.index("--count")
                count = int(args[idx + 1])
            posts = fetch_search(query, subreddit, sort, count)
            _output(posts)

        elif cmd == "read-post":
            if len(args) < 2:
                _error("Usage: reddit-fetch.py read-post <subreddit> <post_id> [--count N]")
                sys.exit(1)
            subreddit = args[0]
            post_id = args[1]
            count = 25
            if "--count" in args:
                idx = args.index("--count")
                count = int(args[idx + 1])
            result = fetch_post(subreddit, post_id, count)
            _output(result)

        elif cmd == "post":
            if len(args) < 3:
                _error("Usage: reddit-fetch.py post <subreddit> <title> <body>")
                sys.exit(1)
            result = post_text(args[0], args[1], args[2])
            _output(result)

        elif cmd == "comment":
            if len(args) < 2:
                _error("Usage: reddit-fetch.py comment <parent_id> <text>")
                sys.exit(1)
            result = post_comment(args[0], args[1])
            _output(result)

        elif cmd == "upvote":
            if len(args) < 1:
                _error("Usage: reddit-fetch.py upvote <fullname>")
                sys.exit(1)
            result = vote(args[0], 1)
            _output(result)

        elif cmd == "downvote":
            if len(args) < 1:
                _error("Usage: reddit-fetch.py downvote <fullname>")
                sys.exit(1)
            result = vote(args[0], -1)
            _output(result)

        elif cmd == "save":
            if len(args) < 1:
                _error("Usage: reddit-fetch.py save <fullname>")
                sys.exit(1)
            result = save_item(args[0])
            _output(result)

        elif cmd == "subscribe":
            if len(args) < 1:
                _error("Usage: reddit-fetch.py subscribe <subreddit>")
                sys.exit(1)
            result = subscribe_subreddit(args[0])
            _output(result)

        elif cmd == "unsubscribe":
            if len(args) < 1:
                _error("Usage: reddit-fetch.py unsubscribe <subreddit>")
                sys.exit(1)
            result = unsubscribe_subreddit(args[0])
            _output(result)

        elif cmd == "delete":
            if len(args) < 1:
                _error("Usage: reddit-fetch.py delete <fullname>")
                sys.exit(1)
            result = delete_item(args[0])
            _output(result)

        elif cmd == "link-post":
            if len(args) < 3:
                _error("Usage: reddit-fetch.py link-post <subreddit> <title> <url>")
                sys.exit(1)
            result = post_link(args[0], args[1], args[2])
            _output(result)

        elif cmd == "crosspost":
            if len(args) < 3:
                _error("Usage: reddit-fetch.py crosspost <subreddit> <title> <crosspost_fullname>")
                sys.exit(1)
            result = crosspost_item(args[0], args[1], args[2])
            _output(result)

        else:
            _error(f"Unknown command: {cmd}")
            sys.exit(1)

    except Exception as e:
        _error(str(e))
        sys.exit(1)


if __name__ == "__main__":
    main()