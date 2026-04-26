"""YouTube Flask Blueprint: all /api/youtube/* routes."""

from __future__ import annotations

import glob as _glob
import os
import queue as _queue_module
import re
import threading
import time
from flask import Blueprint, jsonify, request, send_file

from platforms.youtube import database as db
from config import MEDIA_DIR
from platforms.youtube.api import fetch_channel_info, normalize_handle
from platforms.youtube.loop import (
    is_running, get_state_snapshot, trigger_event,
    enqueue_channel_run, reschedule_loop,
    LOOP_INTERVAL_MINUTES,
)
from thumbnailer import thumb_path_for

youtube_bp = Blueprint("youtube", __name__, url_prefix="/api/youtube")

_add_queue    = _queue_module.Queue()
_pending_lock = threading.Lock()
_pending: dict = {}  # handle -> {"status": "pending"|"error", "message": str}

_cleanup_lock  = threading.Lock()
_cleanup_state: dict = {"running": False, "current": "", "steps": [], "removed": 0, "done": False}


def _process_add(handle: str) -> None:
    try:
        info = fetch_channel_info(f"@{handle}")
    except Exception as e:
        with _pending_lock:
            _pending[handle] = {"status": "error", "message": f"Lookup error: {e}"}
        return

    channel_id = info.get("channel_id")
    if not channel_id:
        with _pending_lock:
            _pending[handle] = {"status": "error", "message": "Channel not found"}
        return

    if db.get_channel(channel_id):
        with _pending_lock:
            _pending[handle] = {"status": "error", "message": "Channel is already being tracked"}
        return

    db.add_channel(
        channel_id=channel_id,
        handle=info.get("handle") or handle,
        display_name=info.get("display_name"),
        description=info.get("description"),
        subscriber_count=info.get("subscriber_count"),
        video_count=info.get("video_count"),
        avatar_url=info.get("avatar_url"),
        banner_url=info.get("banner_url"),
    )
    with _pending_lock:
        del _pending[handle]


def _add_worker() -> None:
    while True:
        handle = _add_queue.get()
        try:
            _process_add(handle)
        except Exception as e:
            with _pending_lock:
                _pending[handle] = {"status": "error", "message": str(e)}
        finally:
            _add_queue.task_done()


threading.Thread(target=_add_worker, daemon=True, name="yt-add-worker").start()


def _run_cleanup() -> None:
    with _cleanup_lock:
        _cleanup_state.update({"running": True, "current": "Starting...",
                                "steps": [], "removed": 0, "done": False})
    removed = 0
    steps: list[str] = []
    try:
        with _cleanup_lock:
            _cleanup_state["current"] = "Removing records for untracked channels..."
        n = db.delete_orphaned_records()
        steps.append(f"Removed {n} orphaned DB record{'s' if n != 1 else ''}")
        removed += n
        with _cleanup_lock:
            _cleanup_state["steps"] = list(steps)

        with _cleanup_lock:
            _cleanup_state["current"] = "Scanning thumbnails..."
        video_ids   = db.get_all_video_ids()
        thumb_count = 0
        for thumbs_dir in _glob.glob(os.path.join(MEDIA_DIR, "youtube", "*", "thumbs")):
            for thumb in _glob.glob(os.path.join(thumbs_dir, "*.avif")):
                vid_id = os.path.splitext(os.path.basename(thumb))[0]
                if vid_id not in video_ids:
                    try:
                        os.remove(thumb)
                        thumb_count += 1
                    except OSError:
                        pass
        n = thumb_count
        steps.append(f"Removed {n} orphaned thumbnail{'s' if n != 1 else ''}")
        removed += n
        with _cleanup_lock:
            _cleanup_state["steps"] = list(steps)

        with _cleanup_lock:
            _cleanup_state["current"] = "Vacuuming database..."
        size_before = os.path.getsize(db.DB_PATH) if os.path.exists(db.DB_PATH) else 0
        db.vacuum()
        size_after  = os.path.getsize(db.DB_PATH) if os.path.exists(db.DB_PATH) else 0

        def _fmt_mb(b: int) -> str:
            return f"{b / 1_048_576:.1f} MB"

        if size_before != size_after:
            steps.append(f"Database vacuumed ({_fmt_mb(size_before)} -> {_fmt_mb(size_after)})")
        else:
            steps.append("Database vacuumed (no size change)")
        with _cleanup_lock:
            _cleanup_state["steps"] = list(steps)

    except Exception as e:
        steps.append(f"Error: {e}")

    with _cleanup_lock:
        _cleanup_state.update({"running": False, "current": "", "steps": steps,
                                "removed": removed, "done": True})


