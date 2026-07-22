"""TikTok sound loop: state, manual-run queue, and scheduler.

Sounds are a TikTok-only collection type, so this subsystem lives outside the
channel engine. It logs into the TikTok engine's log console (one console per
platform) and keeps its own state file, run queue, and fixed-interval
scheduler thread. The engine's user loop and this loop coordinate via the
smart-avoidance hooks in main.py so they never fetch concurrently.
"""

from __future__ import annotations

import asyncio
import atexit
import json
import os
import queue as _queue_module
import threading
import time
from datetime import datetime, timezone

from platforms.tiktok.config import SOUND_LOOP_INTERVAL_MINUTES
from platforms.tiktok.store import TikTokStore


class SoundLoop:

    def __init__(self, engine):
        self.engine = engine
        self.db     = engine.db
        self.store  = TikTokStore(engine.db)

        self.STATE_PATH = os.path.join(engine.db.data_dir, "sound_loop_state.json")

        _persisted  = self._load_state()
        _last_start = _persisted.get("last_run_start")
        _cur_start  = _persisted.get("current_run_start")
        _dur        = _persisted.get("last_run_duration_secs")
        if _cur_start:
            _last_start = _cur_start
            _dur = None
        elif not _last_start:
            _last_start = _persisted.get("last_run_end")

        self.state = {
            "running":                False,
            "last_run_start":         _last_start,
            "current_run_start":      None,
            "last_run_end":           _persisted.get("last_run_end"),
            "last_run_duration_secs": _dur,
            "last_new_videos":        _persisted.get("last_new_videos"),
            "next_run":               None,
            "stage":                  None,  # what the sound check is doing right now, for the activity bar
        }
        self._lock = threading.Lock()

        self.trigger_event    = threading.Event()
        self._stop_event      = threading.Event()
        self._reschedule_flag = False
        self._rflag_lock      = threading.Lock()

        self._run_queue: _queue_module.Queue = _queue_module.Queue()
        self._run_state_lock = threading.Lock()
        self._run_state: dict = {"current": None, "queue": []}

        threading.Thread(target=self._run_worker, daemon=True,
                         name="tt-sound-run-worker").start()
        atexit.register(self._shutdown_save)

    # ── State persistence ─────────────────────────────────────────────────────

    def _load_state(self) -> dict:
        try:
            with open(self.STATE_PATH, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            pass
        # Legacy combined loop_state.json from before the fold-in: sound_* keys.
        try:
            with open(os.path.join(self.engine.db.data_dir, "loop_state.json"),
                      encoding="utf-8") as f:
                legacy = json.load(f)
        except (OSError, ValueError):
            return {}
        if "sound_last_run_end" not in legacy:
            return {}
        return {
            "last_run_start":         legacy.get("sound_last_run_start"),
            "current_run_start":      legacy.get("sound_current_run_start"),
            "last_run_end":           legacy.get("sound_last_run_end"),
            "last_run_duration_secs": legacy.get("sound_last_duration_secs"),
            "last_new_videos":        legacy.get("sound_last_new_videos"),
        }

    def _save_state(self) -> None:
        with self._lock:
            data = {
                "last_run_start":         self.state["last_run_start"],
                "current_run_start":      self.state["current_run_start"],
                "last_run_end":           self.state["last_run_end"],
                "last_run_duration_secs": self.state["last_run_duration_secs"],
                "last_new_videos":        self.state["last_new_videos"],
            }
        os.makedirs(self.engine.db.data_dir, exist_ok=True)
        _tmp = self.STATE_PATH + ".tmp"
        with open(_tmp, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(_tmp, self.STATE_PATH)

    def _shutdown_save(self) -> None:
        now_iso = datetime.now(timezone.utc).isoformat()
        now_ts  = time.time()
        with self._lock:
            cur = self.state.get("current_run_start")
            if not cur:
                return
            try:
                start_ts = datetime.fromisoformat(cur).timestamp()
                dur: int | None = round(now_ts - start_ts)
            except (ValueError, TypeError):
                dur = None
            self.state["last_run_start"]         = cur
            self.state["current_run_start"]      = None
            self.state["last_run_end"]           = now_iso
            self.state["last_run_duration_secs"] = dur
            self.state["running"]                = False
        self._save_state()

    # ── Accessors ─────────────────────────────────────────────────────────────

    def _log(self, msg: str) -> None:
        self.engine.loop._log(msg)

    def is_running(self) -> bool:
        with self._lock:
            return self.state["running"]

    def set_next_run(self, iso: str | None) -> None:
        with self._lock:
            self.state["next_run"] = iso

    def set_stage(self, text: str | None) -> None:
        """What the current sound check is doing right now; shown in the log
        activity bar while the sound loop runs."""
        with self._lock:
            self.state["stage"] = text

    def request_stop(self) -> None:
        """Signal the sound loop to stop as soon as possible: between sounds,
        or after the in-flight download within a sound."""
        self._stop_event.set()
        self._log("Sound loop stop requested: finishing the current item, then stopping...")

    def reschedule(self) -> None:
        """Wake the scheduler to re-read its interval from DB without running the loop."""
        with self._rflag_lock:
            self._reschedule_flag = True
        self.trigger_event.set()

    def check_and_clear_reschedule(self) -> bool:
        with self._rflag_lock:
            val = self._reschedule_flag
            self._reschedule_flag = False
        return val

    def enqueue_sound_run(self, sound_id: str) -> bool:
        """Queue a single-sound manual run. Returns False if already queued/running."""
        with self._run_state_lock:
            if sound_id in self._run_state["queue"] or self._run_state["current"] == sound_id:
                return False
            self._run_state["queue"].append(sound_id)
        self._run_queue.put(sound_id)
        return True

    def get_state(self) -> dict:
        """Sound-loop keys merged into the TikTok /status payload."""
        with self._lock:
            state = {
                "sound_loop_running":            self.state["running"],
                "sound_loop_stage":              self.state["stage"],
                "sound_loop_last_start":         self.state["last_run_start"],
                "sound_loop_last_end":           self.state["last_run_end"],
                "sound_loop_last_duration_secs": self.state["last_run_duration_secs"],
                "sound_loop_last_new_videos":    self.state["last_new_videos"],
                "sound_loop_next":               self.state["next_run"],
            }
        state["sound_loop_interval_minutes"] = int(
            self.db.get_setting("sound_loop_interval_minutes", SOUND_LOOP_INTERVAL_MINUTES))
        state["sound_loop_paused"] = str(self.db.get_setting("sound_loop_paused", "0")) == "1"
        with self._run_state_lock:
            state["sound_run_current"] = self._run_state["current"]
            state["sound_run_queue"]   = list(self._run_state["queue"])
        return state

    # ── Workers ───────────────────────────────────────────────────────────────

    def _run_worker(self) -> None:
        from platforms.tiktok.tracker import process_single_sound
        while True:
            sound_id = self._run_queue.get()
            with self._run_state_lock:
                if sound_id in self._run_state["queue"]:
                    self._run_state["queue"].remove(sound_id)
                self._run_state["current"] = sound_id
            try:
                sound = self.store.get_sound(sound_id)
                if sound:
                    label = sound.get("label") or sound_id
                    self._log(f"=== Manual sound run started: {label} ===")
                    asyncio.run(process_single_sound(self.engine, sound, self._log))
                    self._log(f"=== Manual sound run complete: {label} ===")
                else:
                    self._log(f"Manual sound run: {sound_id} not found in DB")
            except Exception as e:
                self._log(f"Manual sound run error for {sound_id}: {e}")
            finally:
                with self._run_state_lock:
                    self._run_state["current"] = None
                self.set_stage(None)
                self._run_queue.task_done()

    def run_sound_loop(self) -> None:
        """Process all tracked sounds. Called by the scheduler thread."""
        from config import get_path_issues
        from platforms.tiktok.tracker import process_all_sounds
        issues = get_path_issues()
        if issues:
            self._log(f"Sound loop blocked: {issues[0]['message']}")
            return
        _run_start = datetime.now(timezone.utc).isoformat()
        with self._lock:
            self.state["running"]           = True
            self.state["current_run_start"] = _run_start
        self._save_state()
        _loop_start    = time.monotonic()
        _videos_before = self.db.count_downloaded_videos()

        self._stop_event.clear()
        self._log("=== Sound loop started ===")
        _sound_stats: dict | None = None
        try:
            _sound_stats = asyncio.run(process_all_sounds(self.engine, self._log, self._stop_event))
        except Exception as e:
            self._log(f"Unhandled sound loop error: {e}")

        last_run_end  = datetime.now(timezone.utc).isoformat()
        duration_secs = round(time.monotonic() - _loop_start)
        new_videos    = self.db.count_downloaded_videos() - _videos_before
        if _sound_stats:
            self._log(f"=== Sound loop complete: {_sound_stats['sounds_checked']} sound(s) checked,"
                      f" {new_videos} new video(s) ===")
        else:
            self._log("=== Sound loop complete ===")
        with self._lock:
            self.state["running"]                = False
            self.state["stage"]                  = None
            self.state["last_run_start"]         = self.state["current_run_start"]
            self.state["current_run_start"]      = None
            self.state["last_run_end"]           = last_run_end
            self.state["last_run_duration_secs"] = duration_secs
            self.state["last_new_videos"]        = new_videos
        self._save_state()

    def scheduler_thread(self) -> None:
        """Fixed-interval scheduler with manual trigger and smart avoidance of the user loop."""
        def _ts() -> str:
            return f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}]"

        while True:
            interval_minutes = int(self.db.get_setting(
                "sound_loop_interval_minutes", SOUND_LOOP_INTERVAL_MINUTES))
            next_at_ts = time.time() + interval_minutes * 60
            self.set_next_run(datetime.fromtimestamp(next_at_ts, tz=timezone.utc).isoformat())
            print(f"{_ts()} Sound loop sleeping {interval_minutes} min"
                  f" until {datetime.fromtimestamp(next_at_ts).strftime('%H:%M:%S')}.")

            remaining = next_at_ts - time.time()
            triggered = self.trigger_event.wait(timeout=max(remaining, 0))
            self.trigger_event.clear()

            if self.check_and_clear_reschedule():
                print(f"{_ts()} Sound loop: interval changed, rescheduling.")
                continue

            if triggered:
                print(f"{_ts()} Sound loop: manual trigger received.")

            # Paused: skip scheduled runs; manual triggers run anyway.
            if not triggered and str(self.db.get_setting("sound_loop_paused", "0")) == "1":
                print(f"{_ts()} Sound loop: run skipped (paused).")
                continue

            self.set_next_run(None)

            # Smart avoidance: wait for the user loop to finish, then a 5 min buffer
            was_waiting = False
            while self.engine.loop.is_running():
                was_waiting = True
                time.sleep(30)
            if was_waiting:
                print(f"{_ts()} Sound loop: user loop finished, waiting 5 min buffer.")
                self.trigger_event.wait(timeout=5 * 60)
                self.trigger_event.clear()

            self.run_sound_loop()


_instance: SoundLoop | None = None
_instance_lock = threading.Lock()


def get_sound_loop(engine) -> SoundLoop:
    with _instance_lock:
        global _instance
        if _instance is None:
            _instance = SoundLoop(engine)
        return _instance
