"""TikTok Flask Blueprint: all /api/tiktok/* routes."""

from __future__ import annotations

import asyncio
import glob as _glob
import io
import json
import os
import queue as _queue_module
import re
import threading
import time
import traceback
import zipfile
from flask import Blueprint, jsonify, request, send_file

from platforms.tiktok import database as db
from config import DATA_DIR, MEDIA_DIR, CHROME_EXECUTABLE
from platforms.tiktok.config import (
    get_ms_token, get_cookies_flat, cookies_info,
    COOKIES_PATH, COOKIES_TIMESTAMP_PATH, AVATARS_DIR,
    USER_LOOP_INTERVAL_MINUTES, SOUND_LOOP_INTERVAL_MINUTES, DELETION_CONFIRM_THRESHOLD,
)
from platforms.tiktok.api import get_user_info, get_video_details, UserBannedException
from platforms.tiktok.loop import (
    is_user_loop_running, is_sound_loop_running, get_state_snapshot,
    trigger_user_event, trigger_sound_event,
    enqueue_user_run, enqueue_user_profile_run, enqueue_sound_run,
    reschedule_user_loop, reschedule_sound_loop,
)
from thumbnailer import thumb_path_for, avatar_path
import photo_converter as _photo_converter

tiktok_bp = Blueprint("tiktok", __name__, url_prefix="/api/tiktok")


# Add-user queue

_add_queue:   _queue_module.Queue = _queue_module.Queue()
_pending_lock = threading.Lock()
_pending: dict = {}  # username -> {"status": "pending"|"error", "message": str}


def _process_add(username: str) -> None:
    ms_token     = get_ms_token()
    cookies_flat = get_cookies_flat()

    async def _lookup():
        from TikTokApi import TikTokApi
        async with TikTokApi() as api:
            await api.create_sessions(
                ms_tokens=[ms_token] if ms_token else [],
                num_sessions=1,
                sleep_after=3,
                executable_path=CHROME_EXECUTABLE,
                cookies=[cookies_flat] if cookies_flat else None,
            )
            return await get_user_info(api, username=username)

    try:
        info = asyncio.run(_lookup())
    except UserBannedException as e:
        with _pending_lock:
            _pending[username] = {"status": "error", "message": str(e)}
        return
    except Exception as e:
        with _pending_lock:
            _pending[username] = {"status": "error", "message": f"TikTok API error: {e}"}
        return

    if not info.get("tiktok_id"):
        with _pending_lock:
            _pending[username] = {"status": "error", "message": "User not found"}
        return

    existing = db.get_user(info["tiktok_id"])
    if existing:
        if not existing.get("enabled"):
            # Sound-discovered stub (enabled=0); promote to a fully tracked user.
            db.set_user_enabled(info["tiktok_id"], True)
            db.update_user_info(
                tiktok_id=info["tiktok_id"],
                username=info["username"],
                display_name=info["display_name"],
                bio=info["bio"],
                follower_count=info["follower_count"],
                following_count=info["following_count"],
                video_count=info["video_count"],
                sec_uid=info.get("sec_uid"),
            )
            with _pending_lock:
                del _pending[username]
            return
        # Fully tracked user already exists.
        db.update_user_info(
            tiktok_id=info["tiktok_id"],
            username=info["username"],
            display_name=info["display_name"],
            bio=info["bio"],
            follower_count=info["follower_count"],
            following_count=info["following_count"],
            video_count=info["video_count"],
            sec_uid=info.get("sec_uid"),
        )
        with _pending_lock:
            _pending[username] = {"status": "error", "message": "User is already being tracked"}
        return

    db.add_user(
        tiktok_id=info["tiktok_id"],
        sec_uid=info.get("sec_uid"),
        username=info["username"],
        display_name=info["display_name"],
        bio=info["bio"],
        follower_count=info["follower_count"],
        following_count=info["following_count"],
        video_count=info["video_count"],
        join_date=info["join_date"],
    )
    with _pending_lock:
        del _pending[username]  # success: now in DB, frontend picks it up via /api/tiktok/users


def _add_worker() -> None:
    while True:
        username = _add_queue.get()
        try:
            _process_add(username)
        except Exception as e:
            with _pending_lock:
                _pending[username] = {"status": "error", "message": str(e)}
        finally:
            _add_queue.task_done()


threading.Thread(target=_add_worker, daemon=True, name="add-worker").start()


# Stats backfill

_backfill_lock  = threading.Lock()
_backfill_state: dict = {"running": False, "done": 0, "total": 0, "errors": 0}


# Database cleanup

_cleanup_lock  = threading.Lock()
_cleanup_state: dict = {"running": False, "current": "", "steps": [], "removed": 0, "done": False}


# Job reports

REPORTS_DIR = os.path.join(DATA_DIR, "reports")
os.makedirs(REPORTS_DIR, exist_ok=True)


def _write_report(slug: str, header: str, lines: list[str]) -> str:
    ts       = time.strftime("%Y%m%d-%H%M%S")
    filename = f"{slug}-{ts}.txt"
    path     = os.path.join(REPORTS_DIR, filename)
    with open(path, "w", encoding="utf-8") as f:
        f.write(header + "\n\n")
        for line in lines:
            f.write(line + "\n")
    return filename


# Missing file check

_file_check_lock  = threading.Lock()
_file_check_state: dict = {
    "running":     False,
    "mode":        None,   # "scan" | "purge"
    "found":       0,
    "removed":     0,
    "preview":     [],     # first 10 file paths
    "report_file": None,   # filename in REPORTS_DIR
    "last_run":    None,
}


