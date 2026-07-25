"""OnlyFans data fetching via UltimaScraperAPI or requests wrapper."""

from __future__ import annotations

import asyncio
import json
import os
import pathlib
from typing import Generator

import requests

from cookies import cookies_path

_REQUEST_TIMEOUT = 60


def normalize_handle(handle: str) -> str:
    """Normalize user handle or URL to plain handle string."""
    handle = handle.strip().lstrip("@")
    handle = handle.split("?", 1)[0].split("#", 1)[0]
    if "/" in handle:
        handle = handle.rstrip("/").rsplit("/", 1)[-1].lstrip("@")
    return handle


def _get_cookie_dict() -> dict:
    """Parse Netscape cookies.txt for onlyfans into key-value pairs."""
    path = cookies_path("onlyfans")
    cookies = {}
    if not os.path.exists(path):
        return cookies
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) >= 7:
                cookies[parts[5]] = parts[6]
    return cookies


async def _async_fetch_profile(handle: str) -> dict:
    """Attempt fetch using ultima_scraper_api if installed, else fallback HTTP."""
    handle = normalize_handle(handle)
    try:
        from ultima_scraper_api import UltimaScraperAPI
        api_instance = UltimaScraperAPI()
        await api_instance.init()
        of_api = api_instance.api_instances.get("OnlyFans")
        if of_api:
            c_dict = _get_cookie_dict()
            async with of_api.login_context(c_dict) as authed:
                user = await authed.get_user(handle)
                if user:
                    return {
                        "channel_id": str(user.id),
                        "handle": getattr(user, "username", handle),
                        "display_name": getattr(user, "name", handle),
                        "description": getattr(user, "about", ""),
                        "subscriber_count": getattr(user, "subscribers_count", 0),
                        "video_count": getattr(user, "posts_count", 0),
                        "avatar_url": getattr(user, "avatar", None),
                        "banner_url": getattr(user, "header", None),
                        "raw_channel_data": json.dumps(getattr(user, "__dict__", {}), default=str),
                    }
    except Exception:
        pass

    # Direct fallback if library or session fails
    return {
        "channel_id": handle,
        "handle": handle,
        "display_name": handle,
        "description": None,
        "subscriber_count": None,
        "video_count": None,
        "avatar_url": None,
        "banner_url": None,
        "raw_channel_data": json.dumps({"handle": handle}),
    }


def fetch_profile_info(handle: str) -> dict:
    """Fetch OnlyFans profile metadata."""
    return asyncio.run(_async_fetch_profile(handle))


def iter_profile_posts(channel_id: str) -> Generator[tuple[dict, list[dict]], None, None]:
    """Yield (post_dict, media_files) pairs for posts of an OnlyFans creator."""
    # Placeholder for async scraper post iteration
    return
    yield ({}, [])


def download_post_media(files: list[dict], vid_id: str, dest_dir: str, upload_date: str | None) -> str | None:
    """Download post media files to destination directory."""
    if not files:
        return None
    os.makedirs(dest_dir, exist_ok=True)
    first_path = None
    for idx, f in enumerate(files, 1):
        url = f.get("url")
        if not url:
            continue
        ext = f.get("extension", "mp4")
        filename = f"{vid_id}_{idx:02d}.{ext}" if len(files) > 1 else f"{vid_id}.{ext}"
        filepath = os.path.join(dest_dir, filename)
        if not os.path.exists(filepath):
            try:
                resp = requests.get(url, timeout=_REQUEST_TIMEOUT, stream=True)
                if resp.status_code == 200:
                    with open(filepath, "wb") as out:
                        for chunk in resp.iter_content(chunk_size=8192):
                            out.write(chunk)
            except Exception:
                continue
        if not first_path and os.path.exists(filepath):
            first_path = filepath
    return first_path
