"""OnlyFans data fetching via UltimaScraperAPI.

OnlyFans signs its API with an x-bc token that lives in the browser's
localStorage, not in cookies, so a cookies.txt is not enough to authenticate.
The account is instead an auth.json (the UltimaScraperAPI credential file):
a cookie string carrying auth_id and sess, plus x_bc and user_agent. It is
uploaded through the shared cookies file store (Settings > OnlyFans > Account)
and read back from cookies_path("onlyfans").
"""

from __future__ import annotations

import asyncio
import glob
import html
import json
import os
import pathlib
import re
import threading
from datetime import datetime
from typing import Generator
from urllib.parse import urlparse

import requests

from cookies import cookies_path

_REQUEST_TIMEOUT = 60

# Keys AuthDetails(**auth_json) accepts; anything else makes create_auth_details
# raise, so the uploaded file is filtered down to these before it is passed in.
_ALLOWED_AUTH_KEYS = {
    "id", "username", "cookie", "x_bc", "user_agent",
    "email", "password", "hashed", "support_2fa", "active",
}


def clean_html(text: str | None) -> str | None:
    """Flatten the HTML OnlyFans returns in bios and post text to plain text.

    <br> and </p> become newlines, all other tags are dropped, entities are
    unescaped. Also used by scripts/clean_onlyfans_html.py to repair rows
    stored before this existed.
    """
    if not text:
        return text
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"</p\s*>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    text = re.sub(r"\n[ \t]+\n", "\n\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


# Stored columns that may hold raw HTML from before clean_html existed:
# (table, id column, text column, extra WHERE)
_HTML_TARGETS = (
    ("channels",        "channel_id", "description",  ""),
    ("channels",        "channel_id", "display_name", ""),
    ("videos",          "video_id",   "title",        ""),
    ("profile_history", "id",         "old_value",    "AND field IN ('description', 'bio', 'display_name')"),
)


def clean_stored_html(conn, apply: bool = True) -> list[dict]:
    """Strip stored HTML from bios and post titles written before clean_html
    existed. Returns per-column {column, rows, dirty} counts; apply=False only
    reports. Idempotent: already-clean rows are never rewritten. Used by the
    Jobs card (Settings > OnlyFans > Jobs) and scripts/clean_onlyfans_html.py."""
    results = []
    for table, id_col, col, extra in _HTML_TARGETS:
        rows = conn.execute(
            f"SELECT {id_col}, {col} FROM {table} WHERE {col} IS NOT NULL AND {col} != '' {extra}"
        ).fetchall()
        changed = [(clean_html(v), rid) for rid, v in rows if clean_html(v) != v]
        if apply and changed:
            conn.executemany(f"UPDATE {table} SET {col} = ? WHERE {id_col} = ?", changed)
        results.append({"column": f"{table}.{col}", "rows": len(rows), "dirty": len(changed)})
    return results


def normalize_handle(handle: str) -> str:
    """Normalize user handle or URL to plain handle string."""
    handle = handle.strip().lstrip("@")
    handle = handle.split("?", 1)[0].split("#", 1)[0]
    if "/" in handle:
        handle = handle.rstrip("/").rsplit("/", 1)[-1].lstrip("@")
    return handle


def _normalize_auth(raw: dict) -> dict:
    """Coerce an uploaded auth file into the flat shape login_context wants."""
    if isinstance(raw.get("auth"), dict):        # some exports wrap it as {"auth": {...}}
        raw = raw["auth"]
    data = {k.lower(): v for k, v in raw.items()}  # OF-DL Auth Helper exports USER_ID/X_BC/COOKIE
    uid = data.get("user_id")
    if uid is not None and "id" not in data:
        data["id"] = int(uid) if str(uid).isdigit() else 0
    if not data.get("cookie"):                   # legacy format: build the cookie string
        auth_id = data.get("auth_id") or data.get("authid")
        sess = data.get("sess")
        if auth_id and sess:
            data["cookie"] = f"auth_id={auth_id}; sess={sess}"
    clean = {k: v for k, v in data.items() if k in _ALLOWED_AUTH_KEYS}
    clean.setdefault("id", 0)                     # login_context reads auth_json["id"]
    return clean


