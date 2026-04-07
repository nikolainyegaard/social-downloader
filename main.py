import os
import sys
import logging
import threading
import time
from datetime import datetime, timedelta, timezone

import database as db
from config import DATA_DIR, USER_LOOP_INTERVAL_MINUTES, SOUND_LOOP_INTERVAL_MINUTES, WEB_PORT
from loop import (
    run_user_loop, run_sound_loop,
    is_user_loop_running, is_sound_loop_running,
    set_user_loop_next_run, set_sound_loop_next_run,
    trigger_user_event, trigger_sound_event,
    check_and_clear_user_reschedule, check_and_clear_sound_reschedule,
)
from web import create_app

LOGS_DIR = os.path.join(DATA_DIR, "logs")
os.makedirs(LOGS_DIR, exist_ok=True)

# ── Per-run log: run_current.log ──────────────────────────────────────────────
#
# On every startup the previous run_current.log is renamed to a timestamped
# file (run_YYYYMMDD_HHMMSS.log) so each run is self-contained and easy to
# retrieve.  Old run files beyond _RUN_LOG_KEEP are deleted automatically.
# The current run is always at the predictable path run_current.log.

_RUN_LOG_KEEP = 10
_run_current  = os.path.join(LOGS_DIR, "run_current.log")


def _prune_old_runs() -> None:
    old = sorted(f for f in os.listdir(LOGS_DIR)
                 if f.startswith("run_") and f != "run_current.log")
    for name in old[:-_RUN_LOG_KEEP]:
        try:
            os.remove(os.path.join(LOGS_DIR, name))
        except OSError:
            pass


# Startup rotation: rename any leftover run_current.log from the previous run.
if os.path.exists(_run_current):
    _run_ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    try:
        os.rename(_run_current, os.path.join(LOGS_DIR, f"run_{_run_ts}.log"))
    except OSError:
        pass
    _prune_old_runs()


# ── Application log: stdout/stderr → run_current.log ─────────────────────────
#
# _RunLog owns run_current.log and handles two kinds of rotation:
#   • Midnight rotation  — at the first write after midnight the file is closed,
#     renamed run_YYYYMMDD.log, and a fresh run_current.log is opened.
#   • Startup rotation   — handled above before _RunLog is created.
#
# _Tee wraps stdout/stderr so every print() goes to the terminal AND _RunLog.
# Both wrappers share the same _RunLog instance, so midnight rotation is
# coordinated automatically.  _tee_lock prevents interleaved writes from
# concurrent loop threads.

_tee_lock = threading.Lock()


class _RunLog:
    def __init__(self, path: str) -> None:
        self._path = path
        self._date = datetime.now().strftime("%Y%m%d")
        self._file = open(path, "w", encoding="utf-8", buffering=1)

    def write(self, msg: str) -> None:
        today = datetime.now().strftime("%Y%m%d")
        if today != self._date:
            self._rotate(self._date)
            self._date = today
        try:
            self._file.write(msg)
        except Exception:
            pass

    def flush(self) -> None:
        try:
            self._file.flush()
        except Exception:
            pass

    def _rotate(self, old_date: str) -> None:
        try:
            self._file.flush()
            self._file.close()
        except Exception:
            pass
        try:
            os.rename(self._path, os.path.join(LOGS_DIR, f"run_{old_date}.log"))
        except OSError:
            pass
        self._file = open(self._path, "w", encoding="utf-8", buffering=1)
        _prune_old_runs()


_run_log = _RunLog(_run_current)


class _Tee:
    def __init__(self, original) -> None:
        self._original = original

    def write(self, msg: str) -> None:
        self._original.write(msg)
        if msg:
            with _tee_lock:
                _run_log.write(msg)

    def flush(self) -> None:
        self._original.flush()
        _run_log.flush()

    def __getattr__(self, name):
        return getattr(self._original, name)


sys.stdout = _Tee(sys.__stdout__)
sys.stderr = _Tee(sys.__stderr__)

# ── HTTP access log filter ─────────────────────────────────────────────────────
#
# The frontend polls /api/status every 5 s, /api/queue every 3 s, and
# /api/users every 15 s.  Those GET requests are completely uninteresting and
# would otherwise make up ~95 % of the log file.  Filter them from werkzeug's
# logger so only meaningful HTTP activity reaches the transcript.

_POLLING_ENDPOINTS = (
    '"GET /api/status HTTP',
    '"GET /api/queue HTTP',
    '"GET /api/users HTTP',
    '"GET /api/sounds HTTP',
)

class _SuppressPolling(logging.Filter):
    def filter(self, record):
        msg = record.getMessage()
        return not any(pat in msg for pat in _POLLING_ENDPOINTS)

logging.getLogger("werkzeug").addFilter(_SuppressPolling())


def _ts() -> str:
    return f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}]"


# ── User loop scheduler ───────────────────────────────────────────────────────

def _user_loop_thread():
    while True:
        interval_minutes = int(db.get_setting("user_loop_interval_minutes", USER_LOOP_INTERVAL_MINUTES))
        next_at_ts = time.time() + interval_minutes * 60
        set_user_loop_next_run(datetime.fromtimestamp(next_at_ts, tz=timezone.utc).isoformat())
        print(
            f"{_ts()} User loop sleeping {interval_minutes} min"
            f" until {datetime.fromtimestamp(next_at_ts).strftime('%H:%M:%S')}."
        )

        remaining = next_at_ts - time.time()
        triggered = trigger_user_event.wait(timeout=max(remaining, 0))
        trigger_user_event.clear()

        if check_and_clear_user_reschedule():
            print(f"{_ts()} User loop: interval changed, rescheduling.")
            continue

        if triggered:
            print(f"{_ts()} User loop: manual trigger received.")

        set_user_loop_next_run(None)

        # Smart avoidance: wait for sound loop to finish, then add 5 min buffer
        was_waiting = False
        while is_sound_loop_running():
            was_waiting = True
            time.sleep(30)
        if was_waiting:
            print(f"{_ts()} User loop: sound loop finished, waiting 5 min buffer.")
            trigger_user_event.wait(timeout=5 * 60)
            trigger_user_event.clear()

        run_user_loop()


