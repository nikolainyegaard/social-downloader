"""Session-based scheduler shared by the channel platforms (Instagram, Twitter).

Mirrors the TikTok user-loop scheduling model: N sessions are distributed
across each 24-hour window (one random time per equal segment), and each
session processes only the channels whose next_check_at has come due.
Per-channel intervals are derived from starred status and posting activity
by recompute_activity_scores, which runs at startup and after every session.

TikTok keeps its own implementation in main.py/platforms/tiktok because its
scheduler additionally manages quick/full refresh batches and sound-loop
avoidance; this module is the subset that applies to single-loop platforms.
"""

from __future__ import annotations

import os
import random
import time
from datetime import datetime, timezone

_24H = 24 * 3600

SESSION_GAP_MIN_SECS = 15  # minimum inter-channel gap within a session


def platform_defaults(platform: str) -> dict:
    """Env-var defaults for a platform's schedule settings ({PLATFORM}_* variables)."""
    p = platform.upper()
    return {
        "sessions_per_day":          int(os.environ.get(f"{p}_SESSIONS_PER_DAY", 4)),
        "high_priority_check_hours": int(os.environ.get(f"{p}_HIGH_PRIORITY_CHECK_HOURS", 6)),
        "active_check_hours":        int(os.environ.get(f"{p}_ACTIVE_CHECK_HOURS", 24)),
        "inactive_check_hours":      int(os.environ.get(f"{p}_INACTIVE_CHECK_HOURS", 72)),
        "full_refresh_days":         int(os.environ.get(f"{p}_FULL_REFRESH_DAYS", 7)),
        "session_gap_mean_secs":     int(os.environ.get(f"{p}_SESSION_GAP_MEAN_SECS", 90)),
    }


def get_check_intervals(db, platform: str) -> tuple[int, int, int]:
    """Return (high_priority_secs, active_secs, inactive_secs) from settings with env defaults."""
    d = platform_defaults(platform)
    return (
        int(db.get_setting("high_priority_check_hours", d["high_priority_check_hours"])) * 3600,
        int(db.get_setting("active_check_hours",        d["active_check_hours"]))        * 3600,
        int(db.get_setting("inactive_check_hours",      d["inactive_check_hours"]))      * 3600,
    )


def recompute_activity_scores(db, high_priority_secs: int, active_secs: int,
                              inactive_secs: int) -> None:
    """Recompute last_video_at and check_interval_secs for all enabled channels.

    Interval assignment (same rules as the TikTok user scheduler):
      starred=1: high_priority_secs
      active (posted within 30 days): active_secs
      inactive (no post in 60+ days): inactive_secs
      no posts at all: active_secs (default)
    """
    now   = int(time.time())
    ago30 = now - 30 * 86400
    ago60 = now - 60 * 86400
    with db.get_db() as conn:
        channels = conn.execute(
            "SELECT channel_id, starred FROM channels WHERE enabled = 1"
        ).fetchall()
        for ch in channels:
            channel_id = ch["channel_id"]
            row = conn.execute(
                """SELECT MAX(upload_date) AS last_upload,
                          SUM(CASE WHEN upload_date > ? THEN 1 ELSE 0 END) AS recent_count
                   FROM videos WHERE channel_id = ? AND file_path IS NOT NULL""",
                (ago30, channel_id)
            ).fetchone()
            last_video_at = row["last_upload"] if row else None
            recent_count  = int(row["recent_count"] or 0) if row else 0

            if ch["starred"]:
                interval = high_priority_secs
            elif recent_count > 0:
                interval = active_secs
            elif last_video_at and last_video_at < ago60:
                interval = inactive_secs
            else:
                interval = active_secs

            conn.execute(
                "UPDATE channels SET last_video_at = ?, check_interval_secs = ? WHERE channel_id = ?",
                (last_video_at, interval, channel_id)
            )


