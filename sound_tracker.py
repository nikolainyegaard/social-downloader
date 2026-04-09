"""Sound tracking: discovers and downloads new videos for tracked TikTok sounds."""

from __future__ import annotations

import time
from typing import Callable

import database as db
from config import get_ms_token, get_cookies_flat, CHROME_EXECUTABLE, DELETION_CONFIRM_THRESHOLD
from tiktok_api import fetch_sound_video_ids, get_video_details
from downloader import download_video, download_photos

_CONFIRM_THRESHOLD = DELETION_CONFIRM_THRESHOLD


async def process_all_sounds(log: Callable[[str], None]) -> None:
    """Fetch and download new videos for all tracked sounds.
    Called once per main loop run, after user processing.
    """
    sounds = db.get_all_sounds()
    if not sounds:
        return

    for sound in sounds:
        if not sound.get("tracking_enabled", 1):
            log(f"Skipping '{sound.get('label') or sound['sound_id']}' (tracking disabled)")
            continue
        await process_sound(sound, log)


async def process_sound(sound: dict, log: Callable[[str], None]) -> None:
    sound_id = sound["sound_id"]
    label    = sound.get("label") or sound_id

    log(f"Processing sound '{label}' ({sound_id})")

    try:
        ms_token   = get_ms_token()
        remote_ids = await fetch_sound_video_ids(sound_id, ms_token, CHROME_EXECUTABLE,
                                                  cookies_flat=get_cookies_flat())
    except Exception as e:
        log(f"Failed to fetch videos for sound {sound_id}: {e}")
        db.update_sound_last_checked(sound_id)
        return

    log(f"{len(remote_ids)} video(s) found for sound '{label}'")

    remote_id_set = set(remote_ids)
    known_ids     = db.get_sound_video_ids(sound_id)
    new_ids       = [vid_id for vid_id in remote_ids if vid_id not in known_ids]

    # Deletion tracking: active videos no longer in the remote listing
    active_ids   = db.get_sound_active_video_ids(sound_id)
    missing_ids  = active_ids - remote_id_set

    # Clear pending counter for any video that came back
    pending_ids = db.get_sound_pending_deletion_video_ids(sound_id)
    for vid_id in pending_ids & remote_id_set:
        db.clear_video_pending_deletion(vid_id)
        log(f"Deletion check cleared: {vid_id} (back in sound listing)")

    for vid_id in missing_ids:
        count = db.increment_video_pending_deletion(vid_id)
        if count >= _CONFIRM_THRESHOLD:
            db.mark_video_deleted(vid_id)
            log(f"Marked deleted (confirmed {_CONFIRM_THRESHOLD}/{_CONFIRM_THRESHOLD}): {vid_id}")
        else:
            log(f"Possibly deleted ({count}/{_CONFIRM_THRESHOLD}): {vid_id}")

    if not new_ids:
        if not missing_ids:
            log(f"No changes for sound '{label}'")
        db.update_sound_last_checked(sound_id)
        return

    log(f"{len(new_ids)} new video(s) for sound '{label}'")
    cookies = get_cookies_flat()

    for vid_id in new_ids:
        # Already in DB (downloaded via user tracking) -- just add the junction row
        if db.get_video(vid_id):
            db.add_sound_video(sound_id, vid_id)
            log(f"Linked existing video {vid_id} to sound '{label}'")
            continue

        # Fetch full video details (placeholder username; TikTok redirects by video ID)
        try:
            details = get_video_details(vid_id, "user", cookies)
        except Exception as e:
            log(f"Could not fetch details for {vid_id}: {e}")
            continue

        author_id       = details.get("author_id")
        author_username = details.get("author_username") or "unknown"
        author_sec_uid  = details.get("author_sec_uid")
        author_display  = details.get("author_display_name") or author_username

        if not author_id:
            log(f"No author info for {vid_id}, skipping")
            continue

        # Ensure user row exists; add as enabled=0 if this is a new author
        if db.ensure_sound_user(author_id, author_username, author_sec_uid):
            log(f"Discovered untracked author @{author_username} ({author_id})")

        # Download
        if details["type"] == "photo" and details.get("image_urls"):
            log(f"Downloading photo post {vid_id} from @{author_username} "
                f"({len(details['image_urls'])} images)...")
            path      = download_photos(
                video_id=vid_id,
                username=author_username,
                image_urls=details["image_urls"],
                upload_date=details["upload_date"],
            )
            dl_result = {"file_path": path, "ytdlp_data": None} if path else None
        else:
            log(f"Downloading video {vid_id} from @{author_username}...")
            dl_result = download_video(
                video_id=vid_id,
                username=author_username,
                tiktok_id=author_id,
                display_name=author_display,
                description=details["description"],
                upload_date=details["upload_date"],
                download_date=int(time.time()),
            )

        if dl_result:
            db.add_video(
                vid_id, author_id, details["type"],
                details["description"], details["upload_date"],
                view_count=details.get("view_count"),
                like_count=details.get("like_count"),
                comment_count=details.get("comment_count"),
                share_count=details.get("share_count"),
                save_count=details.get("save_count"),
                duration=details.get("duration"),
                width=details.get("width"),
                height=details.get("height"),
                music_title=details.get("music_title"),
                music_artist=details.get("music_artist"),
                music_id=details.get("music_id"),
                raw_video_data=details.get("_raw_video_data"),
            )
            db.update_video_downloaded(vid_id, dl_result["file_path"], dl_result.get("ytdlp_data"))
            db.add_sound_video(sound_id, vid_id)
            log(f"Saved {vid_id} from @{author_username} → {dl_result['file_path']}")
        else:
            log(f"Failed to download {vid_id}")

    db.update_sound_last_checked(sound_id)
