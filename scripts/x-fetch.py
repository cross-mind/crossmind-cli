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
  x-fetch.py notifications [--count N]
  x-fetch.py list <list_id> [--count N]
  x-fetch.py bookmark <tweet_id>
  x-fetch.py unbookmark <tweet_id>

Output: JSON {"ok": true|false, "data": ..., "error": {"message": "..."}}
"""

from __future__ import annotations

import base64
import json
import os
import random
import re
import string
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
# Query IDs are resolved dynamically at startup:
#   1. Disk cache  (~/.cache/x-fetch-query-ids.json, 24h TTL)  — zero latency
#   2. fa0311/twitter-openapi GitHub                            — ~50 ms
#   3. X JS bundle scan via twitter_cli._scan_bundles           — ~2-5 s
# Hardcoded values below are last-resort fallbacks only and may be stale.

_OPENAPI_URL = (
    "https://raw.githubusercontent.com/fa0311/"
    "twitter-openapi/refs/heads/main/src/config/placeholder.json"
)
_QUERY_ID_CACHE_PATH = os.path.expanduser("~/.cache/x-fetch-query-ids.json")
_QUERY_ID_TTL = 86400  # 24 hours
_TWITTER_CLI_VENV = "/root/.local/share/uv/tools/twitter-cli/lib/python3.11/site-packages"

# Hardcoded fallbacks — updated from fa0311 snapshot, used only when all
# network sources fail. Values may rotate; the dynamic system keeps them fresh.
QUERY_IDS: Dict[str, str] = {
    "HomeTimeline":             "c-CzHF1LboFilMpsx4ZCrQ",
    "HomeLatestTimeline":       "BKB7oi212Fi7kQtCBGE4zA",
    "SearchTimeline":           "VhUd6vHVmLBcw0uX-6jMLA",
    "UserTweets":               "q6xj5bs0hapm9309hexA_g",
    "UserByScreenName":         "1VOOyvKkiI3FMmkeDNxM9A",
    "TweetDetail":              "xd_EMdYvB9hfZsZ6Idri0w",
    "Followers":                "IOh4aS6UdGWGJUYTqliQ7Q",
    "Following":                "zx6e-TLzRkeDO_a7p4b3JQ",
    "Bookmarks":                "uzboyXSHSJrR-mGJqep0TQ",
    "ListLatestTweetsTimeline": "ZBbXrl0FVnTqp7K6EAADog",
    "CreateBookmark":           "aoDbu3RHznuiSkQ9aNM67Q",
    "DeleteBookmark":           "Wlmlj2-xISYCixDmuS8KNg",
    "CreateTweet":              "IID9x6WsdMnTlXnzXGq8ng",
    "NotificationsTimeline":    "GquVPn-SKYxKLgLsRPpJ6g",
    # Write mutations (query IDs rotate; dynamic resolution keeps them fresh)
    "DeleteTweet":              "VaenaVgh5q5ih7kvyVjgtg",
    "FavoriteTweet":            "lI07N6Otwv1PhnEgXILM7A",
    "UnfavoriteTweet":          "ZYKSe-w7KEslx3JhSIk5LA",
    "CreateRetweet":            "ojPdsZsimiJrUGLR1sjUtA",
    "DeleteRetweet":            "iQtK4dl5hBmXewYZuEOKVw",
    # X Articles (Premium-gated; loaded from lazy bundle.TwitterArticles.*.js)
    # These are NOT in fa0311/twitter-openapi — dynamic refresh scans the article bundle.
    "ArticleEntityDraftCreate":   "g1l5N8BxGewYuCy5USe_bQ",
    "ArticleEntityUpdateTitle":   "x75E2ABzm8_mGTg1bz8hcA",
    "ArticleEntityUpdateContent": "M7N2FrPrlOmu-YrVIBxFnQ",
    "ArticleEntityPublish":       "m4SHicYMoWO_qkLvjhDk7Q",
    "ArticleEntityUnpublish":     "WbeMAOZdMHilHrqhgpjObw",
    "ArticleEntityDelete":        "e4lWqB6m2TA8Fn_j9L9xEA",
    "ArticleEntitiesSlice":       "N1zzFzRPspT-sP9Q42n_bg",
    "ArticleEntityResultByRestId":"8-OHhj8-KCAHUP8XjPaAYQ",
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

def _save_query_id_cache() -> None:
    try:
        os.makedirs(os.path.dirname(_QUERY_ID_CACHE_PATH), exist_ok=True)
        with open(_QUERY_ID_CACHE_PATH, "w", encoding="utf-8") as f:
            json.dump({"ids": dict(QUERY_IDS), "ts": time.time()}, f)
    except Exception:
        pass

def _load_query_id_cache() -> bool:
    """Load persisted query IDs from disk. Returns True if cache is fresh."""
    try:
        if os.path.exists(_QUERY_ID_CACHE_PATH):
            with open(_QUERY_ID_CACHE_PATH, encoding="utf-8") as f:
                cached = json.load(f)
            if time.time() - cached.get("ts", 0) < _QUERY_ID_TTL:
                QUERY_IDS.update(cached.get("ids", {}))
                return True
    except Exception:
        pass
    return False

def _refresh_from_github() -> bool:
    """Fetch all query IDs from fa0311/twitter-openapi and persist to disk."""
    try:
        resp = _get_session().get(_OPENAPI_URL, headers={"user-agent": "curl/8.0"}, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            updated = False
            for op, meta in data.items():
                qid = meta.get("queryId") if isinstance(meta, dict) else None
                if isinstance(qid, str) and qid:
                    QUERY_IDS[op] = qid
                    updated = True
            if updated:
                _save_query_id_cache()
                return True
    except Exception:
        pass
    return False

def _refresh_from_article_bundle() -> bool:
    """Scan the X Articles lazy JS bundle for Premium article operation query IDs.

    The article operations live in a webpack lazy chunk:
      https://abs.twimg.com/responsive-web/client-web/bundle.TwitterArticles.HASH.js

    The HASH is content-based and rotates on deploy. We discover it by fetching
    x.com/compose/articles (cookie-authed) and extracting the script URL.
    """
    try:
        s = _get_session()
        h = {
            "authorization": f"Bearer {BEARER}",
            "cookie": f"auth_token={AUTH_TOKEN}; ct0={CT0}",
            "user-agent": (
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"
            ),
        }
        page = s.get("https://x.com/compose/articles", headers=h, timeout=15)
        # Find bundle.TwitterArticles.*.js in the page HTML
        matches = re.findall(
            r'"(https?://[^"]*bundle\.TwitterArticles\.[^"]+\.js)"',
            page.text,
        )
        if not matches:
            # Try relative-URL format: "/responsive-web/client-web/bundle.TwitterArticles.*.js"
            rel = re.findall(
                r'"(/responsive-web/client-web/bundle\.TwitterArticles\.[^"]+\.js)"',
                page.text,
            )
            matches = [f"https://abs.twimg.com{m}" for m in rel]
        if not matches:
            return False
        bundle_url = matches[0]
        br = s.get(bundle_url, headers={"user-agent": "curl/8.0"}, timeout=20)
        if br.status_code != 200:
            return False
        # Scan for {"queryId":"...","operationName":"..."}
        ops = re.findall(r'\{"queryId":"([^"]+)","operationName":"([^"]+)"', br.text)
        updated = False
        for qid, opname in ops:
            if QUERY_IDS.get(opname) != qid:
                QUERY_IDS[opname] = qid
                updated = True
        if updated:
            _save_query_id_cache()
        return updated
    except Exception:
        return False


def _refresh_from_bundles() -> None:
    """Scan X JS bundles via twitter_cli._scan_bundles (deepest fallback).

    Also scans the Premium-gated TwitterArticles lazy bundle for article ops.
    """
    try:
        if _TWITTER_CLI_VENV not in sys.path:
            sys.path.insert(0, _TWITTER_CLI_VENV)
        from twitter_cli.graphql import _scan_bundles, _cached_query_ids  # type: ignore
        def _fetch(url: str, headers: Optional[Dict[str, str]] = None) -> str:
            r = _get_session().get(url, headers=headers or {}, timeout=15)
            return r.text
        _scan_bundles(_fetch)
        QUERY_IDS.update(_cached_query_ids)
        _save_query_id_cache()
    except Exception:
        pass
    # Additionally scan the lazy article bundle (not covered by main bundle scan)
    _refresh_from_article_bundle()

# Startup: tier 1 (disk) → tier 2 (GitHub) → tier 3 (bundle scan)
if not _load_query_id_cache():
    if not _refresh_from_github():
        _refresh_from_bundles()

def _resolve_query_id(operation: str, refresh: bool = False) -> str:
    """Return queryId for operation. refresh=True forces a live re-fetch.

    Resolution order on refresh:
      1. GitHub (fa0311) — fast, covers ~95 known operations
      2. Bundle scan — slower, covers all operations including Premium-gated ones
         (triggered if GitHub succeeds but the specific operation is still missing)
      3. Return empty string if still not found
    """
    if refresh:
        if not _refresh_from_github():
            _refresh_from_bundles()
        elif operation not in QUERY_IDS:
            # GitHub refreshed fine but doesn't know this operation
            # (e.g. Premium-gated mutations like CreateNoteTweet).
            # Fall through to the full bundle scan.
            _refresh_from_bundles()
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
    # If query ID was not found in any cached source, force a live bundle scan
    # before making the first request so we don't hit the API with an empty ID.
    if not qid:
        _resolve_query_id(operation, refresh=True)
        qid = QUERY_IDS.get(operation, "")
    url = f"https://x.com/i/api/graphql/{qid}/{operation}"
    path = f"/i/api/graphql/{qid}/{operation}"
    body = {"variables": variables, "queryId": qid}
    resp = _retry_on_tls(lambda: _get_session().post(url, headers=_headers(path=path, method="POST"), json=body, timeout=20))
    if resp.status_code in (400, 403, 404, 405):
        _resolve_query_id(operation, refresh=True)
        qid = QUERY_IDS.get(operation, qid)
        url = f"https://x.com/i/api/graphql/{qid}/{operation}"
        path = f"/i/api/graphql/{qid}/{operation}"
        body["queryId"] = qid
        resp = _retry_on_tls(lambda: _get_session().post(url, headers=_headers(path=path, method="POST"), json=body, timeout=20))
    resp.raise_for_status()
    data = resp.json()
    errors = data.get("errors")
    if errors:
        msg = errors[0].get("message", str(errors[0]))
        code = errors[0].get("code", "")
        raise ValueError(f"X GraphQL error [{code}]: {msg}")
    return data

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

def _bottom_cursor_from_instructions(instructions: List[Dict[str, Any]]) -> Optional[str]:
    """Extract the bottom pagination cursor from a TimelineAddEntries instruction set."""
    for inst in instructions:
        if inst.get("type") != "TimelineAddEntries":
            continue
        for entry in inst.get("entries", []):
            content = entry.get("content", {})
            if content.get("entryType") == "TimelineTimelineCursor" and content.get("cursorType") == "Bottom":
                return content.get("value")
    return None

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

    all_tweets: List[Dict[str, Any]] = []
    seen_ids: set = set()
    cursor: Optional[str] = None
    page_size = min(count, 40)  # X caps per-page at ~40 for UserTweets

    while len(all_tweets) < count:
        variables: Dict[str, Any] = {
            "userId": user_id,
            "count": page_size,
            "includePromotedContent": False,
            "withQuickPromoteEligibilityTweetFields": False,
            "withVoice": True,
            "withV2Timeline": True,
        }
        if cursor:
            variables["cursor"] = cursor

        data = _gql_get("UserTweets", variables)
        instructions = _extract_instructions(
            data, ["data", "user", "result", "timeline", "timeline", "instructions"]
        )
        page_tweets = _tweets_from_instructions(instructions)

        # Deduplicate and accumulate
        new_tweets = [t for t in page_tweets if t["id"] not in seen_ids]
        for t in new_tweets:
            seen_ids.add(t["id"])
        all_tweets.extend(new_tweets)

        # Advance cursor; stop if no new tweets or no next cursor
        next_cursor = _bottom_cursor_from_instructions(instructions)
        if not new_tweets or not next_cursor or next_cursor == cursor:
            break
        cursor = next_cursor

    _out(True, all_tweets[:count])

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

def cmd_notifications(count: int = 20) -> None:
    """Fetch notification timeline. Returns tweet-containing notifications."""
    variables = {
        "count": count,
        "includePromotedContent": False,
    }
    data = _gql_get("NotificationsTimeline", variables)
    instructions = _extract_instructions(
        data, ["data", "notification_timeline", "timeline", "instructions"]
    )
    tweets = []
    for inst in instructions:
        if inst.get("type") != "TimelineAddEntries":
            continue
        for entry in inst.get("entries", []):
            entry_id = entry.get("entryId", "")
            if not entry_id.startswith("notif-"):
                continue
            content = entry.get("content", {})
            item_content = content.get("itemContent", {})
            # Tweet-bearing notifications have tweet_results directly in itemContent
            result = _dig(item_content, "tweet_results", "result")
            t = _parse_tweet(result)
            if t:
                tweets.append(t)
    _out(True, tweets[:count])

def cmd_list(list_id: str, count: int = 20) -> None:
    variables = {"listId": list_id, "count": count}
    data = _gql_get("ListLatestTweetsTimeline", variables)
    instructions = _extract_instructions(
        data, ["data", "list", "tweets_timeline", "timeline", "instructions"]
    )
    tweets = _tweets_from_instructions(instructions)
    _out(True, tweets)

def cmd_delete(tweet_id: str) -> None:
    variables = {"tweet_id": tweet_id, "dark_request": False}
    _gql_post("DeleteTweet", variables)
    _out(True, {"deleted": True})

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

def cmd_post(text: str) -> None:
    """Post a new tweet (no reply context)."""
    variables = {
        "tweet_text": text,
        "dark_request": False,
        "media": {"media_entities": [], "possibly_sensitive": False},
        "semantic_annotation_ids": [],
    }
    result = _gql_post("CreateTweet", variables)
    new_id = _dig(result, "data", "create_tweet", "tweet_results", "result", "rest_id", default="")
    _out(True, {"id": new_id})

# ── X Articles helpers ──────────────────────────────────────────────────────

def _random_key(n: int = 5) -> str:
    """Generate a random Draft.js block key (alphanumeric, lowercase)."""
    return ''.join(random.choices(string.ascii_lowercase + string.digits, k=n))


def _strip_inline_md(text: str) -> str:
    """Remove bold/italic/code markdown markers, leaving plain text."""
    text = re.sub(r'\*\*(.+?)\*\*', r'\1', text)
    text = re.sub(r'__(.+?)__', r'\1', text)
    text = re.sub(r'\*(.+?)\*', r'\1', text)
    text = re.sub(r'_(.+?)_', r'\1', text)
    text = re.sub(r'`([^`]+)`', r'\1', text)
    # Strip links: [label](url) → label
    text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)
    return text.strip()


def _is_table_sep(line: str) -> bool:
    return bool(re.match(r'^\s*\|[-\s|:]+\|\s*$', line))


def _mk_block(text: str, btype: str) -> Dict[str, Any]:
    """Build a Draft.js block for X Articles API (snake_case, no depth field).

    X's API input schema requires:
    - snake_case field names: inline_style_ranges, entity_ranges
    - NO depth field (causes GRAPHQL_VALIDATION_FAILED with any value)
    """
    return {
        'key': _random_key(),
        'text': text,
        'type': btype,
        'inline_style_ranges': [],
        'entity_ranges': [],
    }


def _markdown_to_draftjs(markdown: str) -> Dict[str, Any]:
    """Convert a markdown string to X Articles Draft.js content_state format.

    Handles: headings (h1-h3), unordered/ordered lists, blockquotes,
    horizontal rules (skipped), markdown tables (converted to text rows),
    and plain paragraphs. Strips inline markdown from all block text.

    Returns: {"blocks": [...], "entity_map": []}
    """
    blocks: List[Dict[str, Any]] = []
    lines = markdown.split('\n')
    i = 0

    # Skip YAML front-matter block (--- ... ---)
    if lines and lines[0].strip() == '---':
        i = 1
        while i < len(lines) and lines[i].strip() != '---':
            i += 1
        i += 1  # skip closing ---

    while i < len(lines):
        stripped = lines[i].strip()
        i += 1

        # Empty lines are block separators — skip
        if not stripped:
            continue

        # Horizontal rules — skip (no native hr in X Articles Draft.js)
        if re.match(r'^[-*_]{3,}$', stripped):
            continue

        # Headings
        if stripped.startswith('### '):
            blocks.append(_mk_block(_strip_inline_md(stripped[4:]), 'header-three'))
            continue
        if stripped.startswith('## '):
            blocks.append(_mk_block(_strip_inline_md(stripped[3:]), 'header-two'))
            continue
        if stripped.startswith('# '):
            blocks.append(_mk_block(_strip_inline_md(stripped[2:]), 'header-one'))
            continue

        # Unordered list items: "- " or "* "
        if re.match(r'^[-*]\s', stripped):
            blocks.append(_mk_block(_strip_inline_md(stripped[2:]), 'unordered-list-item'))
            continue

        # Ordered list items: "1. "
        om = re.match(r'^\d+\.\s+(.*)', stripped)
        if om:
            blocks.append(_mk_block(_strip_inline_md(om.group(1)), 'ordered-list-item'))
            continue

        # Blockquote: "> "
        if stripped.startswith('> '):
            blocks.append(_mk_block(_strip_inline_md(stripped[2:]), 'blockquote'))
            continue

        # Markdown table — collect all rows for this table block
        if '|' in stripped and stripped.startswith('|'):
            table_lines = [stripped]
            while i < len(lines):
                nl = lines[i].strip()
                if not nl or '|' not in nl:
                    break
                table_lines.append(nl)
                i += 1
            for row in table_lines:
                if _is_table_sep(row):
                    continue
                cells = [c.strip() for c in row.strip('|').split('|')]
                text = ' | '.join(c for c in cells if c)
                if text:
                    blocks.append(_mk_block(_strip_inline_md(text), 'unstyled'))
            continue

        # Plain paragraph
        text = _strip_inline_md(stripped)
        if text:
            blocks.append(_mk_block(text, 'unstyled'))

    return {'blocks': blocks, 'entity_map': []}


def _decode_article_id(b64_id: str) -> str:
    """Decode a base64 X Article entity ID to the numeric REST ID.

    Input:  "QXJ0aWNsZUVudGl0eToyMDQwNzA2NDA0NTEyODc4NTkz"
    Output: "2040706404512878593"
    """
    # Pad if needed
    padded = b64_id + '=' * (-len(b64_id) % 4)
    decoded = base64.b64decode(padded).decode('utf-8', errors='replace')
    # Format: "ArticleEntity:NUMERIC_ID"
    if ':' in decoded:
        return decoded.split(':')[-1]
    return decoded


def cmd_article(text: str, title: Optional[str] = None) -> None:
    """Post a real X Article (X Premium required).

    Flow:
      1. ArticleEntityDraftCreate  — create empty draft with title
      2. ArticleEntityUpdateContent — set Draft.js body from markdown
      3. ArticleEntityPublish       — publish draft → live article

    Returns {"id": "<numeric_article_entity_id>", "url": "..."}.
    """
    article_title = title or "Untitled"

    # ── Step 1: Create draft ─────────────────────────────────────────────────
    create_vars: Dict[str, Any] = {
        "title": article_title,
        "content_state": {"blocks": [], "entity_map": []},
    }
    create_result = _gql_post("ArticleEntityDraftCreate", create_vars)
    b64_id = _dig(
        create_result,
        "data", "articleentity_create_draft", "article_entity_results", "result", "id",
        default="",
    )
    if not b64_id:
        _out(False, None, "Failed to create article draft — no entity ID in response")
        return
    article_id = _decode_article_id(b64_id)

    # ── Step 2: Update content ────────────────────────────────────────────────
    content_state = _markdown_to_draftjs(text)
    update_vars: Dict[str, Any] = {
        "article_entity": article_id,
        "content_state": content_state,
    }
    _gql_post("ArticleEntityUpdateContent", update_vars)

    # ── Step 3: Publish ───────────────────────────────────────────────────────
    publish_vars: Dict[str, Any] = {"articleEntityId": article_id}
    try:
        _gql_post("ArticleEntityPublish", publish_vars)
    except ValueError as pub_err:
        # Publish failed (e.g. daily tweet rate limit). Article was created and
        # content was saved as a draft. Surface the draft ID so it can be
        # published later via ArticleEntityPublish.
        _out(False, {
            "id": article_id,
            "draft_url": f"https://x.com/compose/articles/edit/{article_id}",
        }, f"Article saved as draft but publish failed: {pub_err}")
        return

    _out(True, {
        "id": article_id,
        "url": f"https://x.com/i/article/{article_id}",
    })


def cmd_quote(tweet_id: str, text: str) -> None:
    """Quote-tweet: CreateTweet with attachment_url."""
    variables = {
        "tweet_text": text,
        "attachment_url": f"https://twitter.com/i/web/status/{tweet_id}",
        "dark_request": False,
        "media": {"media_entities": [], "possibly_sensitive": False},
        "semantic_annotation_ids": [],
    }
    result = _gql_post("CreateTweet", variables)
    new_id = _dig(result, "data", "create_tweet", "tweet_results", "result", "rest_id", default="")
    _out(True, {"id": new_id})

def cmd_like(tweet_id: str) -> None:
    variables = {"tweet_id": tweet_id, "action_source": "tweet_detail"}
    _gql_post("FavoriteTweet", variables)
    _out(True, {"liked": True})

def cmd_unlike(tweet_id: str) -> None:
    variables = {"tweet_id": tweet_id}
    _gql_post("UnfavoriteTweet", variables)
    _out(True, {"liked": False})

def cmd_retweet(tweet_id: str) -> None:
    variables = {"tweet_id": tweet_id, "dark_request": False}
    result = _gql_post("CreateRetweet", variables)
    new_id = _dig(result, "data", "create_retweet", "retweet_results", "result", "rest_id", default="")
    _out(True, {"id": new_id})

def cmd_unretweet(tweet_id: str) -> None:
    variables = {"source_tweet_id": tweet_id, "dark_request": False}
    _gql_post("DeleteRetweet", variables)
    _out(True, {"retweeted": False})

def _v1_post(path: str, form_data: str) -> None:
    """POST to x.com/i/1.1/* with cookie auth (form-urlencoded)."""
    url = f"https://x.com/i/1.1/{path}"
    headers = {**_headers(), "content-type": "application/x-www-form-urlencoded"}
    resp = _retry_on_tls(
        lambda: _get_session().post(url, headers=headers, data=form_data, timeout=20)
    )
    resp.raise_for_status()

def cmd_follow(username: str) -> None:
    """Follow a user via v1.1 friendships/create (cookie auth)."""
    _v1_post(
        "friendships/create.json",
        f"screen_name={urllib.parse.quote(username)}&include_entities=true"
    )
    _out(True, {"following": True})

def cmd_unfollow(username: str) -> None:
    """Unfollow a user via v1.1 friendships/destroy (cookie auth)."""
    _v1_post(
        "friendships/destroy.json",
        f"screen_name={urllib.parse.quote(username)}&include_entities=true"
    )
    _out(True, {"following": False})

# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(1)

    cmd = args[0]
    rest = args[1:]

    # Parse --count N and --title TITLE from rest args
    count = 20
    title: Optional[str] = None
    filtered: List[str] = []
    i = 0
    while i < len(rest):
        if rest[i] == "--count" and i + 1 < len(rest):
            try:
                count = int(rest[i + 1])
            except ValueError:
                pass
            i += 2
        elif rest[i] == "--title" and i + 1 < len(rest):
            title = rest[i + 1]
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
        elif cmd == "notifications":
            cmd_notifications(count)
        elif cmd == "list":
            if not rest:
                _out(False, None, "list requires a list_id argument")
            else:
                cmd_list(rest[0], count)
        elif cmd == "delete":
            if not rest:
                _out(False, None, "delete requires a tweet_id argument")
            else:
                cmd_delete(rest[0])
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
        elif cmd == "post":
            if not rest:
                _out(False, None, "post requires a text argument")
            else:
                cmd_post(rest[0])
        elif cmd == "article":
            if not rest:
                _out(False, None, "article requires a text argument")
            else:
                cmd_article(rest[0], title)
        elif cmd == "quote":
            if len(rest) < 2:
                _out(False, None, "quote requires tweet_id and text arguments")
            else:
                cmd_quote(rest[0], rest[1])
        elif cmd == "like":
            if not rest:
                _out(False, None, "like requires a tweet_id argument")
            else:
                cmd_like(rest[0])
        elif cmd == "unlike":
            if not rest:
                _out(False, None, "unlike requires a tweet_id argument")
            else:
                cmd_unlike(rest[0])
        elif cmd == "retweet":
            if not rest:
                _out(False, None, "retweet requires a tweet_id argument")
            else:
                cmd_retweet(rest[0])
        elif cmd == "unretweet":
            if not rest:
                _out(False, None, "unretweet requires a tweet_id argument")
            else:
                cmd_unretweet(rest[0])
        elif cmd == "follow":
            if not rest:
                _out(False, None, "follow requires a username argument")
            else:
                cmd_follow(rest[0])
        elif cmd == "unfollow":
            if not rest:
                _out(False, None, "unfollow requires a username argument")
            else:
                cmd_unfollow(rest[0])
        else:
            _out(False, None, f"Unknown command: {cmd}")
            sys.exit(1)
    except Exception as exc:
        _out(False, None, str(exc))
        sys.exit(1)


if __name__ == "__main__":
    main()
