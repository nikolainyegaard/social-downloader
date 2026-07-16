"""TikTok platform adapter over the channel engine.

TikTok overrides the engine's generic tracker with its own session processor
(one Playwright browser session per run, bot-detection recovery, photo posts,
ban and privacy machinery), so fetch_profile/iter_posts/download_item are
never called. Sounds, the add queue, stats backfill, and the maintenance jobs
register as extra routes and threads.
"""

from __future__ import annotations

import asyncio
import re
from datetime import datetime

from engine import ChannelAdapter
from platforms.tiktok import tracker
from platforms.tiktok.config import SOUND_LOOP_INTERVAL_MINUTES, STATS_REFRESH_DAYS
from platforms.tiktok.store import TikTokStore


def _logd(msg: str) -> None:
    """Terminal-only log line (implementation detail, not shown in the UI)."""
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}")


def _normalize_handle(raw: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_.]", "", raw.strip().lstrip("@"))


async def _api_lookup(handle: str, sec_uid: str | None):
    from TikTokApi import TikTokApi
    from platforms.tiktok.config import get_ms_token, get_cookies_flat
    from platforms.tiktok.api import create_tiktok_session, get_user_info

    ms_token = get_ms_token()
    cookies  = get_cookies_flat()
    async with TikTokApi() as api:
        await create_tiktok_session(api, ms_token, cookies)
        return await get_user_info(api, username=handle, sec_uid=sec_uid)


def _lookup_profile(handle: str) -> dict:
    """Add-flow resolve via a dedicated browser session. A soft-disabled stub
    (sound-discovered author) resolves by its stored sec_uid, which survives
    handle changes."""
    from platforms.registry import ENGINES
    engine  = ENGINES["tiktok"]
    stub    = engine.db.get_channel_by_handle(handle)
    sec_uid = (stub or {}).get("sec_uid")

    info = asyncio.run(_api_lookup(handle, sec_uid))
    if not info.get("tiktok_id"):
        return {}
    return {
        "channel_id":       info["tiktok_id"],
        "handle":           info["username"],
        "display_name":     info["display_name"],
        "description":      info["bio"],
        "subscriber_count": info["follower_count"],
        "following_count":  info["following_count"],
        "video_count":      info["video_count"],
        "join_date":        info.get("join_date"),
        "sec_uid":          info.get("sec_uid"),
        "verified":         int(info.get("verified", False)),
        "avatar_url":       info.get("avatar_url"),
        "bio_link":         info.get("bio_link"),
        "raw_channel_data": info.get("_raw_user_data"),
    }


def _process_session(engine, channels, log, set_current, stop_event,
                     set_sleep=None, on_large_deletion=None) -> int:
    return asyncio.run(tracker.process_user_session(
        engine, channels, log, _logd, set_current, stop_event,
        set_sleep=set_sleep, on_large_deletion=on_large_deletion)) or 0


def _process_single(engine, channel, log, set_current, profile_only=False, mode="full") -> None:
    asyncio.run(tracker.run_single_user_with_session(
        engine, channel, log, _logd, profile_only=profile_only, mode=mode))


def _init_db_extra(engine) -> None:
    TikTokStore(engine.db).init_tables()


def _extend_status(engine, state: dict) -> None:
    from platforms.tiktok.sounds import get_sound_loop
    state.update(get_sound_loop(engine).get_state())


def _on_settings_changed(engine, changed_keys: list[str]) -> None:
    if "sound_loop_interval_minutes" in changed_keys:
        from platforms.tiktok.sounds import get_sound_loop
        get_sound_loop(engine).reschedule()


def _unused(*_args, **_kwargs):
    raise RuntimeError("TikTok uses the process_session/process_single overrides")


def _register_extra_routes(bp, engine) -> None:
    from platforms.tiktok.web import register_tiktok_routes
    register_tiktok_routes(bp, engine)


tiktok_adapter = ChannelAdapter(
    platform="tiktok",
    label="TikTok",
    prefix="tt",
    creator_noun="user",
    item_noun="video",
    quick_limit=30,
    has_banner=False,
    has_stories=True,
    normalize_handle=_normalize_handle,
    lookup_profile=_lookup_profile,
    fetch_profile=_unused,
    iter_posts=_unused,
    download_item=_unused,
    register_extra_routes=_register_extra_routes,
    process_session=_process_session,
    process_single=_process_single,
    init_db_extra=_init_db_extra,
    extend_status=_extend_status,
    extra_settings={
        "sound_loop_interval_minutes": SOUND_LOOP_INTERVAL_MINUTES,
        "stats_refresh_days":          STATS_REFRESH_DAYS,
    },
    on_settings_changed=_on_settings_changed,
)
