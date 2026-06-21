"""
TikTok download loops (user and sound) and shared state used by both loop threads and the web server.
"""

import atexit
import asyncio
import json
import os
import queue as _queue_module
import threading
import time
from collections import deque
from datetime import datetime, timezone

from platforms.tiktok import database as db
from platforms.tiktok.config import TIKTOK_DATA_DIR, HIGH_PRIORITY_CHECK_HOURS, ACTIVE_CHECK_HOURS
from thumbnailer import backfill_thumbnails
import photo_converter as _photo_converter  # noqa: F401 -- starts conversion thread on import
from platforms.tiktok.tracker import process_all_sounds, process_single_sound
from platforms.tiktok.tracker import process_user_session, run_single_user_with_session

LOOP_STATE_PATH = os.path.join(TIKTOK_DATA_DIR, "loop_state.json")


def _load_loop_state() -> dict:
    try:
        with open(LOOP_STATE_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _save_loop_state() -> None:
    with _user_state_lock:
        u_start = user_loop_state["last_run_start"]
        u_cur   = user_loop_state["current_run_start"]
        u_end   = user_loop_state["last_run_end"]
        u_dur   = user_loop_state["last_run_duration_secs"]
        u_new   = user_loop_state["last_new_videos"]
    with _sound_state_lock:
        s_start = sound_loop_state["last_run_start"]
        s_cur   = sound_loop_state["current_run_start"]
        s_end   = sound_loop_state["last_run_end"]
        s_dur   = sound_loop_state["last_run_duration_secs"]
        s_new   = sound_loop_state["last_new_videos"]
    # COALESCE: don't overwrite a previously persisted non-null value with null.
    # This prevents the sound loop from clobbering user state before any user session runs.
    _prev = _load_loop_state()
    data = {
        "user_last_run_start":     u_start if u_start is not None else _prev.get("user_last_run_start"),
        "user_current_run_start":  u_cur,   # always write; None clears the in-progress marker
        "user_last_run_end":       u_end    if u_end    is not None else _prev.get("user_last_run_end"),
        "user_last_duration_secs": u_dur    if u_dur    is not None else _prev.get("user_last_duration_secs"),
        "user_last_new_videos":    u_new    if u_new    is not None else _prev.get("user_last_new_videos"),
        "sound_last_run_start":    s_start  if s_start  is not None else _prev.get("sound_last_run_start"),
        "sound_current_run_start": s_cur,
        "sound_last_run_end":      s_end    if s_end    is not None else _prev.get("sound_last_run_end"),
        "sound_last_duration_secs": s_dur   if s_dur    is not None else _prev.get("sound_last_duration_secs"),
        "sound_last_new_videos":   s_new    if s_new    is not None else _prev.get("sound_last_new_videos"),
    }
    os.makedirs(TIKTOK_DATA_DIR, exist_ok=True)
    _tmp = LOOP_STATE_PATH + ".tmp"
    with open(_tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(_tmp, LOOP_STATE_PATH)


# ── User loop state ───────────────────────────────────────────────────────────

_persisted = _load_loop_state()

# Recover start time and duration for display. Three cases:
# 1. Normal: user_last_run_start is set from a completed run -- use it directly.
# 2. Killed mid-run (SIGKILL, no atexit): user_current_run_start is set but the service never
#    wrote an end time; promote it so "Last:" shows the start of the interrupted run, and clear
#    the stale duration from the prior completed run so we don't show a contradictory "Took".
# 3. Upgrade from old JSON (no start key): fall back to user_last_run_end as an approximation.
_u_last_start = _persisted.get("user_last_run_start")
_u_cur_start  = _persisted.get("user_current_run_start")
_u_dur        = _persisted.get("user_last_duration_secs")
if _u_cur_start:
    _u_last_start = _u_cur_start
    _u_dur = None  # stale duration from prior completed run would contradict the new start time
elif not _u_last_start:
    _u_last_start = _persisted.get("user_last_run_end")

_s_last_start = _persisted.get("sound_last_run_start")
_s_cur_start  = _persisted.get("sound_current_run_start")
_s_dur        = _persisted.get("sound_last_duration_secs")
if _s_cur_start:
    _s_last_start = _s_cur_start
    _s_dur = None
elif not _s_last_start:
    _s_last_start = _persisted.get("sound_last_run_end")

user_loop_state = {
    "running":                  False,
    "manual_run":               False,
    "sleep_until":              None,  # Unix timestamp (float) when the current sleep ends
    "sleep_next":               None,  # Label for what runs after the sleep
    "last_run_start":           _u_last_start,
    "current_run_start":        None,
    "last_run_end":             _persisted.get("user_last_run_end"),
    "last_run_duration_secs":   _u_dur,
    "last_new_videos":          _persisted.get("user_last_new_videos"),
    "last_session_completed":   None,
    "last_session_total":       None,
    "next_run":                 None,
    "current_user":             None,
    "sessions_today":           [],
    "logs":                     deque(maxlen=1000),
}
_user_state_lock = threading.Lock()
_log_seq = 0  # monotonic counter: total log lines ever written; never resets

trigger_user_event = threading.Event()
_user_stop_event   = threading.Event()

# Set to True when loop interval settings change; cleared by the scheduler thread.
_user_reschedule_flag  = False
_user_rflag_lock       = threading.Lock()

# Scope of the pending manual trigger: "starred" | "half" | "all" | None (scheduled).
# Set by web.py before firing trigger_user_event; read+cleared by main.py after waking.
_user_trigger_scope      = None
_user_trigger_scope_lock = threading.Lock()

# ── Sound loop state ──────────────────────────────────────────────────────────

sound_loop_state = {
    "running":                False,
    "last_run_start":         _s_last_start,
    "current_run_start":      None,
    "last_run_end":           _persisted.get("sound_last_run_end"),
    "last_run_duration_secs": _s_dur,
    "last_new_videos":        _persisted.get("sound_last_new_videos"),
    "next_run":               None,
}
_sound_state_lock = threading.Lock()

trigger_sound_event = threading.Event()
_sound_stop_event   = threading.Event()

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

# ── Pending midpoint re-scans ─────────────────────────────────────────────────
# Keyed by tiktok_id. Each entry holds the Timer object and the Unix timestamp
# when it will fire, so the UI can show a countdown on the user card.

_pending_rescans: dict[str, dict] = {}
_pending_rescans_lock = threading.Lock()


# ── Public accessors ──────────────────────────────────────────────────────────

def is_user_loop_running() -> bool:
    with _user_state_lock:
        return user_loop_state["running"]

# Backward-compat alias (used in older web.py import)
is_running = is_user_loop_running


def is_sound_loop_running() -> bool:
    with _sound_state_lock:
        return sound_loop_state["running"]


def recover_loop_state_from_db() -> None:
    """If user last_run_end is still null after loading the state file, infer it from the DB.

    Called once at startup after db.init_db(). Uses MAX(last_checked) from users as a proxy
    for the last completed user session. Saves the recovered value so subsequent restarts pick it up.
    """
    with _user_state_lock:
        if user_loop_state["last_run_end"] is not None:
            return
    ts = db.get_last_user_check_time()
    if not ts:
        return
    iso = datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
    with _user_state_lock:
        user_loop_state["last_run_end"]   = iso
        user_loop_state["last_run_start"] = iso
    _save_loop_state()


def set_user_loop_next_run(iso: str | None) -> None:
    with _user_state_lock:
        user_loop_state["next_run"] = iso

# Backward-compat alias
set_next_run = set_user_loop_next_run


def set_sound_loop_next_run(iso: str | None) -> None:
    with _sound_state_lock:
        sound_loop_state["next_run"] = iso


def set_user_loop_sessions_today(session_times: list) -> None:
    """Update the list of planned session timestamps for today."""
    with _user_state_lock:
        user_loop_state["sessions_today"] = [
            datetime.fromtimestamp(t, tz=timezone.utc).isoformat()
            for t in session_times
        ]


def get_state_snapshot() -> dict:
    """Return a serialisable snapshot of both loop states plus run-queue state."""
    with _user_state_lock:
        state = {
            "user_loop_running":               user_loop_state["running"],
            "user_loop_manual_run":            user_loop_state["manual_run"],
            "user_loop_sleep_until":           user_loop_state["sleep_until"],
            "user_loop_sleep_next":            user_loop_state["sleep_next"],
            "user_loop_last_start":            user_loop_state["last_run_start"],
            "user_loop_last_end":              user_loop_state["last_run_end"],
            "user_loop_last_duration_secs":    user_loop_state["last_run_duration_secs"],
            "user_loop_last_new_videos":       user_loop_state["last_new_videos"],
            "user_loop_last_session_completed": user_loop_state["last_session_completed"],
            "user_loop_last_session_total":    user_loop_state["last_session_total"],
            "user_loop_next":                  user_loop_state["next_run"],
            "user_loop_current_user":          user_loop_state["current_user"],
            "user_loop_sessions_today":        list(user_loop_state["sessions_today"]),
            "logs":                            list(user_loop_state["logs"]),
            "log_seq":                         _log_seq,
        }
    with _sound_state_lock:
        state["sound_loop_running"]            = sound_loop_state["running"]
        state["sound_loop_last_start"]         = sound_loop_state["last_run_start"]
        state["sound_loop_last_end"]           = sound_loop_state["last_run_end"]
        state["sound_loop_last_duration_secs"] = sound_loop_state["last_run_duration_secs"]
        state["sound_loop_last_new_videos"]    = sound_loop_state["last_new_videos"]
        state["sound_loop_next"]               = sound_loop_state["next_run"]
    from platforms.tiktok.config import SOUND_LOOP_INTERVAL_MINUTES
    state["sound_loop_interval_minutes"] = int(db.get_setting("sound_loop_interval_minutes", SOUND_LOOP_INTERVAL_MINUTES))
    with _run_state_lock:
        state["run_current"] = _run_state["current"]
        state["run_queue"]   = list(_run_state["queue"])
    with _sound_run_state_lock:
        state["sound_run_current"] = _sound_run_state["current"]
        state["sound_run_queue"]   = list(_sound_run_state["queue"])
    with _pending_rescans_lock:
        state["pending_rescans"] = {tid: info["fires_at"] for tid, info in _pending_rescans.items()}
    return state


def request_stop_user_loop() -> None:
    """Signal the user loop to stop after the current creator finishes."""
    _user_stop_event.set()


def request_stop_sound_loop() -> None:
    """Signal the sound loop to stop after the current sound finishes."""
    _sound_stop_event.set()


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


def set_user_trigger_scope(scope: str | None) -> None:
    """Set the scope for the next manual trigger. Call before firing trigger_user_event."""
    global _user_trigger_scope
    with _user_trigger_scope_lock:
        _user_trigger_scope = scope


def get_and_clear_trigger_scope() -> str | None:
    """Read and clear the pending trigger scope. Returns None for scheduled wakes."""
    global _user_trigger_scope
    with _user_trigger_scope_lock:
        val = _user_trigger_scope
        _user_trigger_scope = None
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


def enqueue_user_run(tiktok_id: str, profile_only: bool = False, mode: str = "full") -> bool:
    """Queue a single-user manual run. Returns False if already queued/running.
    Cancels any pending midpoint re-scan for this user."""
    with _pending_rescans_lock:
        pending = _pending_rescans.pop(tiktok_id, None)
    if pending:
        pending["timer"].cancel()
    with _run_state_lock:
        if tiktok_id in _run_state["queue"] or _run_state["current"] == tiktok_id:
            return False
        _run_state["queue"].append(tiktok_id)
    _run_queue.put((tiktok_id, profile_only, mode))
    return True


def enqueue_user_profile_run(tiktok_id: str) -> bool:
    """Queue a profile-only run (no video fetch). Returns False if already queued/running."""
    return enqueue_user_run(tiktok_id, profile_only=True)


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
    global _log_seq
    ts   = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    with _user_state_lock:
        user_loop_state["logs"].append(line)
        _log_seq += 1


def _logd(msg: str):
    """Log to the terminal only -- implementation detail not shown in the UI."""
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}")


def _set_current_user(username: str | None) -> None:
    with _user_state_lock:
        user_loop_state["current_user"] = username


def _set_sleep(until: float | None, next_label: str | None) -> None:
    """Set or clear the active sleep indicator shown in the log console."""
    with _user_state_lock:
        user_loop_state["sleep_until"] = until
        user_loop_state["sleep_next"]  = next_label


# ── Manual run workers ────────────────────────────────────────────────────────

def _run_worker():
    while True:
        tiktok_id, profile_only, mode = _run_queue.get()
        with _run_state_lock:
            if tiktok_id in _run_state["queue"]:
                _run_state["queue"].remove(tiktok_id)
            _run_state["current"] = tiktok_id
        try:
            user = db.get_user(tiktok_id)
            if user:
                label = f"@{user['username']}"
                kind  = "profile" if profile_only else mode
                _log(f"=== Manual {kind} run started: {label} ===")
                asyncio.run(run_single_user_with_session(user, _log, _logd, profile_only=profile_only, mode=mode))
                _log(f"=== Manual {kind} run complete: {label} ===")
                # Schedule next check based on the user's computed interval
                _active = int(db.get_setting("active_check_hours", ACTIVE_CHECK_HOURS)) * 3600
                _high   = int(db.get_setting("high_priority_check_hours", HIGH_PRIORITY_CHECK_HOURS)) * 3600
                _interval = user.get("check_interval_secs") or (_high if user.get("starred") else _active)
                db.set_user_next_check(tiktok_id, int(time.time()) + _interval)
                if not profile_only and mode == "full":
                    db.set_user_last_full_refresh_at(tiktok_id, int(time.time()))
                    db.clear_full_refresh_pending(tiktok_id)
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


def _shutdown_save() -> None:
    """On clean shutdown (SIGTERM, Ctrl+C), persist the in-progress run duration.
    Runs via atexit so the next startup shows an accurate "Took" even after docker compose down.
    Does not run on SIGKILL; startup recovery handles that by clearing the stale duration."""
    now_iso = datetime.now(timezone.utc).isoformat()
    now_ts  = time.time()
    changed = False
    with _user_state_lock:
        cur = user_loop_state.get("current_run_start")
        if cur:
            try:
                start_ts = datetime.fromisoformat(cur).timestamp()
                dur: int | None = round(now_ts - start_ts)
            except (ValueError, TypeError):
                dur = None
            user_loop_state["last_run_start"]         = cur
            user_loop_state["current_run_start"]      = None
            user_loop_state["last_run_end"]           = now_iso
            user_loop_state["last_run_duration_secs"] = dur
            user_loop_state["running"]                = False
            changed = True
    with _sound_state_lock:
        cur = sound_loop_state.get("current_run_start")
        if cur:
            try:
                start_ts = datetime.fromisoformat(cur).timestamp()
                dur = round(now_ts - start_ts)
            except (ValueError, TypeError):
                dur = None
            sound_loop_state["last_run_start"]         = cur
            sound_loop_state["current_run_start"]      = None
            sound_loop_state["last_run_end"]           = now_iso
            sound_loop_state["last_run_duration_secs"] = dur
            sound_loop_state["running"]                = False
            changed = True
    if changed:
        _save_loop_state()


atexit.register(_shutdown_save)


# ── Public entry points ───────────────────────────────────────────────────────

def _schedule_midpoint_run(tiktok_id: str) -> None:
    """Schedule an isolated full re-scan at the midpoint before the next loop run.

    Called when a large deletion spike is detected in a full run. Uses a fresh
    dedicated session (same as pressing Run Full) rather than the shared loop session,
    which avoids the session degradation that can cause item_list to return partial results
    for large accounts."""
    with _user_state_lock:
        next_run_iso = user_loop_state.get("next_run")
    delay = 1800.0  # default: 30 min if next run is unknown
    if next_run_iso:
        try:
            next_ts = datetime.fromisoformat(next_run_iso).timestamp()
            delay   = max((next_ts - time.time()) / 2, 60.0)
        except (ValueError, TypeError):
            pass

    def _fire():
        with _pending_rescans_lock:
            _pending_rescans.pop(tiktok_id, None)
        enqueue_user_run(tiktok_id, mode="full")

    fires_at = time.time() + delay
    timer    = threading.Timer(delay, _fire)
    with _pending_rescans_lock:
        existing = _pending_rescans.get(tiktok_id)
        if existing:
            existing["timer"].cancel()
        _pending_rescans[tiktok_id] = {"timer": timer, "fires_at": fires_at}
    timer.start()

    mins  = round(delay / 60)
    user  = db.get_user(tiktok_id)
    label = f"@{user['username']}" if user else tiktok_id
    _log(f"  Large deletion spike: isolated full re-scan for {label} in {mins}m")


def run_user_session(users_due: list[dict], manual: bool = False, session_kind: str | None = None) -> None:
    """Process a pre-assembled set of users due for checking. Called by the session scheduler."""
    from config import get_path_issues
    issues = get_path_issues()
    if issues:
        _log(f"User loop blocked: {issues[0]['message']}")
        return
    _run_start = datetime.now(timezone.utc).isoformat()
    with _user_state_lock:
        user_loop_state["running"]           = True
        user_loop_state["manual_run"]        = manual
        user_loop_state["current_run_start"] = _run_start
    _save_loop_state()  # persist current_run_start immediately so a kill mid-run is recoverable
    _loop_start    = time.monotonic()
    _videos_before = db.count_downloaded_videos()
    _total         = len(users_due)

    _user_stop_event.clear()
    if session_kind and session_kind != "scheduled":
        _log(f"=== User session started ({session_kind}): {_total} user(s) ===")
    else:
        _log(f"=== User session started: {_total} user(s) due ===")
    _completed = 0

    try:
        _completed = asyncio.run(
            process_user_session(users_due, _log, _logd, _set_current_user, _user_stop_event,
                                 set_sleep=_set_sleep, on_large_deletion=_schedule_midpoint_run)
        ) or 0
    except Exception as e:
        _log(f"Unhandled user session error: {e}")

    last_run_end  = datetime.now(timezone.utc).isoformat()
    duration_secs = round(time.monotonic() - _loop_start)
    new_videos    = db.count_downloaded_videos() - _videos_before
    _log(f"=== User session complete: {_completed}/{_total} users, {new_videos} new video(s) ===")
    with _user_state_lock:
        user_loop_state["running"]                  = False
        user_loop_state["manual_run"]               = False
        user_loop_state["sleep_until"]              = None
        user_loop_state["sleep_next"]               = None
        user_loop_state["last_run_start"]           = user_loop_state["current_run_start"]
        user_loop_state["current_run_start"]        = None
        user_loop_state["last_run_end"]             = last_run_end
        user_loop_state["last_run_duration_secs"]   = duration_secs
        user_loop_state["last_new_videos"]          = new_videos
        user_loop_state["last_session_completed"]   = _completed
        user_loop_state["last_session_total"]       = _total
    _save_loop_state()


def run_sound_loop():
    """Process all tracked sounds. Called by the sound loop scheduler thread."""
    from config import get_path_issues
    issues = get_path_issues()
    if issues:
        _log(f"Sound loop blocked: {issues[0]['message']}")
        return
    _run_start = datetime.now(timezone.utc).isoformat()
    with _sound_state_lock:
        sound_loop_state["running"]           = True
        sound_loop_state["current_run_start"] = _run_start
    _save_loop_state()
    _loop_start = time.monotonic()
    _videos_before = db.count_downloaded_videos()

    _sound_stop_event.clear()
    _log("=== Sound loop started ===")
    _sound_stats: dict | None = None
    try:
        _sound_stats = asyncio.run(process_all_sounds(_log, _sound_stop_event))
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
        sound_loop_state["running"]               = False
        sound_loop_state["last_run_start"]        = sound_loop_state["current_run_start"]
        sound_loop_state["current_run_start"]     = None
        sound_loop_state["last_run_end"]          = last_run_end
        sound_loop_state["last_run_duration_secs"] = duration_secs
        sound_loop_state["last_new_videos"]       = new_videos
    _save_loop_state()
