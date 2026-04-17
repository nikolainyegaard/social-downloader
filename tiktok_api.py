"""TikTok data fetching."""

from __future__ import annotations

import copy
import json
import re


class UserBannedException(Exception):
    """Raised when TikTok returns statusCode 10202 (account banned or removed)."""


async def get_user_info(api, username: str | None = None,
                        sec_uid: str | None = None) -> dict:
    """Fetch user profile data. Returns a normalised dict.

    When sec_uid is available it is used as the primary lookup key via
    api.make_request() directly, bypassing TikTokApi's user.info() username guard
    and resolving the account by secUid alone. The service survives username
    changes transparently.

    Falls back to user.info() with username when sec_uid is absent (e.g. on the
    very first add before a sec_uid has been stored in the DB).
    """
    if not sec_uid and not username:
        raise ValueError("Must provide username or sec_uid")

    if sec_uid:
        # Primary path: resolve by secUid via make_request (no username required).
        # Passing username alongside when available does no harm and may help
        # TikTok disambiguate, but is not required.
        import asyncio as _asyncio
        for _attempt in range(2):
            data = await api.make_request(
                url="https://www.tiktok.com/api/user/detail/",
                params={"secUid": sec_uid, "uniqueId": username or ""},
            )
            if data is None:
                raise RuntimeError(
                    f"TikTokApi returned None for sec_uid={sec_uid} "
                    f"-- TikTok may have blocked the request or cookies are stale"
                )
            if data.get("statusCode") in (10202, 10223):
                raise UserBannedException(
                    f"TikTok returned statusCode {data.get('statusCode')} for sec_uid={sec_uid} "
                    f"-- account is banned, removed, or FTC-restricted"
                )
            # statusCode 0 with empty user object is a transient session artifact.
            # The session is degraded but not blocked -- a short wait and one retry
            # consistently resolves it (confirmed via diagnostics on affected accounts).
            if data.get("userInfo", {}).get("user", {}).get("id"):
                break  # got valid data
            if _attempt == 0:
                await _asyncio.sleep(3)
            # second attempt falls through to the empty-check below
    else:
        # Fallback path: username-only lookup via user.info() (first-time adds).
        user = api.user(username=username)
        try:
            data = await user.info()
        except KeyError as exc:
            if exc.args[0] == 'user':
                # TikTok returned userInfo without a 'user' sub-key — the
                # canonical shape for banned / removed / FTC-restricted accounts.
                raise UserBannedException(
                    f"@{username} is banned or removed on TikTok"
                ) from exc
            raise RuntimeError(
                f"TikTokApi returned incomplete data for @{username} "
                f"(missing key {exc}) -- cookies may be stale"
            ) from exc
        if data.get("statusCode") in (10202, 10223):
            raise UserBannedException(
                f"TikTok returned statusCode {data.get('statusCode')} for @{username} "
                f"-- account is banned, removed, or FTC-restricted"
            )
    u = data.get("userInfo", {}).get("user", {})
    s = data.get("userInfo", {}).get("stats", {})

    if not u.get("id"):
        ident = f"@{username}" if username else f"sec_uid={sec_uid}"
        status_code = data.get("statusCode")
        status_info = f", statusCode={status_code}" if status_code else ""
        raise ValueError(f"No user data returned for {ident}{status_info}")

    return {
        "tiktok_id":       u.get("id"),
        "sec_uid":         u.get("secUid"),
        "username":        u.get("uniqueId", username),
        "display_name":    u.get("nickname"),
        "bio":             u.get("signature"),
        "join_date":       u.get("createTime"),
        "follower_count":  s.get("followerCount", 0),
        "following_count": s.get("followingCount", 0),
        "video_count":     s.get("videoCount", 0),
        # 'secret' flag means the account is private (not necessarily banned)
        "is_private":      bool(u.get("secret")),
        "verified":        bool(u.get("verified")),
        "avatar_url":      u.get("avatarLarger") or u.get("avatarMedium") or u.get("avatarThumb"),
        "_raw_user_data":  json.dumps(data),
    }


