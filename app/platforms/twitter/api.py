"""Twitter data fetching via gallery-dl.

gallery-dl drives the same internal web endpoints a logged-in browser uses,
authenticated with the cookies.txt uploaded in Settings > Twitter > Account. Accounts
are identified by their numeric user ID (gallery-dl's id: URL syntax), which
survives handle changes.
"""

from __future__ import annotations

import json
import os
import pathlib
from typing import Generator

import requests

from cookies import cookies_path

_REQUEST_TIMEOUT = 60


def _configure() -> None:
    from gallery_dl import config as gdl_config
    path = cookies_path("twitter")
    gdl_config.set(("extractor", "twitter"), "cookies", path if os.path.exists(path) else None)
    gdl_config.set(("extractor", "twitter"), "retweets", False)
    gdl_config.set(("extractor", "twitter"), "quoted", False)
    gdl_config.set(("extractor", "twitter"), "videos", True)


def _iter_messages(url: str):
    """Yield gallery-dl (msg_type, url, metadata) tuples for a twitter URL."""
    from gallery_dl import extractor
    _configure()
    ex = extractor.find(url)
    if ex is None:
        raise ValueError(f"Unsupported URL: {url}")
    return iter(ex)


def normalize_handle(handle: str) -> str:
    handle = handle.strip().lstrip("@")
    handle = handle.split("?", 1)[0].split("#", 1)[0]
    if "/" in handle:
        handle = handle.rstrip("/").rsplit("/", 1)[-1].lstrip("@")
    return handle


def fetch_profile_info(handle: str) -> dict:
    """Fetch profile metadata. Returns dict matching the channels DB schema."""
    from gallery_dl.extractor.message import Message

    handle = normalize_handle(handle)
    user   = None
    for msg in _iter_messages(f"https://x.com/{handle}/info"):
        if msg[0] == Message.Directory and msg[2]:
            user = msg[2]
            break
    if not user or not user.get("id"):
        raise ValueError(f"Profile @{handle} not found")

    return {
        "channel_id":       str(user["id"]),
        "handle":           user.get("name") or handle,
        "display_name":     user.get("nick") or user.get("name") or handle,
        "description":      user.get("description"),
        "subscriber_count": user.get("followers_count"),
        "video_count":      user.get("media_count"),
        "avatar_url":       user.get("profile_image") or None,
        "banner_url":       user.get("profile_banner") or None,
        "raw_channel_data": json.dumps({
            "url":            user.get("url"),
            "verified":       user.get("verified"),
            "protected":      user.get("protected"),
            "statuses_count": user.get("statuses_count"),
            "friends_count":  user.get("friends_count"),
            "join_date":      str(user.get("date") or ""),
        }, default=str),
    }


def iter_profile_posts(user_id: str) -> Generator[tuple[dict, list[dict]], None, None]:
    """Yield (post_dict, media_files) pairs for all media tweets of a user.

    media_files is a list of {url, extension, type, duration} dicts straight
    from gallery-dl, consumed by download_post_media.
    """
    from gallery_dl.extractor.message import Message

    current_id:    str | None = None
    current_post:  dict       = {}
    current_files: list[dict] = []

    for msg in _iter_messages(f"https://x.com/id:{user_id}/media"):
        if msg[0] != Message.Url:
            continue
        kw       = msg[2]
        tweet_id = str(kw.get("tweet_id") or "")
        if not tweet_id:
            continue
        if tweet_id != current_id:
            if current_id is not None:
                yield current_post, current_files
            date = kw.get("date")
            current_id    = tweet_id
            current_files = []
            current_post  = {
                "video_id":     tweet_id,
                "title":        (kw.get("content") or "")[:500],
                "upload_date":  int(date.timestamp()) if date else None,
                "duration":     None,
                "view_count":   kw.get("view_count"),
                "content_type": "image",
            }
        file = {
            "url":       msg[1],
            "extension": kw.get("extension") or "",
            "type":      kw.get("type") or "photo",
            "duration":  kw.get("duration"),
        }
        if file["type"] in ("video", "animated_gif"):
            current_post["content_type"] = "video"
            if current_post["duration"] is None and file["duration"]:
                current_post["duration"] = file["duration"]
        current_files.append(file)

    if current_id is not None:
        yield current_post, current_files


def download_post_media(files: list[dict], video_id: str, dest_dir: str,
                        upload_date: int | None = None) -> str | None:
    """Download a tweet's media files to dest_dir. Returns first saved path or None.

    Videos are saved as-is; photos are converted to AVIF with the original
    kept only if the encode fails (same policy as TikTok photo posts).
    """
    from photo_converter import encode_avif, CRF_PHOTO

    target = pathlib.Path(dest_dir)
    target.mkdir(parents=True, exist_ok=True)

    first_path: str | None = None
    total = len(files)

    for i, file in enumerate(files, 1):
        base = video_id if total == 1 else f"{video_id}_{i:02d}"
        ext  = file.get("extension") or ("mp4" if file.get("type") != "photo" else "jpg")
        path = target / f"{base}.{ext}"
        try:
            with requests.get(file["url"], stream=True, timeout=_REQUEST_TIMEOUT) as resp:
                resp.raise_for_status()
                with open(path, "wb") as f:
                    for chunk in resp.iter_content(chunk_size=1 << 16):
                        f.write(chunk)
        except Exception as e:
            print(f"[Twitter] Failed to download media {i}/{total} for {video_id}: {e}")
            try:
                os.remove(path)
            except OSError:
                pass
            continue

        saved = str(path)
        if file.get("type") == "photo":
            avif_path = target / f"{base}.avif"
            if encode_avif(str(path), str(avif_path), CRF_PHOTO):
                try:
                    os.remove(path)
                except OSError:
                    pass
                saved = str(avif_path)

        if upload_date:
            try:
                os.utime(saved, (upload_date, upload_date))
            except OSError:
                pass
        if first_path is None:
            first_path = os.path.abspath(saved)

    return first_path
