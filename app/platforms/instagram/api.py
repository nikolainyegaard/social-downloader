"""Instagram data fetching via instaloader."""

from __future__ import annotations

import json
import os
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


def _session_file() -> str:
    from config import DATA_DIR
    return os.path.join(DATA_DIR, "instagram", "session")


def _session_user_file() -> str:
    from config import DATA_DIR
    return os.path.join(DATA_DIR, "instagram", "session_user")


def get_session_status() -> dict:
    username = _L.context.username
    if username:
        return {"logged_in": True, "username": username}
    saved_user = None
    uf = _session_user_file()
    if os.path.exists(uf):
        with open(uf) as f:
            saved_user = f.read().strip() or None
    return {"logged_in": False, "username": None, "saved_username": saved_user}


def login(username: str, password: str) -> None:
    _L.login(username, password)
    sf = _session_file()
    os.makedirs(os.path.dirname(sf), exist_ok=True)
    _L.save_session_to_file(sf)
    with open(_session_user_file(), "w") as f:
        f.write(username)


def logout() -> None:
    _L.logout()
    for path in (_session_file(), _session_user_file()):
        try:
            os.remove(path)
        except FileNotFoundError:
            pass


def _load_saved_session() -> None:
    uf = _session_user_file()
    sf = _session_file()
    if not (os.path.exists(uf) and os.path.exists(sf)):
        return
    try:
        with open(uf) as f:
            username = f.read().strip()
        if username:
            _L.load_session_from_file(username, sf)
    except Exception:
        pass


_load_saved_session()


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
