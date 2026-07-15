import os
import sys
import logging
import threading
import time
from datetime import datetime, timedelta

import glob as _glob
import shutil as _shutil
from config import DATA_DIR, MEDIA_DIR, WEB_PORT
from platforms.tiktok.config import TIKTOK_DATA_DIR, STATS_REFRESH_DAYS
from platforms.tiktok.migrate import migrate_legacy_tiktok_schema
from platforms.tiktok.sounds import get_sound_loop
from platforms.tiktok.store import TikTokStore
from platforms.registry import ENGINES
import scheduling
from web import create_app
from backup import start_backup_thread

LOGS_DIR = os.path.join(DATA_DIR, "logs")
_RUNS_DIR = os.path.join(LOGS_DIR, "runs")
os.makedirs(LOGS_DIR, exist_ok=True)
os.makedirs(_RUNS_DIR, exist_ok=True)

# ── Per-run log: run_current.log ──────────────────────────────────────────────
#
# On every startup the previous run_current.log is renamed to a timestamped
# file (runs/run_YYYYMMDD_HHMMSS.log) so each run is self-contained and easy
# to retrieve.  Old run files beyond _RUN_LOG_KEEP are deleted automatically.
# The current run is always at the predictable path run_current.log.

_RUN_LOG_KEEP = 50
_run_current  = os.path.join(LOGS_DIR, "run_current.log")


def _prune_old_runs() -> None:
    old = sorted(f for f in os.listdir(_RUNS_DIR) if f.startswith("run_"))
    for name in old[:-_RUN_LOG_KEEP]:
        try:
            os.remove(os.path.join(_RUNS_DIR, name))
        except OSError:
            pass


# Startup rotation: rename any leftover run_current.log from the previous run.
if os.path.exists(_run_current):
    _run_ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    try:
        os.rename(_run_current, os.path.join(_RUNS_DIR, f"run_{_run_ts}.log"))
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
            os.rename(self._path, os.path.join(_RUNS_DIR, f"run_{old_date}.log"))
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
    '"GET /api/tiktok/status HTTP',
    '"GET /api/tiktok/queue HTTP',
    '"GET /api/tiktok/channels HTTP',
    '"GET /api/tiktok/sounds HTTP',
    '"GET /api/youtube/status HTTP',
    '"GET /api/youtube/queue HTTP',
    '"GET /api/youtube/channels HTTP',
    '"GET /api/instagram/status HTTP',
    '"GET /api/instagram/queue HTTP',
    '"GET /api/instagram/channels HTTP',
    '"GET /api/twitter/status HTTP',
    '"GET /api/twitter/queue HTTP',
    '"GET /api/twitter/channels HTTP',
    # feed polls carry query strings, so no trailing HTTP anchor
    '"GET /api/tiktok/recent/feed',
    '"GET /api/youtube/recent/feed',
    '"GET /api/instagram/recent/feed',
    '"GET /api/twitter/recent/feed',
)

class _SuppressPolling(logging.Filter):
    def filter(self, record):
        msg = record.getMessage()
        return not any(pat in msg for pat in _POLLING_ENDPOINTS)

logging.getLogger("werkzeug").addFilter(_SuppressPolling())

# Suppress TikTokApi's own library-level ERROR messages. These duplicate the
# app's own exception handling and appear as raw "ERROR - Got an unexpected
# status code: ..." lines in the log. All meaningful failures are already
# caught and logged by the application code in loop.py / sound_tracker.py.
logging.getLogger("TikTokApi").setLevel(logging.CRITICAL)

# Suppress 'Event loop is closed' noise from asyncio's BaseSubprocessTransport.__del__.
# Python fires sys.unraisablehook for exceptions raised in __del__ (GC context). After
# asyncio.run() closes the event loop, Playwright's subprocess transport objects are GC'd
# and try to close their pipes, which requires calling into the (now-closed) loop. The
# exception is harmless but produces multi-line tracebacks in the log on every loop run.
_orig_unraisablehook = sys.unraisablehook


def _suppress_loop_closed(unraisable):
    if (isinstance(unraisable.exc_value, RuntimeError)
            and "Event loop is closed" in str(unraisable.exc_value)):
        return
    _orig_unraisablehook(unraisable)


sys.unraisablehook = _suppress_loop_closed


def _ts() -> str:
    return f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}]"


# ── Channel platform loop schedulers ──────────────────────────────────────────
# Every engine in the registry gets its own scheduler thread running the shared
# session model (N sessions per 24h window, per-channel due times). Engines are
# fully isolated: separate DBs, run queues, and log buffers.

def _channel_loop_thread(engine):
    scheduling.run_session_scheduler(engine.platform, engine.db, engine.loop)


