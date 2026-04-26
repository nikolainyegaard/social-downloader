"""
TikTok download loops (user and sound) and shared state used by both loop threads and the web server.
"""

import asyncio
import json
import os
import queue as _queue_module
import threading
import time
from collections import deque
from datetime import datetime, timezone

from platforms.tiktok import database as db
from platforms.tiktok.config import TIKTOK_DATA_DIR
from thumbnailer import backfill_thumbnails
import photo_converter as _photo_converter  # noqa: F401 -- starts conversion thread on import
from platforms.tiktok.tracker import process_all_sounds, process_single_sound
from platforms.tiktok.tracker import process_all_users, run_single_user_with_session

LOOP_STATE_PATH = os.path.join(TIKTOK_DATA_DIR, "loop_state.json")


def _load_loop_state() -> dict:
    try:
        with open(LOOP_STATE_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return {}


def _save_loop_state() -> None:
    with _user_state_lock:
        data = {
            "user_last_run_end":       user_loop_state["last_run_end"],
            "user_last_duration_secs": user_loop_state["last_run_duration_secs"],
            "user_last_new_videos":    user_loop_state["last_new_videos"],
        }
    with _sound_state_lock:
        data.update({
            "sound_last_run_end":       sound_loop_state["last_run_end"],
            "sound_last_duration_secs": sound_loop_state["last_run_duration_secs"],
            "sound_last_new_videos":    sound_loop_state["last_new_videos"],
        })
    os.makedirs(TIKTOK_DATA_DIR, exist_ok=True)
    with open(LOOP_STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f)


# ── User loop state ───────────────────────────────────────────────────────────

_persisted = _load_loop_state()

user_loop_state = {
    "running":                False,
    "last_run_end":           _persisted.get("user_last_run_end"),
    "last_run_duration_secs": _persisted.get("user_last_duration_secs"),
    "last_new_videos":        _persisted.get("user_last_new_videos"),
    "next_run":               None,
    "current_user":           None,
    "logs":                   deque(maxlen=1000),
}
_user_state_lock = threading.Lock()

trigger_user_event = threading.Event()

# Set to True when loop interval settings change; cleared by the scheduler thread.
_user_reschedule_flag  = False
_user_rflag_lock       = threading.Lock()

# ── Sound loop state ──────────────────────────────────────────────────────────

sound_loop_state = {
    "running":                False,
    "last_run_end":           _persisted.get("sound_last_run_end"),
    "last_run_duration_secs": _persisted.get("sound_last_duration_secs"),
    "last_new_videos":        _persisted.get("sound_last_new_videos"),
    "next_run":               None,
}
_sound_state_lock = threading.Lock()

trigger_sound_event = threading.Event()

_sound_reschedule_flag = False
_sound_rflag_lock      = threading.Lock()

# ── Single-user run queue ─────────────────────────────────────────────────────

_run_queue:      _queue_module.Queue = _queue_module.Queue()
_run_state_lock  = threading.Lock()
_run_state: dict = {"current": None, "queue": []}

# ── Single-sound run queue ────────────────────────────────────────────────────

_sound_run_queue:      _queue_module.Queue = _queue_module.Queue()
_sound_run_state_lock  = threading.Lock()
_sound_run_state: dict = {"current": None, "queue": []}


# ── Public accessors ──────────────────────────────────────────────────────────

def is_user_loop_running() -> bool:
    with _user_state_lock:
        return user_loop_state["running"]

# Backward-compat alias (used in older web.py import)
is_running = is_user_loop_running


def is_sound_loop_running() -> bool:
    with _sound_state_lock:
        return sound_loop_state["running"]


def set_user_loop_next_run(iso: str | None) -> None:
    with _user_state_lock:
        user_loop_state["next_run"] = iso

# Backward-compat alias
set_next_run = set_user_loop_next_run


def set_sound_loop_next_run(iso: str | None) -> None:
    with _sound_state_lock:
        sound_loop_state["next_run"] = iso


def get_state_snapshot() -> dict:
    """Return a serialisable snapshot of both loop states plus run-queue state."""
    with _user_state_lock:
        state = {
            "user_loop_running":            user_loop_state["running"],
            "user_loop_last_end":           user_loop_state["last_run_end"],
            "user_loop_last_duration_secs": user_loop_state["last_run_duration_secs"],
            "user_loop_last_new_videos":    user_loop_state["last_new_videos"],
            "user_loop_next":               user_loop_state["next_run"],
            "user_loop_current_user":       user_loop_state["current_user"],
            "logs":                         list(user_loop_state["logs"]),
        }
    with _sound_state_lock:
        state["sound_loop_running"]            = sound_loop_state["running"]
        state["sound_loop_last_end"]           = sound_loop_state["last_run_end"]
        state["sound_loop_last_duration_secs"] = sound_loop_state["last_run_duration_secs"]
        state["sound_loop_last_new_videos"]    = sound_loop_state["last_new_videos"]
        state["sound_loop_next"]               = sound_loop_state["next_run"]
    with _run_state_lock:
        state["run_current"] = _run_state["current"]
        state["run_queue"]   = list(_run_state["queue"])
    with _sound_run_state_lock:
        state["sound_run_current"] = _sound_run_state["current"]
        state["sound_run_queue"]   = list(_sound_run_state["queue"])
    return state


def reschedule_user_loop() -> None:
    """Wake the user scheduler to re-read its interval from DB without running the loop."""
    global _user_reschedule_flag
    with _user_rflag_lock:
        _user_reschedule_flag = True
    trigger_user_event.set()


def check_and_clear_user_reschedule() -> bool:
    global _user_reschedule_flag
    with _user_rflag_lock:
        val = _user_reschedule_flag
        _user_reschedule_flag = False
    return val


def reschedule_sound_loop() -> None:
    """Wake the sound scheduler to re-read its interval from DB without running the loop."""
    global _sound_reschedule_flag
    with _sound_rflag_lock:
        _sound_reschedule_flag = True
    trigger_sound_event.set()


def check_and_clear_sound_reschedule() -> bool:
    global _sound_reschedule_flag
    with _sound_rflag_lock:
        val = _sound_reschedule_flag
        _sound_reschedule_flag = False
    return val


def enqueue_user_run(tiktok_id: str) -> bool:
    """Queue a single-user manual run. Returns False if already queued/running."""
    with _run_state_lock:
        if tiktok_id in _run_state["queue"] or _run_state["current"] == tiktok_id:
            return False
        _run_state["queue"].append(tiktok_id)
    _run_queue.put(tiktok_id)
    return True


def enqueue_sound_run(sound_id: str) -> bool:
    """Queue a single-sound manual run. Returns False if already queued/running."""
    with _sound_run_state_lock:
        if sound_id in _sound_run_state["queue"] or _sound_run_state["current"] == sound_id:
            return False
        _sound_run_state["queue"].append(sound_id)
    _sound_run_queue.put(sound_id)
    return True


# ── Logging ───────────────────────────────────────────────────────────────────

def _log(msg: str):
    """Log to both the terminal and the in-app log shown in the UI."""
    ts   = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    with _user_state_lock:
        user_loop_state["logs"].append(line)


def _logd(msg: str):
    """Log to the terminal only -- implementation detail not shown in the UI."""
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}")


