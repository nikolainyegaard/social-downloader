"""YouTube download loop and shared state."""

import json
import os
import queue as _queue_module
import threading
import time
from collections import deque
from datetime import datetime, timezone

from platforms.youtube import database as db
from platforms.youtube.database import YOUTUBE_DATA_DIR

LOOP_STATE_PATH = os.path.join(YOUTUBE_DATA_DIR, "loop_state.json")


def _load_state() -> dict:
    try:
        with open(LOOP_STATE_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return {}


def _save_state() -> None:
    with _state_lock:
        data = {
            "last_run_end":           loop_state["last_run_end"],
            "last_run_duration_secs": loop_state["last_run_duration_secs"],
            "last_new_videos":        loop_state["last_new_videos"],
        }
    os.makedirs(YOUTUBE_DATA_DIR, exist_ok=True)
    _tmp = LOOP_STATE_PATH + ".tmp"
    with open(_tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(_tmp, LOOP_STATE_PATH)


_persisted = _load_state()

loop_state = {
    "running":                False,
    "manual_run":             False,
    "last_run_end":           _persisted.get("last_run_end"),
    "last_run_duration_secs": _persisted.get("last_run_duration_secs"),
    "last_new_videos":        _persisted.get("last_new_videos"),
    "next_run":               None,
    "current_channel":        None,
    "sessions_today":         [],
    "logs":                   deque(maxlen=1000),
}
_state_lock = threading.Lock()

trigger_event    = threading.Event()
_stop_event      = threading.Event()
_reschedule_flag = False
_rflag_lock      = threading.Lock()

# Scope of the pending manual trigger: "next" | "starred" | "half" | "all" | None (scheduled).
# Set by web.py before firing trigger_event; read+cleared by the scheduler after waking.
_trigger_scope      = None
_trigger_scope_lock = threading.Lock()

_run_queue:      _queue_module.Queue = _queue_module.Queue()
_run_state_lock  = threading.Lock()
_run_state: dict = {"current": None, "queue": []}


def is_running() -> bool:
    with _state_lock:
        return loop_state["running"]


def set_next_run(iso: str | None) -> None:
    with _state_lock:
        loop_state["next_run"] = iso


def set_sessions_today(session_times: list) -> None:
    """Update the list of planned session timestamps for the current 24h window."""
    with _state_lock:
        loop_state["sessions_today"] = [
            datetime.fromtimestamp(t, tz=timezone.utc).isoformat()
            for t in session_times
        ]


def set_trigger_scope(scope: str | None) -> None:
    """Set the scope for the next manual trigger. Call before firing trigger_event."""
    global _trigger_scope
    with _trigger_scope_lock:
        _trigger_scope = scope


def get_and_clear_trigger_scope() -> str | None:
    """Read and clear the pending trigger scope. Returns None for scheduled wakes."""
    global _trigger_scope
    with _trigger_scope_lock:
        val = _trigger_scope
        _trigger_scope = None
    return val


def get_state_snapshot() -> dict:
    with _state_lock:
        state = {
            "loop_running":            loop_state["running"],
            "loop_manual_run":         loop_state["manual_run"],
            "loop_last_end":           loop_state["last_run_end"],
            "loop_last_duration_secs": loop_state["last_run_duration_secs"],
            "loop_last_new_videos":    loop_state["last_new_videos"],
            "loop_next":               loop_state["next_run"],
            "loop_current_channel":    loop_state["current_channel"],
            "loop_sessions_today":     list(loop_state["sessions_today"]),
            "logs":                    list(loop_state["logs"]),
        }
    with _run_state_lock:
        state["run_current"] = _run_state["current"]
        state["run_queue"]   = list(_run_state["queue"])
    return state


def request_stop() -> None:
    """Signal the loop to stop after the current channel finishes."""
    _stop_event.set()


def reschedule_loop() -> None:
    """Wake the scheduler to re-read its interval from DB without running the loop."""
    global _reschedule_flag
    with _rflag_lock:
        _reschedule_flag = True
    trigger_event.set()


def check_and_clear_reschedule() -> bool:
    global _reschedule_flag
    with _rflag_lock:
        val = _reschedule_flag
        _reschedule_flag = False
    return val


def enqueue_channel_run(channel_id: str, profile_only: bool = False, mode: str = "full") -> bool:
    """Queue a single-channel manual run. Returns False if already queued/running."""
    with _run_state_lock:
        if channel_id in _run_state["queue"] or _run_state["current"] == channel_id:
            return False
        _run_state["queue"].append(channel_id)
    _run_queue.put((channel_id, profile_only, mode))
    return True


def enqueue_channel_profile_run(channel_id: str) -> bool:
    """Queue a profile-only run (no video fetch). Returns False if already queued/running."""
    return enqueue_channel_run(channel_id, profile_only=True)


def _log(msg: str) -> None:
    ts   = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    with _state_lock:
        loop_state["logs"].append(line)


def _set_current_channel(handle: str | None) -> None:
    with _state_lock:
        loop_state["current_channel"] = handle


def _run_worker() -> None:
    while True:
        channel_id, profile_only, mode = _run_queue.get()
        with _run_state_lock:
            if channel_id in _run_state["queue"]:
                _run_state["queue"].remove(channel_id)
            _run_state["current"] = channel_id
        try:
            channel = db.get_channel(channel_id)
            if channel:
                label = f"@{channel['handle']}"
                kind  = "profile" if profile_only else mode
                _log(f"=== Manual {kind} run started: {label} ===")
                from platforms.youtube.tracker import process_single_channel
                process_single_channel(channel, _log, _set_current_channel, profile_only=profile_only, mode=mode)
                _log(f"=== Manual {kind} run complete: {label} ===")
                # Schedule the next check based on the channel's computed interval
                from scheduling import get_check_intervals, set_channel_last_full, set_channel_next_check
                _high, _active, _ = get_check_intervals(db, "youtube")
                _interval = channel.get("check_interval_secs") or (_high if channel.get("starred") else _active)
                set_channel_next_check(db, channel_id, int(time.time()) + _interval)
                if not profile_only and mode == "full":
                    set_channel_last_full(db, channel_id, int(time.time()))
            else:
                _log(f"Manual run: channel {channel_id} not found in DB")
        except Exception as e:
            _log(f"Manual run error for {channel_id}: {e}")
        finally:
            with _run_state_lock:
                _run_state["current"] = None
            _set_current_channel(None)
            _run_queue.task_done()


threading.Thread(target=_run_worker, daemon=True, name="yt-run-worker").start()


def run_loop(channels_due: list[dict] | None = None, manual: bool = False) -> None:
    """Process channels due for checking. Called by the session scheduler thread.

    Pass the pre-assembled due list from the scheduler; None falls back to all
    enabled channels (used by nothing in normal operation, kept as a safety net).
    """
    from config import get_path_issues
    issues = get_path_issues()
    if issues:
        _log(f"Loop blocked: {issues[0]['message']}")
        return
    from platforms.youtube.tracker import process_all_channels
    with _state_lock:
        loop_state["running"]    = True
        loop_state["manual_run"] = manual
    _loop_start    = time.monotonic()
    _videos_before = db.count_downloaded_videos()

    _stop_event.clear()
    channels   = channels_due if channels_due is not None else db.get_all_channels()
    _log(f"=== YouTube session started: {len(channels)} channel(s) due ===")
    _completed = 0

    if not channels:
        _log("No channels due -- nothing to do.")
    else:
        try:
            _completed = process_all_channels(channels, _log, _set_current_channel, _stop_event) or 0
        except Exception as e:
            _log(f"Unhandled YouTube loop error: {e}")

    last_run_end  = datetime.now(timezone.utc).isoformat()
    duration_secs = round(time.monotonic() - _loop_start)
    new_videos    = db.count_downloaded_videos() - _videos_before
    _log(f"=== YouTube session complete: {_completed}/{len(channels)} channel(s), {new_videos} new video(s) ===")
    with _state_lock:
        loop_state["running"]                = False
        loop_state["manual_run"]             = False
        loop_state["last_run_end"]           = last_run_end
        loop_state["last_run_duration_secs"] = duration_secs
        loop_state["last_new_videos"]        = new_videos
    _save_state()
