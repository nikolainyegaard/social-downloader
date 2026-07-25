"""YouTube adapter for the channel engine."""

from __future__ import annotations

import json
import time

from engine import ChannelAdapter, ChannelGoneError
from platforms.youtube import api

# Definitive account-gone signals from yt-dlp. The loop fetches by stable
# channel ID, so a rename never matches; only a dead channel does.
_GONE_MARKERS = ("does not exist", "has been terminated", "http error 404")


def _lookup_profile(handle: str) -> dict:
    return api.fetch_channel_info(f"@{handle}")


def _fetch_profile(channel: dict) -> dict:
    try:
        return api.fetch_channel_info(f"https://www.youtube.com/channel/{channel['channel_id']}")
    except Exception as e:
        msg = str(e).lower()
        if any(m in msg for m in _GONE_MARKERS):
            raise ChannelGoneError(str(e)) from e
        raise


def _iter_posts(channel_id: str, limit: int | None = None):
    # limit is unused: yt-dlp flat extraction returns the full list in one call
    # either way, so quick mode saves no API calls here; the semantics match the
    # other platforms.
    for v in api.fetch_channel_videos(channel_id):
        yield v, None


def _download_item(engine, channel_id, handle, display_name, vid_id, post, raw, log) -> None:
    from downloader import download_video

    result = download_video(
        video_id=vid_id,
        username=handle,
        tiktok_id=channel_id,
        display_name=display_name,
        description=post.get("title") or "",
        upload_date=post.get("upload_date") or int(time.time()),
        download_date=int(time.time()),
        platform="youtube",
        url=f"https://www.youtube.com/watch?v={vid_id}",
    )
    if result:
        upload_date = post.get("upload_date") or result.get("upload_date")
        engine.db.add_video(
            vid_id, channel_id, post.get("title"), upload_date,
            view_count=post.get("view_count"), duration=post.get("duration"),
            content_type=post.get("content_type", "video"),
        )
        engine.db.update_video_downloaded(vid_id, result["file_path"], result.get("ytdlp_data"))
        log(f"  Saved {vid_id} -> {result['file_path']}")
    else:
        log(f"  Failed to download {vid_id}")


def _register_extra_routes(bp, engine) -> None:
    from flask import jsonify, request

    @bp.route("/debug/channel-videos", methods=["POST"])
    def debug_channel_videos():
        body = request.get_json(silent=True) or {}
        channel_id = body.get("channel_id", "").strip()
        if not channel_id:
            return jsonify({"error": "channel_id is required"}), 400
        try:
            try:
                profile = api.fetch_channel_info(f"https://www.youtube.com/channel/{channel_id}")
                if profile.get("raw_channel_data"):
                    profile["raw_channel_data"] = json.loads(profile["raw_channel_data"])
            except Exception as pe:
                profile = {"error": str(pe)}
            entries = api._raw_fetch_entries(channel_id, limit=5)
            return jsonify({"ok": True, "profile": profile, "entries": entries})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500


youtube_adapter = ChannelAdapter(
    platform="youtube",
    label="YouTube",
    prefix="yt",
    creator_noun="channel",
    item_noun="video",
    quick_limit=None,
    has_banner=True,
    normalize_handle=api.normalize_handle,
    lookup_profile=_lookup_profile,
    fetch_profile=_fetch_profile,
    iter_posts=_iter_posts,
    download_item=_download_item,
    register_extra_routes=_register_extra_routes,
)