def _tiktok_loop_thread(engine):
    """TikTok runs the shared session scheduler with two platform hooks:
    the full-refresh batch cycle advances once per 24h window, and sessions
    wait for the sound loop to finish (plus a 5 min buffer) before starting."""
    store  = TikTokStore(engine.db)
    sounds = get_sound_loop(engine)

    def _advance_refresh_cycle(now: float) -> None:
        # A new cycle starts when no cycle exists yet, or when the current one
        # has run its full length. Otherwise, activate the next day's batch if
        # the day has changed since the last activation.
        _n_days          = max(1, int(engine.db.get_setting("stats_refresh_days", STATS_REFRESH_DAYS)))
        _cycle_start     = int(engine.db.get_setting("refresh_cycle_start", 0) or 0)
        _activated_batch = int(engine.db.get_setting("refresh_cycle_activated_batch", 0) or 0)
        if _cycle_start == 0 or (now - _cycle_start) >= _n_days * 86400:
            _n_assigned = store.assign_refresh_batches(_n_days)
            print(
                f"{_ts()} Refresh cycle: new {_n_days}-day cycle started,"
                f" {_n_assigned} users distributed across {_n_days} batches."
            )
        else:
            _day_in_cycle = int((now - _cycle_start) / 86400) + 1
            if _day_in_cycle > _activated_batch:
                _n_flagged = store.activate_refresh_batch(_day_in_cycle)
                print(
                    f"{_ts()} Refresh cycle: day {_day_in_cycle}/{_n_days},"
                    f" {_n_flagged} users flagged for full refresh."
                )

    def _wait_for_sound_loop(_triggered: bool) -> None:
        was_waiting = False
        while sounds.is_running():
            was_waiting = True
            time.sleep(30)
        if was_waiting:
            print(f"{_ts()} TikTok loop: sound loop finished, waiting 5 min buffer.")
            engine.loop.trigger_event.wait(timeout=5 * 60)
            engine.loop.trigger_event.clear()

    scheduling.run_session_scheduler("tiktok", engine.db, engine.loop,
                                     on_window_start=_advance_refresh_cycle,
                                     pre_session=_wait_for_sound_loop)


# ── File integrity check (twice daily: 00:00 and 12:00) ──────────────────────

def _next_check_time() -> float:
    """Return the Unix timestamp of the next 00:00 or 12:00 (local time)."""
    now  = datetime.now()
    noon = now.replace(hour=12, minute=0, second=0, microsecond=0)
    midn = now.replace(hour=0,  minute=0, second=0, microsecond=0) + timedelta(days=1)
    candidates = [t for t in (noon, midn) if t > now]
    return min(candidates).timestamp()


def _file_check_thread():
    _engine = ENGINES["tiktok"]
    _sounds = get_sound_loop(_engine)
    while True:
        wait = _next_check_time() - time.time()
        time.sleep(max(wait, 0))

        # Back off 10 min at a time while either TikTok loop is active
        while _engine.loop.is_running() or _sounds.is_running():
            time.sleep(10 * 60)

        print(f"{_ts()} File integrity check: scanning for missing video files...")
        try:
            removed = _engine.db.delete_missing_video_files()
            if removed:
                print(f"{_ts()} File integrity check: removed {removed} DB record(s) with no file on disk.")
            else:
                print(f"{_ts()} File integrity check: all files accounted for.")
        except Exception as e:
            print(f"{_ts()} File integrity check error: {e}")


# ── Entry point ───────────────────────────────────────────────────────────────

def _migrate_data_to_platform_dirs() -> None:
    """Move flat data/ and videos/ paths into platform subdirectories. Idempotent."""
    import re as _re
    os.makedirs(TIKTOK_DATA_DIR, exist_ok=True)

    _moves = [
        (os.path.join(DATA_DIR, "tiktok.db"),        os.path.join(TIKTOK_DATA_DIR, "tiktok.db")),
        (os.path.join(DATA_DIR, "cookies.txt"),       os.path.join(TIKTOK_DATA_DIR, "cookies.txt")),
        (os.path.join(DATA_DIR, "cookies.timestamp"), os.path.join(TIKTOK_DATA_DIR, "cookies.timestamp")),
    ]
    for old, new in _moves:
        if os.path.exists(old) and not os.path.exists(new):
            _shutil.move(old, new)
            print(f"{_ts()} Migration: moved {os.path.relpath(old, DATA_DIR)} -> data/tiktok/")

    old_avatars = os.path.join(DATA_DIR, "avatars")
    new_avatars = os.path.join(TIKTOK_DATA_DIR, "avatars")
    if os.path.isdir(old_avatars) and not os.path.exists(new_avatars):
        _shutil.move(old_avatars, new_avatars)
        print(f"{_ts()} Migration: moved data/avatars/ -> data/tiktok/avatars/")

    tiktok_videos = os.path.join(MEDIA_DIR, "tiktok")
    os.makedirs(tiktok_videos, exist_ok=True)
    for user_dir in _glob.glob(os.path.join(MEDIA_DIR, "@*")):
        if not os.path.isdir(user_dir):
            continue
        dest = os.path.join(tiktok_videos, os.path.basename(user_dir))
        if not os.path.exists(dest):
            _shutil.move(user_dir, dest)
            print(f"{_ts()} Migration: moved videos/{os.path.basename(user_dir)} -> videos/tiktok/")

    # ── Cleanup: tiktok-downloader leftover artifacts ─────────────────────────

    # loop_state.json at the DATA_DIR root is a tiktok-downloader artifact;
    # the one at data/tiktok/ is now used by the session scheduler and must not be removed.
    _legacy_loop_state = os.path.join(DATA_DIR, "loop_state.json")
    if os.path.isfile(_legacy_loop_state):
        os.remove(_legacy_loop_state)
        print(f"{_ts()} Cleanup: removed loop_state.json (legacy root location)")

    # Flat date-rotation logs at data/logs/ root (run_YYYYMMDD.log).
    # social-downloader never writes these at the root level; they are all
    # tiktok-downloader artifacts.
    _log_date_re = _re.compile(r"^run_\d{8}\.log$")
    if os.path.isdir(LOGS_DIR):
        for name in os.listdir(LOGS_DIR):
            if _log_date_re.match(name):
                path = os.path.join(LOGS_DIR, name)
                if os.path.isfile(path):
                    os.remove(path)
                    print(f"{_ts()} Cleanup: removed data/logs/{name}")

    # reports/ directory (tiktok-downloader artifact; only removed if empty)
    reports_dir = os.path.join(DATA_DIR, "reports")
    if os.path.isdir(reports_dir):
        try:
            os.rmdir(reports_dir)
            print(f"{_ts()} Cleanup: removed data/reports/")
        except OSError:
            pass