# Channel API

@youtube_bp.route("/channels", methods=["GET"])
def list_channels():
    channels      = db.get_all_channels()
    all_stats     = db.get_all_video_stats()
    all_ph_counts = db.get_all_profile_history_counts()
    for ch in channels:
        cid   = ch["channel_id"]
        stats = all_stats.get(cid, {})
        ch["video_total"]           = stats.get("video_total",      0)
        ch["video_downloaded"]      = stats.get("video_downloaded",  0)
        ch["video_deleted"]         = stats.get("video_deleted",     0)
        ch["video_undeleted"]       = stats.get("video_undeleted",   0)
        ch["video_missing"]         = stats.get("video_missing",     0)
        ch["profile_history_count"] = all_ph_counts.get(cid, 0)
    return jsonify(channels)


@youtube_bp.route("/channels", methods=["POST"])
def add_channel():
    body   = request.get_json(silent=True) or {}
    raw    = body.get("handle", "").strip()
    handle = normalize_handle(raw)

    if not handle:
        return jsonify({"error": "handle is required"}), 400

    existing = db.get_all_channels()
    if any(c["handle"].lower() == handle.lower() for c in existing):
        return jsonify({"error": "Channel is already being tracked"}), 409

    with _pending_lock:
        if _pending.get(handle, {}).get("status") == "pending":
            return jsonify({"error": "Already queued"}), 409
        _pending[handle] = {"status": "pending"}

    _add_queue.put(handle)
    return jsonify({"queued": True, "handle": handle}), 202


@youtube_bp.route("/queue", methods=["GET"])
def get_queue():
    with _pending_lock:
        return jsonify(dict(_pending))


@youtube_bp.route("/queue/<handle>", methods=["DELETE"])
def dismiss_queue_entry(handle: str):
    with _pending_lock:
        entry = _pending.get(handle)
        if entry and entry.get("status") == "pending":
            return jsonify({"error": "Cannot dismiss a pending lookup"}), 409
        _pending.pop(handle, None)
    return jsonify({"ok": True})


@youtube_bp.route("/channels/<channel_id>", methods=["DELETE"])
def remove_channel(channel_id: str):
    db.remove_channel(channel_id)
    return jsonify({"ok": True})


@youtube_bp.route("/channels/<channel_id>/videos", methods=["GET"])
def channel_videos(channel_id: str):
    return jsonify(db.get_videos_for_channel(channel_id))


@youtube_bp.route("/channels/<channel_id>/run", methods=["POST"])
def run_channel(channel_id: str):
    if not db.get_channel(channel_id):
        return jsonify({"error": "Channel not found"}), 404
    if not enqueue_channel_run(channel_id):
        return jsonify({"error": "Already queued or running"}), 409
    return jsonify({"ok": True})


@youtube_bp.route("/channels/<channel_id>/tracking", methods=["PATCH"])
def set_channel_tracking(channel_id: str):
    if not db.get_channel(channel_id):
        return jsonify({"error": "Channel not found"}), 404
    body    = request.get_json(silent=True) or {}
    enabled = body.get("enabled")
    if not isinstance(enabled, bool):
        return jsonify({"error": "enabled must be a boolean"}), 400
    db.set_channel_tracking_enabled(channel_id, enabled)
    return jsonify({"ok": True})


@youtube_bp.route("/channels/<channel_id>/star", methods=["PATCH"])
def set_channel_star(channel_id: str):
    if not db.get_channel(channel_id):
        return jsonify({"error": "Channel not found"}), 404
    body    = request.get_json(silent=True) or {}
    starred = body.get("starred")
    if not isinstance(starred, bool):
        return jsonify({"error": "starred must be a boolean"}), 400
    db.set_channel_starred(channel_id, starred)
    return jsonify({"ok": True})


