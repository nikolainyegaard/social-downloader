"""TikTok tracking: users and sounds."""

from __future__ import annotations

import asyncio
import os
import random
import threading
import time
from typing import Callable

from platforms.tiktok.config import (
    get_ms_token, get_cookies_flat, get_proxy, COOKIES_PATH,
    SESSION_GAP_MEAN_SECS,
    HIGH_PRIORITY_CHECK_HOURS, ACTIVE_CHECK_HOURS,
)
from platforms.tiktok.store import TikTokStore
from scheduling import set_channel_next_check, set_channel_last_full
from platforms.tiktok.api import (
    create_tiktok_session,
    get_user_info, get_user_videos, get_user_videos_with_stats,
    fetch_sound_video_ids, get_video_details, get_user_stories, parse_story_item,
    get_session_cookies,
    UserBannedException, UserPrivateException, UserBlockedException,
)
from downloader import download_video, download_photos, rename_creator_folder
from engine.tracker import save_new_stories
from thumbnailer import cache_avatar, generate_thumbnail

# Bound from the engine instance by the entry points below; module-level so the
# deep helper functions keep their original call shape. All entry points bind
# the same singletons, so concurrent loops are safe.
db = None
store = None


def _bind(engine) -> None:
    global db, store
    if db is None:
        db    = engine.db
        store = TikTokStore(engine.db)

_BOT_SLEEP_1                  = 300  # seconds after first bot detection (5 min)
_BOT_SLEEP_2                  = 600  # seconds after second bot detection (10 min)
_PROFILE_FAIL_QUIET_THRESHOLD = 5
_PROFILE_FAIL_SLEEP           = 30   # seconds to sleep before retrying a failed profile fetch
_BOT_COOLDOWN_SLEEP           = 600  # seconds for full browser restart on session creation failure
_BOT_COOLDOWN_HOURS           = 6    # hours of skipped scheduled sessions after a run cancels on bot detection
_SESSION_GAP_MIN_SECS         = 15   # minimum inter-user gap within a session (seconds)
_LARGE_DELETION_THRESHOLD     = 10   # first-pass missing count that triggers an isolated full re-scan


def _start_bot_cooldown() -> int:
    """Stamp bot_cooldown_until so the scheduler skips upcoming sessions.

    Once TikTok flags the identity, retrying at the next slot only refreshes
    the flag. The stamp is cleared when a run later completes normally.
    Returns the cooldown length in hours for the log line.
    """
    hours = int(db.get_setting("bot_cooldown_hours", _BOT_COOLDOWN_HOURS))
    db.set_setting("bot_cooldown_until", str(int(time.time()) + hours * 3600))
    return hours


class _BotDetectedError(Exception):
    """Raised when TikTok detects the session as a bot. Triggers a full session
    restart with a cooldown sleep."""


class _SessionLostError(_BotDetectedError):
    """The browser session died (page, context, or browser gone) rather than
    TikTok pushing back. Same relaunch, but immediately: there is nothing to
    cool down from, and the 5-minute bot sleep would just stall the loop.
    Subclasses _BotDetectedError so paths that only know the parent still
    restart the browser."""


def _is_dead_session_error(exc: Exception) -> bool:
    # TikTokApi's wording for an empty or invalidated session pool
    msg = str(exc).lower()
    return "no sessions created" in msg or "no valid sessions" in msg


def _restart_error(exc: Exception) -> _BotDetectedError:
    """Map a session-level failure to the right restart exception."""
    cls = _SessionLostError if _is_dead_session_error(exc) else _BotDetectedError
    return cls(str(exc))


def _is_bot_error(exc: Exception) -> bool:
    # An empty body is not a session verdict: since TikTok stopped answering
    # the signed JSON endpoints altogether, it is those endpoints' resting
    # state (the library's message blames bot detection, hence the explicit
    # exclusion before the "bot" match). The same session still loads real
    # pages, and yt-dlp still lists videos, so callers treat it as a plain
    # fetch failure and run their fallbacks instead of restarting the browser.
    from TikTokApi.exceptions import EmptyResponseException
    if isinstance(exc, EmptyResponseException):
        return False
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

