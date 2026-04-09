"""
Download loops (user and sound) and shared state used by both loop threads and the web server.
"""

import asyncio
import json
import os
import queue as _queue_module
import random
import threading
import time
from collections import deque
from datetime import datetime, timezone

import database as db
from config import get_ms_token, get_cookies_flat, COOKIES_PATH, CHROME_EXECUTABLE, DATA_DIR, DELETION_CONFIRM_THRESHOLD
from tiktok_api import (get_user_info, get_user_videos, get_user_videos_with_stats,
                         get_video_details, UserBannedException)
from downloader import download_video, download_photos, rename_user_folder
from thumbnailer import backfill_thumbnails, cache_avatar, generate_thumbnail
import photo_converter as _photo_converter  # noqa: F401 — starts conversion thread on import
from sound_tracker import process_all_sounds, process_sound

LOOP_STATE_PATH = os.path.join(DATA_DIR, "loop_state.json")

_CONFIRM_THRESHOLD    = DELETION_CONFIRM_THRESHOLD  # loops a negative change must persist before it's made official
_MAX_BOT_FAILURES     = 3  # consecutive post-reset bot detections before aborting the run


class _BotDetectedError(Exception):
    """Raised when TikTok detects the session as a bot. Triggers a session reset in the loop."""


def _is_bot_error(exc: Exception) -> bool:
    msg = str(exc).lower()
    return (
        "bot" in msg
        or "captcha" in msg
        or "no sessions created" in msg
        or "no valid sessions" in msg
    )


