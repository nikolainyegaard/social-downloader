import os
import sys
import logging
import threading
from datetime import datetime, timedelta, timezone
from logging.handlers import TimedRotatingFileHandler

import database as db
from config import DATA_DIR, LOOP_INTERVAL_MINUTES, WEB_PORT
from loop import run_loop, set_next_run, trigger_event
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


# Background loop thread

def _loop_thread():
    while True:
        run_loop()

        next_run = datetime.now(timezone.utc) + timedelta(minutes=LOOP_INTERVAL_MINUTES)
        set_next_run(next_run.isoformat())
        print(
            f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}]"
            f" Sleeping until {next_run.strftime('%H:%M:%S')}"
            f" ({LOOP_INTERVAL_MINUTES} min)."
        )

        triggered = trigger_event.wait(timeout=LOOP_INTERVAL_MINUTES * 60)
        trigger_event.clear()
        if triggered:
            print(
                f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}]"
                " Manual trigger received, running loop now."
            )


# Entry point

if __name__ == "__main__":
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Initialising database...")
    db.init_db()

    app = create_app()

    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Starting loop thread...")
    t = threading.Thread(target=_loop_thread, daemon=True, name="loop-thread")
    t.start()

    print(
        f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}]"
        f" Web UI available at http://0.0.0.0:{WEB_PORT}"
    )
    try:
        app.run(host="0.0.0.0", port=WEB_PORT, debug=False, use_reloader=False)
    except KeyboardInterrupt:
        print(f"\n[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Shutting down.")