def _run_file_scan() -> None:
    with _file_check_lock:
        if _file_check_state["running"]:
            return
        _file_check_state.update({"running": True, "mode": "scan",
                                   "found": 0, "removed": 0,
                                   "preview": [], "report_file": None})

    print("[file-check] Scanning for missing video files...")
    try:
        missing  = db.find_missing_video_files()
        paths    = [e["file_path"] for e in missing]
        count    = len(missing)
        header   = f"Missing file check - scan - {time.strftime('%Y-%m-%d %H:%M:%S')}\n{count} missing file(s) found"
        filename = _write_report("file-check-scan", header, paths)
        with _file_check_lock:
            _file_check_state.update({"found": count, "preview": paths[:10],
                                       "report_file": filename})
        print(f"[file-check] Scan done: {count} missing.")
    except Exception as e:
        print(f"[file-check] Scan error: {e}")
    finally:
        with _file_check_lock:
            _file_check_state["running"]  = False
            _file_check_state["last_run"] = time.strftime("%Y-%m-%d %H:%M:%S")


def _run_file_purge() -> None:
    with _file_check_lock:
        if _file_check_state["running"]:
            return
        _file_check_state.update({"running": True, "mode": "purge",
                                   "found": 0, "removed": 0,
                                   "preview": [], "report_file": None})

    print("[file-check] Purging missing video file records...")
    try:
        missing  = db.find_missing_video_files()
        paths    = [e["file_path"] for e in missing]
        count    = len(missing)
        for entry in missing:
            db.delete_video(entry["video_id"])
        header   = f"Missing file check - purge - {time.strftime('%Y-%m-%d %H:%M:%S')}\n{count} record(s) removed from database"
        filename = _write_report("file-check-purge", header, paths)
        with _file_check_lock:
            _file_check_state.update({"found": count, "removed": count,
                                       "preview": paths[:10],
                                       "report_file": filename})
        print(f"[file-check] Purge done: {count} record(s) removed.")
    except Exception as e:
        print(f"[file-check] Purge error: {e}")
    finally:
        with _file_check_lock:
            _file_check_state["running"]  = False
            _file_check_state["last_run"] = time.strftime("%Y-%m-%d %H:%M:%S")


# Audio file cleanup

_AUDIO_EXTENSIONS = frozenset([".mp3", ".m4a", ".m4b", ".aac", ".ogg", ".wav", ".flac", ".opus"])

_audio_cleanup_lock  = threading.Lock()
_audio_cleanup_state: dict = {
    "running":    False,
    "found":      0,
    "deleted":    0,
    "db_removed": 0,
    "errors":     0,
    "last_run":   None,
}


def _run_audio_cleanup() -> None:
    with _audio_cleanup_lock:
        if _audio_cleanup_state["running"]:
            return
        _audio_cleanup_state.update({"running": True, "found": 0, "deleted": 0, "db_removed": 0, "errors": 0})

    print(f"[audio-cleanup] Scanning {MEDIA_DIR} for audio-only files...")
    try:
        audio_files = [
            p for p in _glob.glob(os.path.join(MEDIA_DIR, "*", "@*", "*"))
            if os.path.isfile(p) and os.path.splitext(p)[1].lower() in _AUDIO_EXTENSIONS
        ]

        with _audio_cleanup_lock:
            _audio_cleanup_state["found"] = len(audio_files)

        print(f"[audio-cleanup] Found {len(audio_files)} audio file(s)")

        for path in audio_files:
            video_id = os.path.splitext(os.path.basename(path))[0]
            try:
                os.remove(path)
                with _audio_cleanup_lock:
                    _audio_cleanup_state["deleted"] += 1
                print(f"[audio-cleanup] Deleted {path}")
            except OSError as e:
                print(f"[audio-cleanup] Failed to delete {path}: {e}")
                with _audio_cleanup_lock:
                    _audio_cleanup_state["errors"] += 1
                continue

            if db.delete_video(video_id):
                with _audio_cleanup_lock:
                    _audio_cleanup_state["db_removed"] += 1
                print(f"[audio-cleanup] Removed {video_id} from database")

    except Exception as e:
        print(f"[audio-cleanup] Unexpected error: {e}")
    finally:
        with _audio_cleanup_lock:
            _audio_cleanup_state["running"]  = False
            _audio_cleanup_state["last_run"] = time.strftime("%Y-%m-%d %H:%M:%S")


def _run_backfill() -> None:
    videos  = db.get_videos_missing_stats()
    cookies = get_cookies_flat()
    total   = len(videos)

    with _backfill_lock:
        _backfill_state.update({"running": True, "done": 0, "total": total, "errors": 0})

    print(f"[backfill] Starting: {total} video(s) to process")

    for v in videos:
        vid_id   = v["video_id"]
        username = v["username"]
        success_details = None
        try:
            details = get_video_details(vid_id, username, cookies)
            db.update_video_stats(
                vid_id,
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
            )
            success_details = details
        except Exception as e:
            error_str = str(e)
            error_count = db.increment_stats_error(vid_id, error_str)
            with _backfill_lock:
                _backfill_state["errors"] += 1
            if "HTTP 404" in error_str or "No item data" in error_str or "Could not find page data" in error_str:
                category = "not found (video may be deleted on TikTok)"
            elif "HTTP " in error_str:
                category = "HTTP error"
            elif "timeout" in error_str.lower():
                category = "timeout"
            else:
                category = "fetch error"
            print(f"[backfill] FAIL ({error_count}/3) {vid_id} (@{username}): {category}: {e}")
        with _backfill_lock:
            _backfill_state["done"] += 1
            done = _backfill_state["done"]
        if success_details is not None:
            print(f"[backfill] {done}/{total} OK: {vid_id} (@{username})"
                  f" views={success_details.get('view_count')}")
        time.sleep(1.5)

    with _backfill_lock:
        errors = _backfill_state["errors"]
    print(f"[backfill] Done: {total} processed, {errors} error(s)")

    with _backfill_lock:
        _backfill_state["running"] = False