def _validate_auth(auth: dict) -> str | None:
    """Return an error string if the auth is unusable, else None."""
    cookie = auth.get("cookie") or ""
    if "auth_id=" not in cookie or "sess=" not in cookie:
        return "auth is missing cookie values auth_id and sess"
    if not auth.get("x_bc"):
        return "auth is missing x_bc"
    if not auth.get("user_agent"):
        return "auth is missing user_agent"
    return None


def validate_auth_file() -> str | None:
    """cookie-route on_change hook: reject an uploaded file that is not usable auth."""
    path = cookies_path("onlyfans")
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
    except Exception as e:
        return f"Not valid JSON: {e}"
    if not isinstance(raw, dict):
        return "auth must be a JSON object"
    return _validate_auth(_normalize_auth(raw))


def _load_auth() -> dict:
    path = cookies_path("onlyfans")
    if not os.path.exists(path):
        raise RuntimeError("No OnlyFans auth uploaded (Settings > OnlyFans > Account)")
    with open(path, encoding="utf-8") as f:
        auth = _normalize_auth(json.load(f))
    err = _validate_auth(auth)
    if err:
        raise RuntimeError(f"OnlyFans auth invalid: {err}")
    return auth


def _coerce_identifier(value: str) -> int | str:
    value = str(value)
    return int(value) if value.isdigit() else value


# ── Persistent session ─────────────────────────────────────────────────────────
# One background event loop owns a single logged-in UltimaScraperAPI session,
# shared by profile, post, and story fetches (previously every call was a fresh
# login, so two or three per creator per check). The session is dropped when the
# uploaded auth file changes or a call fails unexpectedly; the next call then
# logs in fresh.

_session: dict = {"loop": None, "lock": None, "ctx": None, "authed": None, "auth_mtime": None}
_session_thread_lock = threading.Lock()


def _session_loop() -> asyncio.AbstractEventLoop:
    with _session_thread_lock:
        if _session["loop"] is None:
            loop = asyncio.new_event_loop()
            threading.Thread(target=loop.run_forever, daemon=True, name="of-session").start()
            _session["loop"] = loop
        return _session["loop"]


async def _close_session() -> None:
    ctx = _session["ctx"]
    _session["ctx"] = _session["authed"] = _session["auth_mtime"] = None
    if ctx is not None:
        try:
            await ctx.__aexit__(None, None, None)
        except Exception:
            pass


async def _get_authed():
    """Return the cached logged-in session, logging in (again) when there is
    none or the auth file changed since the last login."""
    if _session["lock"] is None:            # bg loop is single-threaded: no race
        _session["lock"] = asyncio.Lock()
    async with _session["lock"]:
        auth  = _load_auth()                 # clear error if missing or invalid
        mtime = os.path.getmtime(cookies_path("onlyfans"))
        if _session["authed"] is not None and _session["auth_mtime"] == mtime:
            return _session["authed"]
        await _close_session()
        import ultima_scraper_api

        api = ultima_scraper_api.select_api("onlyfans")
        ctx = api.login_context(auth_json=auth)
        authed = await ctx.__aenter__()
        if not authed:
            await ctx.__aexit__(None, None, None)
            raise RuntimeError("OnlyFans authentication failed; re-upload auth")
        _session.update(ctx=ctx, authed=authed, auth_mtime=mtime)
        return authed


async def _use_session(identifier, fn):
    authed = await _get_authed()
    try:
        user = await authed.get_user(identifier)
        if not user:
            raise ValueError(f"OnlyFans user {identifier} not found")
        return await fn(authed, user)
    except ValueError:
        raise                                # creator gone; the session is fine
    except Exception:
        async with _session["lock"]:         # anything else may be a dead session
            await _close_session()
        raise


def _run(identifier, fn):
    """Run fn(authed, user) on the shared logged-in session.

    All API calls must happen inside fn, never on returned objects afterwards:
    the session can be replaced between _run calls."""
    fut = asyncio.run_coroutine_threadsafe(_use_session(identifier, fn), _session_loop())
    return fut.result()


