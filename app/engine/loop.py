"""Channel platform loop state and run queue.

ChannelLoop replaces the per-platform loop.py clones. Each engine instance
owns one ChannelLoop: its own state dict, locks, trigger events, manual-run
queue, and worker thread, so platforms never share any run state. The method
names match the old module-level functions; scheduling.run_session_scheduler
uses a ChannelLoop instance as its loop_mod.
"""

from __future__ import annotations

import json
import os
import queue as _queue_module
import threading
import time
from collections import deque
from datetime import datetime, timezone


class ChannelLoop:

    def __init__(self, engine):
        self.engine  = engine
        self.db      = engine.db
        self.adapter = engine.adapter

        self.LOOP_STATE_PATH = os.path.join(self.db.data_dir, "loop_state.json")

        _persisted = self._load_state()
        self.loop_state = {
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
        self._state_lock = threading.Lock()

        self.trigger_event    = threading.Event()
        self._stop_event      = threading.Event()
        self._reschedule_flag = False
        self._rflag_lock      = threading.Lock()

        # Scope of the pending manual trigger: "next" | "starred" | "half" | "all" | None (scheduled).
        # Set by the blueprint before firing trigger_event; read+cleared by the scheduler after waking.
        self._trigger_scope      = None
        self._trigger_scope_lock = threading.Lock()

        self._run_queue: _queue_module.Queue = _queue_module.Queue()
        self._run_state_lock = threading.Lock()
        self._run_state: dict = {"current": None, "queue": []}

        threading.Thread(target=self._run_worker, daemon=True,
                         name=f"{self.adapter.prefix}-run-worker").start()

    # ── State persistence ─────────────────────────────────────────────────────

    def _load_state(self) -> dict:
        try:
            with open(self.LOOP_STATE_PATH, encoding="utf-8") as f:
                return json.load(f)
        except (FileNotFoundError, ValueError):
            return {}

    def _save_state(self) -> None:
        with self._state_lock:
            data = {
                "last_run_end":           self.loop_state["last_run_end"],
                "last_run_duration_secs": self.loop_state["last_run_duration_secs"],
                "last_new_videos":        self.loop_state["last_new_videos"],
            }
        os.makedirs(self.db.data_dir, exist_ok=True)
        _tmp = self.LOOP_STATE_PATH + ".tmp"
        with open(_tmp, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(_tmp, self.LOOP_STATE_PATH)

    # ── State accessors (scheduling.py's loop_mod interface) ──────────────────

    def is_running(self) -> bool:
        with self._state_lock:
            return self.loop_state["running"]

    def set_next_run(self, iso: str | None) -> None:
        with self._state_lock:
            self.loop_state["next_run"] = iso

    def set_sessions_today(self, session_times: list) -> None:
        """Update the list of planned session timestamps for the current 24h window."""
        with self._state_lock:
            self.loop_state["sessions_today"] = [
                datetime.fromtimestamp(t, tz=timezone.utc).isoformat()
                for t in session_times
            ]

    def set_trigger_scope(self, scope: str | None) -> None:
        """Set the scope for the next manual trigger. Call before firing trigger_event."""
        with self._trigger_scope_lock:
            self._trigger_scope = scope

    def get_and_clear_trigger_scope(self) -> str | None:
        """Read and clear the pending trigger scope. Returns None for scheduled wakes."""
        with self._trigger_scope_lock:
            val = self._trigger_scope
            self._trigger_scope = None
        return val

    def get_state_snapshot(self) -> dict:
        with self._state_lock:
            state = {
                "loop_running":            self.loop_state["running"],
                "loop_manual_run":         self.loop_state["manual_run"],
                "loop_last_end":           self.loop_state["last_run_end"],
                "loop_last_duration_secs": self.loop_state["last_run_duration_secs"],
                "loop_last_new_videos":    self.loop_state["last_new_videos"],
                "loop_next":               self.loop_state["next_run"],
                "loop_current_channel":    self.loop_state["current_channel"],
                "loop_sessions_today":     list(self.loop_state["sessions_today"]),
                "logs":                    list(self.loop_state["logs"]),
            }
        with self._run_state_lock:
            state["run_current"] = self._run_state["current"]
            state["run_queue"]   = list(self._run_state["queue"])
        return state

    def request_stop(self) -> None:
        """Signal the loop to stop after the current channel finishes."""
        self._stop_event.set()

    def reschedule_loop(self) -> None:
        """Wake the scheduler to re-read its interval from DB without running the loop."""
        with self._rflag_lock:
            self._reschedule_flag = True
        self.trigger_event.set()

    def check_and_clear_reschedule(self) -> bool:
        with self._rflag_lock:
            val = self._reschedule_flag
            self._reschedule_flag = False
        return val

    # ── Manual single-channel runs ────────────────────────────────────────────

    def enqueue_channel_run(self, channel_id: str, profile_only: bool = False, mode: str = "full") -> bool:
        """Queue a single-channel manual run. Returns False if already queued/running."""
        with self._run_state_lock:
            if channel_id in self._run_state["queue"] or self._run_state["current"] == channel_id:
                return False
            self._run_state["queue"].append(channel_id)
        self._run_queue.put((channel_id, profile_only, mode))
        return True

    def enqueue_channel_profile_run(self, channel_id: str) -> bool:
        """Queue a profile-only run (no video fetch). Returns False if already queued/running."""
        return self.enqueue_channel_run(channel_id, profile_only=True)

    def _log(self, msg: str) -> None:
        ts   = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        line = f"[{ts}] {msg}"
        print(line)
        with self._state_lock:
            self.loop_state["logs"].append(line)

    def _set_current_channel(self, handle: str | None) -> None:
        with self._state_lock:
            self.loop_state["current_channel"] = handle

    def _run_worker(self) -> None:
        while True:
            channel_id, profile_only, mode = self._run_queue.get()
            with self._run_state_lock:
                if channel_id in self._run_state["queue"]:
                    self._run_state["queue"].remove(channel_id)
                self._run_state["current"] = channel_id
            try:
                channel = self.db.get_channel(channel_id)
                if channel:
                    label = f"@{channel['handle']}"
                    kind  = "profile" if profile_only else mode
                    self._log(f"=== Manual {kind} run started: {label} ===")
                    from engine.tracker import process_single_channel
                    process_single_channel(self.engine, channel, self._log, self._set_current_channel,
                                           profile_only=profile_only, mode=mode)
                    self._log(f"=== Manual {kind} run complete: {label} ===")
                    # Schedule the next check based on the channel's computed interval
                    from scheduling import get_check_intervals, set_channel_last_full, set_channel_next_check
                    _high, _active, _ = get_check_intervals(self.db, self.engine.platform)
                    _interval = channel.get("check_interval_secs") or (_high if channel.get("starred") else _active)
                    set_channel_next_check(self.db, channel_id, int(time.time()) + _interval)
                    if not profile_only and mode == "full":
                        set_channel_last_full(self.db, channel_id, int(time.time()))
                else:
                    self._log(f"Manual run: channel {channel_id} not found in DB")
            except Exception as e:
                self._log(f"Manual run error for {channel_id}: {e}")
            finally:
                with self._run_state_lock:
                    self._run_state["current"] = None
                self._set_current_channel(None)
                self._run_queue.task_done()

    # ── Session run ───────────────────────────────────────────────────────────

    def run_loop(self, channels_due: list[dict] | None = None, manual: bool = False) -> None:
        """Process channels due for checking. Called by the session scheduler thread.

        Pass the pre-assembled due list from the scheduler; None falls back to all
        enabled channels (used by nothing in normal operation, kept as a safety net).
        """
        from config import get_path_issues
        issues = get_path_issues()
        if issues:
            self._log(f"Loop blocked: {issues[0]['message']}")
            return
        from engine.tracker import process_all_channels
        with self._state_lock:
            self.loop_state["running"]    = True
            self.loop_state["manual_run"] = manual
        _loop_start    = time.monotonic()
        _videos_before = self.db.count_downloaded_videos()

        self._stop_event.clear()
        channels = channels_due if channels_due is not None else self.db.get_all_channels()
        self._log(f"=== {self.engine.label} session started: {len(channels)} channel(s) due ===")
        _completed = 0

        if not channels:
            self._log("No channels due; nothing to do.")
        else:
            try:
                _completed = process_all_channels(self.engine, channels, self._log,
                                                  self._set_current_channel, self._stop_event) or 0
            except Exception as e:
                self._log(f"Unhandled {self.engine.label} loop error: {e}")

        last_run_end  = datetime.now(timezone.utc).isoformat()
        duration_secs = round(time.monotonic() - _loop_start)
        new_videos    = self.db.count_downloaded_videos() - _videos_before
        self._log(f"=== {self.engine.label} session complete: {_completed}/{len(channels)} channel(s), {new_videos} new video(s) ===")
        with self._state_lock:
            self.loop_state["running"]                = False
            self.loop_state["manual_run"]             = False
            self.loop_state["last_run_end"]           = last_run_end
            self.loop_state["last_run_duration_secs"] = duration_secs
            self.loop_state["last_new_videos"]        = new_videos
        self._save_state()
