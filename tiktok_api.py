"""TikTok data fetching."""

from __future__ import annotations

import copy
import json
import re


async def get_user_info(api, username: str | None = None,
                        user_id: str | None = None,
                        sec_uid: str | None = None) -> dict:
    """Fetch user profile data. Returns a normalised dict.

    Pass username= on first add (before sec_uid is known).
    Pass user_id= + sec_uid= in the loop to survive username changes; TikTok does
    not redirect old usernames (they 404). TikTokApi's .info() requires either
    username OR (user_id + sec_uid) together; sec_uid alone is not valid.
    """
    if user_id and sec_uid:
        user = api.user(user_id=user_id, sec_uid=sec_uid)
    elif username:
        user = api.user(username=username)
    else:
        raise ValueError("Must provide username or (user_id + sec_uid)")
    try:
        data = await user.info()
    except KeyError as exc:
        # TikTokApi's __extract_from_data does hard dict access and raises KeyError
        # when TikTok returns a partial/empty response (deleted account, bot block, etc.)
        raise RuntimeError(
            f"TikTokApi returned incomplete data for @{username or sec_uid} "
            f"(missing key {exc}) -- account may not exist or cookies may be stale"
        ) from exc
    u = data.get("userInfo", {}).get("user", {})
    s = data.get("userInfo", {}).get("stats", {})

    if not u.get("id"):
        raise ValueError(f"No user data returned for @{username or sec_uid}")

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


async def fetch_sound_video_ids(sound_id: str, ms_token: str | None,
                                chrome_executable: str | None) -> list[str]:
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