async def _profile(authed, user) -> dict:
    return {
        "channel_id":       str(user.id),
        "handle":           user.username,
        "display_name":     clean_html(user.name) or user.username,
        "description":      clean_html(user.about) or None,
        "subscriber_count": None,          # OnlyFans hides a creator's subscriber count from subscribers
        "video_count":      user.posts_count or None,
        "avatar_url":       user.avatar or None,
        "banner_url":       user.header or None,
        "raw_channel_data": json.dumps({
            "verified":     user.is_verified,
            "join_date":    user.join_date,
            "location":     user.location,
            "website":      user.website,
            "photos_count": user.photos_count,
            "videos_count": user.videos_count,
            "audios_count": user.audios_count,
        }, default=str),
    }


def fetch_profile_info(handle: str) -> dict:
    """Fetch OnlyFans profile metadata."""
    return _run(normalize_handle(handle), _profile)


def _ext_from_url(url: str) -> str:
    name = os.path.basename(urlparse(url).path)
    ext  = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    return ext if ext.isalnum() and len(ext) <= 5 else ""


async def _collect_posts(authed, user, limit: int | None = None) -> list[tuple[dict, list[dict]]]:
    if limit is None:
        posts = await user.get_posts()
    else:
        # get_posts always pages the creator's full archive (its limit param is
        # a page size, the total comes from the profile's post count), so a
        # capped fetch builds just the first page links the same way get_posts
        # does. Newest posts come first. Tied to ultima-scraper-api==2.2.45.
        from ultima_scraper_api.apis.onlyfans.classes.extras import endpoint_links

        epl   = endpoint_links()
        link  = epl.list_posts(user.id)
        links = epl.create_links(link, min(limit, user.posts_count or limit), limit=50)
        posts = user.finalize_content_set(await user.scrape_manager.bulk_scrape(links))
    result: list[tuple[dict, list[dict]]] = []
    for post in posts:
        files: list[dict] = []
        for media in post.media:
            try:
                picked = post.url_picker(media)
            except Exception:
                picked = None
            if not picked:                  # locked/unpurchased media returns None
                continue
            url   = picked.geturl()
            mtype = media.get("type") or "photo"
            files.append({
                "url":       url,
                "extension": _ext_from_url(url) or ("jpg" if mtype == "photo" else "mp4"),
                "type":      mtype,
                "duration":  media.get("duration"),
            })
        if not files:
            if not post.media:              # text-only: nothing to archive, ever
                continue
            # Media exists but none of it is downloadable (locked/unpurchased):
            # keep the post in the listing so it does not read as deleted, but
            # record and download nothing.
            result.append(({"video_id": str(post.id), "listing_only": True}, []))
            continue

        has_video = any(f["type"] in ("video", "gif") for f in files)
        if has_video:
            content_type = "video"
        elif all(f["type"] == "audio" for f in files):
            content_type = "audio"
        else:
            content_type = "image"

        created = post.created_at
        result.append(({
            "video_id":     str(post.id),
            "title":        clean_html(post.text) or "",
            "upload_date":  int(created.timestamp()) if created else None,
            "duration":     next((f["duration"] for f in files
                                  if f["type"] in ("video", "gif") and f["duration"]), None),
            # OnlyFans exposes likes, not views; stored as view_count so the
            # column, sorting, and count refresh work unchanged. The UI labels
            # it "Likes" for this platform (viewsLabel in onlyfans.js).
            "view_count":   getattr(post, "favoritesCount", None),
            "content_type": content_type,
            "media_count":  len(files),
        }, files))
    return result


async def _collect_stories(authed, user) -> list[dict]:
    stories = await user.get_stories()
    result: list[dict] = []
    for story in stories:
        for m in story.media:                # media dicts; usually one per story
            try:
                picked = story.url_picker(m)
            except Exception:
                picked = None
            if not picked:                   # locked or DRM: nothing to save
                continue
            expires = None
            if story.expiredAt:
                try:
                    expires = int(datetime.fromisoformat(story.expiredAt).timestamp())
                except ValueError:
                    pass
            mtype = m.get("type") or "photo"
            result.append({
                "story_id":     str(m.get("id")) if len(story.media) > 1 else str(story.id),
                "content_type": "photo" if mtype == "photo" else "video",
                "posted_at":    int(story.created_at.timestamp()),
                "expires_at":   expires,
                "media_url":    picked.geturl(),
            })
    return result