async def _check_user_stories(user: dict, api, username: str,
                              log, logd) -> int:
    """Fetch and save any live stories for a user. Returns the number of live
    stories the endpoint listed (saved or already known): only a follower can
    list a private account's stories, so a nonzero count doubles as proof of
    access. Never raises: the story endpoint is newer and less proven than
    item_list, so a failure here must not fail the user's whole check or trip
    the bot-detection recovery."""
    channel_id = user["channel_id"]
    try:
        items = await get_user_stories(api, channel_id)
    except Exception as e:
        logd(f"  [{channel_id}] story fetch error: {e}")
        return 0
    if not items:
        return 0
    stories = [s for s in (parse_story_item(i) for i in items) if s]
    if not stories:
        return len(items)
    try:
        # The CDN validates tt_chain_token against the URL signature, so the
        # download must carry the browser session's live cookies, not cookies.txt
        session_cookies = await get_session_cookies(api)
        save_new_stories(db, "tiktok", channel_id, username, stories, log,
                         cookies=session_cookies or None,
                         cookies_path=COOKIES_PATH if os.path.exists(COOKIES_PATH) else None,
                         proxy=get_proxy())
    except Exception as e:
        logd(f"  [{channel_id}] story save error: {e}")
    return len(items)


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
    channel_id = user["channel_id"]

    if set_current_user:
        set_current_user(user["handle"])

    try:
        _mode_tag = "[Quick]" if mode == "quick" else "[Full] "
        log(f"{_mode_tag} Processing @{user['handle']} ({progress or f'ID: {channel_id}'})")

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
                # Pass both: the page read needs the handle for the profile
                # URL, and sec_uid pins the identity across username changes
                # (the fallback tiers resolve by secUid alone).
                info = await get_user_info(
                    api,
                    username=user["handle"],
                    sec_uid=sec_uid,
                )

                # Account recovered from a ban: restore all ban-deleted videos.
                if _was_banned:
                    restored = store.restore_banned_videos(channel_id)
                    store.set_account_status(channel_id, "active")
                    db.set_channel_tracking_enabled(channel_id, True)
                    log(f"  Account restored: ban cleared, {_npost(restored)} re-activated")

                # Record profile field changes before overwriting stored values.
                # Skip bio/bio_link when the account was private_blocked last run OR is
                # currently private: TikTok returns signature="" in statusCode 10222
                # responses regardless of follow relationship, so an empty bio from the
                # API is not a real change and must not overwrite the stored value.
                _is_private_now = info.get("is_private", False)
                _bio_blocked    = user.get("privacy_status") == "private_blocked" or _is_private_now
                _field_labels   = {"username": "Username", "display_name": "Display name", "bio": "Bio", "bio_link": "Bio link"}
                _profile_fields = {
                    "username":     (user.get("handle"),     info.get("username")),
                    "display_name": (user.get("display_name"), info.get("display_name")),
                    "bio":          (user.get("description"),          info.get("bio")),
                    "bio_link":     (user.get("bio_link"),     info.get("bio_link")),
                }
                for _field, (_old, _new) in _profile_fields.items():
                    if _field in ("bio", "bio_link") and _bio_blocked:
                        continue
                    if _new is not None and _new != _old:
                        db.record_profile_change(channel_id, _field, _old)
                        if _field != "username":  # username gets its own log line below
                            log(f"  Profile change: {_field_labels[_field]} updated")

                # Preserve stored bio/bio_link for private accounts: TikTok omits them
                # from the API response so the API values are always empty.
                _bio_for_db      = info["bio"] if not _is_private_now else (info["bio"] or user.get("description"))
                _bio_link_for_db = info.get("bio_link") if not _is_private_now else (info.get("bio_link") or user.get("bio_link"))
                store.update_channel_profile(
                    channel_id,
                    info["username"],
                    info["display_name"],
                    _bio_for_db,
                    info["follower_count"],
                    info["following_count"],
                    info["video_count"],
                    sec_uid=info.get("sec_uid"),
                    verified=int(info.get("verified", False)),
                    avatar_url=info.get("avatar_url"),
                    raw_channel_data=info.get("_raw_user_data"),
                    relation=info.get("relation"),
                    bio_link=_bio_link_for_db,
                )
                store.reset_profile_fail_count(channel_id)
                _profile_ok  = True
                username     = info["username"]
                display_name = info["display_name"] or username
                if info.get("sec_uid"):
                    sec_uid = info["sec_uid"]
                if username != user["handle"]:
                    old_username = user["handle"]
                    log(f"  Username changed: @{old_username} -> @{username}")
                    if rename_creator_folder("tiktok", old_username, username):
                        db.rename_channel_video_paths(channel_id, old_username, username)
                        log(f"  Folder renamed and DB paths updated")
                is_private = _is_private_now
                if info.get("avatar_url"):
                    if cache_avatar(channel_id, info["avatar_url"], db_obj=db) == "changed":
                        log(f"  Profile change: avatar changed")
                break  # profile fetch succeeded; exit retry loop
            except UserBannedException:
                _profile_ok = True  # TikTok responded with valid data; not a rate limit failure
                store.reset_profile_fail_count(channel_id)
                if _was_banned:
                    log(f"  No changes (still banned)")
                    banned_at = user.get("banned_at")
                    if (banned_at
                            and time.time() - banned_at >= 14 * 86400
                            and user.get("tracking_enabled", 1)):
                        db.set_channel_tracking_enabled(channel_id, False)
                        log(f"  Banned for 14+ consecutive days -- tracking disabled")
                else:
                    log(f"  Account banned/removed (TikTok ban code), marking as banned")
                    store.set_account_status(channel_id, "banned")
                    n = store.ban_channel_videos(channel_id)
                    if n:
                        log(f"  {_npost(n)} marked deleted (user_banned)")
                store.touch_last_checked(channel_id)
                return _profile_ok, _deletion_detected
            except UserBlockedException:
                _profile_ok = True
                store.reset_profile_fail_count(channel_id)
                log(f"  Cookies account blocked by this user -- skipping")
                store.update_privacy_status(channel_id, "blocked")
                store.touch_last_checked(channel_id)
                return _profile_ok, _deletion_detected
            except UserPrivateException:
                # Profile data unavailable (TikTok 10222 -- account is fully private at API level).
                # Distinct from a public account with secret=True, which still returns user data.
                # The profile API returns 10222 regardless of follow status; the video list may
                # still be accessible if we follow the account and have valid cookies.
                # Fall through to the video fetch rather than assuming blocked.
                _profile_ok = True
                store.reset_profile_fail_count(channel_id)
                log(f"  Profile data unavailable (private account, TikTok 10222), attempting video fetch")
                is_private = True
                info = {}
                username     = user["handle"]
                display_name = user.get("display_name") or user["handle"]
                break
            except Exception as e:
                if _is_bot_error(e):
                    raise _restart_error(e) from e
                if _attempt == 0:
                    log(f"  Profile fetch failed, retrying in {_PROFILE_FAIL_SLEEP}s")
                    await asyncio.sleep(_PROFILE_FAIL_SLEEP)
                else:
                    _fail_count = store.increment_profile_fail_count(channel_id)
                    if _fail_count < _PROFILE_FAIL_QUIET_THRESHOLD:
                        log(f"  Profile fetch failed after retry: {e}")
                    else:
                        logd(f"  [{channel_id}] profile still failing (#{_fail_count}): {e}")
                    username     = user["handle"]
                    display_name = user.get("display_name") or username

        if not fetch_videos:
            log(f"  Video fetch skipped (tracking disabled for @{username})")
            return _profile_ok, _deletion_detected

        # ── Stories: fetch any currently live stories, save new ones ─────────
        _stories_live = await _check_user_stories(user, api, username, log, logd)

        # ── Primary: item_list (has stats, paginated with inter-page delay) ──
        # sec_uid is required: without it the library calls self.info() to
        # resolve it, making a redundant round-trip that can return 0 results.
        item_list_map: dict = {}
        ydlp_map:      dict = {}

        if sec_uid:
            try:
                _max_count = 30 if mode == "quick" else 2000
                item_list_videos = await get_user_videos_with_stats(
                    api, sec_uid=sec_uid, max_count=_max_count, stop_event=stop_event, logd=log
                )
                curr_ordered  = [v["video_id"] for v in item_list_videos]
                item_list_map = {v["video_id"]: v for v in item_list_videos}
                logd(f"  [{channel_id}] {len(item_list_map)} videos via item_list (sec_uid={sec_uid})")
            except Exception as e:
                if _is_bot_error(e):
                    raise _restart_error(e) from e
                log(f"  Video fetch failed, trying fallback...")
                logd(f"  [{channel_id}] item_list error: {e}")

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
                    db.rename_channel_video_paths(channel_id, old_username, _a_username)
                    log(f"  Folder renamed and DB paths updated")
                db.record_profile_change(channel_id, "username", old_username)
                username = _a_username
            if _a_display and _a_display != user.get("display_name"):
                db.record_profile_change(channel_id, "display_name", user.get("display_name"))
                log(f"  Profile change: Display name updated")
            if _a_display:
                display_name = _a_display
            if _a_avatar:
                if cache_avatar(channel_id, _a_avatar, db_obj=db) == "changed":
                    log(f"  Profile change: avatar changed")
            store.update_channel_from_item_list(
                channel_id, username, display_name, _a_bio,
                sec_uid=sec_uid, avatar_url=_a_avatar,
            )
        elif is_private and not info:
            # 10222 account, item_list returned no data (access lost or transient failure).
            # Still stamp last_checked so the card reflects when this account was last visited.
            store.touch_last_checked(channel_id)

        # Do we follow this account? relation enum: 0=none, 1=we follow them,
        # 2=mutual/friends, 6=they follow us only. The page blob's relation is
        # unknown (None) when it rendered 0, so fall back to the last stored
        # value, and let this run's stories prove access outright: only a
        # follower can list a private account's stories.
        _rel = info.get("relation") if info else None
        if _rel is None:
            _rel = user.get("relation") or 0
        _followed = _rel in (1, 2) or _stories_live > 0
        # Story evidence proves a follow the page blob failed to render;
        # persist it so future checks without live stories stay accessible.
        if _stories_live > 0 and _rel not in (1, 2):
            store.set_channel_relation(channel_id, 1)

        # Inaccessible private account. Accessible private accounts with 0
        # videos fall through to the diff so deletion tracking of any
        # previously-downloaded videos still runs.
        if not item_list_map and is_private is True and info:
            if not _followed:
                log(f"  Private account, cannot be accessed")
                store.update_privacy_status(channel_id, "private_blocked")
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
        if not item_list_map and not (is_private and info and _followed):
            _profile_video_count = info.get("video_count") if info else None
            # Already flagged blocked and the profile still reports videos we cannot
            # list: nothing has changed, don't burn a yt-dlp attempt every cycle.
            if user.get("privacy_status") == "blocked" and (_profile_video_count or 0) > 0:
                log(f"  Cookies account still blocked by this user, skipping")
                store.touch_last_checked(channel_id)
                return _profile_ok, _deletion_detected
            try:
                ydlp_videos = get_user_videos(channel_id, sec_uid=sec_uid,
                                              cookies_path=COOKIES_PATH)
                ydlp_map = {v["video_id"]: v for v in ydlp_videos}
                log(f"  {_npost(len(ydlp_map))} found")
                logd(f"  [{channel_id}] {len(ydlp_map)} videos via yt-dlp fallback")
            except Exception as e:
                logd(f"  [{channel_id}] yt-dlp fallback error: {e}")
                if "does not have any videos" in str(e) and (_profile_video_count or 0) > 0:
                    # Profile reports videos but neither source can list any: the
                    # account has most likely blocked the cookies account.
                    log(f"  Profile reports {_profile_video_count} videos but none are listable; cookies account is likely blocked by this user")
                    store.update_privacy_status(channel_id, "blocked")
                    store.touch_last_checked(channel_id)
                    return _profile_ok, _deletion_detected
                if "does not have any videos" in str(e) and _profile_video_count == 0:
                    # Genuinely empty account (profile confirms 0 videos): continue to
                    # the diff so deletion tracking of saved videos still runs.
                    log(f"  Account has no videos posted")
                else:
                    log(f"  Video fetch failed -- skipping user")
                    if "private" in str(e).lower():
                        store.update_privacy_status(channel_id, "private_blocked")
                    return _profile_ok, _deletion_detected  # both sources failed; propagate profile result

        # If stop was requested during the item_list fetch, the result is partial.
        # Treat it the same as quick mode: skip the full deletion diff and don't
        # update the stored ordered IDs, to avoid falsely flagging un-fetched videos.
        _fetch_interrupted = bool(stop_event and stop_event.is_set())

        remote_ids = set(item_list_map) | set(ydlp_map)

        if is_private is True:
            store.update_privacy_status(channel_id, "private_accessible")
        elif is_private is False:
            store.update_privacy_status(channel_id, "public")
        # if is_private is None (profile fetch failed), leave privacy_status unchanged

        # If the account was previously marked banned but videos are now accessible,
        # clear the ban status. This covers 10222 private accounts: get_user_info raises
        # UserPrivateException so the profile-level recovery block never runs.
        # Public accounts that recover go through the profile-level block above; skip here.
        if _was_banned and is_private is True and remote_ids:
            store.restore_banned_videos(channel_id)
            store.set_account_status(channel_id, "active")
            db.set_channel_tracking_enabled(channel_id, True)
            log(f"  Account recovered (videos accessible): ban cleared")

        known_ids, active_ids, pending_ids = db.get_video_id_sets(channel_id)

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
            prev_ordered = store.get_last_quick_video_ids(channel_id)
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
                    proxy=get_proxy(),
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
                    tiktok_id=channel_id,
                    display_name=display_name,
                    description=details["description"],
                    upload_date=details["upload_date"],
                    download_date=int(time.time()),
                    platform="tiktok",
                    cookies_path=COOKIES_PATH,
                    proxy=get_proxy(),
                )
            _audio_only = isinstance(dl_result, dict) and dl_result.get("audio_only")
            if dl_result and not _audio_only:
                store.add_video_full(
                    vid_id, channel_id, details["type"],
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
                db.update_video_downloaded(vid_id, dl_result["file_path"], None)
            elif _audio_only:
                store.add_video_full(
                    vid_id, channel_id, "audio",
                    details["description"], details["upload_date"],
                    view_count=details.get("view_count"),
                    like_count=details.get("like_count"),
                    comment_count=details.get("comment_count"),
                    share_count=details.get("share_count"),
                    save_count=details.get("save_count"),
                    repost_count=details.get("repost_count"),
                    duration=details.get("duration"),
                    music_title=details.get("music_title"),
                    music_artist=details.get("music_artist"),
                    music_id=details.get("music_id"),
                )
                log(f"  Skipped {vid_id}: audio-only post")
            else:
                log(f"  Failed to download {vid_id}")

        for vid_id in deleted_ids:
            store.mark_video_possibly_deleted(vid_id)
            log(f"  Possibly deleted: {vid_id}")

        for vid_id in confirm_ids:
            store.confirm_video_deletion(vid_id)
            log(f"  Confirmed deleted: {vid_id}")

        if deleted_ids or confirm_ids:
            _deletion_detected = True
        if len(deleted_ids) >= _LARGE_DELETION_THRESHOLD:
            _large_deletion_spike = True

        for vid_id in quick_deleted_ids:
            if vid_id in pending_ids:
                store.confirm_video_deletion(vid_id)
                log(f"  Confirmed deleted: {vid_id}")
            else:
                store.mark_video_possibly_deleted(vid_id)
                log(f"  Possibly deleted: {vid_id}")

        for vid_id in undeleted_ids:
            result = store.revert_or_undelete_video(vid_id)
            if result == "undeleted":
                log(f"  Undeleted: {vid_id}")

        # ── Stats upsert for already-known videos from item_list ─────────────
        # Only on full-mode runs: item_list fetches all pages so stats are complete.
        # Quick-mode runs only fetch the first page (30 videos) and skip this step.
        if mode == "full":
            for vid_id, details in item_list_map.items():
                if vid_id in known_ids and vid_id not in new_ids:
                    store.update_video_stats_loop(
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
                store.set_last_quick_video_ids(channel_id, curr_ordered)
            elif mode == "full" and curr_ordered:
                store.set_last_quick_video_ids(channel_id, curr_ordered[:30])

        return _profile_ok, _deletion_detected, _large_deletion_spike

    finally:
        if set_current_user:
            set_current_user(None)


async def process_user_session(
    engine,
    users: list[dict],
    log: Callable[[str], None],
    logd: Callable[[str], None],
    set_current_user: Callable[[str | None], None] | None = None,
    stop_event: threading.Event | None = None,
    set_sleep: Callable[[float | None, str | None], None] | None = None,
    on_large_deletion: Callable[[str], None] | None = None,
) -> int:
    """Process a set of users in one session. Returns the count of users successfully processed."""
    _bind(engine)
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
                await create_tiktok_session(api, ms_token, cookies)
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
                    if _is_bot_error(_val_err) or _is_dead_session_error(_val_err):
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
    lost_retry_counts: dict[int, int] = {} # {user_idx: relaunches} -- dead-session relaunches
    session_create_failed = False   # True if the most recent _make_session call failed
    cooldown_pending      = False
    cooldown_sleep        = 0

    while start_idx < total:
        if cooldown_pending:
            log(f"Cooling down {cooldown_sleep // 60} min before restarting session...")
            if set_sleep:
                _resume = f"resuming @{users[start_idx]['handle']}" if start_idx < total else "restarting session"
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
                _hours = _start_bot_cooldown()
                log(
                    f"Aborting loop -- session unrecoverable, backing off {_hours}h"
                    f" ({total_completed}/{total} users)"
                )
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
                        set_sleep(time.time() + _gap, f"{_next_mode} for @{user['handle']}")
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
                    # A dead browser session is not TikTok pushing back: skip
                    # the cooldown sleep and relaunch right away, up to twice
                    # per user. A third loss on the same user falls through to
                    # the bot path, so a browser that cannot stay alive still
                    # backs off instead of crash-looping.
                    if (isinstance(exc, _SessionLostError)
                            and lost_retry_counts.get(idx, 0) < 2):
                        lost_retry_counts[idx] = lost_retry_counts.get(idx, 0) + 1
                        logd(f"  [{user['channel_id']}] session lost: {exc}")
                        log(f"  Browser session lost -- relaunching and retrying @{user['handle']}...")
                        total_completed  += completed
                        start_idx         = idx
                        break_for_restart = True
                        break
                    logd(f"  [{user['channel_id']}] bot detection: {exc}")
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
                            f" @{user['handle']}..."
                        )
                        break
                    else:
                        _hours = _start_bot_cooldown()
                        log(
                            f"  Bot detected a 3rd time after 15 min total sleep --"
                            f" cancelling loop, backing off {_hours}h"
                            f" (scheduled sessions skipped, manual triggers still run)"
                        )
                        total_completed += completed
                        return total_completed
                except Exception as e:
                    log(f"Unhandled error for @{user['handle']}: {e}")
                if _user_processed:
                    completed += 1
                    _interval = user.get("check_interval_secs") or (
                        _high_secs if user.get("starred") else _active_secs
                    )
                    set_channel_next_check(db, user["channel_id"], int(time.time()) + _interval)
                    if _mode == "full":
                        set_channel_last_full(db, user["channel_id"], _now_ts)
                        store.clear_full_refresh_pending(user["channel_id"])
                        if _deletion_detected:
                            if _large_deletion and on_large_deletion:
                                on_large_deletion(user["channel_id"])
                            else:
                                set_channel_next_check(db, user["channel_id"], None)
                                log(f"  Deletion candidates found; scheduling ASAP re-check")

            if not break_for_restart:
                total_completed += completed
                start_idx = total  # all users processed; exit outer while

    # A run that made it here worked end to end, so the identity is not (or no
    # longer) flagged and any active cooldown can end early
    if str(db.get_setting("bot_cooldown_until", "0")) not in ("", "0"):
        db.set_setting("bot_cooldown_until", "0")
        log("Bot cooldown cleared -- run completed normally")
    return total_completed


async def run_single_user_with_session(
    engine,
    user: dict,
    log: Callable[[str], None],
    logd: Callable[[str], None],
    profile_only: bool = False,
    mode: str = "full",
) -> None:
    """Create a dedicated session and process a single user. Used by the manual run worker."""
    _bind(engine)
    from TikTokApi import TikTokApi

    cookies  = get_cookies_flat()
    ms_token = get_ms_token()

    async with TikTokApi() as api:
        for _attempt in range(2):
            try:
                await create_tiktok_session(api, ms_token, cookies)
                break
            except Exception as e:
                logd(f"  [{user['channel_id']}] create_sessions attempt {_attempt + 1} error: {e}")
                if _attempt == 0:
                    log(f"Processing @{user['handle']} -- session failed, retrying in 5s...")
                    await asyncio.sleep(5)
                else:
                    log(f"Processing @{user['handle']} -- session failed after retry ({e}), skipping")
                    return
        await asyncio.sleep(3)
        await process_single_user(user, api, cookies, log=log, logd=logd, fetch_videos=not profile_only, mode=mode)


# ── Sound tracking ────────────────────────────────────────────────────────────

async def process_all_sounds(
    engine,
    log: Callable[[str], None],
    stop_event: threading.Event | None = None,
) -> dict:
    """Fetch and download new videos for all tracked sounds.
    Called once per main loop run, after user processing.
    Returns {"sounds_checked": int, "new_videos": int}.
    """
    _bind(engine)
    sounds = store.get_all_sounds()
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
        total_new += await process_single_sound(engine, sound, log)
        sounds_checked += 1

    return {"sounds_checked": sounds_checked, "new_videos": total_new}


async def process_single_sound(engine, sound: dict, log: Callable[[str], None]) -> int:
    """Process one sound. Returns the count of new video associations added."""
    _bind(engine)
    sound_id = sound["sound_id"]
    label    = sound.get("label") or sound_id

    log(f"Processing sound '{label}' ({sound_id})")

    remote_ids: list[str] = []
    for _attempt in range(2):
        try:
            ms_token   = get_ms_token()
            remote_ids = await fetch_sound_video_ids(sound_id, ms_token,
                                                     cookies_flat=get_cookies_flat())
            break
        except Exception as e:
            if _attempt == 0:
                log(f"Sound '{label}' fetch failed, retrying in 15s: {e}")
                await asyncio.sleep(15)
            else:
                log(f"Failed to fetch posts for sound {sound_id}: {e}")
                store.update_sound_last_checked(sound_id)
                return 0

    log(f"{_npost(len(remote_ids))} found for sound '{label}'")

    remote_id_set = set(remote_ids)
    known_ids     = store.get_sound_video_ids(sound_id)
    new_ids       = [vid_id for vid_id in remote_ids if vid_id not in known_ids]

    # Deletion tracking: active videos no longer in the remote listing
    active_ids  = store.get_sound_active_video_ids(sound_id)
    pending_ids = store.get_sound_pending_deletion_video_ids(sound_id)

    missing_ids  = active_ids - remote_id_set   # first absence: mark possibly deleted
    confirm_ids  = pending_ids - remote_id_set   # still absent: confirm deletion
    returned_ids = pending_ids & remote_id_set   # came back: revert silently

    for vid_id in returned_ids:
        store.revert_or_undelete_video(vid_id)

    for vid_id in missing_ids:
        store.mark_video_possibly_deleted(vid_id)
        log(f"Possibly deleted: {vid_id}")

    for vid_id in confirm_ids:
        store.confirm_video_deletion(vid_id)
        log(f"Confirmed deleted: {vid_id}")

    if not new_ids:
        if not missing_ids:
            log(f"No changes for sound '{label}'")
        store.update_sound_last_checked(sound_id)
        return 0

    log(f"New: {_npost(len(new_ids))} for sound '{label}'")
    cookies   = get_cookies_flat()
    new_count = 0

    for vid_id in new_ids:
        # Already in DB (downloaded via user tracking) -- just add the junction row
        if db.get_video(vid_id):
            store.add_sound_video(sound_id, vid_id)
            log(f"Linked existing video {vid_id} to sound '{label}'")
            new_count += 1
            continue

        result = save_video_by_id(vid_id, cookies, log)
        if result:
            store.add_sound_video(sound_id, vid_id)
        if result == "saved":
            new_count += 1

    store.update_sound_last_checked(sound_id)
    return new_count


def save_video_by_id(vid_id: str, cookies, log: Callable[[str], None]) -> str | None:
    """Fetch, download, and record a single post by video ID.

    Ensures the author's channel row exists (enabled=0 when new). Shared by the
    sound loop and the direct-URL add flow. Returns 'saved' on a full download,
    'audio' for an audio-only post (recorded without a file), None on failure.
    """
    # Fetch full video details (placeholder username; TikTok redirects by video ID)
    try:
        details = get_video_details(vid_id, "user", cookies)
    except Exception as e:
        log(f"Could not fetch details for {vid_id}: {e}")
        return None

    author_id       = details.get("author_id")
    author_username = details.get("author_username") or "unknown"
    author_sec_uid  = details.get("author_sec_uid")
    author_display  = details.get("author_display_name") or author_username

    if not author_id:
        log(f"No author info for {vid_id}, skipping")
        return None

    # Ensure user row exists; add as enabled=0 if this is a new author
    if store.ensure_sound_channel(author_id, author_username, author_sec_uid):
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
            proxy=get_proxy(),
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
            proxy=get_proxy(),
        )

    _audio_only = isinstance(dl_result, dict) and dl_result.get("audio_only")
    if dl_result and not _audio_only:
        store.add_video_full(
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
        db.update_video_downloaded(vid_id, dl_result["file_path"], None)
        log(f"Saved {vid_id} from @{author_username} -> {dl_result['file_path']}")
        return "saved"
    elif _audio_only:
        store.add_video_full(
            vid_id, author_id, "audio",
            details["description"], details["upload_date"],
            view_count=details.get("view_count"),
            like_count=details.get("like_count"),
            comment_count=details.get("comment_count"),
            share_count=details.get("share_count"),
            save_count=details.get("save_count"),
            repost_count=details.get("repost_count"),
            duration=details.get("duration"),
            music_title=details.get("music_title"),
            music_artist=details.get("music_artist"),
            music_id=details.get("music_id"),
        )
        log(f"Skipped {vid_id}: audio-only post")
        return "audio"
    log(f"Failed to download {vid_id}")
    return None


def run_direct_video(engine, vid_id: str, log: Callable[[str], None]) -> None:
    """Entry point for the direct post URL add flow.

    Saves one post that profile listings cannot surface (e.g. subscriber-only
    videos) and flags it direct_added so listing-based deletion detection
    leaves it alone. Ban handling still applies: bans mark videos by channel,
    not by listing diff.
    """
    _bind(engine)
    # The page scrape intermittently returns no item data (soft bot detection)
    # and succeeds on a later attempt. The sound loop retries next cycle; the
    # direct flow has no next cycle, so retry here before giving up.
    result = None
    for attempt in range(3):
        if attempt:
            time.sleep(15)
            log(f"Retrying direct post {vid_id} (attempt {attempt + 1}/3)")
        result = save_video_by_id(vid_id, get_cookies_flat(), log)
        if result:
            break
    if result:
        store.set_video_direct_added(vid_id)
        log(f"Direct post {vid_id} recorded; exempt from deletion checks")
    else:
        log(f"Direct post {vid_id} failed after 3 attempts; paste the URL again to retry")
