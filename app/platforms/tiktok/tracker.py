"""TikTok tracking: users and sounds."""

from __future__ import annotations

import asyncio
import random
import threading
import time
from typing import Callable

from platforms.tiktok import database as db
from platforms.tiktok.config import (
    get_ms_token, get_cookies_flat, COOKIES_PATH, CHROME_EXECUTABLE,
    SESSION_GAP_MEAN_SECS,
    HIGH_PRIORITY_CHECK_HOURS, ACTIVE_CHECK_HOURS,
)
from platforms.tiktok.api import (
    get_user_info, get_user_videos, get_user_videos_with_stats,
    fetch_sound_video_ids, get_video_details,
    UserBannedException, UserPrivateException, UserBlockedException,
)
from downloader import download_video, download_photos, rename_creator_folder
from thumbnailer import cache_avatar, generate_thumbnail

_BOT_SLEEP_1                  = 300  # seconds after first bot detection (5 min)
_BOT_SLEEP_2                  = 600  # seconds after second bot detection (10 min)
_PROFILE_FAIL_QUIET_THRESHOLD = 5
_PROFILE_FAIL_SLEEP           = 30   # seconds to sleep before retrying a failed profile fetch
_BOT_COOLDOWN_SLEEP           = 600  # seconds for full browser restart on session creation failure
_SESSION_GAP_MIN_SECS         = 15   # minimum inter-user gap within a session (seconds)
_LARGE_DELETION_THRESHOLD     = 10   # first-pass missing count that triggers an isolated full re-scan


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


# ── User tracking ─────────────────────────────────────────────────────────────

