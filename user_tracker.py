"""User tracking: discovers and downloads new videos for tracked TikTok users."""

from __future__ import annotations

import asyncio
import random
import time
from typing import Callable

import database as db
from config import (get_ms_token, get_cookies_flat, COOKIES_PATH, CHROME_EXECUTABLE,
                    DELETION_CONFIRM_THRESHOLD)
from tiktok_api import (get_user_info, get_user_videos, get_user_videos_with_stats,
                        get_video_details, UserBannedException)
from downloader import download_video, download_photos, rename_user_folder
from thumbnailer import cache_avatar, generate_thumbnail

_CONFIRM_THRESHOLD            = DELETION_CONFIRM_THRESHOLD
_BOT_SLEEP_1                  = 300  # seconds after first bot detection (5 min)
_BOT_SLEEP_2                  = 600  # seconds after second bot detection (10 min)
_PROFILE_FAIL_QUIET_THRESHOLD = 5
_PROFILE_FAIL_SLEEP           = 30   # seconds to sleep before retrying a failed profile fetch
_BOT_COOLDOWN_SLEEP           = 600  # seconds for full browser restart on session creation failure


class _BotDetectedError(Exception):
    """Raised when TikTok detects the session as a bot. Triggers a full session restart."""


def _is_bot_error(exc: Exception) -> bool:
    msg = str(exc).lower()
    return (
        "bot" in msg
        or "captcha" in msg
        or "no sessions created" in msg
        or "no valid sessions" in msg
    )


def _npost(n: int) -> str:
    return "1 post" if n == 1 else f"{n} posts"


