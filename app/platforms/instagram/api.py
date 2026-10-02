"""Instagram data fetching via instaloader, with HikerAPI for profile lookup
and post listing when HIKERAPI_KEY is set.

Instagram gates the web profile and feed endpoints per session (429 and
"feedback_required") long before it touches the story GraphQL query or the
CDN, so a flagged cookies.txt still fetches stories and downloads media but
never lists posts. HikerAPI (a hosted Instagram data API) takes over exactly
those two calls; everything else keeps running on the local session."""

from __future__ import annotations

import json
import os
import pathlib
import time
from datetime import timezone
from typing import Generator

import instaloader
import requests

from cookies import cookies_path, get_cookies_flat

HIKERAPI_KEY = os.environ.get("HIKERAPI_KEY", "").strip()
_HIKERAPI    = "https://api.hikerapi.com"

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
        # load_session builds the jar with empty cookie domains, so Instagram's
        # Set-Cookie responses add .instagram.com duplicates instead of
        # overwriting, and a later cookies.get() raises CookieConflictError.
        # Rebuild the jar with the real domain so responses overwrite in place
        jar = requests.cookies.RequestsCookieJar()
        for name, value in flat.items():
            jar.set(name, value, domain=".instagram.com", path="/")
        _L.context._session.cookies = jar
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


def _hiker_iter_posts(user_id: str) -> Generator[tuple[dict, dict], None, None]:
    """HikerAPI /g2/user/medias, one request per page of 9 to 12 items. The
    raw post is the HikerAPI item dict (private API media shape) and goes to
    download_post_media as is. Some keys arrive with a GraphQL type prefix
    ("1ltaken_at", "1fvideo_duration"), hence the fallbacks."""
    page_id = None
    while True:
        params = {"user_id": user_id}
        if page_id:
            params["next_page_id"] = page_id
        data  = _hiker_get("/g2/user/medias", params)
        items = (data.get("response") or {}).get("items") or []
        for item in items:
            caption = item.get("caption")
            yield {
                "video_id":     item["code"],
                "title":        ((caption or {}).get("text") if isinstance(caption, dict) else caption or "")[:500],
                "upload_date":  item.get("taken_at") or item.get("1ltaken_at"),
                "duration":     item.get("video_duration") or item.get("1fvideo_duration"),
                "view_count":   item.get("like_count"),
                "comment_count": item.get("comment_count"),
                "content_type": "video" if item.get("media_type") == 2 else "image",
            }, item
        page_id = data.get("next_page_id")
        if not items or not page_id:
            break


_SHORTCODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"


def shortcode_to_pk(code: str) -> int:
    """A post's shortcode is its numeric media id in Instagram's base-64
    alphabet, so the pk the comment endpoint wants needs no request."""
    pk = 0
    for ch in code:
        pk = pk * 64 + _SHORTCODE_ALPHABET.index(ch)
    return pk


def fetch_comments(video: dict, max_count: int = 500) -> list[dict]:
    """HikerAPI /v2/media/comments for one post, paged by page_id (one
    request per page of about 20 top-level comments). Replies come only as
    the preview children the page carries; full reply threads are a separate
    endpoint per comment and are not fetched. Comment ids are the private
    API pks, users carry username and full_name."""
    if not HIKERAPI_KEY:
        raise RuntimeError("HIKERAPI_KEY is not set; Instagram comments need HikerAPI")
    pk = shortcode_to_pk(video["video_id"])

    def _row(c: dict, parent: str | None) -> dict | None:
        cid, text = str(c.get("pk") or c.get("id") or ""), (c.get("text") or "").strip()
        if not cid or not text:
            return None
        u = c.get("user") or {}
        return {"comment_id": cid, "parent_id": parent,
                "author": u.get("username"), "author_name": u.get("full_name") or None,
                "author_id": str(u.get("pk") or "") or None, "text": text,
                "likes": c.get("comment_like_count"),
                "created_at": c.get("created_at_utc") or c.get("created_at"), "image_url": None}

    rows: list[dict] = []
    page_id = None
    while len(rows) < max_count:
        params = {"id": pk}
        if page_id:
            params["page_id"] = page_id
        data  = _hiker_get("/v2/media/comments", params)
        resp  = data.get("response") if isinstance(data, dict) else data
        items = (resp.get("items") or resp.get("comments") or []) if isinstance(resp, dict) else (resp or [])
        if not items:
            break
        for c in items:
            r = _row(c, None)
            if r:
                rows.append(r)
            for child in c.get("preview_child_comments") or []:
                cr = _row(child, r["comment_id"] if r else None)
                if cr:
                    rows.append(cr)
        # HikerAPI returns a next_page_id even on the last page; following
        # it answers 404 "Entries not found", so has_more_comments decides
        page_id = data.get("next_page_id") if isinstance(data, dict) else None
        if not page_id or not (isinstance(resp, dict) and resp.get("has_more_comments")):
            break
        time.sleep(1)
    return rows[:max_count]


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
    # dict_from_cookiejar tolerates duplicate cookie names, unlike .get()
    csrf = requests.utils.dict_from_cookiejar(session.cookies).get("csrftoken")
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
            if "HTTP 429" in str(e):
                # The fallback below hits the same endpoint on the same
                # session, so it cannot succeed; instaloader's 429 handling
                # sleeps 20+ minutes before raising. Fail fast instead.
                # Phrase without "does not exist" so this reads as transient
                raise instaloader.ConnectionException(
                    f"Profile lookup for {handle} rate limited (429), "
                    "skipping search fallback") from e
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