def get_channels_due_for_check(db, now: int) -> list[dict]:
    """Return enabled channels whose next check is due (next_check_at <= now or NULL).

    NULL means never scheduled; treat as due immediately. Tracking-disabled
    channels are included so their profiles keep refreshing (the tracker skips
    their post fetch). Ordered starred first, then most-overdue first.
    """
    with db.get_db() as conn:
        return [dict(r) for r in conn.execute(
            """SELECT * FROM channels
               WHERE enabled = 1
                 AND (next_check_at IS NULL OR next_check_at <= ?)
               ORDER BY starred DESC, COALESCE(next_check_at, 0) ASC""",
            (now,)
        ).fetchall()]


def get_starred_channels_due(db, now: int) -> list[dict]:
    """Return enabled starred channels that are due for a check.
    Used by the Starred trigger to ensure only starred channels are processed."""
    with db.get_db() as conn:
        return [dict(r) for r in conn.execute(
            """SELECT * FROM channels
               WHERE enabled = 1 AND starred = 1
                 AND (next_check_at IS NULL OR next_check_at <= ?)
               ORDER BY COALESCE(next_check_at, 0) ASC""",
            (now,)
        ).fetchall()]


def set_channel_next_check(db, channel_id: str, next_check_at: int | None) -> None:
    """Write the next scheduled check timestamp. Pass None to reset (due ASAP)."""
    with db.get_db() as conn:
        conn.execute(
            "UPDATE channels SET next_check_at = ? WHERE channel_id = ?",
            (next_check_at, channel_id),
        )


def get_full_refresh_secs(db, platform: str) -> int:
    """Seconds between full (deletion-detecting) checks per channel; sessions run quick in between."""
    d = platform_defaults(platform)
    return int(db.get_setting("full_refresh_days", d["full_refresh_days"])) * 86400


def set_channel_last_full(db, channel_id: str, ts: int) -> None:
    """Stamp completion of a full check for a channel."""
    with db.get_db() as conn:
        conn.execute(
            "UPDATE channels SET last_full_refresh_at = ? WHERE channel_id = ?",
            (ts, channel_id),
        )


# Manual trigger priming: reset next_check_at so the selected channels become due.
# Same pattern as the TikTok prime_*_for_manual_run functions.

def prime_starred_channels(db) -> int:
    """Reset next_check_at for all enabled starred channels. Returns count affected."""
    with db.get_db() as conn:
        result = conn.execute(
            "UPDATE channels SET next_check_at = NULL WHERE enabled = 1 AND starred = 1"
        )
        return result.rowcount