async def process_single_user(
    user: dict,
    api,
    cookies: dict,
    fetch_videos: bool = True,
    mode: str = "full",
    progress: str = "",
    log: Callable[[str], None] = print,
    logd: Callable[[str], None] = print,
    set_current_user: Callable[[str | None], None] | None = None,
    stop_event: threading.Event | None = None,
) -> bool:
    """Process a single user. Returns True if the profile fetch succeeded, False if it failed."""
    tiktok_id = user["tiktok_id"]

    if set_current_user:
        set_current_user(user["username"])

    try:
        _mode_tag = "[Quick]" if mode == "quick" else "[Full] "
        log(f"{_mode_tag} Processing @{user['username']} ({progress or f'ID: {tiktok_id}'})")

        is_private: bool | None = None

        # Best sec_uid we have: from DB initially, refreshed if profile fetch returns a newer one
        sec_uid = user.get("sec_uid")

        _was_banned           = user.get("account_status") == "banned"
        _profile_ok           = False  # set True on any valid TikTok response (success or ban)
        _deletion_detected    = False  # set True in full mode when deletion candidates are found
        _large_deletion_spike = False  # set True when first-pass missing count >= threshold
        curr_ordered: list    = []     # ordered video IDs from this fetch (item_list only)

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
                    db.set_user_tracking_enabled(tiktok_id, True)
                    log(f"  Account restored: ban cleared, {_npost(restored)} re-activated")

                # Record profile field changes before overwriting stored values.
                # Skip bio detection if the account was private_blocked last run: the bio
                # is hidden from us, so a missing bio just means no access, not a real change.
                # private_accessible accounts (yellow pill) have accessible bios -- track normally.
                _bio_blocked    = user.get("privacy_status") == "private_blocked"
                _is_private_now = info.get("is_private", False)
                _field_labels   = {"username": "Username", "display_name": "Display name", "bio": "Bio", "bio_link": "Profile link"}
                _profile_fields = {
                    "username":     (user.get("username"),     info.get("username")),
                    "display_name": (user.get("display_name"), info.get("display_name")),
                    "bio":          (user.get("bio"),          info.get("bio")),
                    "bio_link":     (user.get("bio_link"),     info.get("bio_link")),
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
                    relation=info.get("relation"),
                    bio_link=info.get("bio_link"),
                )
                db.reset_profile_fail_count(tiktok_id)
                _profile_ok  = True
                username     = info["username"]
                display_name = info["display_name"] or username
                if info.get("sec_uid"):
                    sec_uid = info["sec_uid"]
                if username != user["username"]:
                    old_username = user["username"]
                    log(f"  Username changed: @{old_username} -> @{username}")
                    if rename_creator_folder("tiktok", old_username, username):
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
                    log(f"  Account banned/removed (TikTok ban code), marking as banned")
                    db.set_user_account_status(tiktok_id, "banned")
                    n = db.ban_user_videos(tiktok_id)
                    if n:
                        log(f"  {_npost(n)} marked deleted (user_banned)")
                db.touch_user_last_checked(tiktok_id)
                return _profile_ok, _deletion_detected
            except UserBlockedException:
                _profile_ok = True
                db.reset_profile_fail_count(tiktok_id)
                log(f"  Cookies account blocked by this user -- skipping")
                db.update_user_privacy_status(tiktok_id, "blocked")
                db.touch_user_last_checked(tiktok_id)
                return _profile_ok, _deletion_detected
            except UserPrivateException:
                # Profile data unavailable (TikTok 10222 -- account is fully private at API level).
                # Distinct from a public account with secret=True, which still returns user data.
                # The profile API returns 10222 regardless of follow status; the video list may
                # still be accessible if we follow the account and have valid cookies.
                # Fall through to the video fetch rather than assuming blocked.
                _profile_ok = True
                db.reset_profile_fail_count(tiktok_id)
                log(f"  Profile data unavailable (private account, TikTok 10222), attempting video fetch")
                is_private = True
                info = {}
                username     = user["username"]
                display_name = user.get("display_name") or user["username"]
                break
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
            return _profile_ok, _deletion_detected

        # ── Primary: item_list (has stats, paginated with inter-page delay) ──
        # sec_uid is required: without it the library calls self.info() to
        # resolve it, making a redundant round-trip that can return 0 results.
        item_list_map: dict = {}
        ydlp_map:      dict = {}

        if sec_uid:
            try:
                _max_count = 30 if mode == "quick" else 2000
                item_list_videos = await get_user_videos_with_stats(
                    api, sec_uid=sec_uid, max_count=_max_count, stop_event=stop_event, logd=logd
                )
                curr_ordered  = [v["video_id"] for v in item_list_videos]
                item_list_map = {v["video_id"]: v for v in item_list_videos}
                logd(f"  [{tiktok_id}] {len(item_list_map)} videos via item_list (sec_uid={sec_uid})")
            except Exception as e:
                if _is_bot_error(e):
                    raise _BotDetectedError(str(e)) from e
                log(f"  Video fetch failed, trying fallback...")
                logd(f"  [{tiktok_id}] item_list error: {e}")

        # For 10222 accounts: recover username, display name, bio, and avatar from
        # item_list author data. Follower/video counts remain unavailable.
        if is_private and not info and item_list_map:
            _sample      = next(iter(item_list_map.values()))
            _a_username  = _sample.get("author_username")
            _a_display   = _sample.get("author_display_name")
            _a_bio       = _sample.get("author_bio")
            _a_avatar    = _sample.get("author_avatar")
            _a_sec_uid   = _sample.get("author_sec_uid")
            if _a_sec_uid:
                sec_uid = _a_sec_uid
            if _a_username and _a_username != username:
                old_username = username
                log(f"  Username changed: @{old_username} -> @{_a_username}")
                if rename_creator_folder("tiktok", old_username, _a_username):
                    db.rename_user_video_paths(tiktok_id, old_username, _a_username)
                    log(f"  Folder renamed and DB paths updated")
                db.record_profile_change(tiktok_id, "username", old_username)
                username = _a_username
            if _a_display and _a_display != user.get("display_name"):
                db.record_profile_change(tiktok_id, "display_name", user.get("display_name"))
                log(f"  Profile change: Display name updated")
            if _a_display:
                display_name = _a_display
            if _a_avatar:
                if cache_avatar(tiktok_id, _a_avatar) == "changed":
                    log(f"  Profile change: avatar changed")
            db.update_user_info_from_item_list(
                tiktok_id, username, display_name, _a_bio,
                sec_uid=sec_uid, avatar_url=_a_avatar,
            )
        elif is_private and not info:
            # 10222 account, item_list returned no data (access lost or transient failure).
            # Still stamp last_checked so the card reflects when this account was last visited.
            db.touch_user_last_checked(tiktok_id)

        # Inaccessible private account: relation & 1 == 0 means we don't follow them.
        # (relation bitmask: 0=none, 1=we follow them, 2=they follow us, 3=mutual)
        # Accessible private accounts with 0 videos fall through to the diff so
        # deletion tracking of any previously-downloaded videos still runs.
        # info is empty for 10222 accounts (no relation data available); those skip
        # this check and rely on item_list / yt-dlp success to determine accessibility.
        if not item_list_map and is_private is True and info:
            if not (info.get("relation") or 0) & 1:
                log(f"  Private account, cannot be accessed")
                db.update_user_privacy_status(tiktok_id, "private_blocked")
                return _profile_ok, _deletion_detected

        if item_list_map:
            log(f"  {_npost(len(item_list_map))} found")
            if not _profile_ok:
                # item_list returned data so the session is responsive; the profile
                # endpoint hiccup should not count toward the rate-limit failure counter
                _profile_ok = True

        # ── Fallback: yt-dlp flat extraction ─────────────────────────────────
        # Only runs when item_list returned nothing (failed or no sec_uid).
        # Skipped for accessible private accounts with 0 videos -- yt-dlp cannot
        # access private content and would incorrectly trigger private_blocked.
        if not item_list_map and not (is_private and info and (info.get("relation") or 0) & 1):
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
                return _profile_ok, _deletion_detected  # both sources failed; propagate profile result

        # If stop was requested during the item_list fetch, the result is partial.
        # Treat it the same as quick mode: skip the full deletion diff and don't
        # update the stored ordered IDs, to avoid falsely flagging un-fetched videos.
        _fetch_interrupted = bool(stop_event and stop_event.is_set())

        remote_ids = set(item_list_map) | set(ydlp_map)

        if is_private is True:
            db.update_user_privacy_status(tiktok_id, "private_accessible")
        elif is_private is False:
            db.update_user_privacy_status(tiktok_id, "public")
        # if is_private is None (profile fetch failed), leave privacy_status unchanged

        # If the account was previously marked banned but videos are now accessible,
        # clear the ban status. This covers 10222 private accounts: get_user_info raises
        # UserPrivateException so the profile-level recovery block never runs.
        # Public accounts that recover go through the profile-level block above; skip here.
        if _was_banned and is_private is True and remote_ids:
            db.restore_banned_videos(tiktok_id)
            db.set_user_account_status(tiktok_id, "active")
            db.set_user_tracking_enabled(tiktok_id, True)
            log(f"  Account recovered (videos accessible): ban cleared")

        known_ids, active_ids, pending_ids = db.get_video_id_sets(tiktok_id)

        new_ids = remote_ids - known_ids

        # Full deletion diff: active videos not in the API response are possibly deleted.
        # pending_ids (seen missing once) that are still absent get confirmed.
        # Both skipped in quick mode (partial fetch) and on interrupted fetches.
        _full_diff = mode == "full" and not _fetch_interrupted
        deleted_ids = (active_ids - remote_ids) if _full_diff else set()
        confirm_ids = (pending_ids - remote_ids) if _full_diff else set()

        # Any deleted video (confirmed or not) that's visible again: revert or undelete.
        undeleted_ids = (known_ids - active_ids) & remote_ids

        # Position-aware deletion detection for quick mode.
        quick_deleted_ids: set = set()
        if mode == "quick" and curr_ordered:
            prev_ordered = db.get_user_last_quick_video_ids(tiktok_id)
            if prev_ordered:
                prev_set = set(prev_ordered)
                curr_set = set(curr_ordered)
                n_new    = len(curr_set - prev_set)
                if n_new < len(prev_ordered):
                    expected_dropoffs = set(prev_ordered[-n_new:]) if n_new > 0 else set()
                    # Include both active (first sighting) and pending (confirmation) videos
                    quick_deleted_ids = ((prev_set - curr_set) - expected_dropoffs) & (active_ids | pending_ids)

        if new_ids:
            log(f"  New: {len(new_ids)}")
        if deleted_ids:
            log(f"  Missing (checking for deletion): {len(deleted_ids)}")
        if confirm_ids:
            log(f"  Confirming deletion: {len(confirm_ids)}")
        if quick_deleted_ids:
            log(f"  Missing from quick window: {len(quick_deleted_ids)}")
        if undeleted_ids:
            log(f"  Back on TikTok: {len(undeleted_ids)}")
        if not (new_ids or deleted_ids or confirm_ids or quick_deleted_ids or undeleted_ids):
            log("  No changes.")

        for vid_id in new_ids:
            if stop_event and stop_event.is_set():
                log("  Loop stop requested: skipping remaining downloads")
                break
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
                    platform="tiktok",
                    cookies_path=COOKIES_PATH,
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
                    platform="tiktok",
                    cookies_path=COOKIES_PATH,
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
                    repost_count=details.get("repost_count"),
                    duration=details.get("duration"),
                    width=details.get("width"),
                    height=details.get("height"),
                    music_title=details.get("music_title"),
                    music_artist=details.get("music_artist"),
                    music_id=details.get("music_id"),
                )
                log(f"  Saved {vid_id} -> {dl_result['file_path']}")
                db.update_video_downloaded(vid_id, dl_result["file_path"], dl_result.get("ytdlp_data"))
            else:
                log(f"  Failed to download {vid_id}")

        for vid_id in deleted_ids:
            db.mark_video_possibly_deleted(vid_id)
            log(f"  Possibly deleted: {vid_id}")

        for vid_id in confirm_ids:
            db.confirm_video_deletion(vid_id)
            log(f"  Confirmed deleted: {vid_id}")

        if deleted_ids or confirm_ids:
            _deletion_detected = True
        if len(deleted_ids) >= _LARGE_DELETION_THRESHOLD:
            _large_deletion_spike = True

        for vid_id in quick_deleted_ids:
            if vid_id in pending_ids:
                db.confirm_video_deletion(vid_id)
                log(f"  Confirmed deleted: {vid_id}")
            else:
                db.mark_video_possibly_deleted(vid_id)
                log(f"  Possibly deleted: {vid_id}")

        for vid_id in undeleted_ids:
            result = db.revert_or_undelete_video(vid_id)
            if result == "undeleted":
                log(f"  Undeleted: {vid_id}")

        # ── Stats upsert for already-known videos from item_list ─────────────
        # Only on full-mode runs: item_list fetches all pages so stats are complete.
        # Quick-mode runs only fetch the first page (30 videos) and skip this step.
        if mode == "full":
            for vid_id, details in item_list_map.items():
                if vid_id in known_ids and vid_id not in new_ids:
                    db.update_video_stats_loop(
                        vid_id,
                        details.get("view_count"),
                        details.get("like_count"),
                        details.get("comment_count"),
                        details.get("share_count"),
                        details.get("save_count"),
                        details.get("repost_count"),
                    )

        # Update the stored ordered ID list for the next position-aware quick check.
        # Skip if the fetch was interrupted: a partial list would corrupt the detection baseline.
        if not _fetch_interrupted:
            if mode == "quick" and curr_ordered:
                db.set_user_last_quick_video_ids(tiktok_id, curr_ordered)
            elif mode == "full" and curr_ordered:
                db.set_user_last_quick_video_ids(tiktok_id, curr_ordered[:30])

        return _profile_ok, _deletion_detected, _large_deletion_spike

    finally:
        if set_current_user:
            set_current_user(None)