def fetch_stories(channel_id: str) -> list[dict]:
    """Currently live stories of a creator, mapped to the engine story contract
    ({story_id, content_type, posted_at, expires_at, media_url})."""
    return _run(_coerce_identifier(channel_id), _collect_stories)


def iter_profile_posts(channel_id: str, limit: int | None = None) -> Generator[tuple[dict, list[dict]], None, None]:
    """Yield (post_dict, media_files) pairs for an OnlyFans creator's posts,
    newest first. limit caps the fetch (quick checks pass quick_limit, one
    page request instead of the whole archive); None fetches everything."""
    async def _fn(authed, user):
        return await _collect_posts(authed, user, limit)
    for pair in _run(_coerce_identifier(channel_id), _fn):
        yield pair


def download_post_media(files: list[dict], video_id: str, dest_dir: str,
                        upload_date: int | None = None) -> str | None:
    """Download a post's media to dest_dir. Returns first saved path or None.

    Photos are converted to AVIF (original kept only if the encode fails);
    videos and audio are saved as-is. Same policy as the other platforms.

    Files already on disk are skipped, so a retry of a partially failed post
    (the engine requeues posts whose media_count exceeds the files found)
    only fetches the gaps. Assumes the post's media order is stable between
    fetches, since files are named by position.
    """
    from photo_converter import encode_avif, CRF_PHOTO

    target = pathlib.Path(dest_dir)
    target.mkdir(parents=True, exist_ok=True)

    first_path: str | None = None
    total = len(files)

    for i, file in enumerate(files, 1):
        base = video_id if total == 1 else f"{video_id}_{i:02d}"
        existing = glob.glob(os.path.join(glob.escape(dest_dir), glob.escape(base) + ".*"))
        if existing:
            if first_path is None:
                first_path = os.path.abspath(existing[0])
            continue
        ext  = file.get("extension") or ("jpg" if file.get("type") == "photo" else "mp4")
        path = target / f"{base}.{ext}"
        try:
            with requests.get(file["url"], stream=True, timeout=_REQUEST_TIMEOUT) as resp:
                resp.raise_for_status()
                with open(path, "wb") as f:
                    for chunk in resp.iter_content(chunk_size=1 << 16):
                        f.write(chunk)
        except Exception as e:
            print(f"[OnlyFans] Failed to download media {i}/{total} for {video_id}: {e}")
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


if __name__ == "__main__":
    # ponytail self-check: the auth normalizer and validator, no network.
    legacy = _normalize_auth({"auth_id": "42", "sess": "abc", "x_bc": "xb", "user_agent": "UA"})
    assert legacy["cookie"] == "auth_id=42; sess=abc", legacy
    assert legacy["id"] == 0
    assert _validate_auth(legacy) is None

    wrapped = _normalize_auth({"auth": {"cookie": "auth_id=1; sess=z", "x_bc": "x", "user_agent": "u", "extra": 9}})
    assert "extra" not in wrapped
    assert _validate_auth(wrapped) is None

    assert _validate_auth({"cookie": "sess=z", "x_bc": "x", "user_agent": "u"})  # missing auth_id
    assert _validate_auth({"cookie": "auth_id=1; sess=z", "user_agent": "u"})    # missing x_bc
    assert _ext_from_url("https://cdn.onlyfans.com/files/a/ab/xyz.mp4?Tag=1") == "mp4"
    assert _ext_from_url("https://cdn.onlyfans.com/noext") == ""

    ofdl = _normalize_auth({"USER_ID": "77", "USER_AGENT": "UA", "X_BC": "xb", "COOKIE": "auth_id=77; sess=s"})
    assert ofdl["id"] == 77 and ofdl["x_bc"] == "xb" and ofdl["user_agent"] == "UA", ofdl
    assert _validate_auth(ofdl) is None

    assert clean_html("Hi!<br /> Bye<br /> <br /> &lt;3") == "Hi!\n Bye\n\n <3"
    assert clean_html("Lily &lt;3") == "Lily <3"
    assert clean_html("<p>Marin Kitagawa ! I’m here</p>") == "Marin Kitagawa ! I’m here"
    assert clean_html(None) is None and clean_html("") == ""
    print("ok")