def _run_cleanup() -> None:
    with _cleanup_lock:
        _cleanup_state.update({"running": True, "current": "Starting...", "steps": [], "removed": 0, "done": False})

    removed = 0
    steps: list[str] = []
    try:
        # 1. Orphaned DB records (videos + history for removed users)
        with _cleanup_lock:
            _cleanup_state["current"] = "Removing records for untracked users..."
        record_count = db.delete_orphaned_records()
        n = record_count
        steps.append(f"Removed {n} orphaned DB record{'s' if n != 1 else ''} for untracked users")
        removed += record_count
        with _cleanup_lock:
            _cleanup_state["steps"] = list(steps)

        # 2. Orphaned thumbnails (run after DB purge so deleted video IDs are gone)
        with _cleanup_lock:
            _cleanup_state["current"] = "Scanning thumbnails..."
        video_ids   = db.get_all_video_ids()
        thumb_count = 0
        for thumbs_dir in _glob.glob(os.path.join(MEDIA_DIR, "*", "*", "thumbs")):
            for thumb in _glob.glob(os.path.join(thumbs_dir, "*.jpg")):
                vid_id = os.path.splitext(os.path.basename(thumb))[0]
                if vid_id not in video_ids:
                    try:
                        os.remove(thumb)
                        thumb_count += 1
                    except OSError:
                        pass
        n = thumb_count
        steps.append(f"Removed {n} orphaned thumbnail{'s' if n != 1 else ''}")
        removed += thumb_count
        with _cleanup_lock:
            _cleanup_state["steps"] = list(steps)

        # 3. Orphaned avatars
        with _cleanup_lock:
            _cleanup_state["current"] = "Scanning avatars..."
        user_ids     = db.get_all_user_ids()
        avatar_count = 0
        if os.path.isdir(AVATARS_DIR):
            for fname in os.listdir(AVATARS_DIR):
                if not fname.endswith(".jpg"):
                    continue
                uid = fname[:-4]
                if uid not in user_ids:
                    try:
                        os.remove(os.path.join(AVATARS_DIR, fname))
                        avatar_count += 1
                    except OSError:
                        pass
        n = avatar_count
        steps.append(f"Removed {n} orphaned avatar{'s' if n != 1 else ''}")
        removed += avatar_count
        with _cleanup_lock:
            _cleanup_state["steps"] = list(steps)

        # 4. Vacuum
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
        _cleanup_state.update({"running": False, "current": "", "steps": steps, "removed": removed, "done": True})


# Cookie API

@tiktok_bp.route("/cookies", methods=["GET"])
def get_cookies():
    return jsonify(cookies_info())


@tiktok_bp.route("/cookies", methods=["POST"])
def upload_cookies():
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400
    f = request.files["file"]
    if not f.filename:
        return jsonify({"error": "Empty filename"}), 400

    from platforms.tiktok.config import TIKTOK_DATA_DIR
    os.makedirs(TIKTOK_DATA_DIR, exist_ok=True)
    if os.path.exists(COOKIES_PATH):
        os.remove(COOKIES_PATH)
    f.save(COOKIES_PATH)
    with open(COOKIES_TIMESTAMP_PATH, "w", encoding="utf-8") as ts_f:
        ts_f.write(str(int(time.time())))
    return jsonify({"ok": True, **cookies_info()})


@tiktok_bp.route("/cookies", methods=["DELETE"])
def delete_cookies():
    if os.path.exists(COOKIES_PATH):
        os.remove(COOKIES_PATH)
    if os.path.exists(COOKIES_TIMESTAMP_PATH):
        os.remove(COOKIES_TIMESTAMP_PATH)
    return jsonify({"ok": True})


# User API

@tiktok_bp.route("/users", methods=["GET"])
def list_users():
    users          = db.get_all_users()
    all_stats      = db.get_all_video_stats()
    all_ph         = db.get_all_profile_history_for_search()
    all_ph_counts  = db.get_all_profile_history_counts()

    for user in users:
        tid   = user["tiktok_id"]
        stats = all_stats.get(tid, {})
        user["video_total"]            = stats.get("video_total",      0)
        user["video_downloaded"]       = stats.get("video_downloaded",  0)
        user["video_deleted"]          = stats.get("video_deleted",     0)
        user["video_undeleted"]        = stats.get("video_undeleted",   0)
        user["video_missing"]          = stats.get("video_missing",     0)
        user["profile_history_count"]  = all_ph_counts.get(tid, 0)
        ph   = all_ph.get(tid, {})
        cur  = user["username"]
        user["old_usernames"]     = list(dict.fromkeys(
            v for v in ph.get("username",     []) if v != cur
        ))
        user["old_display_names"] = list(dict.fromkeys(
            v for v in ph.get("display_name", []) if v and v != user.get("display_name")
        ))
        user["old_bios"]          = list(dict.fromkeys(
            v for v in ph.get("bio",          []) if v and v != user.get("bio")
        ))
    return jsonify(users)


@tiktok_bp.route("/users", methods=["POST"])
def add_user():
    body     = request.get_json(silent=True) or {}
    raw      = body.get("username", "").strip().lstrip("@")
    username = re.sub(r'[^a-zA-Z0-9_.]', '', raw)

    if not username:
        return jsonify({"error": "username is required"}), 400

    existing = db.get_all_users()
    if any(u["username"].lower() == username.lower() for u in existing):
        return jsonify({"error": "User is already being tracked"}), 409

    with _pending_lock:
        if _pending.get(username, {}).get("status") == "pending":
            return jsonify({"error": "Already queued"}), 409
        _pending[username] = {"status": "pending"}

    _add_queue.put(username)
    return jsonify({"queued": True, "username": username}), 202


@tiktok_bp.route("/queue", methods=["GET"])
def get_queue():
    with _pending_lock:
        return jsonify(dict(_pending))


