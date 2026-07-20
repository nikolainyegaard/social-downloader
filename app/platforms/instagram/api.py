"""Instagram data fetching via instaloader."""

from __future__ import annotations

import json
import os
import pathlib
from datetime import timezone
from typing import Generator

import instaloader

_L = instaloader.Instaloader(
    quiet=True,
    # The i.instagram.com iphone API 429s instantly for sessions like ours and
    # instaloader retries it with 30 minute sleeps; web endpoints cover everything
    iphone_support=False,
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
    handle = handle.split("?", 1)[0].split("#", 1)[0]
    if "/" in handle:
        handle = handle.rstrip("/").rsplit("/", 1)[-1].lstrip("@")
    return handle


_WEB_APP_ID = "936619743392459"  # X-IG-App-ID the instagram.com web frontend sends


def _profile_from_username(handle: str) -> instaloader.Profile:
    """Resolve a username to a Profile.

    instaloader 4.15 resolves usernames through Instagram's logged-out search
    endpoint, which omits many smaller accounts entirely and misreports them
    as nonexistent (instaloader PR #2715). Instead, when logged in, make the
    same web_profile_info request the instagram.com frontend makes when a
    profile page opens: the www variant with the web app id header and the
    session's own cookies (gallery-dl resolves usernames the same way).
    instaloader only wraps the i.instagram.com variant of this endpoint,
    which rate limits sessions like ours on the first request. Any error
    falls back to the library's own lookup."""
    if _L.context.is_logged_in:
        try:
            session = _L.context._session
            headers = {
                "X-IG-App-ID":      _WEB_APP_ID,
                "X-Requested-With": "XMLHttpRequest",
                "Referer":          f"https://www.instagram.com/{handle}/",
            }
            csrf = session.cookies.get("csrftoken")
            if csrf:
                headers["X-CSRFToken"] = csrf
            resp = session.get(
                "https://www.instagram.com/api/v1/users/web_profile_info/",
                params={"username": handle}, headers=headers, timeout=30)
            if resp.status_code == 200:
                body = resp.json()
                user = (body.get("data") or {}).get("user")
                if user is not None:
                    return instaloader.Profile(_L.context, user)
                if body.get("status") == "ok":
                    # Healthy answer with no user is authoritative nonexistence.
                    # Keep the library's message so the gone markers match
                    raise instaloader.ProfileNotExistsException(
                        f"Profile {handle} does not exist.")
        except instaloader.ProfileNotExistsException:
            raise
        except Exception:
            pass
    return instaloader.Profile.from_username(_L.context, handle)


def fetch_profile_info(handle: str) -> dict:
    """Fetch profile metadata. Returns dict matching the channels DB schema."""
    profile = _profile_from_username(handle)
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


def _story_item_to_dict(item) -> dict | None:
    """Map an instaloader StoryItem to the engine story dict contract.
    Returns None when the item carries no downloadable media URL."""
    def _utc_ts(dt):
        try:
            return int(dt.replace(tzinfo=timezone.utc).timestamp())
        except Exception:
            return None

    posted_at  = _utc_ts(item.date_utc) if getattr(item, "date_utc", None) else None
    exp        = getattr(item, "expiring_utc", None)
    expires_at = _utc_ts(exp) if exp is not None else None
    if expires_at is None and posted_at:
        expires_at = posted_at + 24 * 3600

    media_url = item.video_url if item.is_video else item.url
    if not media_url:
        return None
    return {
        "story_id":     str(item.mediaid),
        "content_type": "video" if item.is_video else "photo",
        "posted_at":    posted_at,
        "expires_at":   expires_at,
        "media_url":    media_url,
    }


def fetch_stories(user_id: str) -> list[dict]:
    """Currently live stories of a profile, mapped to the engine story
    contract. Requires the logged-in session: instaloader refuses story
    access anonymously, so without one this returns [] instead of raising
    on every check."""
    if not _L.context.is_logged_in:
        return []
    stories: list[dict] = []
    for story in _L.get_stories(userids=[int(user_id)]):
        for item in story.get_items():
            d = _story_item_to_dict(item)
            if d:
                stories.append(d)
    return stories


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