async def process_single_user(
    user: dict,
    api,
    cookies: dict,
    fetch_videos: bool = True,
    progress: str = "",
    log: Callable[[str], None] = print,
    logd: Callable[[str], None] = print,
    set_current_user: Callable[[str | None], None] | None = None,
) -> bool:
    """Process a single user. Returns True if the profile fetch succeeded, False if it failed."""
    tiktok_id = user["tiktok_id"]

    if set_current_user:
        set_current_user(user["username"])

    try:
        log(f"Processing @{user['username']} ({progress or f'ID: {tiktok_id}'})")

        is_private: bool | None = None

        # Best sec_uid we have: from DB initially, refreshed if profile fetch returns a newer one
        sec_uid = user.get("sec_uid")

        _was_banned = user.get("account_status") == "banned"
        _profile_ok = False  # set True on any valid TikTok response (success or ban)

        for _attempt in range(2):
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
                    log(f"  Account restored: ban cleared, {_npost(restored)} re-activated")

                # Record profile field changes before overwriting stored values.
                # Skip bio detection if the account was private_blocked last run: the bio
                # is hidden from us, so a missing bio just means no access, not a real change.
                # private_accessible accounts (yellow pill) have accessible bios -- track normally.
                _bio_blocked    = user.get("privacy_status") == "private_blocked"
                _is_private_now = info.get("is_private", False)
                _field_labels   = {"username": "Username", "display_name": "Display name", "bio": "Bio"}
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
                            log(f"  Profile change: {_field_labels[_field]} updated")

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
                db.reset_profile_fail_count(tiktok_id)
                _profile_ok  = True
                username     = info["username"]
                display_name = info["display_name"] or username
                if info.get("sec_uid"):
                    sec_uid = info["sec_uid"]
                if username != user["username"]:
                    old_username = user["username"]
                    log(f"  Username changed: @{old_username} → @{username}")
                    if rename_user_folder(old_username, username):
                        db.rename_user_video_paths(tiktok_id, old_username, username)
                        log(f"  Folder renamed and DB paths updated")
                is_private = _is_private_now
                if info.get("avatar_url"):
                    if cache_avatar(tiktok_id, info["avatar_url"]) == "changed":
                        log(f"  Profile change: avatar changed")
                break  # profile fetch succeeded; exit retry loop
            except UserBannedException:
                _profile_ok = True  # TikTok responded with valid data; not a rate limit failure
                db.reset_profile_fail_count(tiktok_id)
                if _was_banned:
                    log(f"  No changes (still banned)")
                    banned_at = user.get("banned_at")
                    if (banned_at
                            and time.time() - banned_at >= 14 * 86400
                            and user.get("tracking_enabled", 1)):
                        db.set_user_tracking_enabled(tiktok_id, False)
                        log(f"  Banned for 14+ consecutive days -- tracking disabled")
                else:
                    log(f"  Account banned/removed (TikTok 10202), marking as banned")
                    db.set_user_account_status(tiktok_id, "banned")
                    n = db.ban_user_videos(tiktok_id)
                    if n:
                        log(f"  {_npost(n)} marked deleted (user_banned)")
                return _profile_ok
            except Exception as e:
                if _is_bot_error(e):
                    raise _BotDetectedError(str(e)) from e
                if _attempt == 0:
                    log(f"  Profile fetch failed, retrying in {_PROFILE_FAIL_SLEEP}s")
                    await asyncio.sleep(_PROFILE_FAIL_SLEEP)
                else:
                    _fail_count = db.increment_profile_fail_count(tiktok_id)
                    if _fail_count < _PROFILE_FAIL_QUIET_THRESHOLD:
                        log(f"  Profile fetch failed after retry: {e}")
                    else:
                        logd(f"  [{tiktok_id}] profile still failing (#{_fail_count}): {e}")
                    username     = user["username"]
                    display_name = user.get("display_name") or username

        if not fetch_videos:
            log(f"  Video fetch skipped (tracking disabled for @{username})")
            return _profile_ok

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
                logd(f"  [{tiktok_id}] {len(item_list_map)} videos via item_list (sec_uid={sec_uid})")
            except Exception as e:
                if _is_bot_error(e):
                    raise _BotDetectedError(str(e)) from e
                log(f"  Video fetch failed, trying fallback...")
                logd(f"  [{tiktok_id}] item_list error: {e}")

        # Private account with empty item_list: could be no access, or could be
        # accessible with 0 videos. Use relation & 1 (cookie holder follows them)
        # as the access signal -- accessible accounts return a full user object
        # with relation >= 1; inaccessible ones fail before reaching this point.
        if not item_list_map and is_private is True:
            if (info.get("relation") or 0) & 1:
                log(f"  Private account with no videos -- accessible (following)")
                db.update_user_privacy_status(tiktok_id, "private_accessible")
            else:
                log(f"  Private account, no accessible videos -- skipping video fetch")
                db.update_user_privacy_status(tiktok_id, "private_blocked")
            return _profile_ok

        if item_list_map:
            log(f"  {_npost(len(item_list_map))} found")
            if not _profile_ok:
                # item_list returned data so the session is responsive; the profile
                # endpoint hiccup should not count toward the rate-limit failure counter
                _profile_ok = True

        # ── Fallback: yt-dlp flat extraction ─────────────────────────────────
        # Only runs when item_list returned nothing (failed or no sec_uid).
        if not item_list_map:
            try:
                ydlp_videos = get_user_videos(tiktok_id, sec_uid=sec_uid,
                                              cookies_path=COOKIES_PATH)
                ydlp_map = {v["video_id"]: v for v in ydlp_videos}
                log(f"  {_npost(len(ydlp_map))} found")
                logd(f"  [{tiktok_id}] {len(ydlp_map)} videos via yt-dlp fallback")
            except Exception as e:
                log(f"  Video fetch failed -- skipping user")
                logd(f"  [{tiktok_id}] yt-dlp fallback error: {e}")
                if "private" in str(e).lower():
                    db.update_user_privacy_status(tiktok_id, "private_blocked")
                return _profile_ok  # both sources failed; propagate profile result

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

        # Pending-deletion videos that reappeared -- clear their counters immediately
        pending_deletion_ids = db.get_pending_deletion_video_ids(tiktok_id)
        recovered_pending    = pending_deletion_ids & remote_ids
        for vid_id in recovered_pending:
            db.clear_video_pending_deletion(vid_id)
            log(f"  Deletion check cleared: {vid_id} (back on TikTok)")

        if new_ids:
            log(f"  New: {len(new_ids)}")
        if deleted_ids:
            log(f"  Missing (checking for deletion): {len(deleted_ids)}")
        if undeleted_ids:
            log(f"  Undeleted: {len(undeleted_ids)}")
        if not (new_ids or deleted_ids or undeleted_ids or recovered_pending):
            log("  No changes.")

        for vid_id in new_ids:
            if vid_id in item_list_map:
                # Already have full details from item_list -- no page scrape needed.
                details = item_list_map[vid_id]
            else:
                # Not in item_list (very new, or beyond pagination depth).
                # Fall back to curl_cffi page scrape.
                try:
                    details = get_video_details(vid_id, username, cookies)
                except Exception as e:
                    log(f"  Could not fetch details for {vid_id}: {e}, assuming video type")
                    v = ydlp_map.get(vid_id, {})
                    details = {
                        "type":        "video",
                        "description": v.get("description", ""),
                        "upload_date": v.get("upload_date"),
                        "image_urls":  [],
                    }
            if details["type"] == "photo" and details.get("image_urls"):
                log(f"  Downloading photo post {vid_id} ({len(details['image_urls'])} images)...")
                path = download_photos(
                    video_id=vid_id,
                    username=username,
                    image_urls=details["image_urls"],
                    upload_date=details["upload_date"],
                )
                if path:
                    thumb = generate_thumbnail(vid_id, path)
                    if not thumb:
                        log(f"  Thumbnail FAILED for {vid_id} -- see [thumb] lines above")
                dl_result = {"file_path": path, "ytdlp_data": None} if path else None
            else:
                log(f"  Downloading video {vid_id}...")
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
                log(f"  Saved {vid_id} → {dl_result['file_path']}")
                db.update_video_downloaded(vid_id, dl_result["file_path"], dl_result.get("ytdlp_data"))
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

        # ── Stats upsert for already-known videos from item_list ─────────────
        # item_list returned stats for free -- update them in the DB at no extra cost.
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
        return _profile_ok

    finally:
        if set_current_user:
            set_current_user(None)