def _load_loop_state() -> dict:
    try:
        with open(LOOP_STATE_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return {}


def _save_loop_state() -> None:
    with _user_state_lock:
        data = {
            "user_last_run_end":       user_loop_state["last_run_end"],
            "user_last_duration_secs": user_loop_state["last_run_duration_secs"],
            "user_last_new_videos":    user_loop_state["last_new_videos"],
        }
    with _sound_state_lock:
        data.update({
            "sound_last_run_end":       sound_loop_state["last_run_end"],
            "sound_last_duration_secs": sound_loop_state["last_run_duration_secs"],
            "sound_last_new_videos":    sound_loop_state["last_new_videos"],
        })
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(LOOP_STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f)


# ── User loop state ───────────────────────────────────────────────────────────

_persisted = _load_loop_state()

user_loop_state = {
    "running":                False,
    "last_run_end":           _persisted.get("user_last_run_end"),
    "last_run_duration_secs": _persisted.get("user_last_duration_secs"),
    "last_new_videos":        _persisted.get("user_last_new_videos"),
    "next_run":               None,
    "current_user":           None,
    "logs":                   deque(maxlen=1000),
}
_user_state_lock = threading.Lock()

trigger_user_event = threading.Event()

# Set to True when loop interval settings change; cleared by the scheduler thread.
_user_reschedule_flag  = False
_user_rflag_lock       = threading.Lock()

# ── Sound loop state ──────────────────────────────────────────────────────────

sound_loop_state = {
    "running":                False,
    "last_run_end":           _persisted.get("sound_last_run_end"),
    "last_run_duration_secs": _persisted.get("sound_last_duration_secs"),
    "last_new_videos":        _persisted.get("sound_last_new_videos"),
    "next_run":               None,
}
_sound_state_lock = threading.Lock()

trigger_sound_event = threading.Event()

_sound_reschedule_flag = False
_sound_rflag_lock      = threading.Lock()

# ── Single-user run queue ─────────────────────────────────────────────────────

_run_queue:      _queue_module.Queue = _queue_module.Queue()
_run_state_lock  = threading.Lock()
_run_state: dict = {"current": None, "queue": []}

# ── Single-sound run queue ────────────────────────────────────────────────────

_sound_run_queue:      _queue_module.Queue = _queue_module.Queue()
_sound_run_state_lock  = threading.Lock()
_sound_run_state: dict = {"current": None, "queue": []}


# ── Public accessors ──────────────────────────────────────────────────────────

def is_user_loop_running() -> bool:
    with _user_state_lock:
        return user_loop_state["running"]

# Backward-compat alias (used in older web.py import)
is_running = is_user_loop_running


def is_sound_loop_running() -> bool:
    with _sound_state_lock:
        return sound_loop_state["running"]


def set_user_loop_next_run(iso: str | None) -> None:
    with _user_state_lock:
        user_loop_state["next_run"] = iso

# Backward-compat alias
set_next_run = set_user_loop_next_run


def set_sound_loop_next_run(iso: str | None) -> None:
    with _sound_state_lock:
        sound_loop_state["next_run"] = iso


def get_state_snapshot() -> dict:
    """Return a serialisable snapshot of both loop states plus run-queue state."""
    with _user_state_lock:
        state = {
            "user_loop_running":            user_loop_state["running"],
            "user_loop_last_end":           user_loop_state["last_run_end"],
            "user_loop_last_duration_secs": user_loop_state["last_run_duration_secs"],
            "user_loop_last_new_videos":    user_loop_state["last_new_videos"],
            "user_loop_next":               user_loop_state["next_run"],
            "user_loop_current_user":       user_loop_state["current_user"],
            "logs":                         list(user_loop_state["logs"]),
        }
    with _sound_state_lock:
        state["sound_loop_running"]            = sound_loop_state["running"]
        state["sound_loop_last_end"]           = sound_loop_state["last_run_end"]
        state["sound_loop_last_duration_secs"] = sound_loop_state["last_run_duration_secs"]
        state["sound_loop_last_new_videos"]    = sound_loop_state["last_new_videos"]
        state["sound_loop_next"]               = sound_loop_state["next_run"]
    with _run_state_lock:
        state["run_current"] = _run_state["current"]
        state["run_queue"]   = list(_run_state["queue"])
    with _sound_run_state_lock:
        state["sound_run_current"] = _sound_run_state["current"]
        state["sound_run_queue"]   = list(_sound_run_state["queue"])
    return state


def reschedule_user_loop() -> None:
    """Wake the user scheduler to re-read its interval from DB without running the loop."""
    global _user_reschedule_flag
    with _user_rflag_lock:
        _user_reschedule_flag = True
    trigger_user_event.set()


def check_and_clear_user_reschedule() -> bool:
    global _user_reschedule_flag
    with _user_rflag_lock:
        val = _user_reschedule_flag
        _user_reschedule_flag = False
    return val


def reschedule_sound_loop() -> None:
    """Wake the sound scheduler to re-read its interval from DB without running the loop."""
    global _sound_reschedule_flag
    with _sound_rflag_lock:
        _sound_reschedule_flag = True
    trigger_sound_event.set()


def check_and_clear_sound_reschedule() -> bool:
    global _sound_reschedule_flag
    with _sound_rflag_lock:
        val = _sound_reschedule_flag
        _sound_reschedule_flag = False
    return val


def enqueue_user_run(tiktok_id: str) -> bool:
    """Queue a single-user manual run. Returns False if already queued/running."""
    with _run_state_lock:
        if tiktok_id in _run_state["queue"] or _run_state["current"] == tiktok_id:
            return False
        _run_state["queue"].append(tiktok_id)
    _run_queue.put(tiktok_id)
    return True


def enqueue_sound_run(sound_id: str) -> bool:
    """Queue a single-sound manual run. Returns False if already queued/running."""
    with _sound_run_state_lock:
        if sound_id in _sound_run_state["queue"] or _sound_run_state["current"] == sound_id:
            return False
        _sound_run_state["queue"].append(sound_id)
    _sound_run_queue.put(sound_id)
    return True


# ── Logging ───────────────────────────────────────────────────────────────────

def _log(msg: str):
    """Log to both the terminal and the in-app log shown in the UI."""
    ts   = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    with _user_state_lock:
        user_loop_state["logs"].append(line)


def _logd(msg: str):
    """Log to the terminal only — implementation detail not shown in the UI."""
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}")


