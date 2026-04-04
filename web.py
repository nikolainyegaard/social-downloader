"""
Flask web application — user management UI and API.
"""

import asyncio
import os
import queue as _queue_module
import re
import threading
import time
from flask import Flask, jsonify, request, render_template, send_file

import database as db
from config import get_ms_token, get_cookies_flat, cookies_info, COOKIES_PATH, COOKIES_TIMESTAMP_PATH, DATA_DIR, VIDEOS_DIR, CHROME_EXECUTABLE, APP_VERSION
from tiktok_api import get_user_info, get_video_details
from loop import is_running, get_state_snapshot, trigger_event, enqueue_user_run
from thumbnailer import thumb_path_for, avatar_path


# Add-user queue

_add_queue:   _queue_module.Queue = _queue_module.Queue()
_pending_lock = threading.Lock()
_pending: dict = {}  # username → {"status": "pending"|"error", "message": str}


def _process_add(username: str) -> None:
    ms_token = get_ms_token()

    async def _lookup():
        from TikTokApi import TikTokApi
        async with TikTokApi() as api:
            await api.create_sessions(
                ms_tokens=[ms_token] if ms_token else [],
                num_sessions=1,
                sleep_after=3,
                executable_path=CHROME_EXECUTABLE,
            )
            return await get_user_info(api, username=username)

    try:
        info = asyncio.run(_lookup())
    except Exception as e:
        with _pending_lock:
            _pending[username] = {"status": "error", "message": f"TikTok API error: {e}"}
        return

    if not info.get("tiktok_id"):
        with _pending_lock:
            _pending[username] = {"status": "error", "message": "User not found"}
        return

    if db.get_user(info["tiktok_id"]):
        # User already exists by TikTok ID (may have changed username or been added
        # before sec_uid was stored). Patch the record so the loop can find them.
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
        del _pending[username]  # success: now in DB, frontend picks it up via /api/users


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


def _run_backfill() -> None:
    import time as _time

    videos  = db.get_videos_missing_stats()
    cookies = get_cookies_flat()

    with _backfill_lock:
        _backfill_state.update({"running": True, "done": 0, "total": len(videos), "errors": 0})

    for v in videos:
        try:
            details = get_video_details(v["video_id"], v["username"], cookies)
            db.update_video_stats(
                v["video_id"],
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
                raw_video_data=details.get("_raw_video_data"),
            )
        except Exception:
            with _backfill_lock:
                _backfill_state["errors"] += 1
        with _backfill_lock:
            _backfill_state["done"] += 1
        _time.sleep(1.5)

    with _backfill_lock:
        _backfill_state["running"] = False