def _set_current_user(username: str | None) -> None:
    with _user_state_lock:
        user_loop_state["current_user"] = username


# ── Manual run workers ────────────────────────────────────────────────────────

def _run_worker():
    while True:
        tiktok_id = _run_queue.get()
        with _run_state_lock:
            if tiktok_id in _run_state["queue"]:
                _run_state["queue"].remove(tiktok_id)
            _run_state["current"] = tiktok_id
        try:
            user = db.get_user(tiktok_id)
            if user:
                label = f"@{user['username']}"
                _log(f"=== Manual user run started: {label} ===")
                asyncio.run(run_single_user_with_session(user, _log, _logd))
                _log(f"=== Manual user run complete: {label} ===")
            else:
                _log(f"Manual run: user {tiktok_id} not found in DB")
        except Exception as e:
            _log(f"Manual run error for {tiktok_id}: {e}")
        finally:
            with _run_state_lock:
                _run_state["current"] = None
            _run_queue.task_done()


def _sound_run_worker():
    while True:
        sound_id = _sound_run_queue.get()
        with _sound_run_state_lock:
            if sound_id in _sound_run_state["queue"]:
                _sound_run_state["queue"].remove(sound_id)
            _sound_run_state["current"] = sound_id
        try:
            sound = db.get_sound(sound_id)
            if sound:
                label = sound.get("label") or sound_id
                _log(f"=== Manual sound run started: {label} ===")
                asyncio.run(process_single_sound(sound, _log))
                _log(f"=== Manual sound run complete: {label} ===")
            else:
                _log(f"Manual sound run: {sound_id} not found in DB")
        except Exception as e:
            _log(f"Manual sound run error for {sound_id}: {e}")
        finally:
            with _sound_run_state_lock:
                _sound_run_state["current"] = None
            _sound_run_queue.task_done()


