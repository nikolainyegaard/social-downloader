"""Twitter account tracking."""

from __future__ import annotations

import os
import random
import threading
import time
from typing import Callable

from platforms.twitter import database as db
from platforms.twitter import api
from scheduling import channel_gap_secs, get_check_intervals, set_channel_next_check
from thumbnailer import cache_avatar, generate_thumbnail
from config import MEDIA_DIR

_CONFIRM_THRESHOLD = 2


def process_all_channels(
    channels: list[dict],
    log: Callable[[str], None],
    set_current: Callable[[str | None], None] | None = None,
    stop_event: threading.Event | None = None,
) -> int:
    """Process one session of due Twitter accounts. Returns count of successful runs."""
    n = db.backfill_upload_dates()
    if n:
        log(f"  Backfilled upload_date for {n} post(s) from stored metadata")

    high_secs, active_secs, _ = get_check_intervals(db, "twitter")
    random.shuffle(channels)
    completed = 0
    for i, channel in enumerate(channels):
        if stop_event and stop_event.is_set():
            log("=== Twitter loop stopped by request ===")
            break
        if i > 0:
            gap = channel_gap_secs("twitter")
            if stop_event:
                stop_event.wait(gap)
            else:
                time.sleep(gap)
        try:
            process_single_channel(channel, log, set_current)
            completed += 1
            interval = channel.get("check_interval_secs") or (
                high_secs if channel.get("starred") else active_secs
            )
            set_channel_next_check(db, channel["channel_id"], int(time.time()) + interval)
        except Exception as e:
            log(f"Unhandled error for @{channel.get('handle', '?')}: {e}")
    return completed


def process_single_channel(
    channel: dict,
    log: Callable[[str], None],
    set_current: Callable[[str | None], None] | None = None,
    profile_only: bool = False,
) -> None:
    """Update profile, fetch media tweets, download new posts, track deletions."""
    channel_id = channel["channel_id"]
    handle     = channel["handle"]

    if set_current:
        set_current(handle)

    try:
        log(f"Processing @{handle}" + (" (profile only)" if profile_only else ""))

        try:
            info = api.fetch_profile_info(handle)
            _update_profile(channel, info, log)
            handle = info.get("handle") or handle
        except Exception as e:
            log(f"  Profile fetch failed: {e}")

        if profile_only:
            return

        if not channel.get("tracking_enabled", 1):
            log(f"  Post fetch skipped (tracking disabled for @{handle})")
            return

        try:
            remote_posts: dict[str, dict] = {}
            raw_posts:    dict[str, list] = {}
            for post_dict, files in api.iter_profile_posts(channel_id):
                vid_id               = post_dict["video_id"]
                remote_posts[vid_id] = post_dict
                raw_posts[vid_id]    = files
        except Exception as e:
            log(f"  Post fetch failed: {e}")
            return

        remote_ids = set(remote_posts)
        known_ids, active_ids = db.get_video_id_sets(channel_id)

        new_ids       = remote_ids - known_ids
        deleted_ids   = active_ids - remote_ids
        undeleted_ids = (known_ids - active_ids) & remote_ids

        pending_ids = db.get_pending_deletion_video_ids(channel_id)
        recovered   = pending_ids & remote_ids
        for vid_id in recovered:
            db.clear_video_pending_deletion(vid_id)
            log(f"  Deletion check cleared: {vid_id} (back on Twitter)")

        if new_ids:
            log(f"  New: {len(new_ids)}")
        if deleted_ids:
            log(f"  Missing (checking for deletion): {len(deleted_ids)}")
        if undeleted_ids:
            log(f"  Undeleted: {len(undeleted_ids)}")
        if not (new_ids or deleted_ids or undeleted_ids or recovered):
            log("  No changes.")

        dest_dir = os.path.join(MEDIA_DIR, "twitter", f"@{handle}")

        for vid_id in sorted(new_ids):
            v     = remote_posts[vid_id]
            files = raw_posts[vid_id]
            log(f"  Downloading {vid_id}...")
            db.add_video(
                vid_id, channel_id, v.get("title"),
                v.get("upload_date"),
                view_count=v.get("view_count"),
                duration=v.get("duration"),
                content_type=v.get("content_type", "video"),
            )
            file_path = api.download_post_media(files, vid_id, dest_dir, v.get("upload_date"))
            if file_path:
                db.update_video_downloaded(vid_id, file_path)
                generate_thumbnail(vid_id, file_path)
                log(f"  Saved {vid_id} -> {file_path}")
            else:
                log(f"  Failed to download {vid_id} (recorded in DB)")

        for vid_id in deleted_ids:
            count = db.increment_video_pending_deletion(vid_id)
            if count >= _CONFIRM_THRESHOLD:
                db.mark_video_deleted(vid_id)
                log(f"  Marked deleted (confirmed {_CONFIRM_THRESHOLD}/{_CONFIRM_THRESHOLD}): {vid_id}")
            else:
                log(f"  Possibly deleted ({count}/{_CONFIRM_THRESHOLD}): {vid_id}")

        for vid_id in undeleted_ids:
            db.mark_video_undeleted(vid_id)
            log(f"  Marked undeleted: {vid_id}")

    finally:
        if set_current:
            set_current(None)


def _update_profile(channel: dict, info: dict, log: Callable[[str], None]) -> None:
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
                from downloader import rename_creator_folder
                if rename_creator_folder("twitter", old, new):
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
            result = cache_avatar(channel_id, info["avatar_url"], "twitter")
            if result == "changed":
                log("  Profile change: avatar changed")
        except Exception as e:
            log(f"  Avatar cache failed: {e}")