def get_user_videos(tiktok_id: str, sec_uid: str | None = None,
                    cookies_path: str | None = None) -> list[dict]:
    """List all videos from a user's profile using yt-dlp flat extraction.

    Prefers tiktokuser:{sec_uid} when sec_uid is available: yt-dlp can use it
    directly without needing to resolve the "secondary user ID" internally, so it
    survives username changes without an extra lookup. Falls back to
    tiktokuser:{tiktok_id} when sec_uid is absent (e.g. newly added users).
    Returns [{video_id, description, upload_date}].
    """
    import yt_dlp

    ydl_opts = {
        "quiet":        True,
        "no_warnings":  True,
        "extract_flat": True,
    }
    if cookies_path:
        ydl_opts["cookiefile"] = cookies_path

    # sec_uid is the "channel_id" in yt-dlp terms. Using it directly avoids the
    # "Unable to extract secondary user ID" error yt-dlp raises when it can't
    # resolve a sec_uid from a numeric-only lookup (common after username changes).
    urls_to_try = []
    if sec_uid:
        urls_to_try.append(f"tiktokuser:{sec_uid}")
    urls_to_try.append(f"tiktokuser:{tiktok_id}")

    last_exc: Exception | None = None
    for url in urls_to_try:
        try:
            videos = []
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
                for entry in (info or {}).get("entries") or []:
                    if not entry or not entry.get("id"):
                        continue
                    videos.append({
                        "video_id":    entry["id"],
                        "description": entry.get("title") or "",
                        "upload_date": entry.get("timestamp"),
                    })
            return videos
        except Exception as exc:
            last_exc = exc
            continue

    raise last_exc  # type: ignore[misc]


async def get_user_videos_with_stats(api, sec_uid: str,
                                     max_count: int = 2000) -> list[dict]:
    """Page through /api/post/item_list/ and return all reachable videos with stats.

    Uses the already-open TikTokApi session (no new browser launch).
    Stops when hasMore=False or max_count reached.
    Returns a list of normalised dicts in the same shape as get_video_details().

    A randomised delay is inserted after every 10 items (~every 3 items within a
    30-item page) to avoid triggering TikTok rate-limiting on the shared session.
    The sleep lands before the generator issues its next request.
    """
    import asyncio
    import random

    results = []
    async for video in api.user(sec_uid=sec_uid).videos(count=max_count):
        results.append(_normalise_item_list_entry(video.as_dict))
        if len(results) % 10 == 0:
            await asyncio.sleep(round(random.uniform(0.5, 1.5), 2))
    return results


def _normalise_item_list_entry(item: dict) -> dict:
    """Map a raw /api/post/item_list/ item to the same shape as get_video_details().

    Handles both statsV2 (nested string values) and stats (direct integers).
    """
    def _stat(v):
        if v is None:
            return None
        if isinstance(v, dict):
            return int(v.get("count", 0) or 0)
        return int(v)

    raw_stats  = item.get("statsV2") or item.get("stats") or {}
    image_post = item.get("imagePost")
    video_meta = item.get("video") or {}
    music      = item.get("music") or {}
    author     = item.get("author") or {}

    image_urls = []
    if image_post:
        image_urls = [
            img["imageURL"]["urlList"][0]
            for img in image_post.get("images", [])
            if img.get("imageURL", {}).get("urlList")
        ]

    try:
        upload_date = int(item["createTime"]) if item.get("createTime") else None
    except (ValueError, TypeError):
        upload_date = None

    return {
        "video_id":            str(item["id"]),
        "description":         item.get("desc", ""),
        "upload_date":         upload_date,
        "type":                "photo" if image_post else "video",
        "image_urls":          image_urls,
        "view_count":          _stat(raw_stats.get("playCount")),
        "like_count":          _stat(raw_stats.get("diggCount")),
        "comment_count":       _stat(raw_stats.get("commentCount")),
        "share_count":         _stat(raw_stats.get("shareCount")),
        "save_count":          _stat(raw_stats.get("collectCount")),
        "duration":            video_meta.get("duration"),
        "width":               video_meta.get("width"),
        "height":              video_meta.get("height"),
        "music_title":         music.get("title"),
        "music_artist":        music.get("authorName"),
        "music_id":            str(music["id"]) if music.get("id") else None,
        "author_id":           author.get("id"),
        "author_username":     author.get("uniqueId"),
        "author_sec_uid":      author.get("secUid"),
        "author_display_name": author.get("nickname"),
        "_raw_video_data":     None,
    }


async def fetch_sound_video_ids(sound_id: str, ms_token: str | None,
                                chrome_executable: str | None,
                                cookies_flat: dict | None = None) -> list[str]:
    """Fetch all video IDs that use a given TikTok sound.
    Returns a list of video ID strings (up to ~3000).
    Opens its own TikTokApi session.
    """
    from TikTokApi import TikTokApi

    video_ids: list[str] = []
    async with TikTokApi() as api:
        await api.create_sessions(
            ms_tokens=[ms_token] if ms_token else [],
            num_sessions=1,
            sleep_after=3,
            executable_path=chrome_executable,
            cookies=[cookies_flat] if cookies_flat else None,
        )
        async for video in api.sound(id=sound_id).videos(count=3000):
            video_ids.append(str(video.id))
    return video_ids


