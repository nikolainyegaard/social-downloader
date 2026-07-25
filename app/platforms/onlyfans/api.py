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
import html
import json
import os
import pathlib
import re
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
    ("channels",        "channel_id", "description", ""),
    ("videos",          "video_id",   "title",       ""),
    ("profile_history", "id",         "old_value",   "AND field IN ('description', 'bio')"),
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


async def _run(identifier, fn):
    """Authenticate and run fn(authed, user) inside the live session.

    login_context closes its aiohttp session on exit, so every call to the API
    must happen inside this block, never on the returned objects afterwards.

    ponytail: re-authenticates on every call (profile fetch and post fetch are
    separate engine hooks, so that is two logins per creator per check). Fine at
    a handful of creators; if OnlyFans rate-limits the re-auth, cache one authed
    session per loop pass the way TikTok's browser_gate does.
    """
    import ultima_scraper_api

    api = ultima_scraper_api.select_api("onlyfans")
    async with api.login_context(auth_json=_load_auth()) as authed:
        if not authed:
            raise RuntimeError("OnlyFans authentication failed; re-upload auth")
        user = await authed.get_user(identifier)
        if not user:
            raise ValueError(f"OnlyFans user {identifier} not found")
        return await fn(authed, user)


async def _profile(authed, user) -> dict:
    return {
        "channel_id":       str(user.id),
        "handle":           user.username,
        "display_name":     user.name or user.username,
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
    return asyncio.run(_run(normalize_handle(handle), _profile))


def _ext_from_url(url: str) -> str:
    name = os.path.basename(urlparse(url).path)
    ext  = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    return ext if ext.isalnum() and len(ext) <= 5 else ""


async def _collect_posts(authed, user) -> list[tuple[dict, list[dict]]]:
    posts = await user.get_posts()          # defaults fetch the full post count
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
        if not files:                       # text-only or fully locked: nothing to archive
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
            "title":        (clean_html(post.text) or "")[:500],
            "upload_date":  int(created.timestamp()) if created else None,
            "duration":     next((f["duration"] for f in files
                                  if f["type"] in ("video", "gif") and f["duration"]), None),
            "view_count":   None,
            "content_type": content_type,
        }, files))
    return result


def iter_profile_posts(channel_id: str) -> Generator[tuple[dict, list[dict]], None, None]:
    """Yield (post_dict, media_files) pairs for an OnlyFans creator's posts."""
    for pair in asyncio.run(_run(_coerce_identifier(channel_id), _collect_posts)):
        yield pair


def download_post_media(files: list[dict], video_id: str, dest_dir: str,
                        upload_date: int | None = None) -> str | None:
    """Download a post's media to dest_dir. Returns first saved path or None.

    Photos are converted to AVIF (original kept only if the encode fails);
    videos and audio are saved as-is. Same policy as the other platforms.
    """
    from photo_converter import encode_avif, CRF_PHOTO

    target = pathlib.Path(dest_dir)
    target.mkdir(parents=True, exist_ok=True)

    first_path: str | None = None
    total = len(files)

    for i, file in enumerate(files, 1):
        base = video_id if total == 1 else f"{video_id}_{i:02d}"
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
    assert clean_html("<p>Marin Kitagawa ! I’m here</p>") == "Marin Kitagawa ! I’m here"
    assert clean_html(None) is None and clean_html("") == ""
    print("ok")
