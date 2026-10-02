"""
Comment scraping into the comments table and media_text.

Opt-in per creator (channels.comments_enabled) or per post
(videos.comments_enabled, NULL follows the creator): pulling comments for
every saved post of every creator would be far more requests than the
posts themselves.

No worker and no schedule of its own: comments are fetched inside the
normal creator check, on the session the check already holds. Every
listing carries each post's comment count, so after the stats stage the
tracker asks due_posts() which opted-in posts changed since their last
comment fetch (comments_count_at_fetch, NULL = never) and fetches those,
capped per check. A post whose count did not move costs nothing; a post
with zero comments is never fetched. Fetch now in the viewer is the manual
override for one post, run on its own browser turn.

comments_failed counts consecutive failures and 3 parks the post until
Retry failed. Each fetch replaces the post's rows and its 'comment' rows in
media_text, so the search box finds comment text like captions and OCR.
"""

from __future__ import annotations

import json
import os
import threading
import time
from collections import deque

from config import DATA_DIR, MEDIA_DIR, _ts

_SETTINGS_PATH = os.path.join(DATA_DIR, "comments.json")

_DEFAULT_SETTINGS = {
    "max_per_post":  500,   # comments kept per post, replies included
    "max_per_check": 20,    # posts fetched per creator check; the rest wait for the next one
}

_state_lock = threading.Lock()
_recent: deque = deque(maxlen=10)   # {platform, video_id, handle, comments, secs, error}
_posts_done = 0


def get_settings() -> dict:
    try:
        with open(_SETTINGS_PATH, encoding="utf-8") as f:
            stored = json.load(f)
    except (OSError, ValueError):
        stored = {}
    return {**_DEFAULT_SETTINGS, **{k: stored[k] for k in _DEFAULT_SETTINGS if k in stored}}


def save_settings(changes: dict) -> dict:
    merged = {**get_settings(), **{k: changes[k] for k in _DEFAULT_SETTINGS if k in changes}}
    tmp = _SETTINGS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(merged, f, indent=2)
    os.replace(tmp, _SETTINGS_PATH)
    return merged


def due_posts(engine, channel_id: str, counts: dict[str, int | None]) -> list[tuple[str, int]]:
    """(video_id, count) pairs the check should fetch, from the listing's
    counts: opted in, not parked, and the count differs from the one at the
    last fetch. Capped by max_per_check, never-fetched posts first."""
    s = get_settings()
    return engine.db.get_comments_due(channel_id, counts)[:int(s["max_per_check"])]


def _save_images(engine, handle: str, rows: list[dict]) -> int:
    """Download the image of every picture comment (image_url, a CDN URL that
    expires) to media/{platform}/@handle/comments/{comment_id}.avif and set
    image_path. Already saved files are kept (a re-fetch replaces the rows,
    not the files). Returns how many were fetched now."""
    import requests
    from downloader import _load_cookies
    from photo_converter import encode_avif, CRF_PHOTO
    todo = [r for r in rows if r.get("image_url")]
    if not todo:
        return 0
    folder = os.path.join(MEDIA_DIR, engine.platform, f"@{handle}", "comments")
    os.makedirs(folder, exist_ok=True)
    cookies = proxies = None
    if engine.platform == "tiktok":
        from platforms.tiktok.config import COOKIES_PATH, get_proxy
        cookies = _load_cookies(COOKIES_PATH) if os.path.exists(COOKIES_PATH) else None
        proxy   = get_proxy()
        proxies = {"http": proxy, "https": proxy} if proxy else None
    n = 0
    for r in todo:
        base = os.path.join(folder, str(r["comment_id"]))
        have = next((base + ext for ext in (".avif", ".webp", ".jpg") if os.path.exists(base + ext)), None)
        if have:
            r["image_path"] = have
            continue
        try:
            resp = requests.get(r["image_url"], cookies=cookies, proxies=proxies, timeout=30)
            resp.raise_for_status()
            # Stickers are animated WebP (.awebp URLs, image/webp): kept as
            # is, browsers animate them and ffmpeg cannot. Photos go to AVIF
            # like photo posts
            if "webp" in resp.headers.get("Content-Type", "") or ".awebp" in r["image_url"].split("?")[0]:
                with open(base + ".webp", "wb") as f:
                    f.write(resp.content)
                r["image_path"] = base + ".webp"
            else:
                with open(base + ".jpg", "wb") as f:
                    f.write(resp.content)
                if encode_avif(base + ".jpg", base + ".avif", CRF_PHOTO):
                    os.remove(base + ".jpg")
                    r["image_path"] = base + ".avif"
                else:
                    r["image_path"] = base + ".jpg"
            n += 1
        except Exception as e:
            print(f"[{_ts()}] [comments] image of {r['comment_id']} failed: {type(e).__name__}: {e}")
    return n


