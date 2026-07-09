"""YouTube channel tracking."""

from __future__ import annotations

import random
import threading
import time
from typing import Callable

from platforms.youtube import database as db
from platforms.youtube.api import fetch_channel_info, fetch_channel_videos
from downloader import download_video, rename_creator_folder
from scheduling import (
    channel_gap_secs, get_check_intervals, get_full_refresh_secs,
    set_channel_last_full, set_channel_next_check,
)
from thumbnailer import cache_avatar, cache_banner

_CONFIRM_THRESHOLD = 2
_ABORT_AFTER_FAILURES = 3  # consecutive channel failures that abort the session (rate limit or auth wall)


def _npost(n: int) -> str:
    return "1 video" if n == 1 else f"{n} videos"


def process_all_channels(
    channels: list[dict],
    log: Callable[[str], None],
    set_current: Callable[[str | None], None] | None = None,
    stop_event: threading.Event | None = None,
) -> int:
    """Process one session of due YouTube channels. Returns the count of successful runs.

    Per-channel mode follows the TikTok cadence: quick check by default, full
    (deletion-detecting) check once the channel's last full run is older than
    full_refresh_days. Failed channels stay due; the session aborts after
    consecutive failures so a rate limit or auth wall is not hammered.
    """
    n = db.backfill_upload_dates()
    if n:
        log(f"  Backfilled upload_date for {n} video(s) from stored metadata")

    high_secs, active_secs, _ = get_check_intervals(db, "youtube")
    full_secs = get_full_refresh_secs(db, "youtube")
    random.shuffle(channels)
    completed = 0
    consecutive_failures = 0
    for i, channel in enumerate(channels):
        if stop_event and stop_event.is_set():
            log("=== YouTube loop stopped by request ===")
            break
        if i > 0:
            gap = channel_gap_secs("youtube")
            if stop_event:
                stop_event.wait(gap)
            else:
                time.sleep(gap)
        now       = int(time.time())
        last_full = channel.get("last_full_refresh_at")
        mode      = "quick" if (last_full and now - last_full < full_secs) else "full"
        try:
            result = process_single_channel(channel, log, set_current, mode=mode)
        except Exception as e:
            log(f"Unhandled error for @{channel.get('handle', '?')}: {e}")
            result = "failed"
        if result == "failed":
            # No next_check advance: the channel stays due and is retried next session
            consecutive_failures += 1
            if consecutive_failures >= _ABORT_AFTER_FAILURES:
                log(f"=== YouTube session aborted: {consecutive_failures} consecutive failures (rate limit or auth issue?) ===")
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
    channel: dict,
    log: Callable[[str], None],
    set_current: Callable[[str | None], None] | None = None,
    profile_only: bool = False,
    mode: str = "full",
) -> str:
    """Update profile, fetch video list, download new videos, track deletions.

    mode="quick" skips deletion detection and only picks up new videos; the
    yt-dlp flat extraction fetches the full list either way, so quick saves
    no API calls here, but the semantics match the other platforms.

    Returns "ok", "deletions" (unconfirmed deletion candidates found; caller
    schedules an ASAP re-check), or "failed" (video fetch failed; caller leaves
    the channel due and counts it toward the session abort threshold).
    """
    channel_id = channel["channel_id"]
    handle     = channel["handle"]

    if set_current:
        set_current(handle)

    try:
        suffix = " (profile only)" if profile_only else (" (quick)" if mode == "quick" else "")
        log(f"Processing @{handle}{suffix}")

        info:         dict = {}
        display_name: str  = channel.get("display_name") or handle

        try:
            info = fetch_channel_info(f"https://www.youtube.com/channel/{channel_id}")
            _update_profile(channel, info, log)
            handle       = info.get("handle") or handle
            display_name = info.get("display_name") or display_name
        except Exception as e:
            log(f"  Profile fetch failed: {e}")

        if profile_only:
            return "ok"

        if not channel.get("tracking_enabled", 1):
            log(f"  Video fetch skipped (tracking disabled for @{handle})")
            return "ok"

        try:
            remote_videos = fetch_channel_videos(channel_id)
        except Exception as e:
            log(f"  Video fetch failed: {e}")
            return "failed"

        remote_map = {v["video_id"]: v for v in remote_videos}
        remote_ids = set(remote_map)

        known_ids, active_ids = db.get_video_id_sets(channel_id)

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
            log(f"  Deletion check cleared: {vid_id} (back on YouTube)")

        if new_ids:
            log(f"  New: {len(new_ids)}")
        if deleted_ids:
            log(f"  Missing (checking for deletion): {len(deleted_ids)}")
        if undeleted_ids:
            log(f"  Undeleted: {len(undeleted_ids)}")
        if not (new_ids or deleted_ids or undeleted_ids or recovered):
            log("  No changes.")

        for vid_id in sorted(new_ids):
            v = remote_map.get(vid_id, {})
            log(f"  Downloading {vid_id}...")
            result = download_video(
                video_id=vid_id,
                username=handle,
                tiktok_id=channel_id,
                display_name=display_name,
                description=v.get("title") or "",
                upload_date=v.get("upload_date") or int(time.time()),
                download_date=int(time.time()),
                platform="youtube",
                url=f"https://www.youtube.com/watch?v={vid_id}",
            )
            if result:
                upload_date = v.get("upload_date") or result.get("upload_date")
                db.add_video(
                    vid_id, channel_id, v.get("title"), upload_date,
                    view_count=v.get("view_count"), duration=v.get("duration"),
                    content_type=v.get("content_type", "video"),
                )
                db.update_video_downloaded(vid_id, result["file_path"], result.get("ytdlp_data"))
                log(f"  Saved {vid_id} -> {result['file_path']}")
            else:
                log(f"  Failed to download {vid_id}")

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


def _update_profile(channel: dict, info: dict, log: Callable[[str], None]) -> None:
    """Detect profile field changes, record them, and update the DB."""
    channel_id = channel["channel_id"]

    field_map = {
        "handle":       (channel.get("handle"),       info.get("handle")),
        "display_name": (channel.get("display_name"), info.get("display_name")),
        "description":  (channel.get("description"),  info.get("description")),
    }
    for field, (old, new) in field_map.items():
        if new is not None and new != old and old is not None:
            db.record_profile_change(channel_id, field, old)
            if field == "handle":
                log(f"  Handle changed: @{old} -> @{new}")
                if rename_creator_folder("youtube", old, new):
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
            result = cache_avatar(channel_id, info["avatar_url"], "youtube")
            if result == "changed":
                log("  Profile change: avatar changed")
        except Exception as e:
            log(f"  Avatar cache failed: {e}")

    if info.get("banner_url"):
        try:
            cache_banner(channel_id, info["banner_url"])
        except Exception as e:
            log(f"  Banner cache failed: {e}")
