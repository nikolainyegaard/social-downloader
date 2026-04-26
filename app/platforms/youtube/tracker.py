"""YouTube channel tracking."""

from __future__ import annotations

import time
from typing import Callable

from platforms.youtube import database as db
from platforms.youtube.api import fetch_channel_info, fetch_channel_videos
from downloader import download_video, rename_creator_folder
from thumbnailer import cache_avatar, cache_banner

_CONFIRM_THRESHOLD = 3


def _npost(n: int) -> str:
    return "1 video" if n == 1 else f"{n} videos"


def process_all_channels(
    channels: list[dict],
    log: Callable[[str], None],
    set_current: Callable[[str | None], None] | None = None,
) -> int:
    """Process all tracked YouTube channels. Returns the count of successful channel runs."""
    completed = 0
    for channel in channels:
        try:
            process_single_channel(channel, log, set_current)
            completed += 1
        except Exception as e:
            log(f"Unhandled error for @{channel.get('handle', '?')}: {e}")
    return completed


def process_single_channel(
    channel: dict,
    log: Callable[[str], None],
    set_current: Callable[[str | None], None] | None = None,
) -> None:
    """Update profile, fetch video list, download new videos, track deletions."""
    channel_id = channel["channel_id"]
    handle     = channel["handle"]

    if set_current:
        set_current(handle)

    try:
        log(f"Processing @{handle}")

        info:         dict = {}
        display_name: str  = channel.get("display_name") or handle

        try:
            info = fetch_channel_info(f"https://www.youtube.com/channel/{channel_id}")
            _update_profile(channel, info, log)
            handle       = info.get("handle") or handle
            display_name = info.get("display_name") or display_name
        except Exception as e:
            log(f"  Profile fetch failed: {e}")

        if not channel.get("tracking_enabled", 1):
            log(f"  Video fetch skipped (tracking disabled for @{handle})")
            return

        try:
            remote_videos = fetch_channel_videos(channel_id)
        except Exception as e:
            log(f"  Video fetch failed: {e}")
            return

        remote_map = {v["video_id"]: v for v in remote_videos}
        remote_ids = set(remote_map)

        known_ids, active_ids = db.get_video_id_sets(channel_id)

        new_ids       = remote_ids - known_ids
        deleted_ids   = active_ids - remote_ids
        undeleted_ids = (known_ids - active_ids) & remote_ids

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
                db.add_video(
                    vid_id, channel_id, v.get("title"), v.get("upload_date"),
                    view_count=v.get("view_count"), duration=v.get("duration"),
                    content_type=v.get("content_type", "video"),
                )
                db.update_video_downloaded(vid_id, result["file_path"], result.get("ytdlp_data"))
                log(f"  Saved {vid_id} -> {result['file_path']}")
            else:
                log(f"  Failed to download {vid_id}")

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
