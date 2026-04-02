"""
Main download loop and shared state used by both the loop thread and the web server.
"""

import asyncio
import random
import threading
import time
from collections import deque
from datetime import datetime, timezone

import database as db
from config import get_ms_token, get_cookies_flat, COOKIES_PATH, CHROME_EXECUTABLE
from tiktok_api import get_user_info, get_user_videos, get_video_details
from downloader import download_video, download_photos, prefix_video_files, unprefix_video_files, rename_user_folder

# Shared state

loop_state = {
    "running":        False,
    "last_run_start": None,
    "last_run_end":   None,
    "next_run":       None,
    "current_user":   None,
    "logs":           deque(maxlen=1000),
}
_state_lock        = threading.Lock()
trigger_event      = threading.Event()
_CONFIRM_THRESHOLD = 3  # loops a negative change must persist before it's made official


# Public accessors

def is_running() -> bool:
    with _state_lock:
        return loop_state["running"]


def set_next_run(iso: str) -> None:
    with _state_lock:
        loop_state["next_run"] = iso


def get_state_snapshot() -> dict:
    """Return a serialisable copy of loop_state."""
    with _state_lock:
        state = {k: v for k, v in loop_state.items() if k != "logs"}
        state["logs"] = list(loop_state["logs"])
    return state


# Logging

def _log(msg: str):
    ts   = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    with _state_lock:
        loop_state["logs"].append(line)


# Core async logic

async def _fetch_user_info(username: str, sec_uid: str | None = None) -> dict:
    """Open a fresh TikTokApi session, fetch profile info, and close it.
    Uses sec_uid when available (survives username changes).
    Falls back to username for accounts not yet populated with sec_uid.
    """
    from TikTokApi import TikTokApi

    ms_token = get_ms_token()
    async with TikTokApi() as api:
        await api.create_sessions(
            ms_tokens=[ms_token] if ms_token else [],
            num_sessions=1,
            sleep_after=3,
            executable_path=CHROME_EXECUTABLE,
        )
        return await get_user_info(api, sec_uid=sec_uid, username=username if not sec_uid else None)


