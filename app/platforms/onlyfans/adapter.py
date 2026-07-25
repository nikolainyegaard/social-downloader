"""OnlyFans adapter for the channel engine."""

from __future__ import annotations

import os

from config import MEDIA_DIR
from engine import ChannelAdapter, ChannelGoneError
from platforms.onlyfans import api
from thumbnailer import generate_thumbnail

# Definitive account-gone signals. Kept narrow: an unsubscribed or renamed
# creator also reads as "not found", so the ban clears itself once the account
# is accessible again. Auth failures use different wording and stay transient.
_GONE_MARKERS = ("not found", "suspended", "does not exist")


def _fetch_profile(channel: dict) -> dict:
    try:
        return api.fetch_profile_info(channel["handle"])
    except Exception as e:
        msg = str(e).lower()
        if any(m in msg for m in _GONE_MARKERS):
            raise ChannelGoneError(str(e)) from e
        raise


def _download_item(engine, channel_id, handle, display_name, vid_id, post, files, log) -> None:
    dest_dir = os.path.join(MEDIA_DIR, "onlyfans", f"@{handle}")
    engine.db.add_video(
        vid_id, channel_id, post.get("title"), post.get("upload_date"),
        view_count=post.get("view_count"), duration=post.get("duration"),
        content_type=post.get("content_type", "video"),
    )
    file_path = api.download_post_media(files, vid_id, dest_dir, post.get("upload_date"))
    if file_path:
        engine.db.update_video_downloaded(vid_id, file_path)
        generate_thumbnail(vid_id, file_path)
        log(f"  Saved {vid_id} -> {file_path}")
    else:
        log(f"  Failed to download {vid_id} (recorded in DB)")


def _register_extra_routes(bp, engine) -> None:
    from flask import jsonify, request
    from cookies import register_cookie_routes

    register_cookie_routes(bp, "onlyfans", on_change=api.validate_auth_file)

    @bp.route("/jobs/clean-html", methods=["POST"])
    def clean_html_job():
        with engine.db.get_db() as conn:
            results = api.clean_stored_html(conn)
        return jsonify({"ok": True, "results": results,
                        "rewrote": sum(r["dirty"] for r in results)})

    @bp.route("/diagnostics", methods=["POST"])
    def run_diagnostics():
        body = request.get_json(silent=True) or {}
        handle = api.normalize_handle(body.get("handle", "").strip())
        action = body.get("action", "profile")
        if not handle:
            return jsonify({"error": "handle is required"}), 400
        try:
            if action == "profile":
                info = api.fetch_profile_info(handle)
                return jsonify({"ok": True, "result": info})
            elif action == "posts":
                info = api.fetch_profile_info(handle)
                posts = []
                # limit=20 not 5: text-only and fully locked posts are filtered
                # out of the iterator, so leave headroom to still fill 5.
                for post_dict, files in api.iter_profile_posts(info["channel_id"], limit=20):
                    posts.append({**post_dict, "media": files})
                    if len(posts) >= 5:
                        break
                return jsonify({"ok": True, "result": {"profile": info, "posts": posts}})
            else:
                return jsonify({"error": "unknown action"}), 400
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500


onlyfans_adapter = ChannelAdapter(
    platform="onlyfans",
    label="OnlyFans",
    prefix="of",
    creator_noun="creator",
    item_noun="post",
    quick_limit=30,
    has_banner=True,
    normalize_handle=api.normalize_handle,
    lookup_profile=api.fetch_profile_info,
    fetch_profile=_fetch_profile,
    iter_posts=api.iter_profile_posts,
    download_item=_download_item,
    register_extra_routes=_register_extra_routes,
)
