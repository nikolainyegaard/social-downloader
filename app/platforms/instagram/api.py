"""Instagram data fetching via instaloader."""

from __future__ import annotations

import json
import pathlib
from typing import Generator

import instaloader

_L = instaloader.Instaloader(
    quiet=True,
    download_pictures=True,
    download_videos=True,
    download_video_thumbnails=False,
    download_geotags=False,
    download_comments=False,
    save_metadata=False,
    compress_json=False,
    filename_pattern="{shortcode}",
    request_timeout=30,
)


def normalize_handle(handle: str) -> str:
    handle = handle.strip().lstrip("@")
    if "/" in handle:
        handle = handle.rstrip("/").rsplit("/", 1)[-1].lstrip("@")
    return handle


def fetch_profile_info(handle: str) -> dict:
    """Fetch profile metadata. Returns dict matching the channels DB schema."""
    profile = instaloader.Profile.from_username(_L.context, handle)
    return {
        "channel_id":       str(profile.userid),
        "handle":           profile.username,
        "display_name":     profile.full_name or profile.username,
        "description":      profile.biography,
        "subscriber_count": profile.followers,
        "video_count":      profile.mediacount,
        "avatar_url":       profile.profile_pic_url,
        "banner_url":       None,
        "raw_channel_data": json.dumps({
            "external_url": profile.external_url,
            "is_verified":  profile.is_verified,
            "is_private":   profile.is_private,
            "following":    profile.followees,
        }),
    }


def iter_profile_posts(user_id: str) -> Generator[tuple[dict, object], None, None]:
    """Yield (post_dict, raw_post) pairs for all posts of a profile."""
    profile = instaloader.Profile.from_id(_L.context, int(user_id))
    for post in profile.get_posts():
        yield {
            "video_id":     post.shortcode,
            "title":        (post.caption or "")[:500],
            "upload_date":  int(post.date_utc.timestamp()),
            "duration":     None,
            "view_count":   post.video_view_count if post.is_video else None,
            "content_type": "video" if post.is_video else "image",
        }, post


def download_post_media(post, dest_dir: str) -> str | None:
    """Download a post's primary media file to dest_dir. Returns absolute path or None."""
    target = pathlib.Path(dest_dir)
    target.mkdir(parents=True, exist_ok=True)
    shortcode = post.shortcode
    try:
        _L.download_post(post, target=target)
    except Exception:
        return None
    for ext in ("mp4", "jpg", "jpeg", "png", "webp"):
        path = target / f"{shortcode}.{ext}"
        if path.exists():
            return str(path.resolve())
    # Carousel: first item named {shortcode}_1.ext
    for ext in ("mp4", "jpg", "jpeg", "png", "webp"):
        path = target / f"{shortcode}_1.{ext}"
        if path.exists():
            return str(path.resolve())
    return None