async def process_all_users(
    users: list[dict],
    log: Callable[[str], None],
    logd: Callable[[str], None],
    set_current_user: Callable[[str | None], None] | None = None,
) -> int:
    """Fetch and download new videos for all tracked users.
    Called once per main loop run. Returns the count of users successfully processed.
    """
    from TikTokApi import TikTokApi

    random.shuffle(users)
    cookies  = get_cookies_flat()
    ms_token = get_ms_token()
    total    = len(users)

    async def _make_session(api) -> bool:
        """(Re)create sessions on an existing TikTokApi instance. Returns True on success.

        Calling create_sessions() again resets the Playwright browser context without
        relaunching the browser process, so this is cheap relative to a full TikTokApi()
        instantiation. Used for the initial session only; bot detection now exits the
        TikTokApi context entirely and creates a fresh one via the outer while loop.
        """
        _last_exc: Exception | None = None
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
                # Verify the session is actually usable: TikTok sometimes completes the
                # browser handshake but returns empty sessions when it detects automation.
                # A quick make_request catches this before the user loop starts so the
                # bot-detection path triggers immediately rather than after 3 users.
                try:
                    await api.make_request(
                        url="https://www.tiktok.com/api/user/detail/",
                        params={"secUid": "", "uniqueId": ""},
                    )
                except Exception as _val_err:
                    if _is_bot_error(_val_err):
                        raise  # treated as a failed attempt; loop will retry or give up
                    # non-bot errors (empty response, unexpected shape) are fine
                return True
            except Exception as e:
                _last_exc = e
                logd(f"create_sessions attempt {_attempt + 1} error: {e}")
                if _attempt == 0:
                    log("Session creation failed, retrying in 5s...")
                    await asyncio.sleep(5)
        log(f"Session creation failed after retry: {_last_exc}")
        return False

    # The outer while loop runs one TikTokApi() context per iteration.
    # Bot detection exits the current context (closing the browser), sleeps, then
    # the next iteration opens a fresh browser. Each user gets up to 2 bot-triggered
    # restarts (_BOT_SLEEP_1 then _BOT_SLEEP_2) before being skipped.
    total_completed       = 0
    start_idx             = 0
    bot_retry_counts: dict[int, int] = {}  # {user_idx: restart_count} -- per-user bot retries
    session_create_failed = False   # True if the most recent _make_session call failed
    cooldown_pending      = False
    cooldown_sleep        = 0

    while start_idx < total:
        if cooldown_pending:
            log(f"Cooling down {cooldown_sleep // 60} min before restarting session...")
            await asyncio.sleep(cooldown_sleep)
            cooldown_pending = False
            cooldown_sleep   = 0

        async with TikTokApi() as api:
            if not await _make_session(api):
                if not session_create_failed:
                    session_create_failed = True
                    cooldown_pending      = True
                    cooldown_sleep        = _BOT_COOLDOWN_SLEEP
                    log(
                        f"Session failed -- cooling down {_BOT_COOLDOWN_SLEEP // 60} min,"
                        f" then restarting ({total_completed}/{total} users so far)"
                    )
                    continue
                log(f"Aborting loop -- session unrecoverable ({total_completed}/{total} users)")
                return total_completed

            session_create_failed = False

            completed         = 0
            break_for_restart = False

            for idx in range(start_idx, total):
                user = users[idx]
                if idx > 0:
                    await asyncio.sleep(random.uniform(2, 5))
                fetch_videos    = bool(user.get("tracking_enabled", 1))
                progress        = f"{idx + 1}/{total}"
                _user_processed = False
                try:
                    await process_single_user(
                        user, api, cookies,
                        fetch_videos=fetch_videos,
                        progress=progress,
                        log=log,
                        logd=logd,
                        set_current_user=set_current_user,
                    )
                    _user_processed = True
                except _BotDetectedError as exc:
                    logd(f"  [{user['tiktok_id']}] bot detection: {exc}")
                    _retry_count = bot_retry_counts.get(idx, 0)
                    if _retry_count < 2:
                        _sleep = _BOT_SLEEP_1 if _retry_count == 0 else _BOT_SLEEP_2
                        bot_retry_counts[idx] = _retry_count + 1
                        total_completed  += completed
                        start_idx         = idx
                        cooldown_pending  = True
                        cooldown_sleep    = _sleep
                        break_for_restart = True
                        log(
                            f"  Bot detected -- closing session,"
                            f" sleeping {_sleep // 60} min, then restarting"
                            f" @{user['username']}..."
                        )
                        break
                    else:
                        log(f"  Giving up on @{user['username']} after 2 bot retries -- skipping")
                except Exception as e:
                    log(f"Unhandled error for @{user['username']}: {e}")
                if _user_processed:
                    completed += 1

            if not break_for_restart:
                total_completed += completed
                start_idx = total  # all users processed; exit outer while

    return total_completed


async def run_single_user_with_session(
    user: dict,
    log: Callable[[str], None],
    logd: Callable[[str], None],
) -> None:
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
                logd(f"  [{user['tiktok_id']}] create_sessions attempt {_attempt + 1} error: {e}")
                if _attempt == 0:
                    log(f"Processing @{user['username']} -- session failed, retrying in 5s...")
                    await asyncio.sleep(5)
                else:
                    log(f"Processing @{user['username']} -- session failed after retry ({e}), skipping")
                    return
        await asyncio.sleep(3)
        await process_single_user(user, api, cookies, log=log, logd=logd)