def _hiker_get(path: str, params: dict) -> dict:
    """GET a HikerAPI endpoint. Raises on a non-200 response with the body,
    so the run log shows HikerAPI's own reason (balance, not found)."""
    resp = requests.get(_HIKERAPI + path, params=params, timeout=30,
                        headers={"x-access-key": HIKERAPI_KEY, "accept": "application/json"})
    if resp.status_code != 200:
        raise RuntimeError(f"HikerAPI HTTP {resp.status_code}: {resp.text[:300]}")
    return resp.json()


def _hiker_profile_info(handle: str) -> dict:
    try:
        user = _hiker_get("/v2/user/by/username", {"username": handle})["user"]
    except RuntimeError as e:
        # HikerAPI answers 404 for unknown, deleted, and banned usernames
        # alike. Phrase with "does not exist" so the adapter's gone markers
        # match, the same contract as the instaloader path
        if "HTTP 404" in str(e):
            raise RuntimeError(f"Profile {handle} does not exist ({e})") from e
        raise
    hd = user.get("hd_profile_pic_url_info") or {}
    return {
        "channel_id":       str(user.get("pk") or user["id"]),
        "handle":           user["username"],
        "display_name":     user.get("full_name") or user["username"],
        "description":      user.get("biography"),
        "subscriber_count": user.get("follower_count"),
        "video_count":      user.get("media_count"),
        "avatar_url":       hd.get("url") or user.get("profile_pic_url"),
        "banner_url":       None,
        "raw_channel_data": json.dumps({
            "external_url": user.get("external_url"),
            "is_verified":  user.get("is_verified"),
            "is_private":   user.get("is_private"),
            "following":    user.get("following_count"),
        }),
    }


def fetch_profile_info(handle: str) -> dict:
    """Fetch profile metadata. Returns dict matching the channels DB schema."""
    if HIKERAPI_KEY:
        return _hiker_profile_info(handle)
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


def iter_profile_posts(user_id: str, limit: int | None = None) -> Generator[tuple[dict, object], None, None]:
    """Yield (post_dict, raw_post) pairs for all posts of a profile, newest first.

    limit is unused: pagination is lazy, so the engine stopping consumption
    already stops the fetching.

    Paginates the web frontend's /api/v1/feed/user/ endpoint directly:
    instaloader's Profile.get_posts uses a GraphQL doc_id Instagram retired,
    a persistent 401 dressed up as a rate limit message (instaloader issue
    #2689, unfixed in 4.15.2). Feed items come in the shape
    Post.from_iphone_struct wraps, so downloads work unchanged."""
    if HIKERAPI_KEY:
        yield from _hiker_iter_posts(user_id)
        return
    url    = f"https://www.instagram.com/api/v1/feed/user/{user_id}/"
    max_id = None
    while True:
        params = {"count": 12}
        if max_id:
            params["max_id"] = max_id
        data = _web_api_get(url, params, "https://www.instagram.com/")
        for item in data.get("items") or []:
            post = instaloader.Post.from_iphone_struct(_L.context, item)
            yield {
                "video_id":     post.shortcode,
                "title":        (post.caption or "")[:500],
                "upload_date":  int(post.date_utc.timestamp()),
                "duration":     None,
                # Headline count convention (see engine iter_posts): this feed
                # has no view counts except play_count on reels, so likes fill
                # the column; the UI labels it "Likes" via viewsLabel.
                "view_count":   item.get("like_count"),
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


def _media_url(item: dict) -> str | None:
    """Best media URL of one private-API media item: the largest video
    version, else the largest image candidate."""
    vids = item.get("video_versions") or []
    if vids:
        return max(vids, key=lambda v: (v.get("width") or 0) * (v.get("height") or 0))["url"]
    cands = (item.get("image_versions2") or {}).get("candidates") or []
    if cands:
        return max(cands, key=lambda c: (c.get("width") or 0) * (c.get("height") or 0))["url"]
    return None


def _download_hiker_media(item: dict, target: pathlib.Path) -> str | None:
    """Direct CDN GETs for a HikerAPI item, named like instaloader's output
    ({code}.ext, carousel {code}_N.ext) so the rest of the app sees no
    difference. Raises on the first failed file."""
    from urllib.parse import urlparse
    from transcoder import maybe_enqueue
    code     = item["code"]
    children = item.get("carousel_media") or []
    jobs = ([(f"{code}_{n}", _media_url(c)) for n, c in enumerate(children, 1)]
            if children else [(code, _media_url(item))])
    first = None
    for stem, url in jobs:
        if not url:
            raise RuntimeError(f"{stem}: no media URL in HikerAPI item")
        ext  = os.path.splitext(urlparse(url).path)[1].lstrip(".") or "bin"
        path = target / f"{stem}.{ext}"
        with requests.get(url, stream=True, timeout=60) as r:
            if r.status_code != 200:
                raise RuntimeError(f"{stem}: CDN HTTP {r.status_code}")
            with open(path, "wb") as f:
                for chunk in r.iter_content(1 << 16):
                    f.write(chunk)
        if ext == "mp4":
            maybe_enqueue(str(path))
        first = first or str(path.resolve())
    return first


def download_post_media(post, dest_dir: str) -> str | None:
    """Download a post's primary media file to dest_dir. Returns absolute path or None."""
    target = pathlib.Path(dest_dir)
    target.mkdir(parents=True, exist_ok=True)
    if isinstance(post, dict):
        return _download_hiker_media(post, target)
    shortcode = post.shortcode
    try:
        _L.download_post(post, target=target)
    except Exception:
        return None
    # Videos land as {shortcode}.mp4 or {shortcode}_N.mp4 (carousel); offer
    # each to the transcode queue (it filters by size and settings itself).
    from transcoder import maybe_enqueue
    for name in os.listdir(target):
        if name.startswith(shortcode) and name.endswith(".mp4"):
            maybe_enqueue(str(target / name))
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
