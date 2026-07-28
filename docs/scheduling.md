# Session-based scheduling

The TikTok user loop and all engine platforms share one model (`app/scheduling.py`). Only the TikTok sound loop still uses a fixed-interval sleep.

1. **Sessions per 24h.** The scheduler splits the window into `sessions_per_day` segments and picks a random time in each (5% to 95% into the segment, first session at least 60 s out). Random placement avoids a detectable cadence.
2. **Per-creator due times.** `next_check_at` NULL (never scheduled) or `<= now` means due. Due creators are ordered starred first, then most overdue; after a successful check `next_check_at = now + check_interval_secs`.
3. **Activity-based intervals**, recomputed at startup and after every session: starred `high_priority_check_hours` (6h), active (posted within 30 days) `active_check_hours` (24h), inactive (no post in 60+ days) `inactive_check_hours` (72h), no posts at all uses the active interval.
4. **In-session.** The due list is shuffled and a random exponential gap (mean `*_SESSION_GAP_MEAN_SECS`, min 15 s) separates creators, so request times form no pattern.
5. **Triggers** wake the scheduler without consuming a session slot. Four scopes behind the Next/Starred/Half/All buttons: `/trigger/next` runs what is due, `/trigger` primes all starred (resets `next_check_at` to NULL) and restricts the run to them, `/trigger/half` primes the 50% longest since their last check, `/trigger/all` primes everyone. Priming just makes creators due; the normal due query picks them up. A trigger with nothing to process does not fire the loop: the route logs one line and returns `queued: 0` plus a `message`, which the frontend toasts and uses to re-enable the button (without a run there is no status change to free it).
6. **Pause and cooldown.** A settings save sets a reschedule flag that regenerates the schedule without running. `loop_paused` (Loops panel header) skips scheduled sessions but still consumes the slot, so unpausing resumes the cadence; manual triggers always run. Sounds have their own `sound_loop_paused`. `bot_cooldown_until` skips sessions the same way; the TikTok tracker stamps it when a run cancels on repeated bot detection (`bot_cooldown_hours`, default 6) and clears it when a later run completes.
7. **Manual single-creator runs** push `next_check_at` forward by the interval after completing and never run concurrently with a session: during a live session the queued run is inserted between creators (logged `=== Manual ... run (inserted) ===`, no session renumbering, and the session skips that creator's own turn), otherwise the run worker executes it under the work lock.
8. **First run / upgrade.** Everyone starts `next_check_at IS NULL`, so the first session processes all enabled creators; after that only due ones.
9. **DB wins over env.** Scheduler threads read `db.get_setting(key, env_default)` at runtime, so a value set in the Settings UI survives restarts even if the env var differs.

## Quick/full cadence

Scheduled sessions run a quick check per creator (newest posts only, no deletion detection) unless the last full check is older than `full_refresh_days` (default 7), which triggers a full deletion-detecting check and stamps `last_full_refresh_at`. Manual Full runs stamp it too. TikTok uses explicit daily batches (`refresh_batch`, `full_refresh_pending`); engine platforms gate per creator on `last_full_refresh_at`, which staggers naturally.

## Session resilience (engine tracker)

- A full run with unconfirmed deletion candidates resets `next_check_at` to NULL for an ASAP re-check (the 2-strike threshold still applies)
- Deletion spike guard: if a full run finds >= max(10, 25% of active) videos missing, the increments are skipped for that run (a truncated listing looks like mass deletion) and the ASAP re-check verifies
- A creator whose post fetch fails keeps its due status; 3 consecutive failures abort the session so a rate limit or auth wall is not hammered. This is the engine equivalent of TikTok's browser-specific bot recovery

## TikTok-only extensions

In `main.py` `_tiktok_loop_thread` + `platforms/tiktok/*`: daily full-refresh batches, bot-detection browser restarts, and smart avoidance of the sound loop. Midpoint re-scan timers after large deletion spikes live in ChannelLoop (`schedule_midpoint_run`, via the adapter's `on_large_deletion` hook), used only by TikTok today.

**Smart loop avoidance.** When a loop's scheduled time arrives it checks whether the companion loop (sounds) is running; if so it polls every 30 s until clear, then waits a 5-minute buffer via `trigger_*_event.wait(timeout=5*60)` + `.clear()`. Must be the event wait, not `time.sleep()`: sleep made Run Now during the buffer ignored and left the event set, causing a double-run. A manual trigger during the buffer skips the remainder without double-running.

## Loop stop is immediate, not end-of-iteration

`request_stop()` must take effect at the next safe point, not after the current phase. Every long sleep inside a session is stop-interruptible: the TikTok tracker's inter-user gaps go through `_service_sleep` (1 s slices, checks stop and services queued gate jobs and manual runs), its bot cooldowns and retry sleeps through `_stoppable_sleep` (`stop_event.wait` via `asyncio.to_thread`, instant wake); the generic tracker's gap sleeps use 1 s slices with the same stop re-check and mid-sleep manual-run drain (without the re-check the current channel still got a full run). Download loops check the event between items so the in-flight download completes and the rest are skipped (TikTok per-user downloads, the generic tracker's loop, the sound loop's per-video downloads). A stop mid post-listing on the generic tracker abandons the fetch and returns "failed", so the truncated listing never feeds the deletion diff and the channel stays due.

**Wire any new sleep or per-item loop the same way.**

## `scheduling.py` exports

- `run_session_scheduler(platform, db, loop_mod)`: the scheduler thread body; `loop_mod` needs `trigger_event`, `check_and_clear_reschedule()`, `get_and_clear_trigger_scope()`, `set_next_run()`, `set_sessions_today()`, `run_loop(channels_due, manual)`
- `recompute_activity_scores(db, high, active, inactive)`, `get_channels_due_for_check(db, now)`, `get_starred_channels_due(db, now)`, `set_channel_next_check(db, channel_id, ts)`, `set_channel_last_full(db, channel_id, ts)`, `channel_gap_secs(platform)`
- `prime_starred_channels(db)` / `prime_half_channels(db)` / `prime_all_channels(db)` back the trigger routes
- `platform_defaults(platform)` reads the `{PLATFORM}_*` env vars; DB settings (same key names) win
- Tracking-disabled channels stay in the rotation so profiles keep refreshing; the tracker skips their post fetch

## Frontend wiring

Engine platforms share `_scheduleSettingsLoad` / `_scheduleSettingsSave(platform, idPrefix)` in common.js (ids `{idPrefix}SessionsPerDay`, `{idPrefix}HighPriorityHours`, `{idPrefix}ActiveHours`, `{idPrefix}InactiveHours`). Loop panels are generated by channels.js with `_renderSessionPills` and `_makeTriggerToast(noun)`; the TikTok user loop uses the same pill renderer.