@tiktok_bp.route("/queue/<username>", methods=["DELETE"])
def dismiss_queue_entry(username: str):
    with _pending_lock:
        entry = _pending.get(username)
        if entry and entry.get("status") == "pending":
            return jsonify({"error": "Cannot dismiss a pending lookup"}), 409
        _pending.pop(username, None)
    return jsonify({"ok": True})


@tiktok_bp.route("/users/<tiktok_id>", methods=["DELETE"])
def remove_user(tiktok_id: str):
    db.remove_user(tiktok_id)
    return jsonify({"ok": True})


@tiktok_bp.route("/users/<tiktok_id>/videos", methods=["GET"])
def user_videos(tiktok_id: str):
    return jsonify(db.get_videos_for_user(tiktok_id))


@tiktok_bp.route("/users/<tiktok_id>/avatar", methods=["GET"])
def user_avatar(tiktok_id: str):
    avif = avatar_path(tiktok_id)
    jpg  = avif.replace(".avif", ".jpg")
    if os.path.exists(avif):
        return send_file(avif, mimetype="image/avif", max_age=300)
    if os.path.exists(jpg):
        return send_file(jpg, mimetype="image/jpeg", max_age=300)
    return ("", 404)


@tiktok_bp.route("/users/<tiktok_id>/avatar-history/<filename>", methods=["GET"])
def user_avatar_history(tiktok_id: str, filename: str):
    if not re.fullmatch(r"[0-9]+_[0-9]+\.(jpg|avif)", filename):
        return ("", 400)
    path = os.path.join(AVATARS_DIR, filename)
    if not os.path.exists(path):
        return ("", 404)
    mime = "image/avif" if filename.endswith(".avif") else "image/jpeg"
    return send_file(path, mimetype=mime)


@tiktok_bp.route("/users/<tiktok_id>/profile-history", methods=["GET"])
def user_profile_history(tiktok_id: str):
    return jsonify(db.get_profile_history(tiktok_id))


@tiktok_bp.route("/users/<tiktok_id>/run", methods=["POST"])
def run_user(tiktok_id: str):
    if not db.get_user(tiktok_id):
        return jsonify({"error": "User not found"}), 404
    if not enqueue_user_run(tiktok_id):
        return jsonify({"error": "Already queued or running"}), 409
    return jsonify({"ok": True})


@tiktok_bp.route("/users/<tiktok_id>/run-profile", methods=["POST"])
def run_user_profile(tiktok_id: str):
    if not db.get_user(tiktok_id):
        return jsonify({"error": "User not found"}), 404
    if not enqueue_user_profile_run(tiktok_id):
        return jsonify({"error": "Already queued or running"}), 409
    return jsonify({"ok": True})


@tiktok_bp.route("/users/<tiktok_id>/tracking", methods=["PATCH"])
def set_user_tracking(tiktok_id: str):
    if not db.get_user(tiktok_id):
        return jsonify({"error": "User not found"}), 404
    body    = request.get_json(silent=True) or {}
    enabled = body.get("enabled")
    if not isinstance(enabled, bool):
        return jsonify({"error": "enabled must be a boolean"}), 400
    db.set_user_tracking_enabled(tiktok_id, enabled)
    return jsonify({"ok": True})


@tiktok_bp.route("/users/<tiktok_id>/comment", methods=["PATCH"])
def set_user_comment(tiktok_id: str):
    if not db.get_user(tiktok_id):
        return jsonify({"error": "User not found"}), 404
    body    = request.get_json(silent=True) or {}
    comment = body.get("comment", "")
    if not isinstance(comment, str):
        return jsonify({"error": "comment must be a string"}), 400
    db.set_user_comment(tiktok_id, comment.strip())
    return jsonify({"ok": True})


@tiktok_bp.route("/users/<tiktok_id>/star", methods=["PATCH"])
def set_user_star(tiktok_id: str):
    if not db.get_user(tiktok_id):
        return jsonify({"error": "User not found"}), 404
    body    = request.get_json(silent=True) or {}
    starred = body.get("starred")
    if not isinstance(starred, bool):
        return jsonify({"error": "starred must be a boolean"}), 400
    db.set_user_starred(tiktok_id, starred)
    return jsonify({"ok": True})


# Video API

@tiktok_bp.route("/videos/<video_id>/thumbnail", methods=["GET"])
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


@tiktok_bp.route("/videos/<video_id>/file", methods=["GET"])
def video_file(video_id: str):
    video = db.get_video(video_id)
    if not video or not video.get("file_path"):
        return ("", 404)
    path = video["file_path"]
    if not os.path.exists(path):
        return ("", 404)
    return send_file(path, conditional=True)


@tiktok_bp.route("/videos/<video_id>/photos", methods=["GET"])
def video_photos(video_id: str):
    video = db.get_video(video_id)
    if not video or video.get("type") != "photo" or not video.get("file_path"):
        return ("", 404)
    folder = os.path.dirname(video["file_path"])
    urls: list[str] = []
    for i in range(1, 51):  # TikTok caps photo posts well below 50
        found = False
        for ext in ("avif", "jpg", "jpeg"):
            path = os.path.join(folder, f"{video_id}_{i:02d}.{ext}")
            if os.path.exists(path):
                urls.append(f"/api/tiktok/videos/{video_id}/photo/{i}")
                found = True
                break
        if not found:
            break
    if not urls:
        return ("", 404)
    return jsonify({"urls": urls, "count": len(urls)})


@tiktok_bp.route("/videos/<video_id>/photos/zip", methods=["GET"])
def video_photos_zip(video_id: str):
    video = db.get_video(video_id)
    if not video or video.get("type") != "photo" or not video.get("file_path"):
        return ("", 404)
    folder = os.path.dirname(video["file_path"])
    buf = io.BytesIO()
    added = 0
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
        for i in range(1, 51):
            for ext in ("avif", "jpg", "jpeg"):
                path = os.path.join(folder, f"{video_id}_{i:02d}.{ext}")
                if os.path.exists(path):
                    zf.write(path, f"{video_id}_{i:02d}.{ext}")
                    added += 1
                    break
            else:
                break
    if not added:
        return ("", 404)
    buf.seek(0)
    return send_file(
        buf,
        mimetype="application/zip",
        as_attachment=True,
        download_name=f"{video_id}_photos.zip",
    )


