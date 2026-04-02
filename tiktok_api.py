"""TikTok data fetching."""

from __future__ import annotations

import json
import re


async def get_user_info(api, username: str | None = None,
                        sec_uid: str | None = None) -> dict:
    """Fetch user profile data. Returns a normalised dict.

    Pass username= on first add (before sec_uid is known).
    Pass sec_uid= in the loop — works even after the user changes their username,
    since TikTok does not redirect old usernames (they 404).
    TikTokApi's .info() accepts either username or (user_id + sec_uid).
    """
    kwargs: dict = {}
    if username:
        kwargs["username"] = username
    if sec_uid:
        kwargs["sec_uid"] = sec_uid
    if not kwargs:
        raise ValueError("Must provide username or sec_uid")
    user = api.user(**kwargs)
    data = await user.info()
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
    }


def get_user_videos(tiktok_id: str, cookies_path: str | None = None) -> list[dict]:
    """List all videos from a user's profile using yt-dlp flat extraction.
    Uses the numeric TikTok ID so lookups survive username changes.
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

    url    = f"tiktokuser:{tiktok_id}"
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

    try:
        upload_date = int(item.get("createTime") or 0) or None
    except (ValueError, TypeError):
        upload_date = None

    image_post = item.get("imagePost")
    if image_post:
        image_urls = [
            img["imageURL"]["urlList"][0]
            for img in image_post.get("images", [])
            if img.get("imageURL", {}).get("urlList")
        ]
        return {
            "type":        "photo",
            "description": item.get("desc", ""),
            "upload_date": upload_date,
            "image_urls":  image_urls,
        }

    return {
        "type":        "video",
        "description": item.get("desc", ""),
        "upload_date": upload_date,
        "image_urls":  [],
    }
