"""YouTube data fetching via yt-dlp."""

from __future__ import annotations

import json
import re
from datetime import datetime

import yt_dlp

_CHANNEL_STRIP_KEYS = frozenset({"thumbnails", "formats", "requested_formats", "entries"})


def _raw_fetch_entries(channel_id: str, limit: int = 5) -> list[dict]:
    """Fetch raw yt-dlp flat-extraction entries for diagnostics. Returns first `limit` entries per tab."""
    ydl_opts = {"quiet": True, "no_warnings": True, "extract_flat": True}
    results = []
    for tab, ctype in [("/videos", "video"), ("/shorts", "short"), ("/streams", "stream")]:
        url = f"https://www.youtube.com/channel/{channel_id}{tab}"
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
            entries = (info.get("entries") or [])[:limit]
            for e in entries:
                if e:
                    safe = {k: v for k, v in e.items() if isinstance(v, (str, int, float, bool, type(None)))}
                    results.append({"_tab": tab, "_ctype": ctype, **safe})
        except Exception as ex:
            results.append({"_tab": tab, "_error": str(ex)})
    return results


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
    """Fetch channel metadata. Returns a dict with channel_id, handle, display_name, raw_channel_data, etc.

    Uses a processed flat extraction limited to one playlist item; lazy_playlist
    + playlist_items keeps it to a single page fetch. The explicit /featured tab
    is tried first: a tabless channel or @handle URL resolves to a metadata-less
    husk (title = channel ID, everything else null) when the channel has no
    videos tab (e.g. shorts-only channels), while /featured always carries the
    channel metadata.
    """
    url = _to_url(url_or_handle)
    ydl_opts = {"quiet": True, "no_warnings": True, "extract_flat": True,
                "playlist_items": "1", "lazy_playlist": True}

    urls = [url]
    if not re.search(r"/(featured|videos|shorts|streams|live|playlists|community|about)/?$", url):
        urls.insert(0, url.rstrip("/") + "/featured")

    parsed:   dict | None      = None
    last_exc: Exception | None = None
    for u in urls:
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(u, download=False)
        except Exception as e:
            last_exc = e
            continue
        if not info:
            continue
        parsed = _parse_channel(info)
        if parsed.get("handle") or parsed.get("display_name"):
            return parsed
    if parsed is not None:
        return parsed
    if last_exc is not None:
        raise last_exc
    raise ValueError(f"No channel info returned for: {url_or_handle}")


def _parse_channel(info: dict) -> dict:
    avatar_url, banner_url = _split_thumbs(info.get("thumbnails") or [])
    channel_id = info.get("channel_id") or info.get("id")
    handle = (info.get("uploader_id") or "").lstrip("@")
    if not handle:
        m = re.search(r"youtube\.com/@([\w.-]+)",
                      info.get("uploader_url") or info.get("channel_url") or "")
        handle = m.group(1) if m else ""
    display_name = info.get("channel") or info.get("uploader") or info.get("title")
    cleaned = {k: v for k, v in info.items() if k not in _CHANNEL_STRIP_KEYS}
    return {
        "channel_id":       channel_id,
        "handle":           handle or None,
        "display_name":     None if display_name == channel_id else display_name,
        "description":      info.get("description"),
        "subscriber_count": info.get("channel_follower_count"),
        "video_count":      info.get("playlist_count"),
        "avatar_url":       avatar_url,
        "banner_url":       banner_url,
        "raw_channel_data": _safe_json(cleaned),
    }


def _safe_json(obj) -> str | None:
    try:
        return json.dumps(obj, default=str)
    except Exception:
        return None


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

    for tab, ctype in [("/videos", "video"), ("/shorts", "short"), ("/streams", "stream")]:
        url = f"https://www.youtube.com/channel/{channel_id}{tab}"
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
            for e in (info.get("entries") or []):
                if e and e.get("id") and e["id"] not in videos:
                    videos[e["id"]] = {**e, "_ctype": ctype}
        except Exception as e:
            last_exc = e

    if not videos and last_exc is not None:
        raise last_exc

    return [
        {
            "video_id":     e.get("id"),
            "title":        e.get("title"),
            "upload_date":  _parse_date(e.get("upload_date")) or e.get("timestamp"),
            "duration":     e.get("duration"),
            "view_count":   e.get("view_count"),
            "content_type": e.get("_ctype", "video"),
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