@tiktok_bp.route("/videos/<video_id>/photo/<int:n>", methods=["GET"])
def video_photo(video_id: str, n: int):
    if n < 1 or n > 50:
        return ("", 400)
    video = db.get_video(video_id)
    if not video or not video.get("file_path"):
        return ("", 404)
    folder = os.path.dirname(video["file_path"])
    for ext in ("avif", "jpg", "jpeg"):
        path = os.path.join(folder, f"{video_id}_{n:02d}.{ext}")
        if os.path.exists(path):
            mime = "image/avif" if ext == "avif" else "image/jpeg"
            return send_file(path, mimetype=mime)
    return ("", 404)


# Stats backfill API

@tiktok_bp.route("/backfill", methods=["GET"])
def get_backfill_status():
    with _backfill_lock:
        return jsonify(dict(_backfill_state))


@tiktok_bp.route("/backfill", methods=["POST"])
def start_backfill():
    with _backfill_lock:
        if _backfill_state["running"]:
            return jsonify({"error": "Already running"}), 409
    threading.Thread(target=_run_backfill, daemon=True, name="stats-backfill").start()
    return jsonify({"ok": True})


@tiktok_bp.route("/backfill/failed", methods=["GET"])
def get_backfill_failed():
    return jsonify(db.get_videos_stats_failed())


@tiktok_bp.route("/backfill/reset", methods=["POST"])
def reset_backfill():
    with _backfill_lock:
        if _backfill_state["running"]:
            return jsonify({"error": "Backfill is currently running"}), 409
    count = db.reset_backfill_status()
    return jsonify({"ok": True, "reset": count})


@tiktok_bp.route("/backfill/reset-errors", methods=["POST"])
def reset_backfill_errors():
    with _backfill_lock:
        if _backfill_state["running"]:
            return jsonify({"error": "Backfill is currently running"}), 409
    count = db.reset_backfill_errors()
    return jsonify({"ok": True, "reset": count})


# Aggregate stats and recent activity

@tiktok_bp.route("/stats", methods=["GET"])
def get_aggregate_stats():
    return jsonify(db.get_aggregate_stats())


@tiktok_bp.route("/recent", methods=["GET"])
def get_recent():
    return jsonify(db.get_recent_activity())


@tiktok_bp.route("/recent/deletions", methods=["GET"])
def get_recent_deletions():
    offset = int(request.args.get("offset", 0))
    limit  = int(request.args.get("limit",  50))
    return jsonify(db.get_deletion_history(offset=offset, limit=limit))


@tiktok_bp.route("/recent/profile-changes", methods=["GET"])
def get_recent_profile_changes():
    offset = int(request.args.get("offset", 0))
    limit  = int(request.args.get("limit",  50))
    return jsonify(db.get_profile_change_history(offset=offset, limit=limit))


@tiktok_bp.route("/recent/bans", methods=["GET"])
def get_recent_bans():
    offset = int(request.args.get("offset", 0))
    limit  = int(request.args.get("limit",  50))
    return jsonify(db.get_ban_history(offset=offset, limit=limit))


@tiktok_bp.route("/recent/saved", methods=["GET"])
def get_recent_saved():
    offset = int(request.args.get("offset", 0))
    limit  = int(request.args.get("limit",  50))
    return jsonify(db.get_saved_history(offset=offset, limit=limit))


# DB cleanup

@tiktok_bp.route("/db/cleanup", methods=["GET"])
def get_cleanup_status():
    with _cleanup_lock:
        return jsonify(dict(_cleanup_state))


@tiktok_bp.route("/db/cleanup", methods=["POST"])
def start_cleanup():
    with _cleanup_lock:
        if _cleanup_state["running"]:
            return jsonify({"error": "Already running"}), 409
    threading.Thread(target=_run_cleanup, daemon=True, name="db-cleanup").start()
    return jsonify({"ok": True})


# Sound API

@tiktok_bp.route("/sounds/<sound_id>/star", methods=["PATCH"])
def set_sound_star(sound_id: str):
    if not db.get_sound(sound_id):
        return jsonify({"error": "Sound not found"}), 404
    body    = request.get_json(silent=True) or {}
    starred = body.get("starred")
    if not isinstance(starred, bool):
        return jsonify({"error": "starred must be a boolean"}), 400
    db.set_sound_starred(sound_id, starred)
    return jsonify({"ok": True})


@tiktok_bp.route("/sounds/<sound_id>/tracking", methods=["PATCH"])
def set_sound_tracking(sound_id: str):
    if not db.get_sound(sound_id):
        return jsonify({"error": "Sound not found"}), 404
    body    = request.get_json(silent=True) or {}
    enabled = body.get("enabled")
    if not isinstance(enabled, bool):
        return jsonify({"error": "enabled must be a boolean"}), 400
    db.set_sound_tracking_enabled(sound_id, enabled)
    return jsonify({"ok": True})


@tiktok_bp.route("/sounds", methods=["GET"])
def list_sounds():
    return jsonify(db.get_all_sounds())


@tiktok_bp.route("/sounds", methods=["POST"])
def add_sound():
    body     = request.get_json(silent=True) or {}
    raw      = str(body.get("sound_id", "")).strip()
    label    = str(body.get("label", "")).strip() or None

    # Accept full TikTok sound URLs; extract the trailing numeric ID
    m = re.search(r'(\d{10,25})(?:[^0-9]|$)', raw)
    sound_id = m.group(1) if m else raw

    if not sound_id.isdigit():
        return jsonify({"error": "sound_id must be numeric (or a TikTok sound URL)"}), 400

    added = db.add_sound(sound_id, label)
    if not added:
        return jsonify({"error": "Sound is already being tracked"}), 409
    return jsonify({"ok": True, "sound_id": sound_id}), 201