def record(engine, video_id: str, channel_id: str, handle: str | None,
           count: int | None, rows: list[dict] | None, error: Exception | None,
           secs: float, log=None) -> None:
    """Store a fetch result (rows) or a failure (error) and log one line."""
    global _posts_done
    if handle is None:
        handle = (engine.db.get_channel(channel_id) or {}).get("handle")
    rec = {"platform": engine.platform, "video_id": video_id, "handle": handle,
           "comments": len(rows or []), "secs": round(secs, 1), "error": None}
    if error is None:
        images = _save_images(engine, handle, rows or []) if handle else 0
        engine.db.replace_comments(video_id, channel_id, rows or [], count)
        line = f"{len(rows or [])} comment(s) in {rec['secs']}s" + (f", {images} image(s)" if images else "")
    else:
        engine.db.mark_comments_failed(video_id)
        last = next((l for l in reversed(str(error).splitlines()) if l.strip()), "")
        rec["error"] = f"{type(error).__name__}: {last.strip()[:200]}"
        line = f"failed: {rec['error']}"
    with _state_lock:
        _recent.appendleft(rec)
        _posts_done += 1
    msg = f"[comments] {engine.platform} @{handle} {video_id}: {line}"
    print(f"[{_ts()}] {msg}")
    if log:
        log(f"  Comments {video_id}: {line}")


def fetch_now(engine, video_id: str) -> None:
    """Viewer's Fetch now: turn the post on and fetch it in a thread on the
    adapter's own-turn path (run_browser_job for TikTok)."""
    v = engine.db.get_video(video_id)
    engine.db.queue_video_comments(video_id)
    s = get_settings()

    def _run():
        t0 = time.time()
        try:
            rows = engine.adapter.fetch_comments(engine, v, int(s["max_per_post"]))
            record(engine, video_id, v["channel_id"], None, v.get("comment_count"), rows, None,
                   time.time() - t0)
        except Exception as e:
            record(engine, video_id, v["channel_id"], None, v.get("comment_count"), None, e,
                   time.time() - t0)

    threading.Thread(target=_run, daemon=True, name=f"comments-{video_id}").start()


def retry_failed() -> int:
    from platforms.registry import ENGINES
    return sum(e.db.reset_comments_failed() for e in ENGINES.values() if e.adapter.fetch_comments)


def get_status() -> dict:
    from platforms.registry import ENGINES
    from config import platform_enabled
    counts = {"pending": 0, "done": 0, "failed": 0, "comments": 0}
    platforms = []
    for e in ENGINES.values():
        if not e.adapter.fetch_comments:
            continue
        platforms.append(e.platform)
        if not platform_enabled(e.platform):
            continue
        for k, v in e.db.comments_counts().items():
            counts[k] += v
    with _state_lock:
        return {
            "settings":   get_settings(),
            "platforms":  platforms,
            "counts":     counts,
            "posts_done": _posts_done,
            "recent":     list(_recent),
        }