# ── Sound loop scheduler ──────────────────────────────────────────────────────

def _sound_loop_thread():
    while True:
        interval_minutes = int(db.get_setting("sound_loop_interval_minutes", SOUND_LOOP_INTERVAL_MINUTES))
        next_at_ts = time.time() + interval_minutes * 60
        set_sound_loop_next_run(datetime.fromtimestamp(next_at_ts, tz=timezone.utc).isoformat())
        print(
            f"{_ts()} Sound loop sleeping {interval_minutes} min"
            f" until {datetime.fromtimestamp(next_at_ts).strftime('%H:%M:%S')}."
        )

        remaining = next_at_ts - time.time()
        triggered = trigger_sound_event.wait(timeout=max(remaining, 0))
        trigger_sound_event.clear()

        if check_and_clear_sound_reschedule():
            print(f"{_ts()} Sound loop: interval changed, rescheduling.")
            continue

        if triggered:
            print(f"{_ts()} Sound loop: manual trigger received.")

        set_sound_loop_next_run(None)

        # Smart avoidance: wait for user loop to finish, then add 5 min buffer
        was_waiting = False
        while is_user_loop_running():
            was_waiting = True
            time.sleep(30)
        if was_waiting:
            print(f"{_ts()} Sound loop: user loop finished, waiting 5 min buffer.")
            trigger_sound_event.wait(timeout=5 * 60)
            trigger_sound_event.clear()

        run_sound_loop()


# ── File integrity check (twice daily: 00:00 and 12:00) ──────────────────────

def _next_check_time() -> float:
    """Return the Unix timestamp of the next 00:00 or 12:00 (local time)."""
    now  = datetime.now()
    noon = now.replace(hour=12, minute=0, second=0, microsecond=0)
    midn = now.replace(hour=0,  minute=0, second=0, microsecond=0) + timedelta(days=1)
    candidates = [t for t in (noon, midn) if t > now]
    return min(candidates).timestamp()


def _file_check_thread():
    while True:
        wait = _next_check_time() - time.time()
        time.sleep(max(wait, 0))

        # Back off 10 min at a time while either loop is active
        while is_user_loop_running() or is_sound_loop_running():
            time.sleep(10 * 60)

        print(f"{_ts()} File integrity check: scanning for missing video files...")
        try:
            removed = db.delete_missing_video_files()
            if removed:
                print(f"{_ts()} File integrity check: removed {removed} DB record(s) with no file on disk.")
            else:
                print(f"{_ts()} File integrity check: all files accounted for.")
        except Exception as e:
            print(f"{_ts()} File integrity check error: {e}")


# ── Entry point ───────────────────────────────────────────────────────────────

def _check_config() -> None:
    """Warn about outdated docker-compose.yml env var patterns."""
    # Legacy LOOP_INTERVAL_MINUTES without the split replacements.
    # The old var still works via backward-compat in config.py, but
    # SOUND_LOOP_INTERVAL_MINUTES will silently use its hardcoded default.
    has_legacy  = bool(os.environ.get("LOOP_INTERVAL_MINUTES"))
    has_user    = bool(os.environ.get("USER_LOOP_INTERVAL_MINUTES"))
    has_sound   = bool(os.environ.get("SOUND_LOOP_INTERVAL_MINUTES"))

    if has_legacy and not (has_user and has_sound):
        print(
            f"{_ts()} [config] WARNING: your docker-compose.yml uses the deprecated\n"
            f"  LOOP_INTERVAL_MINUTES variable. Replace it with the two current variables:\n"
            f"\n"
            f"    USER_LOOP_INTERVAL_MINUTES:  \"180\"  # how often to check tracked users\n"
            f"    SOUND_LOOP_INTERVAL_MINUTES: \"60\"   # how often to check tracked sounds\n"
            f"\n"
            f"  Until then, SOUND_LOOP_INTERVAL_MINUTES defaults to 60 min."
        )


if __name__ == "__main__":
    _check_config()
    print(f"{_ts()} Initialising database...")
    db.init_db()

    n = db.migrate_del_prefix()
    if n:
        print(f"{_ts()} Migration: renamed {n} del_-prefixed video file(s) and updated DB paths.")

    n = db.migrate_username_history_to_profile_history()
    print(f"{_ts()} Migration: {n} username history record(s) in profile_history.")

    app = create_app()

    print(f"{_ts()} Starting loop threads...")
    threading.Thread(target=_user_loop_thread,  daemon=True, name="user-loop-thread").start()
    threading.Thread(target=_sound_loop_thread, daemon=True, name="sound-loop-thread").start()
    threading.Thread(target=_file_check_thread, daemon=True, name="file-check-thread").start()

    print(f"{_ts()} Web UI available at http://0.0.0.0:{WEB_PORT}")
    try:
        app.run(host="0.0.0.0", port=WEB_PORT, debug=False, use_reloader=False)
    except KeyboardInterrupt:
        print(f"\n{_ts()} Shutting down.")
