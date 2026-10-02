"""
Background comment scraping into the comments table and media_text.

Opt-in per creator (channels.comments_enabled) or per post
(videos.comments_enabled, NULL follows the creator): pulling comments for
every saved post of every creator would be far more requests than the
posts themselves. Platforms join by setting the adapter's fetch_comments
hook; the worker skips the rest.

Queue model: the videos columns are the queue. comments_fetched_at NULL
means pending; posts younger than refresh_days are fetched again once a
day so new comments on live posts land; comments_failed counts consecutive
failures and 3 parks the post until Retry failed. Each fetch replaces the
post's rows and its 'comment' rows in media_text, so the search box finds
comment text like captions and OCR text.
"""

from __future__ import annotations

import json
import os
import threading
import time
from collections import deque

from config import DATA_DIR, _ts

_SETTINGS_PATH = os.path.join(DATA_DIR, "comments.json")

_DEFAULT_SETTINGS = {
    "enabled":      False,
    "paused":       False,
    "refresh_days": 30,    # posts younger than this are re-fetched daily
    "max_per_post": 500,   # comments kept per post, replies included
    "gap_secs":     10,    # pause between posts
}

_state_lock = threading.Lock()
_state: dict = {
    "current":    None,   # {platform, video_id, handle}
    "message":    "",
    "recent":     deque(maxlen=10),   # {platform, video_id, handle, comments, secs, error}
    "posts_done": 0,
    "started_at": None,
}
_wake = threading.Event()
_worker_started = False


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
    _wake.set()
    return merged


def wake() -> None:
    _wake.set()


def _fetch_one(eng, v: dict, s: dict) -> dict:
    t0  = time.time()
    rec = {"platform": eng.platform, "video_id": v["video_id"], "handle": v.get("handle"),
           "comments": 0, "secs": 0, "error": None}
    try:
        rows = eng.adapter.fetch_comments(eng, v, int(s["max_per_post"]))
        eng.db.replace_comments(v["video_id"], v["channel_id"], rows)
        rec["comments"] = len(rows)
        print(f"[{_ts()}] [comments] {eng.platform} @{v.get('handle')} {v['video_id']}: "
              f"{len(rows)} comment(s) in {round(time.time() - t0, 1)}s")
    except Exception as e:
        eng.db.mark_comments_failed(v["video_id"])
        last = next((l for l in reversed(str(e).splitlines()) if l.strip()), "")
        rec["error"] = f"{type(e).__name__}: {last.strip()[:200]}"
        print(f"[{_ts()}] [comments] {eng.platform} @{v.get('handle')} {v['video_id']} failed: {rec['error']}")
    rec["secs"] = round(time.time() - t0, 1)
    return rec


def _worker() -> None:
    from platforms.registry import ENGINES
    from config import platform_enabled
    print(f"[{_ts()}] [comments] worker started")
    was_active = None
    while True:
        try:
            s = get_settings()
            active = s["enabled"] and not s["paused"]
            if active != was_active:
                print(f"[{_ts()}] [comments] " + ("running" if active else
                      ("paused" if s["enabled"] else "disabled, waiting")))
                was_active = active
            if not active:
                _wake.wait(15)
                _wake.clear()
                continue
            with _state_lock:
                if _state["started_at"] is None:
                    _state["started_at"] = time.time()
            did_any = False
            for eng in ENGINES.values():
                if not eng.adapter.fetch_comments or not platform_enabled(eng.platform):
                    continue
                for v in eng.db.get_comments_pending(int(s["refresh_days"]), limit=10):
                    did_any = True
                    with _state_lock:
                        _state["current"] = {"platform": eng.platform, "video_id": v["video_id"],
                                             "handle": v.get("handle")}
                    rec = _fetch_one(eng, v, s)
                    with _state_lock:
                        _state["recent"].appendleft(rec)
                        _state["posts_done"] += 1
                        _state["current"] = None
                    s = get_settings()
                    if not s["enabled"] or s["paused"]:
                        break
                    _wake.wait(max(1, int(s["gap_secs"])))
                    _wake.clear()
            if not did_any:
                print(f"[{_ts()}] [comments] nothing pending, checking again in 60 s")
                _wake.wait(60)
                _wake.clear()
        except Exception as e:
            print(f"[{_ts()}] [comments] worker error: {type(e).__name__}: {e}")
            with _state_lock:
                _state["current"] = None
            time.sleep(30)


def start() -> None:
    """Called once from main.py after init_db. Idempotent."""
    global _worker_started
    if _worker_started:
        return
    _worker_started = True
    threading.Thread(target=_worker, daemon=True, name="comments-worker").start()


def retry_failed() -> int:
    from platforms.registry import ENGINES
    n = sum(e.db.reset_comments_failed() for e in ENGINES.values() if e.adapter.fetch_comments)
    _wake.set()
    return n


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
        elapsed = (time.time() - _state["started_at"]) if _state["started_at"] else 0
        return {
            "settings":   get_settings(),
            "platforms":  platforms,
            "current":    dict(_state["current"]) if _state["current"] else None,
            "message":    _state["message"],
            "counts":     counts,
            "posts_done": _state["posts_done"],
            "posts_per_min": round(_state["posts_done"] / (elapsed / 60), 1) if elapsed > 30 else None,
            "recent":     list(_state["recent"]),
        }
