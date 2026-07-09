"""Instagram adapter for the channel engine."""

from __future__ import annotations

import os

from config import MEDIA_DIR
from engine import ChannelAdapter
from platforms.instagram import api


def _fetch_profile(channel: dict) -> dict:
    return api.fetch_profile_info(channel["handle"])


def _download_item(engine, channel_id, handle, display_name, vid_id, post, raw_post, log) -> None:
    dest_dir = os.path.join(MEDIA_DIR, "instagram", f"@{handle}")
    engine.db.add_video(
        vid_id, channel_id, post.get("title"), post.get("upload_date"),
        view_count=post.get("view_count"), duration=post.get("duration"),
        content_type=post.get("content_type", "video"),
    )
    file_path = api.download_post_media(raw_post, dest_dir)
    if file_path:
        engine.db.update_video_downloaded(vid_id, file_path)
        log(f"  Saved {vid_id} -> {file_path}")
    else:
        log(f"  Failed to download {vid_id} (recorded in DB)")


def _register_extra_routes(bp, engine) -> None:
    import instaloader
    from flask import jsonify, request

    @bp.route("/diagnostics", methods=["POST"])
    def run_diagnostics():
        body   = request.get_json(silent=True) or {}
        handle = api.normalize_handle(body.get("handle", "").strip())
        action = body.get("action", "profile")
        if not handle:
            return jsonify({"error": "handle is required"}), 400
        try:
            if action == "profile":
                info = api.fetch_profile_info(handle)
                return jsonify({"ok": True, "result": info})
            elif action == "posts":
                info  = api.fetch_profile_info(handle)
                posts = []
                for post_dict, _ in api.iter_profile_posts(info["channel_id"]):
                    posts.append(post_dict)
                    if len(posts) >= 5:
                        break
                return jsonify({"ok": True, "result": {"profile": info, "posts": posts}})
            else:
                return jsonify({"error": "unknown action"}), 400
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500

    @bp.route("/session", methods=["GET"])
    def get_session():
        return jsonify(api.get_session_status())

    @bp.route("/session", methods=["POST"])
    def session_login():
        body     = request.get_json(silent=True) or {}
        username = (body.get("username") or "").strip()
        password = body.get("password") or ""
        if not username or not password:
            return jsonify({"error": "username and password are required"}), 400
        try:
            api.login(username, password)
            return jsonify({"ok": True, "username": username})
        except instaloader.TwoFactorAuthRequiredException:
            return jsonify({"ok": False, "error": "Two-factor authentication is required; disable 2FA or use an app password"}), 400
        except instaloader.BadCredentialsException:
            return jsonify({"ok": False, "error": "Incorrect username or password"}), 400
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 400

    @bp.route("/session", methods=["DELETE"])
    def session_logout():
        api.logout()
        return jsonify({"ok": True})


instagram_adapter = ChannelAdapter(
    platform="instagram",
    label="Instagram",
    prefix="ig",
    creator_noun="profile",
    item_noun="post",
    quick_limit=30,
    has_banner=False,
    normalize_handle=api.normalize_handle,
    lookup_profile=api.fetch_profile_info,
    fetch_profile=_fetch_profile,
    iter_posts=api.iter_profile_posts,
    download_item=_download_item,
    register_extra_routes=_register_extra_routes,
)
