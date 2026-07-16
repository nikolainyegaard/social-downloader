"""Channel platform tracking: session processing, diffing, deletion detection.

One tracker for all channel platforms. Everything platform-specific goes
through the engine's adapter: profile fetch, post iteration, and the
download-and-record sequence. The diff logic, quick/full cadence, deletion
spike guard, and consecutive-failure abort are identical everywhere.
"""

from __future__ import annotations

import random
import threading
import time
from typing import Callable

from engine import ChannelGoneError
from scheduling import (
    channel_gap_secs, get_check_intervals, get_full_refresh_secs,
    set_channel_last_full, set_channel_next_check,
)
from thumbnailer import cache_avatar, cache_banner

_CONFIRM_THRESHOLD    = 2
_ABORT_AFTER_FAILURES = 3  # consecutive channel failures that abort the session (rate limit or auth wall)


def save_new_stories(db, platform: str, channel_id: str, handle: str,
                     stories: list[dict], log: Callable[[str], None],
                     cookies_path: str | None = None,
                     proxy: str | None = None) -> int:
    """Download and record stories not yet in the DB. Returns the saved count.

    Story dicts: {story_id, content_type 'video'|'photo', posted_at,
    expires_at, media_url, headers?}. Used by the generic tracker below and by
    platform trackers with a session override (TikTok).
    """
    from downloader import download_story

    known = db.get_known_story_ids(channel_id)
    fresh = [s for s in stories if s["story_id"] not in known]
    saved = 0
    for s in fresh:
        path = download_story(
            story_id=s["story_id"], username=handle, platform=platform,
            media_url=s["media_url"], content_type=s.get("content_type", "video"),
            posted_at=s.get("posted_at"), cookies_path=cookies_path,
            headers=s.get("headers"), proxy=proxy,
        )
        if not path:
            log(f"  Story {s['story_id']} download failed")
            continue
        db.add_story(s["story_id"], channel_id, s.get("content_type", "video"),
                     s.get("posted_at"), s.get("expires_at"), path)
        saved += 1
    if saved:
        log(f"  {saved} new {'story' if saved == 1 else 'stories'} saved")
    return saved


def process_all_channels(
    engine,
    channels: list[dict],
    log: Callable[[str], None],
    set_current: Callable[[str | None], None] | None = None,
    stop_event: threading.Event | None = None,
) -> int:
    """Process one session of due channels. Returns the count of successful runs.

    Per-channel mode follows the TikTok cadence: quick check by default, full
    (deletion-detecting) check once the channel's last full run is older than
    full_refresh_days. Failed channels stay due; the session aborts after
    consecutive failures so a rate limit or auth wall is not hammered.
    """
    db       = engine.db
    platform = engine.platform
    noun     = engine.adapter.item_noun

    n = db.backfill_upload_dates()
    if n:
        log(f"  Backfilled upload_date for {n} {noun}(s) from stored metadata")

    high_secs, active_secs, _ = get_check_intervals(db, platform)
    full_secs = get_full_refresh_secs(db, platform)
    random.shuffle(channels)
    completed = 0
    consecutive_failures = 0
    for i, channel in enumerate(channels):
        if stop_event and stop_event.is_set():
            log(f"=== {engine.label} loop stopped by request ===")
            break
        if i > 0:
            gap = channel_gap_secs(platform)
            if stop_event:
                stop_event.wait(gap)
            else:
                time.sleep(gap)
        now       = int(time.time())
        last_full = channel.get("last_full_refresh_at")
        mode      = "quick" if (last_full and now - last_full < full_secs) else "full"
        try:
            result = process_single_channel(engine, channel, log, set_current, mode=mode)
        except Exception as e:
            log(f"Unhandled error for @{channel.get('handle', '?')}: {e}")
            result = "failed"
        if result == "failed":
            # No next_check advance: the channel stays due and is retried next session
            consecutive_failures += 1
            if consecutive_failures >= _ABORT_AFTER_FAILURES:
                log(f"=== {engine.label} session aborted: {consecutive_failures} consecutive failures (rate limit or auth issue?) ===")
                break
            continue
        consecutive_failures = 0
        completed += 1
        if mode == "full":
            set_channel_last_full(db, channel["channel_id"], int(time.time()))
        if result == "deletions":
            set_channel_next_check(db, channel["channel_id"], None)
            log("  Deletion candidates found; scheduling ASAP re-check")
        else:
            interval = channel.get("check_interval_secs") or (
                high_secs if channel.get("starred") else active_secs
            )
            set_channel_next_check(db, channel["channel_id"], int(time.time()) + interval)
    return completed