def _check_config() -> None:
    """Warn about outdated docker-compose.yml env var patterns."""
    # LOOP_INTERVAL_MINUTES predates both the user/sound split and platform namespacing.
    # Still accepted via backward-compat in platforms/tiktok/config.py, but the current
    # names should be used going forward.
    has_legacy  = bool(os.environ.get("LOOP_INTERVAL_MINUTES"))
    has_user    = bool(os.environ.get("USER_LOOP_INTERVAL_MINUTES")
                       or os.environ.get("TIKTOK_USER_LOOP_INTERVAL_MINUTES"))
    has_sound   = bool(os.environ.get("SOUND_LOOP_INTERVAL_MINUTES")
                       or os.environ.get("TIKTOK_SOUND_LOOP_INTERVAL_MINUTES"))

    if has_legacy and not (has_user and has_sound):
        print(
            f"{_ts()} [config] WARNING: your docker-compose.yml uses the deprecated\n"
            f"  LOOP_INTERVAL_MINUTES variable. Replace it with the current variables:\n"
            f"\n"
            f"    TIKTOK_USER_LOOP_INTERVAL_MINUTES:  \"180\"  # how often to check tracked users\n"
            f"    TIKTOK_SOUND_LOOP_INTERVAL_MINUTES: \"60\"   # how often to check tracked sounds\n"
            f"\n"
            f"  Until then, TIKTOK_SOUND_LOOP_INTERVAL_MINUTES defaults to 60 min."
        )


if __name__ == "__main__":
    _check_config()
    _migrate_data_to_platform_dirs()
    print(f"{_ts()} Initialising databases...")
    # Fold-in migration must run before init_db creates the engine schema,
    # otherwise the users -> channels rename would collide with a fresh table.
    migrate_legacy_tiktok_schema(ENGINES["tiktok"].db.DB_PATH)
    for _engine in ENGINES.values():
        _engine.db.init_db()
        if _engine.adapter.init_db_extra:
            _engine.adapter.init_db_extra(_engine)
        _engine.loop.recover_state_from_db()

    for _engine in ENGINES.values():
        scheduling.recompute_activity_scores(_engine.db, *scheduling.get_check_intervals(_engine.db, _engine.platform))
    print(f"{_ts()} Startup: activity scores computed for all creators.")

    app = create_app()

    print(f"{_ts()} Starting loop threads...")
    for _engine in ENGINES.values():
        _target = _tiktok_loop_thread if _engine.platform == "tiktok" else _channel_loop_thread
        threading.Thread(target=_target, args=(_engine,), daemon=True,
                         name=f"{_engine.adapter.prefix}-loop-thread").start()
    threading.Thread(target=get_sound_loop(ENGINES["tiktok"]).scheduler_thread,
                     daemon=True, name="sound-loop-thread").start()
    threading.Thread(target=_file_check_thread,  daemon=True, name="file-check-thread").start()
    from thumbnailer import backfill_thumbnails
    threading.Thread(target=backfill_thumbnails, daemon=True, name="thumb-backfill").start()
    start_backup_thread()

    print(f"{_ts()} Web UI available at http://0.0.0.0:{WEB_PORT}")
    try:
        app.run(host="0.0.0.0", port=WEB_PORT, debug=False, use_reloader=False)
    except KeyboardInterrupt:
        print(f"\n{_ts()} Shutting down.")