threading.Thread(target=_run_worker,        daemon=True, name="run-worker").start()
threading.Thread(target=_sound_run_worker,  daemon=True, name="sound-run-worker").start()
threading.Thread(target=backfill_thumbnails, daemon=True, name="thumb-backfill").start()


# ── Public entry points ───────────────────────────────────────────────────────

def run_user_loop():
    """Process all enabled tracked users. Called by the user loop scheduler thread."""
    with _user_state_lock:
        user_loop_state["running"] = True
    _loop_start = time.monotonic()
    _videos_before = db.count_downloaded_videos()

    _log("=== User loop started ===")
    users      = db.get_all_users()
    _completed = 0

    if not users:
        _log("No users configured -- nothing to do.")
    else:
        try:
            _completed = asyncio.run(process_all_users(users, _log, _logd, _set_current_user)) or 0
        except Exception as e:
            _log(f"Unhandled user loop error: {e}")

    last_run_end  = datetime.now(timezone.utc).isoformat()
    duration_secs = round(time.monotonic() - _loop_start)
    new_videos    = db.count_downloaded_videos() - _videos_before
    _log(f"=== User loop complete: {_completed}/{len(users)} users, {new_videos} new video(s) ===")
    with _user_state_lock:
        user_loop_state["running"]                = False
        user_loop_state["last_run_end"]           = last_run_end
        user_loop_state["last_run_duration_secs"] = duration_secs
        user_loop_state["last_new_videos"]        = new_videos
    _save_loop_state()


def run_sound_loop():
    """Process all tracked sounds. Called by the sound loop scheduler thread."""
    with _sound_state_lock:
        sound_loop_state["running"] = True
    _loop_start = time.monotonic()
    _videos_before = db.count_downloaded_videos()

    _log("=== Sound loop started ===")
    _sound_stats: dict | None = None
    try:
        _sound_stats = asyncio.run(process_all_sounds(_log))
    except Exception as e:
        _log(f"Unhandled sound loop error: {e}")

    last_run_end  = datetime.now(timezone.utc).isoformat()
    duration_secs = round(time.monotonic() - _loop_start)
    new_videos    = db.count_downloaded_videos() - _videos_before
    if _sound_stats:
        _log(f"=== Sound loop complete: {_sound_stats['sounds_checked']} sound(s) checked,"
             f" {new_videos} new video(s) ===")
    else:
        _log("=== Sound loop complete ===")
    with _sound_state_lock:
        sound_loop_state["running"]                = False
        sound_loop_state["last_run_end"]           = last_run_end
        sound_loop_state["last_run_duration_secs"] = duration_secs
        sound_loop_state["last_new_videos"]        = new_videos
    _save_loop_state()