def prime_half_channels(db) -> int:
    """Reset next_check_at for the 50% of enabled channels longest since their last check.
    Never-checked channels sort first. Returns count affected."""
    with db.get_db() as conn:
        rows = conn.execute(
            "SELECT channel_id FROM channels WHERE enabled = 1"
            " ORDER BY COALESCE(last_checked, 0) ASC"
        ).fetchall()
        if not rows:
            return 0
        half = rows[: max(1, len(rows) // 2)]
        ids  = [r["channel_id"] for r in half]
        conn.execute(
            f"UPDATE channels SET next_check_at = NULL WHERE channel_id IN ({','.join('?' * len(ids))})",
            ids,
        )
        return len(ids)


def prime_all_channels(db) -> int:
    """Reset next_check_at for all enabled channels. Returns count affected."""
    with db.get_db() as conn:
        result = conn.execute(
            "UPDATE channels SET next_check_at = NULL WHERE enabled = 1"
        )
        return result.rowcount


def channel_gap_secs(platform: str) -> float:
    """Random inter-channel gap within a session (exponential, floored)."""
    mean = platform_defaults(platform)["session_gap_mean_secs"]
    return max(random.expovariate(1.0 / mean), SESSION_GAP_MIN_SECS)


def run_session_scheduler(platform: str, db, loop_mod,
                          on_window_start=None, pre_session=None) -> None:
    """Scheduler thread body: distributes N sessions across each 24-hour window.

    loop_mod must expose: trigger_event, check_and_clear_reschedule(),
    get_and_clear_trigger_scope(), set_next_run(iso), set_sessions_today(times),
    run_loop(channels_due, manual).

    Optional hooks:
    on_window_start(now): called when a new 24h window is scheduled (TikTok
    advances its full-refresh batch cycle here).
    pre_session(triggered): called right before a session runs (TikTok waits
    for the sound loop to finish plus a buffer).
    """
    label = {"youtube": "YouTube", "tiktok": "TikTok"}.get(platform, platform.capitalize())
    defaults = platform_defaults(platform)
    session_times: list[float] = []
    window_end = 0.0

    def _ts() -> str:
        return f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}]"

    while True:
        now = time.time()

        # Regenerate the session schedule when the window has expired or the list is empty
        if not session_times or now >= window_end:
            n_sessions   = max(1, int(db.get_setting("sessions_per_day", defaults["sessions_per_day"])))
            window_end   = now + _24H
            segment_size = _24H / n_sessions
            # Pick one random time within each equal segment of the 24-hour window
            session_times = sorted(
                now + i * segment_size + random.uniform(
                    max(60.0, segment_size * 0.05),
                    segment_size * 0.95,
                )
                for i in range(n_sessions)
            )
            # Guarantee the first session is at least 60 s from now
            session_times[0] = max(session_times[0], now + 60)
            loop_mod.set_sessions_today(session_times)
            print(f"{_ts()} {label} loop: {n_sessions} session(s) scheduled for the next 24 h.")
            if on_window_start:
                try:
                    on_window_start(now)
                except Exception as e:
                    print(f"{_ts()} {label} loop: window-start hook error: {e}")

        next_ts   = session_times[0]
        remaining = next_ts - time.time()
        loop_mod.set_next_run(datetime.fromtimestamp(next_ts, tz=timezone.utc).isoformat())
        print(
            f"{_ts()} {label} loop: next session at"
            f" {datetime.fromtimestamp(next_ts).strftime('%H:%M:%S')}"
            f" ({remaining / 60:.0f} min)."
        )

        triggered = loop_mod.trigger_event.wait(timeout=max(remaining, 0))
        loop_mod.trigger_event.clear()

        if loop_mod.check_and_clear_reschedule():
            print(f"{_ts()} {label} loop: settings changed, rescheduling sessions.")
            session_times = []
            window_end    = 0.0
            continue

        if triggered:
            print(f"{_ts()} {label} loop: manual trigger received.")
        else:
            # Scheduled wake-up: consume this session slot. Manual triggers do not
            # consume a slot so the next scheduled session still fires as planned.
            session_times = session_times[1:]

        # Paused: scheduled sessions are skipped (their slot is still consumed,
        # so unpausing resumes the normal cadence). Manual triggers run anyway
        # since the user asked explicitly.
        if not triggered and str(db.get_setting("loop_paused", "0")) == "1":
            print(f"{_ts()} {label} loop: session skipped (paused).")
            continue

        loop_mod.set_next_run(None)

        if pre_session:
            try:
                pre_session(triggered)
            except Exception as e:
                print(f"{_ts()} {label} loop: pre-session hook error: {e}")

        now_ts = int(time.time())
        scope  = loop_mod.get_and_clear_trigger_scope() if triggered else None

        if scope == "starred":
            channels_due = get_starred_channels_due(db, now_ts)
        else:
            channels_due = get_channels_due_for_check(db, now_ts)

        if not channels_due:
            print(f"{_ts()} {label} loop: no channels due at this session, skipping.")
            continue

        loop_mod.run_loop(channels_due, manual=triggered)

        # Recompute activity scores after each session so intervals stay current
        high, active, inactive = get_check_intervals(db, platform)
        recompute_activity_scores(db, high, active, inactive)
