"""
Main download loop and shared state used by both the loop thread and the web server.
"""

import asyncio
import queue as _queue_module
import random
import threading
import time
from collections import deque
from datetime import datetime, timezone

import database as db
from config import get_ms_token, get_cookies_flat, COOKIES_PATH, CHROME_EXECUTABLE
from tiktok_api import get_user_info, get_user_videos, get_video_details
from downloader import download_video, download_photos, prefix_video_files, unprefix_video_files, rename_user_folder
from thumbnailer import backfill_thumbnails, cache_avatar

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

# Single-user run queue (for manual "Run" button)
_run_queue:      _queue_module.Queue = _queue_module.Queue()
_run_state_lock  = threading.Lock()
_run_state: dict = {"current": None, "queue": []}  # tiktok_ids


# Public accessors

def is_running() -> bool:
    with _state_lock:
        return loop_state["running"]


def set_next_run(iso: str) -> None:
    with _state_lock:
        loop_state["next_run"] = iso


def get_state_snapshot() -> dict:
    """Return a serialisable copy of loop_state plus run-queue state."""
    with _state_lock:
        state = {k: v for k, v in loop_state.items() if k != "logs"}
        state["logs"] = list(loop_state["logs"])
    with _run_state_lock:
        state["run_current"] = _run_state["current"]
        state["run_queue"]   = list(_run_state["queue"])
    return state


def enqueue_user_run(tiktok_id: str) -> bool:
    """Queue a single-user manual run. Returns False if already queued/running."""
    with _run_state_lock:
        if tiktok_id in _run_state["queue"] or _run_state["current"] == tiktok_id:
            return False
        _run_state["queue"].append(tiktok_id)
    _run_queue.put(tiktok_id)
    return True


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
        if sec_uid:
            try:
                return await get_user_info(api, sec_uid=sec_uid)
            except Exception:
                pass  # sec_uid lookup failed; fall back to username
        return await get_user_info(api, username=username)


async def _process_single_user(user: dict, cookies: dict):
    tiktok_id = user["tiktok_id"]

    with _state_lock:
        loop_state["current_user"] = user["username"]

    try:
        _log(f"Processing @{user['username']} (ID: {tiktok_id})")

        is_private: bool | None = None

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
                verified=int(info.get("verified", False)),
                avatar_url=info.get("avatar_url"),
                raw_user_data=info.get("_raw_user_data"),
            )
            username     = info["username"]
            display_name = info["display_name"] or username
            if username != user["username"]:
                old_username = user["username"]
                _log(f"  Username changed: @{old_username} → @{username}")
                if rename_user_folder(old_username, username):
                    db.rename_user_video_paths(tiktok_id, old_username, username)
                    _log(f"  Folder renamed and DB paths updated")
            is_private = info.get("is_private", False)
            if info.get("avatar_url"):
                cache_avatar(tiktok_id, info["avatar_url"])
        except Exception as e:
            _log(f"  Failed to fetch profile info: {e}")
            username     = user["username"]
            display_name = user.get("display_name") or username

        try:
            remote_videos = get_user_videos(tiktok_id, COOKIES_PATH)
            _log(f"  {len(remote_videos)} videos visible on TikTok")
            if is_private is True:
                db.update_user_privacy_status(tiktok_id, "private_accessible")
            elif is_private is False:
                db.update_user_privacy_status(tiktok_id, "public")
            # if is_private is None (profile fetch failed), leave privacy_status unchanged
            if user.get("account_status") == "banned":
                db.set_user_account_status(tiktok_id, "active")
                _log("  Account status cleared (videos accessible)")
        except Exception as e:
            _log(f"  Failed to fetch video list: {e}")
            if "private" in str(e).lower():
                db.update_user_privacy_status(tiktok_id, "private_blocked")
            return

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
                dl_result = {"file_path": path, "ytdlp_data": None} if path else None
            else:
                _log(f"  Downloading video {vid_id}...")
                dl_result = download_video(
                    video_id=vid_id,
                    username=username,
                    tiktok_id=tiktok_id,
                    display_name=display_name,
                    description=details["description"],
                    upload_date=details["upload_date"],
                    download_date=int(time.time()),
                )
            if dl_result:
                db.add_video(
                    vid_id, tiktok_id, details["type"],
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
                    raw_video_data=details.get("_raw_video_data"),
                )
                _log(f"  Saved {vid_id} → {dl_result['file_path']}")
                db.update_video_downloaded(vid_id, dl_result["file_path"], dl_result.get("ytdlp_data"))
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

    finally:
        with _state_lock:
            loop_state["current_user"] = None


async def _process_all_users(users: list[dict]):
    cookies = get_cookies_flat()

    for idx, user in enumerate(users):
        if idx > 0:
            await asyncio.sleep(random.uniform(2, 5))
        await _process_single_user(user, cookies)


def _run_worker():
    while True:
        tiktok_id = _run_queue.get()
        with _run_state_lock:
            if tiktok_id in _run_state["queue"]:
                _run_state["queue"].remove(tiktok_id)
            _run_state["current"] = tiktok_id
        try:
            user = db.get_user(tiktok_id)
            if user:
                cookies = get_cookies_flat()
                asyncio.run(_process_single_user(user, cookies))
            else:
                _log(f"Manual run: user {tiktok_id} not found in DB")
        except Exception as e:
            _log(f"Manual run error for {tiktok_id}: {e}")
        finally:
            with _run_state_lock:
                _run_state["current"] = None
            _run_queue.task_done()


threading.Thread(target=_run_worker, daemon=True, name="run-worker").start()
threading.Thread(target=backfill_thumbnails, daemon=True, name="thumb-backfill").start()


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
