"""Channel platform loop state and run queue.

ChannelLoop replaces the per-platform loop.py clones. Each engine instance
owns one ChannelLoop: its own state dict, locks, trigger events, manual-run
queue, and worker thread, so platforms never share any run state. The method
names match the old module-level functions; scheduling.run_session_scheduler
uses a ChannelLoop instance as its loop_mod.

Carries the full TikTok-grade session feature set for every platform:
run-start persistence with crash recovery, a sleep indicator for inter-creator
gaps, session completed/total counts, a monotonic log sequence, and pending
midpoint re-scans scheduled on large deletion spikes.
"""

from __future__ import annotations

import atexit
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
        # Recover start time and duration for display. Three cases:
        # 1. Normal: last_run_start is set from a completed run; use it directly.
        # 2. Killed mid-run (SIGKILL, no atexit): current_run_start is set but no
        #    end time was written; promote it so "Last:" shows the interrupted
        #    run's start, and clear the stale duration from the prior run.
        # 3. Old state file (no start key): fall back to last_run_end.
        _last_start = _persisted.get("last_run_start")
        _cur_start  = _persisted.get("current_run_start")
        _dur        = _persisted.get("last_run_duration_secs")
        if _cur_start:
            _last_start = _cur_start
            _dur = None
        elif not _last_start:
            _last_start = _persisted.get("last_run_end")

        self.loop_state = {
            "running":                False,
            "manual_run":             False,
            "sleep_until":            None,  # Unix ts (float) when the current sleep ends
            "sleep_next":             None,  # label for what runs after the sleep
            "last_run_start":         _last_start,
            "current_run_start":      None,
            "last_run_end":           _persisted.get("last_run_end"),
            "last_run_duration_secs": _dur,
            "last_new_videos":        _persisted.get("last_new_videos"),
            "last_session_completed": _persisted.get("last_session_completed"),
            "last_session_total":     _persisted.get("last_session_total"),
            "next_run":               None,
            "current_channel":        None,
            "sessions_today":         [],
            "logs":                   deque(maxlen=1000),
        }
        self._state_lock = threading.Lock()
        self._log_seq = 0  # monotonic counter: total log lines ever written; never resets

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

        # Pending midpoint re-scans, keyed by channel_id. Each entry holds the
        # Timer object and the Unix timestamp when it fires, so the UI can show
        # a countdown on the creator card.
        self._pending_rescans: dict[str, dict] = {}
        self._pending_rescans_lock = threading.Lock()

        threading.Thread(target=self._run_worker, daemon=True,
                         name=f"{self.adapter.prefix}-run-worker").start()
        atexit.register(self._shutdown_save)

    # ── State persistence ─────────────────────────────────────────────────────

    def _load_state(self) -> dict:
        try:
            with open(self.LOOP_STATE_PATH, encoding="utf-8") as f:
                data = json.load(f)
        except (FileNotFoundError, ValueError):
            return {}
        # Legacy TikTok state file: user_-prefixed keys from before the fold-in.
        if "last_run_end" not in data and "user_last_run_end" in data:
            data = {
                "last_run_start":         data.get("user_last_run_start"),
                "current_run_start":      data.get("user_current_run_start"),
                "last_run_end":           data.get("user_last_run_end"),
                "last_run_duration_secs": data.get("user_last_duration_secs"),
                "last_new_videos":        data.get("user_last_new_videos"),
            }
        return data

    def _save_state(self) -> None:
        with self._state_lock:
            data = {
                "last_run_start":         self.loop_state["last_run_start"],
                "current_run_start":      self.loop_state["current_run_start"],
                "last_run_end":           self.loop_state["last_run_end"],
                "last_run_duration_secs": self.loop_state["last_run_duration_secs"],
                "last_new_videos":        self.loop_state["last_new_videos"],
                "last_session_completed": self.loop_state["last_session_completed"],
                "last_session_total":     self.loop_state["last_session_total"],
            }
        os.makedirs(self.db.data_dir, exist_ok=True)
        _tmp = self.LOOP_STATE_PATH + ".tmp"
        with open(_tmp, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(_tmp, self.LOOP_STATE_PATH)

    def _shutdown_save(self) -> None:
        """On clean shutdown (SIGTERM, Ctrl+C), persist the in-progress run duration
        via atexit so the next startup shows an accurate "Took". Does not run on
        SIGKILL; startup recovery handles that by clearing the stale duration."""
        now_iso = datetime.now(timezone.utc).isoformat()
        now_ts  = time.time()
        with self._state_lock:
            cur = self.loop_state.get("current_run_start")
            if not cur:
                return
            try:
                start_ts = datetime.fromisoformat(cur).timestamp()
                dur: int | None = round(now_ts - start_ts)
            except (ValueError, TypeError):
                dur = None
            self.loop_state["last_run_start"]         = cur
            self.loop_state["current_run_start"]      = None
            self.loop_state["last_run_end"]           = now_iso
            self.loop_state["last_run_duration_secs"] = dur
            self.loop_state["running"]                = False
        self._save_state()

    def recover_state_from_db(self) -> None:
        """If last_run_end is still null after loading the state file, infer it
        from MAX(last_checked) in the DB. Called once at startup after init_db."""
        with self._state_lock:
            if self.loop_state["last_run_end"] is not None:
                return
        with self.db.get_db() as conn:
            row = conn.execute("SELECT MAX(last_checked) AS ts FROM channels").fetchone()
        ts = row["ts"] if row else None
        if not ts:
            return
        iso = datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
        with self._state_lock:
            self.loop_state["last_run_end"]   = iso
            self.loop_state["last_run_start"] = iso
        self._save_state()

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
                "loop_running":                self.loop_state["running"],
                "loop_manual_run":             self.loop_state["manual_run"],
                "loop_sleep_until":            self.loop_state["sleep_until"],
                "loop_sleep_next":             self.loop_state["sleep_next"],
                "loop_last_start":             self.loop_state["last_run_start"],
                "loop_last_end":               self.loop_state["last_run_end"],
                "loop_last_duration_secs":     self.loop_state["last_run_duration_secs"],
                "loop_last_new_videos":        self.loop_state["last_new_videos"],
                "loop_last_session_completed": self.loop_state["last_session_completed"],
                "loop_last_session_total":     self.loop_state["last_session_total"],
                "loop_next":                   self.loop_state["next_run"],
                "loop_current_channel":        self.loop_state["current_channel"],
                "loop_sessions_today":         list(self.loop_state["sessions_today"]),
                "logs":                        list(self.loop_state["logs"]),
                "log_seq":                     self._log_seq,
            }
        state["loop_paused"] = str(self.db.get_setting("loop_paused", "0")) == "1"
        with self._run_state_lock:
            state["run_current"] = self._run_state["current"]
            state["run_queue"]   = list(self._run_state["queue"])
        with self._pending_rescans_lock:
            state["pending_rescans"] = {cid: info["fires_at"]
                                        for cid, info in self._pending_rescans.items()}
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
        """Queue a single-channel manual run. Returns False if already queued/running.
        Cancels any pending midpoint re-scan for this channel."""
        with self._pending_rescans_lock:
            pending = self._pending_rescans.pop(channel_id, None)
        if pending:
            pending["timer"].cancel()
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
            self._log_seq += 1

    def _set_current_channel(self, handle: str | None) -> None:
        with self._state_lock:
            self.loop_state["current_channel"] = handle

    def _set_sleep(self, until: float | None, next_label: str | None) -> None:
        """Set or clear the active sleep indicator shown in the log console."""
        with self._state_lock:
            self.loop_state["sleep_until"] = until
            self.loop_state["sleep_next"]  = next_label

    # ── Pending midpoint re-scans ─────────────────────────────────────────────

    def schedule_midpoint_run(self, channel_id: str) -> None:
        """Schedule an isolated full re-scan at the midpoint before the next loop run.

        Called when a large deletion spike is detected in a full run. Uses a fresh
        dedicated session (same as pressing Run Full) rather than the shared loop
        session, which avoids session degradation returning partial listings."""
        with self._state_lock:
            next_run_iso = self.loop_state.get("next_run")
        delay = 1800.0  # default: 30 min if the next run is unknown
        if next_run_iso:
            try:
                next_ts = datetime.fromisoformat(next_run_iso).timestamp()
                delay   = max((next_ts - time.time()) / 2, 60.0)
            except (ValueError, TypeError):
                pass

        def _fire():
            with self._pending_rescans_lock:
                self._pending_rescans.pop(channel_id, None)
            self.enqueue_channel_run(channel_id, mode="full")

        fires_at = time.time() + delay
        timer    = threading.Timer(delay, _fire)
        with self._pending_rescans_lock:
            existing = self._pending_rescans.get(channel_id)
            if existing:
                existing["timer"].cancel()
            self._pending_rescans[channel_id] = {"timer": timer, "fires_at": fires_at}
        timer.start()

        mins    = round(delay / 60)
        channel = self.db.get_channel(channel_id)
        label   = f"@{channel['handle']}" if channel else channel_id
        self._log(f"  Large deletion spike: isolated full re-scan for {label} in {mins}m")

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
                    if self.adapter.process_single:
                        self.adapter.process_single(self.engine, channel, self._log,
                                                    self._set_current_channel,
                                                    profile_only=profile_only, mode=mode)
                    else:
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
                        with self.db.get_db() as conn:
                            conn.execute("UPDATE channels SET full_refresh_pending = 0 WHERE channel_id = ?",
                                         (channel_id,))
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
        _run_start = datetime.now(timezone.utc).isoformat()
        with self._state_lock:
            self.loop_state["running"]           = True
            self.loop_state["manual_run"]        = manual
            self.loop_state["current_run_start"] = _run_start
        self._save_state()  # persist current_run_start immediately so a kill mid-run is recoverable
        _loop_start    = time.monotonic()
        _videos_before = self.db.count_downloaded_videos()

        self._stop_event.clear()
        channels = channels_due if channels_due is not None else self.db.get_all_channels()
        noun = self.adapter.creator_noun
        self._log(f"=== {self.engine.label} session started: {len(channels)} {noun}(s) due ===")
        _completed = 0

        if not channels:
            self._log(f"No {noun}s due; nothing to do.")
        else:
            try:
                if self.adapter.process_session:
                    _completed = self.adapter.process_session(
                        self.engine, channels, self._log, self._set_current_channel,
                        self._stop_event, set_sleep=self._set_sleep,
                        on_large_deletion=self.schedule_midpoint_run) or 0
                else:
                    _completed = process_all_channels(self.engine, channels, self._log,
                                                      self._set_current_channel, self._stop_event) or 0
            except Exception as e:
                self._log(f"Unhandled {self.engine.label} loop error: {e}")

        last_run_end  = datetime.now(timezone.utc).isoformat()
        duration_secs = round(time.monotonic() - _loop_start)
        new_videos    = self.db.count_downloaded_videos() - _videos_before
        self._log(f"=== {self.engine.label} session complete: {_completed}/{len(channels)} {noun}(s), {new_videos} new video(s) ===")
        with self._state_lock:
            self.loop_state["running"]                = False
            self.loop_state["manual_run"]             = False
            self.loop_state["sleep_until"]            = None
            self.loop_state["sleep_next"]             = None
            self.loop_state["last_run_start"]         = self.loop_state["current_run_start"]
            self.loop_state["current_run_start"]      = None
            self.loop_state["last_run_end"]           = last_run_end
            self.loop_state["last_run_duration_secs"] = duration_secs
            self.loop_state["last_new_videos"]        = new_videos
            self.loop_state["last_session_completed"] = _completed
            self.loop_state["last_session_total"]     = len(channels)
        self._save_state()
