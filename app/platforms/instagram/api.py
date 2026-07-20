"""Instagram data fetching via instaloader."""

from __future__ import annotations

import json
import os
import pathlib
import time
from datetime import timezone
from typing import Generator

import instaloader

from cookies import cookies_path, get_cookies_flat

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
    # Default is "{caption}", which writes a stray {shortcode}.txt next to
    # every downloaded post; titles live in the DB
    post_metadata_txt_pattern="",
    compress_json=False,
    filename_pattern="{shortcode}",
    request_timeout=30,
)


def reload_session_from_cookies() -> str | None:
    """(Re)build the instaloader session from the uploaded cookies.txt.

    Called at import and whenever the file changes (the cookies routes'
    on_change hook). Instagram serves rate limits to sessions minted by
    instaloader's own password login, so authentication is cookies exported
    from a real browser, the same model as Twitter. Returns an error message
    when a present file lacks the cookies instaloader needs, leaving the
    session logged out."""
    flat = get_cookies_flat("instagram")
    missing = [c for c in ("sessionid", "csrftoken") if c not in flat]
    if not missing:
        # The username only feeds instaloader display and own-profile helpers
        # the app never calls; the numeric ds_user_id stands in
        _L.load_session(flat.get("ds_user_id") or "session", flat)
        return None
    _L.context._session.cookies.clear()
    _L.context.username = None
    if os.path.exists(cookies_path("instagram")):
        return "cookies.txt is missing the " + " and ".join(missing) + " cookie(s)"
    return None


reload_session_from_cookies()


def normalize_handle(handle: str) -> str:
    handle = handle.strip().lstrip("@")
    handle = handle.split("?", 1)[0].split("#", 1)[0]
    if "/" in handle:
        handle = handle.rstrip("/").rsplit("/", 1)[-1].lstrip("@")
    return handle


_WEB_APP_ID = "936619743392459"  # X-IG-App-ID the instagram.com web frontend sends


def _web_api_get(url: str, params: dict, referer: str) -> dict:
    """GET a www.instagram.com/api/v1 endpoint on the instaloader session with
    the headers the web frontend sends. Raises on a non-200 response.

    instaloader's own wrappers cannot make these requests: get_json sends only
    the session's default headers (no web app id, so Instagram answers 401)
    and get_iphone_json hits i.instagram.com, which rate limits sessions like
    ours on the first request and retries with 30 minute sleeps."""
    session = _L.context._session
    headers = {
        "X-IG-App-ID":      _WEB_APP_ID,
        "X-ASBD-ID":        "129477",
        "X-Requested-With": "XMLHttpRequest",
        "Referer":          referer,
    }
    csrf = session.cookies.get("csrftoken")
    if csrf:
        headers["X-CSRFToken"] = csrf
    resp = session.get(url, params=params, headers=headers, timeout=30)
    if resp.status_code != 200:
        raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:300]}")
    return resp.json()


def _profile_from_username(handle: str) -> instaloader.Profile:
    """Resolve a username to a Profile.

    instaloader 4.15 resolves usernames through Instagram's logged-out search
    endpoint, which omits many smaller accounts entirely and misreports them
    as nonexistent (instaloader PR #2715). Instead, when logged in, make the
    same web_profile_info request the instagram.com frontend makes when a
    profile page opens (gallery-dl resolves usernames the same way). Any
    error falls back to the library's own lookup."""
    web_err = None
    if _L.context.is_logged_in:
        try:
            body = _web_api_get(
                "https://www.instagram.com/api/v1/users/web_profile_info/",
                {"username": handle}, f"https://www.instagram.com/{handle}/")
            user = (body.get("data") or {}).get("user")
            if user is not None:
                return instaloader.Profile(_L.context, user)
            if body.get("status") == "ok":
                # Healthy answer with no user is authoritative nonexistence.
                # Must contain "does not exist" so the gone markers match
                raise instaloader.ProfileNotExistsException(
                    f"Profile {handle} does not exist (web profile endpoint).")
            web_err = f"unexpected response: {str(body)[:300]}"
        except instaloader.ProfileNotExistsException:
            raise
        except Exception as e:
            web_err = repr(e)
    else:
        web_err = "no session login"
    try:
        return instaloader.Profile.from_username(_L.context, handle)
    except instaloader.ProfileNotExistsException as e:
        # The search lookup omits small accounts, so absence here proves
        # nothing when the direct lookup gave no healthy answer. Phrase
        # without "does not exist" so the loop never reads this as banned
        raise instaloader.ConnectionException(
            f"Profile lookup for {handle} failed; web profile endpoint: "
            f"{web_err}; search fallback found no match") from e


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
    """Yield (post_dict, raw_post) pairs for all posts of a profile, newest first.

    Paginates the web frontend's /api/v1/feed/user/ endpoint directly:
    instaloader's Profile.get_posts uses a GraphQL doc_id Instagram retired,
    a persistent 401 dressed up as a rate limit message (instaloader issue
    #2689, unfixed in 4.15.2). Feed items come in the shape
    Post.from_iphone_struct wraps, so downloads work unchanged."""
    url    = f"https://www.instagram.com/api/v1/feed/user/{user_id}/"
    max_id = None
    while True:
        params = {"count": 12}
        if max_id:
            params["max_id"] = max_id
        data = _web_api_get(url, params, "https://www.instagram.com/")
        for item in data.get("items") or []:
            post = instaloader.Post.from_iphone_struct(_L.context, item)
            try:
                view_count = post.video_view_count if post.is_video else None
            except Exception:
                # Missing from the feed item; fetching full post metadata
                # uses another retired doc_id, so never fall through to it
                view_count = None
            yield {
                "video_id":     post.shortcode,
                "title":        (post.caption or "")[:500],
                "upload_date":  int(post.date_utc.timestamp()),
                "duration":     None,
                "view_count":   view_count,
                "content_type": "video" if post.is_video else "image",
            }, post
        if not data.get("more_available"):
            break
        max_id = data.get("next_max_id")
        if not max_id:
            break
        time.sleep(2)


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