def get_video_details(video_id: str, username: str, cookies: dict) -> dict:
    """Fetch type and image URLs for a single video by parsing the TikTok page HTML.
    Returns {type, description, upload_date, image_urls}.
    """
    from curl_cffi import requests as curl_requests

    url = f"https://www.tiktok.com/@{username}/video/{video_id}"
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        ),
        "Referer":         "https://www.tiktok.com/",
        "Accept-Language": "en-US,en;q=0.9",
    }

    resp = curl_requests.get(
        url, headers=headers, cookies=cookies,
        impersonate="chrome120", timeout=30,
    )

    if resp.status_code != 200:
        raise RuntimeError(
            f"HTTP {resp.status_code} fetching video {video_id} details"
        )

    match = re.search(
        r'<script[^>]+\bid=["\']__UNIVERSAL_DATA_FOR_REHYDRATION__["\'][^>]*>'
        r'([^<]+)</script>',
        resp.text,
    )
    if not match:
        raise RuntimeError("Could not find page data in TikTok response")

    data = json.loads(match.group(1))
    item = (
        data
        .get("__DEFAULT_SCOPE__", {})
        .get("webapp.video-detail", {})
        .get("itemInfo", {})
        .get("itemStruct", {})
    )
    if not item:
        raise RuntimeError("No item data in TikTok page response")

    stats  = item.get("stats", {}) or {}
    video_meta = item.get("video", {}) or {}
    music  = item.get("music", {}) or {}
    author = item.get("author", {}) or {}

    # Build a cleaned raw blob: strip large/expiring fields
    raw = copy.deepcopy(item)
    _vid = raw.get("video", {})
    for _k in ("bitrateInfo", "playAddr", "downloadAddr", "cover", "dynamicCover",
               "originCover", "shareCover", "reflowCover", "codecType",
               "videoQuality", "encodeUserTag", "encodedType"):
        _vid.pop(_k, None)
    for _k in ("avatarLarger", "avatarMedium", "avatarThumb",
               "avatarLargerUrl", "avatarMediumUrl", "avatarThumbUrl"):
        raw.get("author", {}).pop(_k, None)
    _raw_video_data = json.dumps(raw)

    try:
        upload_date = int(item.get("createTime") or 0) or None
    except (ValueError, TypeError):
        upload_date = None

    image_post = item.get("imagePost")
    _author_info = {
        "author_id":           author.get("id"),
        "author_username":     author.get("uniqueId"),
        "author_sec_uid":      author.get("secUid"),
        "author_display_name": author.get("nickname"),
    }

    if image_post:
        image_urls = [
            img["imageURL"]["urlList"][0]
            for img in image_post.get("images", [])
            if img.get("imageURL", {}).get("urlList")
        ]
        return {
            "type":          "photo",
            "description":   item.get("desc", ""),
            "upload_date":   upload_date,
            "image_urls":    image_urls,
            "view_count":    stats.get("playCount"),
            "like_count":    stats.get("diggCount"),
            "comment_count": stats.get("commentCount"),
            "share_count":   stats.get("shareCount"),
            "save_count":    stats.get("collectCount"),
            "duration":      None,
            "width":         None,
            "height":        None,
            "music_title":   music.get("title"),
            "music_artist":  music.get("authorName"),
            "music_id":      str(music["id"]) if music.get("id") else None,
            "_raw_video_data": _raw_video_data,
            **_author_info,
        }

    return {
        "type":          "video",
        "description":   item.get("desc", ""),
        "upload_date":   upload_date,
        "image_urls":    [],
        "view_count":    stats.get("playCount"),
        "like_count":    stats.get("diggCount"),
        "comment_count": stats.get("commentCount"),
        "share_count":   stats.get("shareCount"),
        "save_count":    stats.get("collectCount"),
        "duration":      video_meta.get("duration"),
        "width":         video_meta.get("width"),
        "height":        video_meta.get("height"),
        "music_title":   music.get("title"),
        "music_artist":  music.get("authorName"),
        "music_id":      str(music["id"]) if music.get("id") else None,
        "_raw_video_data": _raw_video_data,
        **_author_info,
    }
