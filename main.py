import os
import sys
import logging
import threading
import time
from datetime import datetime, timezone
from logging.handlers import TimedRotatingFileHandler

import database as db
from config import DATA_DIR, USER_LOOP_INTERVAL_MINUTES, SOUND_LOOP_INTERVAL_MINUTES, WEB_PORT
from loop import (
    run_user_loop, run_sound_loop,
    is_user_loop_running, is_sound_loop_running,
    set_user_loop_next_run, set_sound_loop_next_run,
    trigger_user_event, trigger_sound_event,
)
from web import create_app

LOGS_DIR = os.path.join(DATA_DIR, "logs")
os.makedirs(LOGS_DIR, exist_ok=True)

# Tee stdout/stderr to a daily-rotating transcript log

class _Tee:
    def __init__(self, original, handler):
        self._original = original
        self._handler  = handler

    def write(self, msg):
        self._original.write(msg)
        if msg:
            self._handler.stream.write(msg)
            self._handler.stream.flush()

    def flush(self):
        self._original.flush()
        self._handler.stream.flush()

    def __getattr__(self, name):
        return getattr(self._original, name)


_transcript_handler = TimedRotatingFileHandler(
    os.path.join(LOGS_DIR, "transcript.log"),
    when="midnight", backupCount=30, encoding="utf-8",
)
_transcript_handler.setFormatter(logging.Formatter("%(message)s"))
sys.stdout = _Tee(sys.__stdout__, _transcript_handler)
sys.stderr = _Tee(sys.__stderr__, _transcript_handler)


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
            time.sleep(5 * 60)

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
            time.sleep(5 * 60)

        run_sound_loop()


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
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

    print(f"{_ts()} Web UI available at http://0.0.0.0:{WEB_PORT}")
    try:
        app.run(host="0.0.0.0", port=WEB_PORT, debug=False, use_reloader=False)
    except KeyboardInterrupt:
        print(f"\n{_ts()} Shutting down.")
