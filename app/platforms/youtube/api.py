"""YouTube data fetching via yt-dlp."""

from __future__ import annotations

import re
from datetime import datetime

import yt_dlp


def _to_url(raw: str) -> str:
    """Convert @handle, channel ID, or any YouTube URL to a canonical URL."""
    raw = raw.strip()
    if raw.startswith("http://") or raw.startswith("https://"):
        return raw
    # Raw channel ID: starts with UC
    if re.match(r"^UC[a-zA-Z0-9_-]+$", raw):
        return f"https://www.youtube.com/channel/{raw}"
    handle = raw.lstrip("@")
    return f"https://www.youtube.com/@{handle}"


def fetch_channel_info(url_or_handle: str) -> dict:
    """Fetch channel metadata. Returns a dict with channel_id, handle, display_name, etc."""
    url = _to_url(url_or_handle)
    ydl_opts = {"quiet": True, "no_warnings": True}
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False, process=False)
    if not info:
        raise ValueError(f"No channel info returned for: {url_or_handle}")
    return _parse_channel(info)


def _parse_channel(info: dict) -> dict:
    avatar_url, banner_url = _split_thumbs(info.get("thumbnails") or [])
    handle = (info.get("uploader_id") or "").lstrip("@")
    return {
        "channel_id":       info.get("channel_id") or info.get("id"),
        "handle":           handle,
        "display_name":     info.get("channel") or info.get("uploader") or info.get("title"),
        "description":      info.get("description"),
        "subscriber_count": info.get("channel_follower_count"),
        "video_count":      info.get("playlist_count"),
        "avatar_url":       avatar_url,
        "banner_url":       banner_url,
    }


def _split_thumbs(thumbs: list) -> tuple[str | None, str | None]:
    """Separate avatar (square) from banner (wide) thumbnails.

    Tries id-keyword hints first; falls back to aspect ratio.
    Returns (avatar_url, banner_url).
    """
    avatar_cands: list[dict] = []
    banner_cands: list[dict] = []

    for t in thumbs:
        url = t.get("url")
        if not url:
            continue
        tid   = (t.get("id") or "").lower()
        w, h  = t.get("width") or 0, t.get("height") or 0
        ratio = (w / h) if h else 0

        if "avatar" in tid:
            avatar_cands.append(t)
        elif "banner" in tid:
            banner_cands.append(t)
        elif w and h:
            if ratio <= 1.5:
                avatar_cands.append(t)
            elif ratio > 2.5:
                banner_cands.append(t)

    def _best(cands: list[dict]) -> str | None:
        return max(cands, key=lambda t: t.get("width") or 0)["url"] if cands else None

    return _best(avatar_cands), _best(banner_cands)


def fetch_channel_videos(channel_id: str) -> list[dict]:
    """Fetch all video IDs from all content tabs (Videos, Shorts, Streams)."""
    ydl_opts = {"quiet": True, "no_warnings": True, "extract_flat": True}
    videos: dict[str, dict] = {}
    last_exc: Exception | None = None

    for tab in ("/videos", "/shorts", "/streams"):
        url = f"https://www.youtube.com/channel/{channel_id}{tab}"
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
            for e in (info.get("entries") or []):
                if e and e.get("id"):
                    videos[e["id"]] = e
        except Exception as e:
            last_exc = e

    if not videos and last_exc is not None:
        raise last_exc

    return [
        {
            "video_id":    e.get("id"),
            "title":       e.get("title"),
            "upload_date": _parse_date(e.get("upload_date")),
            "duration":    e.get("duration"),
            "view_count":  e.get("view_count"),
        }
        for e in videos.values()
    ]


def _parse_date(val) -> int | None:
    if not val:
        return None
    try:
        return int(datetime.strptime(str(val), "%Y%m%d").timestamp())
    except (ValueError, TypeError):
        return None


def normalize_handle(raw: str) -> str:
    """Strip @ and whitespace from a handle or URL string."""
    raw = raw.strip()
    m = re.search(r"youtube\.com/@([\w.-]+)", raw)
    if m:
        return m.group(1)
    return raw.lstrip("@")
