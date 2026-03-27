#!/usr/bin/env python3
"""
X (Twitter) cookie-auth GraphQL client with Chrome TLS fingerprinting.

Uses curl_cffi for JA3/JA4 Chrome impersonation — required because X's
GraphQL endpoints reject Node.js/OpenSSL TLS fingerprints with 404.

Env vars (required for authenticated operations):
  X_AUTH_TOKEN  - auth_token cookie value
  X_CT0         - ct0 cookie value (CSRF token)

Usage:
  x-fetch.py feed [--count N]
  x-fetch.py search <query> [--count N]
  x-fetch.py user-posts <username> [--count N]
  x-fetch.py user <username>
  x-fetch.py tweet <tweet_id>
  x-fetch.py followers <username> [--count N]
  x-fetch.py following <username> [--count N]
  x-fetch.py bookmarks [--count N]
  x-fetch.py list <list_id> [--count N]
  x-fetch.py bookmark <tweet_id>
  x-fetch.py unbookmark <tweet_id>

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
    # Try uv first (faster, preferred); fall back to the stdlib pip module
    try:
        subprocess.check_call(['uv', 'pip', 'install', 'curl_cffi', '-q'], stderr=sys.stderr)
    except (FileNotFoundError, subprocess.CalledProcessError):
        subprocess.check_call(
            [sys.executable, '-m', 'pip', 'install', 'curl_cffi', '-q'],
            stderr=sys.stderr,
        )
    from curl_cffi import requests as cffi_requests

# ── x_client_transaction import (optional, from twitter-cli venv) ───────────
# Generates x-client-transaction-id header required by X's GraphQL endpoints.

import time

_CT_VENV = "/root/.local/share/uv/tools/twitter-cli/lib/python3.11/site-packages"
_client_transaction: Optional[Any] = None
_ct_initialized = False
_ct_cache_path = os.path.expanduser("~/.cache/x-fetch-ct.json")
_CT_TTL = 3600  # 1 hour


def _init_client_transaction() -> None:
    global _client_transaction, _ct_initialized
    if _ct_initialized:
        return
    _ct_initialized = True

    # Try cache first
    try:
        if os.path.exists(_ct_cache_path):
            with open(_ct_cache_path, encoding="utf-8") as f:
                cached = json.load(f)
            if time.time() - cached.get("ts", 0) < _CT_TTL:
                if _CT_VENV not in sys.path:
                    sys.path.insert(0, _CT_VENV)
                import bs4
                from x_client_transaction import ClientTransaction
                _client_transaction = ClientTransaction(
                    home_page_response=bs4.BeautifulSoup(cached["html"], "html.parser"),
                    ondemand_file_response=cached["ondemand"],
                )
                return
    except Exception:
        pass

    # Fetch fresh
    try:
        if _CT_VENV not in sys.path:
            sys.path.insert(0, _CT_VENV)
        import bs4
        from x_client_transaction import ClientTransaction
        from x_client_transaction.utils import generate_headers as _ct_gen_headers, get_ondemand_file_url
        s = _get_session()
        ct_hdrs = _ct_gen_headers()
        home = s.get("https://x.com", headers=ct_hdrs, timeout=15)
        soup = bs4.BeautifulSoup(home.content, "html.parser")
        od_url = get_ondemand_file_url(response=soup)
        od = s.get(od_url, headers=ct_hdrs, timeout=15)
        _client_transaction = ClientTransaction(
            home_page_response=soup,
            ondemand_file_response=od.text,
        )
        # Persist cache
        os.makedirs(os.path.dirname(_ct_cache_path), exist_ok=True)
        with open(_ct_cache_path, "w", encoding="utf-8") as f:
            json.dump({"html": home.text, "ondemand": od.text, "ts": time.time()}, f)
    except Exception:
        pass  # Silently degrade — requests work without CT-id on some endpoints


def _transaction_id(method: str, path: str) -> Optional[str]:
    _init_client_transaction()
    if _client_transaction is None:
        return None
    try:
        return _client_transaction.generate_transaction_id(method=method, path=path)
    except Exception:
        return None


def _out(ok: bool, data: Any, error_msg: Optional[str] = None) -> None:
    obj: Dict[str, Any] = {"ok": ok}
    if data is not None:
        obj["data"] = data
    if error_msg:
        obj["error"] = {"message": error_msg}
    print(json.dumps(obj, ensure_ascii=False))


# ── Credentials ─────────────────────────────────────────────────────────────

AUTH_TOKEN = os.environ.get("X_AUTH_TOKEN", "")
CT0 = os.environ.get("X_CT0", "")

BEARER = (
    "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs"
    "%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA"
)

# ── Query IDs ────────────────────────────────────────────────────────────────
# Fetched from X JS bundles; may rotate periodically.
# Self-heals via twitter-openapi fallback (see _resolve_query_id).

QUERY_IDS: Dict[str, str] = {
    "HomeTimeline":             "HCosKfLNW1AcOo3la3mMgg",
    "SearchTimeline":           "GcXk9vN_d1jUfHNqLacXQA",
    "UserTweets":               "E3opETHurmVJflFsUBVuUQ",
    "UserByScreenName":         "qRednkZG-rn1P6b48NINmQ",
    "TweetDetail":              "nBS-WpgA6ZG0CyNHD517JQ",
    "Followers":                "IOh4aS6UdGWGJUYTqliQ7Q",
    "Following":                "zx6e-TLzRkeDO_a7p4b3JQ",
    "Bookmarks":                "uzboyXSHSJrR-mGJqep0TQ",
    "ListLatestTweetsTimeline": "ZBbXrl0FVnTqp7K6EAADog",
    "CreateBookmark":           "aoDbu3RHznuiSkQ9aNM67Q",
    "DeleteBookmark":           "Wlmlj2-xISYCixDmuS8KNg",
    "CreateTweet":              "tTsjMKyhajZvK4q76mpIbg",
}

FEATURES: Dict[str, bool] = {
    "rweb_video_screen_enabled": False,
    "profile_label_improvements_pcf_label_in_post_enabled": True,
    "responsive_web_profile_redirect_enabled": False,
    "rweb_tipjar_consumption_enabled": False,
    "verified_phone_label_enabled": False,
    "creator_subscriptions_tweet_preview_api_enabled": True,
    "responsive_web_graphql_timeline_navigation_enabled": True,
    "responsive_web_graphql_skip_user_profile_image_extensions_enabled": False,
    "premium_content_api_read_enabled": False,
    "communities_web_enable_tweet_community_results_fetch": True,
    "c9s_tweet_anatomy_moderator_badge_enabled": True,
    "responsive_web_grok_analyze_button_fetch_trends_enabled": False,
    "responsive_web_grok_analyze_post_followups_enabled": True,
    "responsive_web_jetfuel_frame": True,
    "responsive_web_grok_share_attachment_enabled": True,
    "responsive_web_grok_annotations_enabled": True,
    "articles_preview_enabled": True,
    "responsive_web_edit_tweet_api_enabled": True,
    "graphql_is_translatable_rweb_tweet_is_translatable_enabled": True,
    "view_counts_everywhere_api_enabled": True,
    "longform_notetweets_consumption_enabled": True,
    "responsive_web_twitter_article_tweet_consumption_enabled": True,
    "content_disclosure_indicator_enabled": True,
    "content_disclosure_ai_generated_indicator_enabled": True,
    "responsive_web_grok_show_grok_translated_post": True,
    "responsive_web_grok_analysis_button_from_backend": True,
    "post_ctas_fetch_enabled": True,
    "freedom_of_speech_not_reach_fetch_enabled": True,
    "standardized_nudges_misinfo": True,
    "tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled": True,
    "longform_notetweets_rich_text_read_enabled": True,
    "longform_notetweets_inline_media_enabled": False,
    "responsive_web_grok_image_annotation_enabled": True,
    "responsive_web_grok_imagine_annotation_enabled": True,
    "responsive_web_grok_community_note_auto_translation_is_enabled": False,
    "responsive_web_enhance_cards_enabled": False,
}

# ── HTTP session ────────────────────────────────────────────────────────────

_session: Optional[cffi_requests.Session] = None

def _get_session() -> cffi_requests.Session:
    global _session
    if _session is None:
        _session = cffi_requests.Session(impersonate="chrome")
    return _session

def _retry_on_tls(fn: Any, max_retries: int = 2, delay: float = 2.0) -> Any:
    """Retry fn() on TLS/connection errors (curl_cffi sporadic failures).

    X's GraphQL bridge occasionally throws TLS handshake errors under high
    request frequency. A short pause + retry resolves them in practice.
    """
    for attempt in range(max_retries + 1):
        try:
            return fn()
        except Exception as exc:
            msg = str(exc).lower()
            is_network_err = any(k in msg for k in ("tls", "ssl", "connection", "openssl"))
            if is_network_err and attempt < max_retries:
                time.sleep(delay)
                continue
            raise

def _headers(path: Optional[str] = None, method: str = "GET") -> Dict[str, str]:
    h = {
        "authorization": f"Bearer {BEARER}",
        "content-type": "application/json",
        "x-csrf-token": CT0,
        "cookie": f"auth_token={AUTH_TOKEN}; ct0={CT0}",
        "x-twitter-auth-type": "OAuth2Session",
        "x-twitter-active-user": "yes",
        "x-twitter-client-language": "en",
        "referer": "https://x.com/",
        "origin": "https://x.com",
        "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    }
    if path:
        tid = _transaction_id(method, path)
        if tid:
            h["x-client-transaction-id"] = tid
    return h

# ── Query ID resolution ──────────────────────────────────────────────────────

_OPENAPI_URL = (
    "https://raw.githubusercontent.com/fa0311/"
    "twitter-openapi/refs/heads/main/src/config/placeholder.json"
)

def _resolve_query_id(operation: str, refresh: bool = False) -> str:
    """Return queryId, refreshing from community source if refresh=True."""
    if refresh:
        try:
            resp = _get_session().get(_OPENAPI_URL, headers={"user-agent": "curl/8.0"}, timeout=10)
            if resp.status_code == 200:
                data = resp.json()
                qid = data.get(operation, {}).get("queryId")
                if qid:
                    QUERY_IDS[operation] = qid
                    return qid
        except Exception:
            pass
    return QUERY_IDS.get(operation, "")

# ── GraphQL URL builder ──────────────────────────────────────────────────────

def _gql_url(operation: str, variables: Dict[str, Any], features: Optional[Dict[str, bool]] = None) -> str:
    qid = _resolve_query_id(operation)
    feat = dict(features or FEATURES)
    return (
        f"https://x.com/i/api/graphql/{qid}/{operation}"
        f"?variables={urllib.parse.quote(json.dumps(variables, separators=(',', ':')))}"
        f"&features={urllib.parse.quote(json.dumps(feat, separators=(',', ':')))}"
    )

def _gql_get(operation: str, variables: Dict[str, Any]) -> Dict[str, Any]:
    url = _gql_url(operation, variables)
    path = urllib.parse.urlparse(url).path
    resp = _retry_on_tls(lambda: _get_session().get(url, headers=_headers(path=path, method="GET"), timeout=20))
    if resp.status_code in (400, 403, 404):
        # Query ID may have rotated — refresh once
        _resolve_query_id(operation, refresh=True)
        url = _gql_url(operation, variables)
        path = urllib.parse.urlparse(url).path
        resp = _retry_on_tls(lambda: _get_session().get(url, headers=_headers(path=path, method="GET"), timeout=20))
    resp.raise_for_status()
    return resp.json()

def _gql_post(operation: str, variables: Dict[str, Any]) -> Dict[str, Any]:
    qid = _resolve_query_id(operation)
    url = f"https://x.com/i/api/graphql/{qid}/{operation}"
    path = f"/i/api/graphql/{qid}/{operation}"
    body = {"variables": variables, "queryId": qid}
    resp = _retry_on_tls(lambda: _get_session().post(url, headers=_headers(path=path, method="POST"), json=body, timeout=20))
    if resp.status_code in (400, 403, 404):
        _resolve_query_id(operation, refresh=True)
        qid = QUERY_IDS.get(operation, qid)
        url = f"https://x.com/i/api/graphql/{qid}/{operation}"
        path = f"/i/api/graphql/{qid}/{operation}"
        body["queryId"] = qid
        resp = _retry_on_tls(lambda: _get_session().post(url, headers=_headers(path=path, method="POST"), json=body, timeout=20))
    resp.raise_for_status()
    return resp.json()

# ── Response parsers ─────────────────────────────────────────────────────────

def _dig(obj: Any, *keys: str, default: Any = None) -> Any:
    for k in keys:
        if not isinstance(obj, dict):
            return default
        obj = obj.get(k)
        if obj is None:
            return default
    return obj

def _parse_tweet(result: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not result:
        return None
    if result.get("__typename") == "TweetWithVisibilityResults":
        result = result.get("tweet", result)
    if result.get("__typename") == "TweetTombstone":
        return None

    legacy = result.get("legacy") or {}
    core = result.get("core") or {}
    user_result = _dig(core, "user_results", "result") or {}
    # screen_name/name may be in user_result.core (new API) or user_result.legacy (old API)
    user_core = user_result.get("core") or {}
    user_legacy = user_result.get("legacy") or {}
    screen_name = user_core.get("screen_name") or user_legacy.get("screen_name", "")
    author_name = user_core.get("name") or user_legacy.get("name", "")
    views = result.get("views") or {}

    tweet_id = legacy.get("id_str") or result.get("rest_id") or ""

    return {
        "id": tweet_id,
        "text": legacy.get("full_text", ""),
        "author": {
            "screenName": screen_name,
            "name": author_name,
            "id": user_result.get("rest_id", ""),
        },
        "metrics": {
            "likes":     legacy.get("favorite_count", 0),
            "retweets":  legacy.get("retweet_count", 0),
            "replies":   legacy.get("reply_count", 0),
            "views":     int(views.get("count") or 0),
            "quotes":    legacy.get("quote_count", 0),
        },
        "createdAtISO": legacy.get("created_at", ""),
    }

def _parse_user(result: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not result:
        return None
    legacy = result.get("legacy") or {}
    return {
        "id":          result.get("rest_id", ""),
        "screenName":  legacy.get("screen_name", ""),
        "name":        legacy.get("name", ""),
        "description": legacy.get("description", ""),
        "followers":   legacy.get("followers_count", 0),
        "following":   legacy.get("friends_count", 0),
        "tweets":      legacy.get("statuses_count", 0),
        "verified":    legacy.get("verified", False) or legacy.get("is_blue_verified", False),
    }

def _extract_instructions(data: Dict[str, Any], path: List[str]) -> List[Dict[str, Any]]:
    node: Any = data
    for key in path:
        if not isinstance(node, dict):
            return []
        node = node.get(key)
        if node is None:
            return []
    if isinstance(node, list):
        return node
    return []

def _tweets_from_instructions(instructions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    tweets = []
    for inst in instructions:
        if inst.get("type") != "TimelineAddEntries":
            continue
        for entry in inst.get("entries", []):
            entry_id = entry.get("entryId", "")
            content = entry.get("content", {})
            item_content = content.get("itemContent", {})

            if entry_id.startswith("tweet-"):
                result = _dig(item_content, "tweet_results", "result")
                t = _parse_tweet(result)
                if t:
                    tweets.append(t)
            elif (entry_id.startswith("homeConversation-")
                  or entry_id.startswith("profile-conversation-")
                  or entry_id.startswith("conversationthread-")):
                # Conversation items contain a list of tweet items.
                # homeConversation-/profile-conversation- appear in timeline views;
                # conversationthread- appears in TweetDetail replies.
                for item in content.get("items", []):
                    inner = _dig(item, "item", "itemContent", "tweet_results", "result")
                    t = _parse_tweet(inner)
                    if t:
                        tweets.append(t)
    return tweets

def _users_from_instructions(instructions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    users = []
    for inst in instructions:
        if inst.get("type") != "TimelineAddEntries":
            continue
        for entry in inst.get("entries", []):
            entry_id = entry.get("entryId", "")
            if not entry_id.startswith("user-"):
                continue
            result = _dig(entry, "content", "itemContent", "user_results", "result")
            u = _parse_user(result)
            if u:
                users.append(u)
    return users

# ── Commands ─────────────────────────────────────────────────────────────────

def cmd_feed(count: int = 20) -> None:
    variables = {
        "count": count,
        "includePromotedContent": False,
        "latestControlAvailable": True,
        "requestContext": "launch",
        "withCommunity": True,
    }
    data = _gql_get("HomeTimeline", variables)
    instructions = _extract_instructions(
        data, ["data", "home", "home_timeline_urt", "instructions"]
    )
    tweets = _tweets_from_instructions(instructions)
    _out(True, tweets)

def cmd_search(query: str, count: int = 20) -> None:
    variables = {
        "rawQuery": query,
        "count": count,
        "querySource": "typed_query",
        "product": "Top",
        "withGrokTranslatedBio": False,
    }
    data = _gql_get("SearchTimeline", variables)
    instructions = _extract_instructions(
        data, ["data", "search_by_raw_query", "search_timeline", "timeline", "instructions"]
    )
    tweets = _tweets_from_instructions(instructions)
    _out(True, tweets)

def cmd_user_posts(username: str, count: int = 20) -> None:
    # First resolve user ID
    user_vars = {"screen_name": username, "withSafetyModeUserFields": True}
    user_data = _gql_get("UserByScreenName", user_vars)
    user_id = _dig(user_data, "data", "user", "result", "rest_id")
    if not user_id:
        _out(False, None, f"User not found: {username}")
        return

    variables = {
        "userId": user_id,
        "count": count,
        "includePromotedContent": False,
        "withQuickPromoteEligibilityTweetFields": False,
        "withVoice": True,
        "withV2Timeline": True,
    }
    data = _gql_get("UserTweets", variables)
    instructions = _extract_instructions(
        data, ["data", "user", "result", "timeline_v2", "timeline", "instructions"]
    )
    tweets = _tweets_from_instructions(instructions)
    _out(True, tweets)

def cmd_user(username: str) -> None:
    variables = {"screen_name": username, "withSafetyModeUserFields": True}
    data = _gql_get("UserByScreenName", variables)
    result = _dig(data, "data", "user", "result")
    u = _parse_user(result)
    if not u:
        _out(False, None, f"User not found: {username}")
        return
    _out(True, u)

def cmd_tweet(tweet_id: str, count: int = 20) -> None:
    variables = {
        "focalTweetId": tweet_id,
        "count": count,
        "referrer": "tweet",
        "with_rux_injections": False,
        "includePromotedContent": False,
        "withCommunity": True,
        "withQuickPromoteEligibilityTweetFields": True,
        "withBirdwatchNotes": True,
        "withVoice": True,
        "withV2Timeline": True,
    }
    data = _gql_get("TweetDetail", variables)
    instructions = _extract_instructions(
        data, ["data", "threaded_conversation_with_injections_v2", "instructions"]
    )
    tweets = _tweets_from_instructions(instructions)
    if not tweets:
        _out(False, None, "Tweet not found")
        return
    main = tweets[0]
    thread = [t for t in tweets[1:] if t["id"] != tweet_id]
    main["replies"] = thread[:count]  # embed replies so bridge can use data as CliTweet
    _out(True, main)

def cmd_followers(username: str, count: int = 20) -> None:
    user_vars = {"screen_name": username, "withSafetyModeUserFields": True}
    user_data = _gql_get("UserByScreenName", user_vars)
    user_id = _dig(user_data, "data", "user", "result", "rest_id")
    if not user_id:
        _out(False, None, f"User not found: {username}")
        return

    variables = {"userId": user_id, "count": count, "includePromotedContent": False}
    data = _gql_get("Followers", variables)
    instructions = _extract_instructions(
        data, ["data", "user", "result", "timeline", "timeline", "instructions"]
    )
    users = _users_from_instructions(instructions)
    _out(True, users)

def cmd_following(username: str, count: int = 20) -> None:
    user_vars = {"screen_name": username, "withSafetyModeUserFields": True}
    user_data = _gql_get("UserByScreenName", user_vars)
    user_id = _dig(user_data, "data", "user", "result", "rest_id")
    if not user_id:
        _out(False, None, f"User not found: {username}")
        return

    variables = {"userId": user_id, "count": count, "includePromotedContent": False}
    data = _gql_get("Following", variables)
    instructions = _extract_instructions(
        data, ["data", "user", "result", "timeline", "timeline", "instructions"]
    )
    users = _users_from_instructions(instructions)
    _out(True, users)

def cmd_bookmarks(count: int = 20) -> None:
    variables = {
        "count": count,
        "includePromotedContent": False,
    }
    data = _gql_get("Bookmarks", variables)
    instructions = _extract_instructions(
        data, ["data", "bookmark_timeline_v2", "timeline", "instructions"]
    )
    tweets = _tweets_from_instructions(instructions)
    _out(True, tweets)

def cmd_list(list_id: str, count: int = 20) -> None:
    variables = {"listId": list_id, "count": count}
    data = _gql_get("ListLatestTweetsTimeline", variables)
    instructions = _extract_instructions(
        data, ["data", "list", "tweets_timeline", "timeline", "instructions"]
    )
    tweets = _tweets_from_instructions(instructions)
    _out(True, tweets)

def cmd_bookmark(tweet_id: str) -> None:
    variables = {"tweet_id": tweet_id}
    _gql_post("CreateBookmark", variables)
    _out(True, {"bookmarked": True})

def cmd_unbookmark(tweet_id: str) -> None:
    variables = {"tweet_id": tweet_id}
    _gql_post("DeleteBookmark", variables)
    _out(True, {"bookmarked": False})

def cmd_reply(tweet_id: str, text: str) -> None:
    variables = {
        "tweet_text": text,
        "reply": {
            "in_reply_to_tweet_id": tweet_id,
            "exclude_reply_user_ids": [],
        },
        "dark_request": False,
        "media": {"media_entities": [], "possibly_sensitive": False},
        "semantic_annotation_ids": [],
    }
    result = _gql_post("CreateTweet", variables)
    new_id = _dig(result, "data", "create_tweet", "tweet_results", "result", "rest_id", default="")
    _out(True, {"id": new_id})

# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(1)

    cmd = args[0]
    rest = args[1:]

    # Parse --count N from rest args
    count = 20
    filtered: List[str] = []
    i = 0
    while i < len(rest):
        if rest[i] == "--count" and i + 1 < len(rest):
            try:
                count = int(rest[i + 1])
            except ValueError:
                pass
            i += 2
        else:
            filtered.append(rest[i])
            i += 1
    rest = filtered

    try:
        if cmd == "feed":
            cmd_feed(count)
        elif cmd == "search":
            if not rest:
                _out(False, None, "search requires a query argument")
            else:
                cmd_search(rest[0], count)
        elif cmd == "user-posts":
            if not rest:
                _out(False, None, "user-posts requires a username argument")
            else:
                cmd_user_posts(rest[0], count)
        elif cmd == "user":
            if not rest:
                _out(False, None, "user requires a username argument")
            else:
                cmd_user(rest[0])
        elif cmd == "tweet":
            if not rest:
                _out(False, None, "tweet requires a tweet_id argument")
            else:
                cmd_tweet(rest[0], count)
        elif cmd == "followers":
            if not rest:
                _out(False, None, "followers requires a username argument")
            else:
                cmd_followers(rest[0], count)
        elif cmd == "following":
            if not rest:
                _out(False, None, "following requires a username argument")
            else:
                cmd_following(rest[0], count)
        elif cmd == "bookmarks":
            cmd_bookmarks(count)
        elif cmd == "list":
            if not rest:
                _out(False, None, "list requires a list_id argument")
            else:
                cmd_list(rest[0], count)
        elif cmd == "bookmark":
            if not rest:
                _out(False, None, "bookmark requires a tweet_id argument")
            else:
                cmd_bookmark(rest[0])
        elif cmd == "unbookmark":
            if not rest:
                _out(False, None, "unbookmark requires a tweet_id argument")
            else:
                cmd_unbookmark(rest[0])
        elif cmd == "reply":
            if len(rest) < 2:
                _out(False, None, "reply requires tweet_id and text arguments")
            else:
                cmd_reply(rest[0], rest[1])
        else:
            _out(False, None, f"Unknown command: {cmd}")
            sys.exit(1)
    except Exception as exc:
        _out(False, None, str(exc))
        sys.exit(1)


if __name__ == "__main__":
    main()