async def _process_all_users(users: list[dict]):
    cookies = get_cookies_flat()

    for idx, user in enumerate(users):
        if idx > 0:
            await asyncio.sleep(random.uniform(2, 5))
        tiktok_id = user["tiktok_id"]

        with _state_lock:
            loop_state["current_user"] = user["username"]

        _log(f"Processing @{user['username']} (ID: {tiktok_id})")

        try:
            info = await _fetch_user_info(user["username"], sec_uid=user.get("sec_uid"))
            db.update_user_info(
                tiktok_id,
                info["username"],
                info["display_name"],
                info["bio"],
                info["follower_count"],
                info["following_count"],
                info["video_count"],
                sec_uid=info.get("sec_uid"),
            )
            username     = info["username"]
            display_name = info["display_name"] or username
            if username != user["username"]:
                old_username = user["username"]
                _log(f"  Username changed: @{old_username} → @{username}")
                if rename_user_folder(old_username, username):
                    db.rename_user_video_paths(tiktok_id, old_username, username)
                    _log(f"  Folder renamed and DB paths updated")

            # Account status: positive changes (banned → active) are immediate;
            # negative changes (active → banned) require _CONFIRM_THRESHOLD loops.
            new_status     = info["account_status"]
            current_status = user.get("account_status", "active")
            if new_status == "active":
                if current_status != "active":
                    db.set_user_account_status(tiktok_id, "active")
                    _log(f"  Account status: {current_status} → active")
                db.clear_user_pending_ban(tiktok_id)
            elif current_status != "banned":
                count = db.increment_user_pending_ban(tiktok_id)
                if count >= _CONFIRM_THRESHOLD:
                    db.set_user_account_status(tiktok_id, "banned")
                    db.clear_user_pending_ban(tiktok_id)
                    _log(f"  Account banned (confirmed {_CONFIRM_THRESHOLD}/{_CONFIRM_THRESHOLD})")
                else:
                    _log(f"  Account possibly banned ({count}/{_CONFIRM_THRESHOLD})")
        except Exception as e:
            _log(f"  Failed to fetch profile info: {e}")
            username     = user["username"]
            display_name = user.get("display_name") or username

        try:
            remote_videos = get_user_videos(tiktok_id, COOKIES_PATH)
            _log(f"  {len(remote_videos)} videos visible on TikTok")
        except Exception as e:
            _log(f"  Failed to fetch video list: {e}")
            continue

        remote_ids            = {v["video_id"] for v in remote_videos}
        known_ids, active_ids = db.get_video_id_sets(tiktok_id)

        new_ids       = remote_ids - known_ids
        deleted_ids   = active_ids - remote_ids
        undeleted_ids = (known_ids - active_ids) & remote_ids

        # Pending-deletion videos that reappeared — clear their counters immediately
        pending_deletion_ids = db.get_pending_deletion_video_ids(tiktok_id)
        recovered_pending    = pending_deletion_ids & remote_ids
        for vid_id in recovered_pending:
            db.clear_video_pending_deletion(vid_id)
            _log(f"  Deletion check cleared: {vid_id} (back on TikTok)")

        if new_ids:
            _log(f"  New: {len(new_ids)}")
        if deleted_ids:
            _log(f"  Missing (checking for deletion): {len(deleted_ids)}")
        if undeleted_ids:
            _log(f"  Undeleted: {len(undeleted_ids)}")
        if not (new_ids or deleted_ids or undeleted_ids or recovered_pending):
            _log("  No changes.")

        video_map = {v["video_id"]: v for v in remote_videos}
        for vid_id in new_ids:
            v = video_map[vid_id]
            try:
                details = get_video_details(vid_id, username, cookies)
            except Exception as e:
                _log(f"  Could not fetch details for {vid_id}: {e}, assuming video type")
                details = {
                    "type":        "video",
                    "description": v["description"],
                    "upload_date": v["upload_date"],
                    "image_urls":  [],
                }
            if details["type"] == "photo" and details.get("image_urls"):
                _log(f"  Downloading photo post {vid_id} ({len(details['image_urls'])} images)...")
                path = download_photos(
                    video_id=vid_id,
                    username=username,
                    image_urls=details["image_urls"],
                    upload_date=details["upload_date"],
                )
            else:
                _log(f"  Downloading video {vid_id}...")
                path = download_video(
                    video_id=vid_id,
                    username=username,
                    tiktok_id=tiktok_id,
                    display_name=display_name,
                    description=details["description"],
                    upload_date=details["upload_date"],
                    download_date=int(time.time()),
                )
            if path:
                db.add_video(
                    vid_id, tiktok_id, details["type"],
                    details["description"], details["upload_date"]
                )
                _log(f"  Saved {vid_id} → {path}")
                db.update_video_downloaded(vid_id, path)
            else:
                _log(f"  Failed to download {vid_id}")

        for vid_id in deleted_ids:
            count = db.increment_video_pending_deletion(vid_id)
            if count >= _CONFIRM_THRESHOLD:
                db.mark_video_deleted(vid_id)
                new_path = prefix_video_files(vid_id, username)
                if new_path:
                    db.update_video_file_path(vid_id, new_path)
                _log(f"  Marked deleted (confirmed {_CONFIRM_THRESHOLD}/{_CONFIRM_THRESHOLD}): {vid_id}")
            else:
                _log(f"  Possibly deleted ({count}/{_CONFIRM_THRESHOLD}): {vid_id}")

        for vid_id in undeleted_ids:
            db.mark_video_undeleted(vid_id)
            new_path = unprefix_video_files(vid_id, username)
            if new_path:
                db.update_video_file_path(vid_id, new_path)
            _log(f"  Marked undeleted: {vid_id}")

    with _state_lock:
        loop_state["current_user"] = None


# Public entry point

def run_loop():
    with _state_lock:
        loop_state["running"]        = True
        loop_state["last_run_start"] = datetime.now(timezone.utc).isoformat()

    _log("=== Loop started ===")
    users = db.get_all_users()

    if not users:
        _log("No users configured — nothing to do.")
    else:
        try:
            asyncio.run(_process_all_users(users))
        except Exception as e:
            _log(f"Unhandled loop error: {e}")

    _log("=== Loop complete ===")
    with _state_lock:
        loop_state["running"]      = False
        loop_state["last_run_end"] = datetime.now(timezone.utc).isoformat()