@tiktok_bp.route("/sounds/<sound_id>", methods=["PATCH"])
def update_sound(sound_id: str):
    if not db.get_sound(sound_id):
        return jsonify({"error": "Sound not found"}), 404
    body  = request.get_json(silent=True) or {}
    label = body.get("label")
    if label is not None:
        label = str(label).strip() or None
    db.update_sound_label(sound_id, label)
    return jsonify({"ok": True})


@tiktok_bp.route("/sounds/<sound_id>/comment", methods=["PATCH"])
def set_sound_comment(sound_id: str):
    if not db.get_sound(sound_id):
        return jsonify({"error": "Sound not found"}), 404
    body    = request.get_json(silent=True) or {}
    comment = body.get("comment", "")
    if not isinstance(comment, str):
        return jsonify({"error": "comment must be a string"}), 400
    db.set_sound_comment(sound_id, comment.strip())
    return jsonify({"ok": True})


@tiktok_bp.route("/sounds/<sound_id>", methods=["DELETE"])
def remove_sound(sound_id: str):
    if not db.get_sound(sound_id):
        return jsonify({"error": "Sound not found"}), 404
    db.remove_sound(sound_id)
    return jsonify({"ok": True})


@tiktok_bp.route("/sounds/<sound_id>/videos", methods=["GET"])
def sound_videos(sound_id: str):
    if not db.get_sound(sound_id):
        return jsonify({"error": "Sound not found"}), 404
    return jsonify(db.get_sound_videos(sound_id))


@tiktok_bp.route("/sounds/<sound_id>/run", methods=["POST"])
def run_sound(sound_id: str):
    if not db.get_sound(sound_id):
        return jsonify({"error": "Sound not found"}), 404
    if not enqueue_sound_run(sound_id):
        return jsonify({"error": "Already queued or running"}), 409
    return jsonify({"ok": True})


# Loop API

@tiktok_bp.route("/status", methods=["GET"])
def get_status():
    state = get_state_snapshot()
    state["missing_stats_count"]        = db.count_videos_missing_stats()
    state["stats_failed_count"]         = db.count_videos_stats_failed()
    state["deletion_confirm_threshold"] = DELETION_CONFIRM_THRESHOLD
    return jsonify(state)


@tiktok_bp.route("/trigger", methods=["POST"])
def trigger_now():
    from config import get_path_issues
    issues = get_path_issues()
    if issues:
        return jsonify({"error": issues[0]["message"]}), 503
    if is_user_loop_running():
        return jsonify({"error": "User loop is already running"}), 409
    trigger_user_event.set()
    return jsonify({"ok": True})


@tiktok_bp.route("/trigger/sounds", methods=["POST"])
def trigger_sounds_now():
    from config import get_path_issues
    issues = get_path_issues()
    if issues:
        return jsonify({"error": issues[0]["message"]}), 503
    if is_sound_loop_running():
        return jsonify({"error": "Sound loop is already running"}), 409
    trigger_sound_event.set()
    return jsonify({"ok": True})


@tiktok_bp.route("/settings", methods=["GET"])
def get_settings():
    return jsonify({
        "user_loop_interval_minutes":  int(db.get_setting("user_loop_interval_minutes",  USER_LOOP_INTERVAL_MINUTES)),
        "sound_loop_interval_minutes": int(db.get_setting("sound_loop_interval_minutes", SOUND_LOOP_INTERVAL_MINUTES)),
    })


@tiktok_bp.route("/settings", methods=["PATCH"])
def update_settings():
    body    = request.get_json(silent=True) or {}
    allowed = ("user_loop_interval_minutes", "sound_loop_interval_minutes")
    for key in allowed:
        if key in body:
            val = body[key]
            if not isinstance(val, int) or val < 1:
                return jsonify({"error": f"{key} must be a positive integer"}), 400
            db.set_setting(key, val)
    if "user_loop_interval_minutes" in body:
        reschedule_user_loop()
    if "sound_loop_interval_minutes" in body:
        reschedule_sound_loop()
    return jsonify({"ok": True})


# Jobs API

@tiktok_bp.route("/jobs/photo-converter/status", methods=["GET"])
def get_photo_converter_status():
    return jsonify(_photo_converter.get_state())


@tiktok_bp.route("/jobs/photo-converter/start", methods=["POST"])
def start_photo_converter():
    if not _photo_converter.start():
        return jsonify({"error": "Already running"}), 409
    return jsonify({"ok": True})


@tiktok_bp.route("/jobs/audio-cleanup/status", methods=["GET"])
def get_audio_cleanup_status():
    with _audio_cleanup_lock:
        return jsonify(dict(_audio_cleanup_state))


@tiktok_bp.route("/jobs/audio-cleanup/start", methods=["POST"])
def start_audio_cleanup():
    with _audio_cleanup_lock:
        if _audio_cleanup_state["running"]:
            return jsonify({"error": "Already running"}), 409
    threading.Thread(target=_run_audio_cleanup, daemon=True, name="audio-cleanup").start()
    return jsonify({"ok": True})


@tiktok_bp.route("/jobs/file-check/status", methods=["GET"])
def get_file_check_status():
    with _file_check_lock:
        return jsonify(dict(_file_check_state))


@tiktok_bp.route("/jobs/file-check/scan", methods=["POST"])
def start_file_scan():
    with _file_check_lock:
        if _file_check_state["running"]:
            return jsonify({"error": "Already running"}), 409
    threading.Thread(target=_run_file_scan, daemon=True, name="file-check").start()
    return jsonify({"ok": True})