def create_app() -> Flask:
    app = Flask(__name__)

    # Pages

    @app.route("/")
    def index():
        return render_template("index.html", version=APP_VERSION)

    # Cookie API

    @app.route("/api/cookies", methods=["GET"])
    def get_cookies():
        return jsonify(cookies_info())

    @app.route("/api/cookies", methods=["POST"])
    def upload_cookies():
        if "file" not in request.files:
            return jsonify({"error": "No file provided"}), 400
        f = request.files["file"]
        if not f.filename:
            return jsonify({"error": "Empty filename"}), 400

        os.makedirs(DATA_DIR, exist_ok=True)
        if os.path.exists(COOKIES_PATH):
            os.remove(COOKIES_PATH)
        f.save(COOKIES_PATH)
        with open(COOKIES_TIMESTAMP_PATH, "w", encoding="utf-8") as ts_f:
            ts_f.write(str(int(time.time())))
        return jsonify({"ok": True, **cookies_info()})

    @app.route("/api/cookies", methods=["DELETE"])
    def delete_cookies():
        if os.path.exists(COOKIES_PATH):
            os.remove(COOKIES_PATH)
        if os.path.exists(COOKIES_TIMESTAMP_PATH):
            os.remove(COOKIES_TIMESTAMP_PATH)
        return jsonify({"ok": True})

    # User API

    @app.route("/api/users", methods=["GET"])
    def list_users():
        users       = db.get_all_users()
        all_stats   = db.get_all_video_stats()
        all_history = db.get_all_username_history()

        for user in users:
            tid   = user["tiktok_id"]
            stats = all_stats.get(tid, {})
            user["video_total"]      = stats.get("video_total",      0)
            user["video_downloaded"] = stats.get("video_downloaded",  0)
            user["video_deleted"]    = stats.get("video_deleted",     0)
            user["video_undeleted"]  = stats.get("video_undeleted",   0)
            cur  = user["username"]
            user["old_usernames"] = list(dict.fromkeys(
                u for u in all_history.get(tid, []) if u != cur
            ))
        return jsonify(users)

    @app.route("/api/users", methods=["POST"])
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

    @app.route("/api/queue", methods=["GET"])
    def get_queue():
        with _pending_lock:
            return jsonify(dict(_pending))

    @app.route("/api/queue/<username>", methods=["DELETE"])
    def dismiss_queue_entry(username: str):
        with _pending_lock:
            entry = _pending.get(username)
            if entry and entry.get("status") == "pending":
                return jsonify({"error": "Cannot dismiss a pending lookup"}), 409
            _pending.pop(username, None)
        return jsonify({"ok": True})

    @app.route("/api/users/<tiktok_id>", methods=["DELETE"])
    def remove_user(tiktok_id: str):
        db.remove_user(tiktok_id)
        return jsonify({"ok": True})

    @app.route("/api/users/<tiktok_id>/videos", methods=["GET"])
    def user_videos(tiktok_id: str):
        return jsonify(db.get_videos_for_user(tiktok_id))

    @app.route("/api/users/<tiktok_id>/avatar", methods=["GET"])
    def user_avatar(tiktok_id: str):
        path = avatar_path(tiktok_id)
        if not os.path.exists(path):
            return ("", 404)
        return send_file(path, mimetype="image/jpeg")

    @app.route("/api/videos/<video_id>/thumbnail", methods=["GET"])
    def video_thumbnail(video_id: str):
        video = db.get_video(video_id)
        if not video or not video.get("file_path"):
            return ("", 404)
        path = thumb_path_for(video_id, video["file_path"])
        if not os.path.exists(path):
            return ("", 404)
        return send_file(path, mimetype="image/jpeg")

    @app.route("/api/videos/<video_id>/file", methods=["GET"])
    def video_file(video_id: str):
        video = db.get_video(video_id)
        if not video or not video.get("file_path"):
            return ("", 404)
        path = video["file_path"]
        if not os.path.exists(path):
            return ("", 404)
        return send_file(path, conditional=True)

    @app.route("/api/backfill", methods=["GET"])
    def get_backfill_status():
        with _backfill_lock:
            return jsonify(dict(_backfill_state))

    @app.route("/api/backfill", methods=["POST"])
    def start_backfill():
        with _backfill_lock:
            if _backfill_state["running"]:
                return jsonify({"error": "Already running"}), 409
        threading.Thread(target=_run_backfill, daemon=True, name="stats-backfill").start()
        return jsonify({"ok": True})

    @app.route("/api/users/<tiktok_id>/run", methods=["POST"])
    def run_user(tiktok_id: str):
        if not db.get_user(tiktok_id):
            return jsonify({"error": "User not found"}), 404
        if not enqueue_user_run(tiktok_id):
            return jsonify({"error": "Already queued or running"}), 409
        return jsonify({"ok": True})

    # Loop API

    @app.route("/api/status", methods=["GET"])
    def get_status():
        state = get_state_snapshot()
        state["missing_stats_count"] = db.count_videos_missing_stats()
        return jsonify(state)

    @app.route("/api/trigger", methods=["POST"])
    def trigger_now():
        if is_running():
            return jsonify({"error": "Loop is already running"}), 409
        trigger_event.set()
        return jsonify({"ok": True})

    return app