def process_single_channel(
    engine,
    channel: dict,
    log: Callable[[str], None],
    set_current: Callable[[str | None], None] | None = None,
    profile_only: bool = False,
    mode: str = "full",
) -> str:
    """Update profile, fetch the post list, download new posts, track deletions.

    mode="quick" fetches only the newest posts (adapter.quick_limit) and skips
    deletion detection (absence from a partial listing proves nothing);
    mode="full" fetches the whole list and runs the full diff.

    Returns "ok", "deletions" (unconfirmed deletion candidates found; caller
    schedules an ASAP re-check), or "failed" (post fetch failed; caller leaves
    the channel due and counts it toward the session abort threshold).
    """
    db      = engine.db
    adapter = engine.adapter
    noun    = adapter.item_noun

    channel_id = channel["channel_id"]
    handle     = channel["handle"]

    if set_current:
        set_current(handle)

    try:
        suffix = " (profile only)" if profile_only else (" (quick)" if mode == "quick" else "")
        log(f"Processing @{handle}{suffix}")

        display_name = channel.get("display_name") or handle
        was_banned   = channel.get("account_status") == "banned"

        try:
            info = adapter.fetch_profile(channel)
            if was_banned:
                restored = db.restore_banned_videos(channel_id)
                db.set_account_status(channel_id, "active")
                db.set_channel_tracking_enabled(channel_id, True)
                log(f"  Account restored: ban cleared, {restored} {noun}s re-activated")
            _update_profile(engine, channel, info, log)
            handle       = info.get("handle") or handle
            display_name = info.get("display_name") or display_name
        except ChannelGoneError as e:
            if was_banned:
                log("  No changes (still banned)")
                banned_at = channel.get("banned_at")
                if (banned_at
                        and time.time() - banned_at >= 14 * 86400
                        and channel.get("tracking_enabled", 1)):
                    db.set_channel_tracking_enabled(channel_id, False)
                    log("  Banned for 14+ consecutive days, tracking disabled")
            else:
                log(f"  {adapter.creator_noun.capitalize()} banned or removed ({e}), marking as banned")
                db.set_account_status(channel_id, "banned")
                n = db.ban_channel_videos(channel_id)
                if n:
                    log(f"  {n} {noun}s marked deleted (user_banned)")
            db.touch_last_checked(channel_id)
            return "ok"
        except Exception as e:
            log(f"  Profile fetch failed: {e}")

        if profile_only:
            return "ok"

        if not channel.get("tracking_enabled", 1):
            log(f"  {noun.capitalize()} fetch skipped (tracking disabled for @{handle})")
            return "ok"

        if adapter.fetch_stories:
            try:
                stories = adapter.fetch_stories(engine, channel)
                if stories:
                    save_new_stories(db, engine.platform, channel_id, handle, stories, log)
            except Exception as e:
                log(f"  Story fetch failed: {e}")

        try:
            remote_posts: dict[str, dict]   = {}
            raw_posts:    dict[str, object] = {}
            for post_dict, raw_post in adapter.iter_posts(channel_id):
                vid_id               = post_dict["video_id"]
                remote_posts[vid_id] = post_dict
                raw_posts[vid_id]    = raw_post
                if mode == "quick" and adapter.quick_limit and len(remote_posts) >= adapter.quick_limit:
                    break
        except Exception as e:
            log(f"  {noun.capitalize()} fetch failed: {e}")
            return "failed"

        remote_ids = set(remote_posts)
        known_ids, active_ids, _confirm_pending = db.get_video_id_sets(channel_id)

        new_ids       = remote_ids - known_ids
        deleted_ids   = (active_ids - remote_ids) if mode == "full" else set()
        undeleted_ids = (known_ids - active_ids) & remote_ids

        # Deletion spike guard: a truncated listing looks like a mass deletion.
        # Skip the increments this run and let the ASAP re-check verify.
        deletion_spike = bool(deleted_ids) and len(deleted_ids) >= max(10, len(active_ids) // 4)
        if deletion_spike:
            log(f"  Deletion spike: {len(deleted_ids)} of {len(active_ids)} missing; skipping deletion marks this run (possible truncated listing)")
            deleted_ids = set()

        pending_ids = db.get_pending_deletion_video_ids(channel_id)
        recovered   = pending_ids & remote_ids
        for vid_id in recovered:
            db.clear_video_pending_deletion(vid_id)
            log(f"  Deletion check cleared: {vid_id} (back on {engine.label})")

        if new_ids:
            log(f"  New: {len(new_ids)}")
        if deleted_ids:
            log(f"  Missing (checking for deletion): {len(deleted_ids)}")
        if undeleted_ids:
            log(f"  Undeleted: {len(undeleted_ids)}")
        if not (new_ids or deleted_ids or undeleted_ids or recovered):
            log("  No changes.")

        for vid_id in sorted(new_ids):
            log(f"  Downloading {vid_id}...")
            adapter.download_item(
                engine, channel_id, handle, display_name,
                vid_id, remote_posts[vid_id], raw_posts[vid_id], log,
            )

        deletion_candidates = False
        for vid_id in deleted_ids:
            count = db.increment_video_pending_deletion(vid_id)
            if count >= _CONFIRM_THRESHOLD:
                db.mark_video_deleted(vid_id)
                log(f"  Marked deleted (confirmed {_CONFIRM_THRESHOLD}/{_CONFIRM_THRESHOLD}): {vid_id}")
            else:
                deletion_candidates = True
                log(f"  Possibly deleted ({count}/{_CONFIRM_THRESHOLD}): {vid_id}")

        for vid_id in undeleted_ids:
            db.mark_video_undeleted(vid_id)
            log(f"  Marked undeleted: {vid_id}")

        return "deletions" if (deletion_candidates or deletion_spike) else "ok"

    finally:
        if set_current:
            set_current(None)


def _update_profile(engine, channel: dict, info: dict, log: Callable[[str], None]) -> None:
    """Detect profile field changes, record them, and update the DB."""
    db         = engine.db
    channel_id = channel["channel_id"]

    field_map = {
        "handle":       (channel.get("handle"),       info.get("handle")),
        "display_name": (channel.get("display_name"), info.get("display_name")),
        "description":  (channel.get("description"),  info.get("description")),
    }
    for field, (old, new) in field_map.items():
        if new and new != old and old is not None:  # falsy new = field missing from a sparse fetch, not a change
            db.record_profile_change(channel_id, field, old)
            if field == "handle":
                log(f"  Handle changed: @{old} -> @{new}")
                from downloader import rename_creator_folder
                if rename_creator_folder(engine.platform, old, new):
                    db.rename_channel_video_paths(channel_id, old, new)
                    log("  Folder renamed and DB paths updated")
            else:
                labels = {"display_name": "Display name", "description": "Description"}
                log(f"  Profile change: {labels.get(field, field)} updated")

    db.update_channel_info(
        channel_id,
        info.get("handle") or channel["handle"],
        info.get("display_name"),
        info.get("description"),
        info.get("subscriber_count"),
        info.get("video_count"),
        avatar_url=info.get("avatar_url"),
        banner_url=info.get("banner_url"),
        raw_channel_data=info.get("raw_channel_data"),
    )

    if info.get("avatar_url"):
        try:
            result = cache_avatar(channel_id, info["avatar_url"], engine.platform, db_obj=db)
            if result == "changed":
                log("  Profile change: avatar changed")
        except Exception as e:
            log(f"  Avatar cache failed: {e}")

    if engine.adapter.has_banner and info.get("banner_url"):
        try:
            cache_banner(channel_id, info["banner_url"], engine.platform, db_obj=db)
        except Exception as e:
            log(f"  Banner cache failed: {e}")