@tiktok_bp.route("/jobs/file-check/purge", methods=["POST"])
def start_file_purge():
    with _file_check_lock:
        if _file_check_state["running"]:
            return jsonify({"error": "Already running"}), 409
    threading.Thread(target=_run_file_purge, daemon=True, name="file-check").start()
    return jsonify({"ok": True})


@tiktok_bp.route("/utils/clear-avatars", methods=["POST"])
def clear_avatars():
    body = request.get_json(silent=True) or {}
    include_banned = bool(body.get("include_banned", False))

    banned_ids = set()
    if not include_banned:
        with db.get_db() as conn:
            rows = conn.execute(
                "SELECT tiktok_id FROM users WHERE account_status = 'banned'"
            ).fetchall()
            banned_ids = {r["tiktok_id"] for r in rows}

    deleted = 0
    deleted_ids = []
    if os.path.isdir(AVATARS_DIR):
        for fname in os.listdir(AVATARS_DIR):
            # Current avatars: {tiktok_id}.avif or {tiktok_id}.jpg -- no underscore before extension
            stem, ext = os.path.splitext(fname)
            if ext.lower() in (".avif", ".jpg", ".jpeg") and "_" not in stem:
                if stem in banned_ids:
                    continue
                try:
                    os.remove(os.path.join(AVATARS_DIR, fname))
                    deleted += 1
                    deleted_ids.append(stem)
                except OSError:
                    pass

    if deleted_ids:
        with db.get_db() as conn:
            conn.executemany(
                "UPDATE users SET avatar_cached = 0 WHERE tiktok_id = ?",
                [(tid,) for tid in deleted_ids]
            )

    return jsonify({"deleted": deleted})


@tiktok_bp.route("/utils/clear-thumbnails", methods=["POST"])
def clear_thumbnails():
    deleted = 0
    for thumbs_dir in _glob.glob(os.path.join(MEDIA_DIR, "*", "*", "thumbs")):
        if not os.path.isdir(thumbs_dir):
            continue
        for fname in os.listdir(thumbs_dir):
            if os.path.splitext(fname)[1].lower() in (".avif", ".jpg", ".jpeg"):
                try:
                    os.remove(os.path.join(thumbs_dir, fname))
                    deleted += 1
                except OSError:
                    pass
    return jsonify({"deleted": deleted})


@tiktok_bp.route("/db/query", methods=["POST"])
def run_db_query():
    body = request.get_json(silent=True) or {}
    sql  = (body.get("sql") or "").strip()
    if not sql:
        return jsonify({"error": "No SQL provided"}), 400
    try:
        with db.get_db() as conn:
            cursor = conn.execute(sql)
            if cursor.description:
                cols   = [d[0] for d in cursor.description]
                rows   = cursor.fetchall()
                lines  = ["\t".join(cols)]
                lines += ["\t".join("" if v is None else str(v) for v in row) for row in rows]
                total  = len(rows)
                summary = f"{total} row{'s' if total != 1 else ''} returned"
            else:
                conn.commit()
                affected = cursor.rowcount
                lines   = [f"OK - {affected} row{'s' if affected != 1 else ''} affected"]
                total   = 1
                summary = lines[0]
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400
    header   = f"SQL: {sql}"
    filename = _write_report("db-query", header, lines)
    preview  = lines[:12]
    return jsonify({"ok": True, "report_file": filename,
                    "preview": preview, "total": total, "summary": summary})


@tiktok_bp.route("/reports/<path:filename>", methods=["GET"])
def download_report(filename: str):
    if "/" in filename or "\\" in filename or ".." in filename:
        return ("", 400)
    path = os.path.join(REPORTS_DIR, filename)
    if not os.path.exists(path):
        return ("", 404)
    as_attachment = request.args.get("download") == "1"
    return send_file(path, mimetype="text/plain",
                     as_attachment=as_attachment,
                     download_name=filename)


# Diagnostics API