@youtube_bp.route("/channels/<channel_id>/comment", methods=["PATCH"])
def set_channel_comment(channel_id: str):
    if not db.get_channel(channel_id):
        return jsonify({"error": "Channel not found"}), 404
    body    = request.get_json(silent=True) or {}
    comment = body.get("comment", "")
    if not isinstance(comment, str):
        return jsonify({"error": "comment must be a string"}), 400
    db.set_channel_comment(channel_id, comment.strip())
    return jsonify({"ok": True})


@youtube_bp.route("/channels/<channel_id>/profile-history", methods=["GET"])
def channel_profile_history(channel_id: str):
    return jsonify(db.get_profile_history(channel_id))


# Channel avatar

@youtube_bp.route("/channels/<channel_id>/avatar", methods=["GET"])
def channel_avatar(channel_id: str):
    from config import DATA_DIR
    path = os.path.join(DATA_DIR, "youtube", "avatars", f"{channel_id}.avif")
    if os.path.exists(path):
        return send_file(path, mimetype="image/avif")
    return ("", 404)


@youtube_bp.route("/channels/<channel_id>/banner", methods=["GET"])
def channel_banner(channel_id: str):
    from config import DATA_DIR
    path = os.path.join(DATA_DIR, "youtube", "banners", f"{channel_id}.avif")
    if os.path.exists(path):
        return send_file(path, mimetype="image/avif")
    return ("", 404)


# Video API

@youtube_bp.route("/videos/<video_id>/thumbnail", methods=["GET"])
def video_thumbnail(video_id: str):
    video = db.get_video(video_id)
    if not video or not video.get("file_path"):
        return ("", 404)
    avif = thumb_path_for(video_id, video["file_path"])
    jpg  = avif.replace(".avif", ".jpg")
    if os.path.exists(avif):
        return send_file(avif, mimetype="image/avif")
    if os.path.exists(jpg):
        return send_file(jpg, mimetype="image/jpeg")
    return ("", 404)


@youtube_bp.route("/videos/<video_id>/file", methods=["GET"])
def video_file(video_id: str):
    video = db.get_video(video_id)
    if not video or not video.get("file_path"):
        return ("", 404)
    path = video["file_path"]
    if not os.path.exists(path):
        return ("", 404)
    return send_file(path, conditional=True)


# Stats and recent activity

@youtube_bp.route("/stats", methods=["GET"])
def get_aggregate_stats():
    return jsonify(db.get_aggregate_stats())


@youtube_bp.route("/recent", methods=["GET"])
def get_recent():
    return jsonify(db.get_recent_activity())


# DB cleanup

@youtube_bp.route("/db/cleanup", methods=["GET"])
def get_cleanup_status():
    with _cleanup_lock:
        return jsonify(dict(_cleanup_state))


@youtube_bp.route("/db/cleanup", methods=["POST"])
def start_cleanup():
    with _cleanup_lock:
        if _cleanup_state["running"]:
            return jsonify({"error": "Already running"}), 409
    threading.Thread(target=_run_cleanup, daemon=True, name="yt-db-cleanup").start()
    return jsonify({"ok": True})


# Loop API

@youtube_bp.route("/status", methods=["GET"])
def get_status():
    return jsonify(get_state_snapshot())


@youtube_bp.route("/trigger", methods=["POST"])
def trigger_now():
    if is_running():
        return jsonify({"error": "Loop is already running"}), 409
    trigger_event.set()
    return jsonify({"ok": True})


@youtube_bp.route("/settings", methods=["GET"])
def get_settings():
    return jsonify({
        "loop_interval_minutes": int(db.get_setting("loop_interval_minutes", LOOP_INTERVAL_MINUTES)),
    })


@youtube_bp.route("/settings", methods=["PATCH"])
def update_settings():
    body = request.get_json(silent=True) or {}
    if "loop_interval_minutes" in body:
        val = body["loop_interval_minutes"]
        if not isinstance(val, int) or val < 1:
            return jsonify({"error": "loop_interval_minutes must be a positive integer"}), 400
        db.set_setting("loop_interval_minutes", val)
        reschedule_loop()
    return jsonify({"ok": True})