# ── Core async logic ──────────────────────────────────────────────────────────

async def _process_single_user(user: dict, api, cookies: dict,
                               fetch_videos: bool = True):
    tiktok_id = user["tiktok_id"]

    with _user_state_lock:
        user_loop_state["current_user"] = user["username"]

    try:
        _log(f"Processing @{user['username']} (ID: {tiktok_id})")

        is_private: bool | None = None

        # Best sec_uid we have: from DB initially, refreshed if profile fetch returns a newer one
        sec_uid = user.get("sec_uid")

        _was_banned = user.get("account_status") == "banned"

        try:
            # If sec_uid is known, resolve purely by secUid (username not needed).
            # For new users (no sec_uid yet), fall back to username lookup.
            info = await get_user_info(
                api,
                username=None if sec_uid else user["username"],
                sec_uid=sec_uid,
            )

            # Account recovered from a ban: restore all ban-deleted videos.
            if _was_banned:
                restored = db.restore_banned_videos(tiktok_id)
                db.set_user_account_status(tiktok_id, "active")
                _log(f"  Account restored: ban cleared, {restored} video(s) re-activated")

            # Record profile field changes before overwriting stored values.
            # Skip bio detection if the account was private_blocked last run: the bio
            # is hidden from us, so a missing bio just means no access, not a real change.
            # private_accessible accounts (yellow pill) have accessible bios — track normally.
            _bio_blocked = user.get("privacy_status") == "private_blocked"
            _is_private_now = info.get("is_private", False)
            _field_labels = {"username": "Username", "display_name": "Display name", "bio": "Bio"}
            _profile_fields = {
                "username":     (user.get("username"),     info.get("username")),
                "display_name": (user.get("display_name"), info.get("display_name")),
                "bio":          (user.get("bio"),          info.get("bio")),
            }
            for _field, (_old, _new) in _profile_fields.items():
                if _field == "bio" and _bio_blocked:
                    continue
                if _new is not None and _new != _old:
                    db.record_profile_change(tiktok_id, _field, _old)
                    if _field != "username":  # username gets its own log line below
                        _log(f"  Profile change: {_field_labels[_field]} updated")

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
            if info.get("sec_uid"):
                sec_uid = info["sec_uid"]
            if username != user["username"]:
                old_username = user["username"]
                _log(f"  Username changed: @{old_username} → @{username}")
                if rename_user_folder(old_username, username):
                    db.rename_user_video_paths(tiktok_id, old_username, username)
                    _log(f"  Folder renamed and DB paths updated")
            is_private = _is_private_now
            if info.get("avatar_url"):
                if cache_avatar(tiktok_id, info["avatar_url"]) == "changed":
                    _log(f"  Profile change: avatar changed")
        except UserBannedException:
            if _was_banned:
                _log(f"  No changes (still banned)")
                banned_at = user.get("banned_at")
                if (banned_at
                        and time.time() - banned_at >= 14 * 86400
                        and user.get("tracking_enabled", 1)):
                    db.set_user_tracking_enabled(tiktok_id, False)
                    _log(f"  Banned for 14+ consecutive days — tracking disabled")
            else:
                _log(f"  Account banned/removed (TikTok 10202), marking as banned")
                db.set_user_account_status(tiktok_id, "banned")
                n = db.ban_user_videos(tiktok_id)
                if n:
                    _log(f"  {n} active video(s) marked deleted (user_banned)")
            return
        except Exception as e:
            if _is_bot_error(e):
                raise _BotDetectedError(str(e)) from e
            _log(f"  Failed to fetch profile info: {e}")
            username     = user["username"]
            display_name = user.get("display_name") or username

        if not fetch_videos:
            _log(f"  Video fetch skipped (tracking disabled for @{username})")
            return

        # ── Primary: item_list (has stats, paginated with inter-page delay) ──
        # sec_uid is required: without it the library calls self.info() to
        # resolve it, making a redundant round-trip that can return 0 results.
        item_list_map: dict = {}
        ydlp_map:      dict = {}

        if sec_uid:
            try:
                item_list_videos = await get_user_videos_with_stats(
                    api, sec_uid=sec_uid
                )
                item_list_map = {v["video_id"]: v for v in item_list_videos}
                _log(f"  {len(item_list_map)} videos found")
                _logd(f"  [{tiktok_id}] {len(item_list_map)} videos via item_list (sec_uid={sec_uid})")
            except Exception as e:
                if _is_bot_error(e):
                    raise _BotDetectedError(str(e)) from e
                _log(f"  Video fetch failed, trying fallback...")
                _logd(f"  [{tiktok_id}] item_list error: {e}")

        # Private account with empty item_list → no access. yt-dlp will fail
        # identically ("account is private"), so skip it and mark accordingly.
        if not item_list_map and is_private is True:
            _log(f"  Private account, no accessible videos — skipping video fetch")
            db.update_user_privacy_status(tiktok_id, "private_blocked")
            return

        # ── Fallback: yt-dlp flat extraction ─────────────────────────────────
        # Only runs when item_list returned nothing (failed or no sec_uid).
        if not item_list_map:
            try:
                ydlp_videos = get_user_videos(tiktok_id, sec_uid=sec_uid,
                                              cookies_path=COOKIES_PATH)
                ydlp_map = {v["video_id"]: v for v in ydlp_videos}
                _log(f"  {len(ydlp_map)} videos found")
                _logd(f"  [{tiktok_id}] {len(ydlp_map)} videos via yt-dlp fallback")
            except Exception as e:
                _log(f"  Video fetch failed — skipping user")
                _logd(f"  [{tiktok_id}] yt-dlp fallback error: {e}")
                if "private" in str(e).lower():
                    db.update_user_privacy_status(tiktok_id, "private_blocked")
                return  # both sources failed

        remote_ids = set(item_list_map) | set(ydlp_map)

        if is_private is True:
            db.update_user_privacy_status(tiktok_id, "private_accessible")
        elif is_private is False:
            db.update_user_privacy_status(tiktok_id, "public")
        # if is_private is None (profile fetch failed), leave privacy_status unchanged

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

        for vid_id in new_ids:
            if vid_id in item_list_map:
                # Already have full details from item_list — no page scrape needed.
                details = item_list_map[vid_id]
            else:
                # Not in item_list (very new, or beyond pagination depth).
                # Fall back to curl_cffi page scrape.
                try:
                    details = get_video_details(vid_id, username, cookies)
                except Exception as e:
                    _log(f"  Could not fetch details for {vid_id}: {e}, assuming video type")
                    v = ydlp_map.get(vid_id, {})
                    details = {
                        "type":        "video",
                        "description": v.get("description", ""),
                        "upload_date": v.get("upload_date"),
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
                if path:
                    thumb = generate_thumbnail(vid_id, path)
                    if thumb:
                        _log(f"  Thumbnail OK: {os.path.basename(thumb)}")
                    else:
                        _log(f"  Thumbnail FAILED for {vid_id} — see [thumb] lines above")
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
                    music_id=details.get("music_id"),
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
                _log(f"  Marked deleted (confirmed {_CONFIRM_THRESHOLD}/{_CONFIRM_THRESHOLD}): {vid_id}")
            else:
                _log(f"  Possibly deleted ({count}/{_CONFIRM_THRESHOLD}): {vid_id}")

        for vid_id in undeleted_ids:
            db.mark_video_undeleted(vid_id)
            _log(f"  Marked undeleted: {vid_id}")

        # ── Stats upsert for already-known videos from item_list ─────────────
        # item_list returned stats for free — update them in the DB at no extra cost.
        # Uses COALESCE to avoid overwriting with None.
        for vid_id, details in item_list_map.items():
            if vid_id in known_ids and vid_id not in new_ids:
                db.update_video_stats_loop(
                    vid_id,
                    details.get("view_count"),
                    details.get("like_count"),
                    details.get("comment_count"),
                    details.get("share_count"),
                    details.get("save_count"),
                )

    finally:
        with _user_state_lock:
            user_loop_state["current_user"] = None


async def _process_all_users(users: list[dict]):
    from TikTokApi import TikTokApi

    cookies  = get_cookies_flat()
    ms_token = get_ms_token()

    async def _make_session(api) -> bool:
        """(Re)create sessions on an existing TikTokApi instance. Returns True on success.

        Calling create_sessions() again resets the Playwright browser context without
        relaunching the browser process, so this is cheap relative to a full TikTokApi()
        instantiation. Used both for the initial session and after bot detection.
        """
        for _attempt in range(2):
            try:
                await api.create_sessions(
                    ms_tokens=[ms_token] if ms_token else [],
                    num_sessions=1,
                    sleep_after=3,
                    executable_path=CHROME_EXECUTABLE,
                    cookies=[cookies] if cookies else None,
                )
                await asyncio.sleep(3)
                return True
            except Exception as e:
                _logd(f"create_sessions attempt {_attempt + 1} error: {e}")
                if _attempt == 0:
                    _log("Session creation failed, retrying in 5s...")
                    await asyncio.sleep(5)
        _log("Session creation failed after retry")
        return False

    # One browser process for the whole run. On bot detection, create_sessions() is
    # called again for a fresh session — no new browser launch needed.
    async with TikTokApi() as api:
        if not await _make_session(api):
            _log("Aborting loop — could not create initial session")
            return

        consecutive_bot_failures = 0

        for idx, user in enumerate(users):
            if idx > 0:
                await asyncio.sleep(random.uniform(2, 5))
            fetch_videos = bool(user.get("tracking_enabled", 1))
            try:
                await _process_single_user(user, api, cookies, fetch_videos=fetch_videos)
                consecutive_bot_failures = 0
            except _BotDetectedError as exc:
                _logd(f"  [{user['tiktok_id']}] bot detection: {exc}")
                _log(f"  Bot detected — resetting session and retrying @{user['username']}")
                if not await _make_session(api):
                    _log("Aborting loop — session reset failed")
                    return
                try:
                    await _process_single_user(user, api, cookies, fetch_videos=fetch_videos)
                    consecutive_bot_failures = 0
                except _BotDetectedError:
                    consecutive_bot_failures += 1
                    _log(f"  Still bot-detected after reset — skipping @{user['username']}")
                    if consecutive_bot_failures >= _MAX_BOT_FAILURES:
                        _log(f"Aborting loop — {_MAX_BOT_FAILURES} consecutive bot detections, session unrecoverable")
                        return
                except Exception as exc2:
                    consecutive_bot_failures = 0
                    _log(f"  @{user['username']} failed after session reset: {exc2}")
            except Exception as e:
                consecutive_bot_failures = 0
                _log(f"Unhandled error for @{user['username']}: {e}")


# ── Manual run workers ────────────────────────────────────────────────────────

async def _run_single_user_with_session(user: dict):
    """Create a dedicated session and process a single user. Used by the manual run worker."""
    from TikTokApi import TikTokApi

    cookies  = get_cookies_flat()
    ms_token = get_ms_token()

    async with TikTokApi() as api:
        for _attempt in range(2):
            try:
                await api.create_sessions(
                    ms_tokens=[ms_token] if ms_token else [],
                    num_sessions=1,
                    sleep_after=3,
                    executable_path=CHROME_EXECUTABLE,
                    cookies=[cookies] if cookies else None,
                )
                break
            except Exception as e:
                _logd(f"  [{user['tiktok_id']}] create_sessions attempt {_attempt + 1} error: {e}")
                if _attempt == 0:
                    _log(f"Processing @{user['username']} — session failed, retrying in 5s...")
                    await asyncio.sleep(5)
                else:
                    _log(f"Processing @{user['username']} — session failed after retry, skipping")
                    return
        await asyncio.sleep(3)
        await _process_single_user(user, api, cookies)


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
                label = f"@{user['username']}"
                _log(f"=== Manual user run started: {label} ===")
                asyncio.run(_run_single_user_with_session(user))
                _log(f"=== Manual user run complete: {label} ===")
            else:
                _log(f"Manual run: user {tiktok_id} not found in DB")
        except Exception as e:
            _log(f"Manual run error for {tiktok_id}: {e}")
        finally:
            with _run_state_lock:
                _run_state["current"] = None
            _run_queue.task_done()


def _sound_run_worker():
    while True:
        sound_id = _sound_run_queue.get()
        with _sound_run_state_lock:
            if sound_id in _sound_run_state["queue"]:
                _sound_run_state["queue"].remove(sound_id)
            _sound_run_state["current"] = sound_id
        try:
            sound = db.get_sound(sound_id)
            if sound:
                label = sound.get("label") or sound_id
                _log(f"=== Manual sound run started: {label} ===")
                asyncio.run(process_sound(sound, _log))
                _log(f"=== Manual sound run complete: {label} ===")
            else:
                _log(f"Manual sound run: {sound_id} not found in DB")
        except Exception as e:
            _log(f"Manual sound run error for {sound_id}: {e}")
        finally:
            with _sound_run_state_lock:
                _sound_run_state["current"] = None
            _sound_run_queue.task_done()


threading.Thread(target=_run_worker,        daemon=True, name="run-worker").start()
threading.Thread(target=_sound_run_worker,  daemon=True, name="sound-run-worker").start()
threading.Thread(target=backfill_thumbnails, daemon=True, name="thumb-backfill").start()


# ── Public entry points ───────────────────────────────────────────────────────

def run_user_loop():
    """Process all enabled tracked users. Called by the user loop scheduler thread."""
    with _user_state_lock:
        user_loop_state["running"] = True
    _loop_start = time.monotonic()
    _videos_before = db.count_downloaded_videos()

    _log("=== User loop started ===")
    users = db.get_all_users()

    if not users:
        _log("No users configured — nothing to do.")
    else:
        try:
            asyncio.run(_process_all_users(users))
        except Exception as e:
            _log(f"Unhandled user loop error: {e}")

    _log("=== User loop complete ===")
    last_run_end = datetime.now(timezone.utc).isoformat()
    duration_secs = round(time.monotonic() - _loop_start)
    new_videos = db.count_downloaded_videos() - _videos_before
    with _user_state_lock:
        user_loop_state["running"]                = False
        user_loop_state["last_run_end"]           = last_run_end
        user_loop_state["last_run_duration_secs"] = duration_secs
        user_loop_state["last_new_videos"]        = new_videos
    _save_loop_state()


def run_sound_loop():
    """Process all tracked sounds. Called by the sound loop scheduler thread."""
    with _sound_state_lock:
        sound_loop_state["running"] = True
    _loop_start = time.monotonic()
    _videos_before = db.count_downloaded_videos()

    _log("=== Sound loop started ===")
    try:
        asyncio.run(process_all_sounds(_log))
    except Exception as e:
        _log(f"Unhandled sound loop error: {e}")

    _log("=== Sound loop complete ===")
    last_run_end = datetime.now(timezone.utc).isoformat()
    duration_secs = round(time.monotonic() - _loop_start)
    new_videos = db.count_downloaded_videos() - _videos_before
    with _sound_state_lock:
        sound_loop_state["running"]                = False
        sound_loop_state["last_run_end"]           = last_run_end
        sound_loop_state["last_run_duration_secs"] = duration_secs
        sound_loop_state["last_new_videos"]        = new_videos
    _save_loop_state()