@tiktok_bp.route("/debug/fetch", methods=["POST"])
def debug_fetch():
    body   = request.get_json(silent=True) or {}
    source = body.get("source", "")
    action = body.get("action", "")
    inp    = (body.get("input") or "").strip()

    if not inp:
        return jsonify({"ok": False, "output": "Error: no input provided"})

    try:
        if source == "get_video_details":
            m_vid  = re.search(r'/(?:video|photo)/(\d+)', inp)
            m_user = re.search(r'@([\w.]+)/', inp)
            video_id = m_vid.group(1)  if m_vid  else inp
            username = m_user.group(1) if m_user else "user"
            cookies  = get_cookies_flat()
            result   = get_video_details(video_id, username, cookies)
            return jsonify({"ok": True, "output": json.dumps(result, indent=2, default=str)})

        elif source == "ytdlp" and action == "user_videos":
            from platforms.tiktok.api import get_user_videos
            result = get_user_videos(inp, COOKIES_PATH if os.path.exists(COOKIES_PATH) else None)
            return jsonify({"ok": True, "output": json.dumps(result, indent=2, default=str)})

        elif source == "ytdlp" and action == "video_info":
            import yt_dlp
            opts = {"quiet": True, "no_warnings": True,
                    **({"cookiefile": COOKIES_PATH} if os.path.exists(COOKIES_PATH) else {})}
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.sanitize_info(ydl.extract_info(inp, download=False))
            return jsonify({"ok": True, "output": json.dumps(info, indent=2, default=str)})

        elif source == "tiktokapi" and action == "user_info":
            from TikTokApi import TikTokApi as _TikTokApi
            from platforms.tiktok.api import get_user_info as _get_user_info
            username = inp.lstrip("@").strip()

            async def _fetch_user_info_adhoc():
                ms_token     = get_ms_token()
                cookies_flat = get_cookies_flat()
                async with _TikTokApi() as _api:
                    await _api.create_sessions(
                        ms_tokens=[ms_token] if ms_token else [],
                        num_sessions=1,
                        sleep_after=3,
                        executable_path=CHROME_EXECUTABLE,
                        cookies=[cookies_flat] if cookies_flat else None,
                    )
                    return await _get_user_info(_api, username=username)

            result = asyncio.run(_fetch_user_info_adhoc())
            return jsonify({"ok": True, "output": json.dumps(result, indent=2, default=str)})

        # Uses TikTokApi's make_request() (Playwright + X-Bogus signing) but
        # bypasses the username guard in user.info(). Tests whether TikTok
        # resolves a user by secUid alone when uniqueId is empty.
        elif source == "tiktokapi" and action == "user_info_by_id":
            from TikTokApi import TikTokApi as _TikTokApi
            if ":" not in inp:
                return jsonify({"ok": False, "output": "Error: input must be tiktok_id:sec_uid"})
            tiktok_id, sec_uid = inp.split(":", 1)
            tiktok_id = tiktok_id.strip()
            sec_uid   = sec_uid.strip()
            ms_token  = get_ms_token()

            async def _fetch_by_sec_uid():
                cookies_flat = get_cookies_flat()
                async with _TikTokApi() as _api:
                    await _api.create_sessions(
                        ms_tokens=[ms_token] if ms_token else [],
                        num_sessions=1,
                        sleep_after=3,
                        executable_path=CHROME_EXECUTABLE,
                        cookies=[cookies_flat] if cookies_flat else None,
                    )
                    return await _api.make_request(
                        url="https://www.tiktok.com/api/user/detail/",
                        params={"secUid": sec_uid, "uniqueId": ""},
                    )

            data = asyncio.run(_fetch_by_sec_uid())
            if data is None:
                data = {"error": "TikTok returned no data (None)"}
            return jsonify({"ok": True, "output": json.dumps(data, indent=2, default=str)})

        elif source == "tiktokapi" and action == "item_list_username":
            from TikTokApi import TikTokApi as _TikTokApi
            from platforms.tiktok.api import get_user_videos_with_stats as _get_vws
            username = inp.lstrip("@").strip()

            async def _item_list_by_username():
                ms_token     = get_ms_token()
                cookies_flat = get_cookies_flat()
                async with _TikTokApi() as _api:
                    await _api.create_sessions(
                        ms_tokens=[ms_token] if ms_token else [],
                        num_sessions=1,
                        sleep_after=3,
                        executable_path=CHROME_EXECUTABLE,
                        cookies=[cookies_flat] if cookies_flat else None,
                    )
                    await asyncio.sleep(3)
                    user_obj = _api.user(username=username)
                    await user_obj.info()  # resolve sec_uid
                    sec_uid = getattr(user_obj, "sec_uid", None)
                    results = await _get_vws(_api, sec_uid=sec_uid)
                    return {"sec_uid_resolved": sec_uid, "count": len(results), "videos": results}

            result = asyncio.run(_item_list_by_username())
            return jsonify({"ok": True, "output": json.dumps(result, indent=2, default=str)})

        elif source == "tiktokapi" and action == "item_list_by_id":
            from TikTokApi import TikTokApi as _TikTokApi
            from platforms.tiktok.api import get_user_videos_with_stats as _get_vws
            if ":" not in inp:
                return jsonify({"ok": False, "output": "Error: input must be tiktok_id:sec_uid"})
            tiktok_id, sec_uid = inp.split(":", 1)
            tiktok_id = tiktok_id.strip()
            sec_uid   = sec_uid.strip()

            async def _item_list_by_id():
                ms_token     = get_ms_token()
                cookies_flat = get_cookies_flat()
                async with _TikTokApi() as _api:
                    await _api.create_sessions(
                        ms_tokens=[ms_token] if ms_token else [],
                        num_sessions=1,
                        sleep_after=3,
                        executable_path=CHROME_EXECUTABLE,
                        cookies=[cookies_flat] if cookies_flat else None,
                    )
                    await asyncio.sleep(3)
                    results = await _get_vws(_api, sec_uid=sec_uid)
                    return {"tiktok_id": tiktok_id, "sec_uid": sec_uid,
                            "count": len(results), "videos": results}

            result = asyncio.run(_item_list_by_id())
            return jsonify({"ok": True, "output": json.dumps(result, indent=2, default=str)})

        elif source == "tiktokapi" and action == "item_list_from_db":
            from TikTokApi import TikTokApi as _TikTokApi
            from platforms.tiktok.api import get_user_videos_with_stats as _get_vws
            username = inp.lstrip("@").strip()
            user = db.get_user_by_username(username)
            if not user:
                return jsonify({"ok": False,
                                "output": f"Error: @{username} not found in database"})
            sec_uid   = user.get("sec_uid")
            tiktok_id = user.get("tiktok_id")
            if not sec_uid:
                return jsonify({"ok": False,
                                "output": f"Error: @{username} has no sec_uid stored -- "
                                          f"loop would skip item_list for this user"})

            async def _item_list_from_db():
                ms_token     = get_ms_token()
                cookies_flat = get_cookies_flat()
                async with _TikTokApi() as _api:
                    await _api.create_sessions(
                        ms_tokens=[ms_token] if ms_token else [],
                        num_sessions=1,
                        sleep_after=3,
                        executable_path=CHROME_EXECUTABLE,
                        cookies=[cookies_flat] if cookies_flat else None,
                    )
                    await asyncio.sleep(3)
                    results = await _get_vws(_api, sec_uid=sec_uid)
                    return {"tiktok_id": tiktok_id, "username": username,
                            "sec_uid": sec_uid, "count": len(results), "videos": results}

            result = asyncio.run(_item_list_from_db())
            return jsonify({"ok": True, "output": json.dumps(result, indent=2, default=str)})

        else:
            return jsonify({"ok": False, "output": f"Unknown source/action: {source}/{action}"})

    except Exception as e:
        return jsonify({"ok": False, "output": f"Error: {e}\n\n{traceback.format_exc()}"})