async def process_user_session(
    users: list[dict],
    log: Callable[[str], None],
    logd: Callable[[str], None],
    set_current_user: Callable[[str | None], None] | None = None,
    stop_event: threading.Event | None = None,
    set_sleep: Callable[[float | None, str | None], None] | None = None,
    on_large_deletion: Callable[[str], None] | None = None,
) -> int:
    """Process a set of users in one session. Returns the count of users successfully processed."""
    from TikTokApi import TikTokApi

    random.shuffle(users)
    cookies  = get_cookies_flat()
    ms_token = get_ms_token()
    total    = len(users)

    _active_secs  = int(db.get_setting("active_check_hours",        ACTIVE_CHECK_HOURS))        * 3600
    _high_secs    = int(db.get_setting("high_priority_check_hours", HIGH_PRIORITY_CHECK_HOURS)) * 3600

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
                # Use a real secUid so TikTok returns a proper response -- empty-param
                # requests trigger "unexpected status code" noise from the library.
                _val_sec_uid = next((u.get("sec_uid") for u in users if u.get("sec_uid")), "")
                try:
                    await api.make_request(
                        url="https://www.tiktok.com/api/user/detail/",
                        params={"secUid": _val_sec_uid, "uniqueId": ""},
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
    # restarts (_BOT_SLEEP_1 then _BOT_SLEEP_2); a third consecutive failure
    # cancels the loop entirely and lets the full loop cooldown restart.
    total_completed       = 0
    start_idx             = 0
    bot_retry_counts: dict[int, int] = {}  # {user_idx: restart_count} -- per-user bot retries
    session_create_failed = False   # True if the most recent _make_session call failed
    cooldown_pending      = False
    cooldown_sleep        = 0

    while start_idx < total:
        if cooldown_pending:
            log(f"Cooling down {cooldown_sleep // 60} min before restarting session...")
            if set_sleep:
                _resume = f"resuming @{users[start_idx]['username']}" if start_idx < total else "restarting session"
                set_sleep(time.time() + cooldown_sleep, _resume)
            await asyncio.sleep(cooldown_sleep)
            cooldown_pending = False
            cooldown_sleep   = 0
            if set_sleep:
                set_sleep(None, None)

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
                if stop_event and stop_event.is_set():
                    log("=== User loop stopped by request ===")
                    return total_completed
                user = users[idx]
                if idx > 0:
                    _gap       = max(random.expovariate(1.0 / SESSION_GAP_MEAN_SECS), _SESSION_GAP_MIN_SECS)
                    _next_mode = "full refresh" if user.get("full_refresh_pending") else "quick check"
                    if set_sleep:
                        set_sleep(time.time() + _gap, f"{_next_mode} for @{user['username']}")
                    await asyncio.sleep(_gap)
                    if set_sleep:
                        set_sleep(None, None)
                fetch_videos    = bool(user.get("tracking_enabled", 1))
                progress        = f"{idx + 1}/{total}"
                _now_ts         = int(time.time())
                _mode           = "full" if user.get("full_refresh_pending") else "quick"
                _user_processed    = False
                _deletion_detected = False
                try:
                    _result = await process_single_user(
                        user, api, cookies,
                        fetch_videos=fetch_videos,
                        mode=_mode,
                        progress=progress,
                        log=log,
                        logd=logd,
                        set_current_user=set_current_user,
                        stop_event=stop_event,
                    )
                    _deletion_detected = _result[1] if isinstance(_result, tuple) else False
                    _large_deletion    = _result[2] if isinstance(_result, tuple) and len(_result) > 2 else False
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
                        log(
                            f"  Bot detected a 3rd time after 15 min total sleep;"
                            f" cancelling loop, cooldown restarting"
                        )
                        total_completed += completed
                        return total_completed
                except Exception as e:
                    log(f"Unhandled error for @{user['username']}: {e}")
                if _user_processed:
                    completed += 1
                    _interval = user.get("check_interval_secs") or (
                        _high_secs if user.get("starred") else _active_secs
                    )
                    db.set_user_next_check(user["tiktok_id"], int(time.time()) + _interval)
                    if _mode == "full":
                        db.set_user_last_full_refresh_at(user["tiktok_id"], _now_ts)
                        db.clear_full_refresh_pending(user["tiktok_id"])
                        if _deletion_detected:
                            if _large_deletion and on_large_deletion:
                                on_large_deletion(user["tiktok_id"])
                            else:
                                db.set_user_next_check(user["tiktok_id"], None)
                                log(f"  Deletion candidates found; scheduling ASAP re-check")

            if not break_for_restart:
                total_completed += completed
                start_idx = total  # all users processed; exit outer while

    return total_completed


async def run_single_user_with_session(
    user: dict,
    log: Callable[[str], None],
    logd: Callable[[str], None],
    profile_only: bool = False,
    mode: str = "full",
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
        await process_single_user(user, api, cookies, log=log, logd=logd, fetch_videos=not profile_only, mode=mode)


# ── Sound tracking ────────────────────────────────────────────────────────────

async def process_all_sounds(
    log: Callable[[str], None],
    stop_event: threading.Event | None = None,
) -> dict:
    """Fetch and download new videos for all tracked sounds.
    Called once per main loop run, after user processing.
    Returns {"sounds_checked": int, "new_videos": int}.
    """
    sounds = db.get_all_sounds()
    if not sounds:
        return {"sounds_checked": 0, "new_videos": 0}
    random.shuffle(sounds)

    sounds_checked = 0
    total_new      = 0
    for sound in sounds:
        if stop_event and stop_event.is_set():
            log("=== Sound loop stopped by request ===")
            break
        if not sound.get("tracking_enabled", 1):
            log(f"Skipping '{sound.get('label') or sound['sound_id']}' (tracking disabled)")
            continue
        total_new += await process_single_sound(sound, log)
        sounds_checked += 1

    return {"sounds_checked": sounds_checked, "new_videos": total_new}


async def process_single_sound(sound: dict, log: Callable[[str], None]) -> int:
    """Process one sound. Returns the count of new video associations added."""
    sound_id = sound["sound_id"]
    label    = sound.get("label") or sound_id

    log(f"Processing sound '{label}' ({sound_id})")

    remote_ids: list[str] = []
    for _attempt in range(2):
        try:
            ms_token   = get_ms_token()
            remote_ids = await fetch_sound_video_ids(sound_id, ms_token, CHROME_EXECUTABLE,
                                                      cookies_flat=get_cookies_flat())
            break
        except Exception as e:
            if _attempt == 0:
                log(f"Sound '{label}' fetch failed, retrying in 15s: {e}")
                await asyncio.sleep(15)
            else:
                log(f"Failed to fetch posts for sound {sound_id}: {e}")
                db.update_sound_last_checked(sound_id)
                return 0

    log(f"{_npost(len(remote_ids))} found for sound '{label}'")

    remote_id_set = set(remote_ids)
    known_ids     = db.get_sound_video_ids(sound_id)
    new_ids       = [vid_id for vid_id in remote_ids if vid_id not in known_ids]

    # Deletion tracking: active videos no longer in the remote listing
    active_ids  = db.get_sound_active_video_ids(sound_id)
    pending_ids = db.get_sound_pending_deletion_video_ids(sound_id)

    missing_ids  = active_ids - remote_id_set   # first absence: mark possibly deleted
    confirm_ids  = pending_ids - remote_id_set   # still absent: confirm deletion
    returned_ids = pending_ids & remote_id_set   # came back: revert silently

    for vid_id in returned_ids:
        db.revert_or_undelete_video(vid_id)

    for vid_id in missing_ids:
        db.mark_video_possibly_deleted(vid_id)
        log(f"Possibly deleted: {vid_id}")

    for vid_id in confirm_ids:
        db.confirm_video_deletion(vid_id)
        log(f"Confirmed deleted: {vid_id}")

    if not new_ids:
        if not missing_ids:
            log(f"No changes for sound '{label}'")
        db.update_sound_last_checked(sound_id)
        return 0

    log(f"New: {_npost(len(new_ids))} for sound '{label}'")
    cookies   = get_cookies_flat()
    new_count = 0

    for vid_id in new_ids:
        # Already in DB (downloaded via user tracking) -- just add the junction row
        if db.get_video(vid_id):
            db.add_sound_video(sound_id, vid_id)
            log(f"Linked existing video {vid_id} to sound '{label}'")
            new_count += 1
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
            path = download_photos(
                video_id=vid_id,
                username=author_username,
                image_urls=details["image_urls"],
                upload_date=details["upload_date"],
                platform="tiktok",
                cookies_path=COOKIES_PATH,
            )
            if path:
                thumb = generate_thumbnail(vid_id, path)
                if not thumb:
                    log(f"Thumbnail FAILED for {vid_id} -- see [thumb] lines above")
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
                platform="tiktok",
                cookies_path=COOKIES_PATH,
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
                repost_count=details.get("repost_count"),
                duration=details.get("duration"),
                width=details.get("width"),
                height=details.get("height"),
                music_title=details.get("music_title"),
                music_artist=details.get("music_artist"),
                music_id=details.get("music_id"),
            )
            db.update_video_downloaded(vid_id, dl_result["file_path"], dl_result.get("ytdlp_data"))
            db.add_sound_video(sound_id, vid_id)
            log(f"Saved {vid_id} from @{author_username} -> {dl_result['file_path']}")
            new_count += 1
        else:
            log(f"Failed to download {vid_id}")

    db.update_sound_last_checked(sound_id)
    return new_count
