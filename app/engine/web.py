"""Channel platform Flask Blueprint factory: all /api/{platform}/* routes.

create_channel_blueprint(engine) replaces the per-platform web.py clones.
Platform-specific routes (Twitter cookies, Instagram session login, YouTube
debug) are added by the adapter's register_extra_routes hook.
"""

from __future__ import annotations

import glob as _glob
import os
import queue as _queue_module
import re as _re
import threading
import time
from flask import Blueprint, jsonify, request, send_file

from config import DATA_DIR, MEDIA_DIR
from thumbnailer import thumb_path_for

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


_VIDEO_MIME = {
    ".mp4":  "video/mp4",
    ".webm": "video/webm",
    ".mkv":  "video/x-matroska",
    ".mov":  "video/quicktime",
    ".avif": "image/avif",
    ".jpg":  "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png":  "image/png",
    ".gif":  "image/gif",
}

_SCHEDULE_KEYS = (
    "sessions_per_day",
    "high_priority_check_hours",
    "active_check_hours",
    "inactive_check_hours",
    "full_refresh_days",
)


def create_channel_blueprint(engine) -> Blueprint:
    db       = engine.db
    loop     = engine.loop
    adapter  = engine.adapter
    platform = engine.platform
    noun     = adapter.creator_noun.capitalize()  # "Account" / "Profile" / "Channel"

    bp = Blueprint(platform, __name__, url_prefix=f"/api/{platform}")

    _add_queue = _queue_module.Queue()

    _cleanup_lock  = threading.Lock()
    _cleanup_state: dict = {"running": False, "current": "", "steps": [], "removed": 0, "done": False}

    def _classify_error(text: str) -> str:
        """Map a lookup failure to a shorthand kind for the Add history panel.
        Substring heuristics only. The full text lands in error_detail."""
        t = text.lower()
        if "rate" in t or "429" in t or "too many" in t:
            return "rate limit"
        if "bot" in t or "captcha" in t or "no session" in t or "login" in t or "blocked" in t:
            return "bot detection"
        if "not found" in t or "404" in t or "does not exist" in t:
            return "not found"
        return "error"

    def _process_add(handle: str) -> None:
        try:
            info = adapter.lookup_profile(handle)
        except Exception as e:
            db.add_queue_resolve(handle, "error", _classify_error(str(e)), f"Lookup error: {e}")
            return

        channel_id = info.get("channel_id")
        if not channel_id:
            db.add_queue_resolve(handle, "error", "not found", f"{noun} not found")
            return

        existing = db.get_channel(channel_id)
        if existing:
            if not existing.get("enabled"):
                # Soft-disabled stub (e.g. a sound-discovered TikTok author):
                # promote to a fully tracked creator and refresh its profile.
                with db.get_db() as conn:
                    conn.execute("UPDATE channels SET enabled = 1 WHERE channel_id = ?", (channel_id,))
                db.update_channel_info(
                    channel_id, info.get("handle") or handle,
                    info.get("display_name"), info.get("description"),
                    info.get("subscriber_count"), info.get("video_count"),
                    avatar_url=info.get("avatar_url"),
                    raw_channel_data=info.get("raw_channel_data"),
                )
                db.add_queue_resolve(handle, "ok")
                return
            db.add_queue_resolve(handle, "error", "duplicate", f"{noun} is already being tracked")
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
            raw_channel_data=info.get("raw_channel_data"),
            following_count=info.get("following_count"),
            join_date=info.get("join_date"),
            sec_uid=info.get("sec_uid"),
            verified=info.get("verified"),
            bio_link=info.get("bio_link"),
        )
        db.add_queue_resolve(handle, "ok")

    def _add_worker() -> None:
        while True:
            handle = _add_queue.get()
            try:
                _process_add(handle)
            except Exception as e:
                db.add_queue_resolve(handle, "error", _classify_error(str(e)), str(e))
            finally:
                _add_queue.task_done()

    # Lookups interrupted by a restart are still pending in the DB; feed them
    # back to the worker so they resume instead of sitting pending forever.
    for _stale in db.add_queue_pending_handles():
        _add_queue.put(_stale)

    threading.Thread(target=_add_worker, daemon=True, name=f"{adapter.prefix}-add-worker").start()

    def _enqueue_add(handle: str) -> bool:
        """Queue a handle for background lookup + add. Returns False if already pending.
        A retry of a failed entry lands here too: add_queue_set_pending flips the
        existing error row back to pending rather than growing the history.
        Exposed on the engine so platform extras (e.g. TikTok's track-author flow)
        can feed the same queue the frontend polls via /queue."""
        if handle in db.add_queue_pending_handles():
            return False
        db.add_queue_set_pending(handle)
        _add_queue.put(handle)
        return True

    engine.enqueue_add = _enqueue_add

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
                _cleanup_state["current"] = "Checking for missing video files..."
            n = db.delete_missing_video_files()
            steps.append(f"Removed {n} video row{'s' if n != 1 else ''} with missing files (will re-download next loop)")
            removed += n
            with _cleanup_lock:
                _cleanup_state["steps"] = list(steps)

            with _cleanup_lock:
                _cleanup_state["current"] = "Scanning thumbnails..."
            video_ids   = db.get_all_video_ids()
            thumb_count = 0
            for thumbs_dir in _glob.glob(os.path.join(MEDIA_DIR, platform, "*", "thumbs")):
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

    # ── Channel API ───────────────────────────────────────────────────────────

    @bp.route("/channels", methods=["GET"])
    def list_channels():
        channels      = db.get_all_channels()
        all_stats     = db.get_all_video_stats()
        all_ph_counts = db.get_all_profile_history_counts()
        all_ph        = db.get_all_profile_history_for_search()
        live_stories  = db.get_live_story_counts() if adapter.has_stories else {}
        for ch in channels:
            cid   = ch["channel_id"]
            stats = all_stats.get(cid, {})
            ch["live_stories"]          = live_stories.get(cid, 0)
            ch["video_total"]           = stats.get("video_total",      0)
            ch["video_downloaded"]      = stats.get("video_downloaded",  0)
            ch["video_deleted"]         = stats.get("video_deleted",     0)
            ch["video_undeleted"]       = stats.get("video_undeleted",   0)
            ch["video_missing"]         = stats.get("video_missing",     0)
            ch["last_saved"]            = stats.get("last_saved")
            ch["profile_history_count"] = all_ph_counts.get(cid, 0)
            ph = all_ph.get(cid, {})
            ch["old_handles"] = list(dict.fromkeys(
                v for v in ph.get("handle", []) if v and v != ch["handle"]
            ))
            ch["old_display_names"] = list(dict.fromkeys(
                v for v in ph.get("display_name", []) if v and v != ch.get("display_name")
            ))
            ch["old_descriptions"] = list(dict.fromkeys(
                v for v in ph.get("description", []) if v and v != ch.get("description")
            ))
        return jsonify(channels)

    @bp.route("/channels", methods=["POST"])
    def add_channel():
        body   = request.get_json(silent=True) or {}
        raw    = body.get("handle", "").strip()
        handle = adapter.normalize_handle(raw)

        if not handle:
            return jsonify({"error": "handle is required"}), 400

        existing = db.get_all_channels()
        if any(c["handle"].lower() == handle.lower() for c in existing):
            return jsonify({"error": f"{noun} is already being tracked"}), 409

        if not _enqueue_add(handle):
            return jsonify({"error": "Already queued"}), 409
        return jsonify({"queued": True, "handle": handle}), 202

    @bp.route("/queue", methods=["GET"])
    def get_queue():
        # Newest state per handle: pending lookups plus resolutions from the
        # last 10 minutes, so the frontend toasts catch changes between polls.
        rows = db.add_queue_recent(since=int(time.time()) - 600)
        return jsonify({
            r["handle"]: {"status": r["status"], "kind": r["error_kind"], "message": r["error_detail"]}
            for r in rows
        })

    @bp.route("/add-history", methods=["GET"])
    def add_history():
        before = request.args.get("before", type=int)
        limit  = min(request.args.get("limit", 30, type=int), 100)
        items  = db.add_queue_history(before, limit + 1)
        return jsonify({"items": items[:limit], "has_more": len(items) > limit})

    @bp.route("/add-history/<int:entry_id>", methods=["DELETE"])
    def add_history_delete(entry_id: int):
        entry = db.add_queue_get(entry_id)
        if not entry:
            return jsonify({"error": "Not found"}), 404
        if entry["status"] == "pending":
            return jsonify({"error": "Cannot discard a pending lookup"}), 409
        db.add_queue_delete(entry_id)
        return jsonify({"ok": True})

    @bp.route("/channels/<channel_id>", methods=["DELETE"])
    def remove_channel(channel_id: str):
        db.remove_channel(channel_id)
        return jsonify({"ok": True})

    @bp.route("/channels/<channel_id>/videos", methods=["GET"])
    def channel_videos(channel_id: str):
        videos = db.get_videos_for_channel(channel_id)
        # Photo posts stored with numbered siblings ({id}_01.avif) can't reveal
        # single vs carousel from file_path alone; annotate from disk.
        for v in videos:
            if v.get("content_type") in ("photo", "image") and v.get("file_path") \
                    and os.path.basename(v["file_path"]).startswith(f"{v['video_id']}_"):
                folder = os.path.dirname(v["file_path"])
                v["multi"] = any(
                    os.path.exists(os.path.join(folder, f"{v['video_id']}_02.{ext}"))
                    or os.path.exists(os.path.join(folder, f"{v['video_id']}_2.{ext}"))
                    for ext in ("avif", "jpg", "jpeg", "png", "webp", "mp4")
                )
        return jsonify(videos)

    @bp.route("/channels/<channel_id>/run", methods=["POST"])
    def run_channel(channel_id: str):
        from config import get_path_issues
        issues = get_path_issues()
        if issues:
            return jsonify({"error": issues[0]["message"]}), 503
        if not db.get_channel(channel_id):
            return jsonify({"error": f"{noun} not found"}), 404
        mode = request.args.get("mode", "full")
        if mode not in ("quick", "full"):
            return jsonify({"error": "mode must be quick or full"}), 400
        if not loop.enqueue_channel_run(channel_id, mode=mode):
            return jsonify({"error": "Already queued or running"}), 409
        return jsonify({"ok": True})

    @bp.route("/channels/<channel_id>/run-profile", methods=["POST"])
    def run_channel_profile(channel_id: str):
        if not db.get_channel(channel_id):
            return jsonify({"error": f"{noun} not found"}), 404
        if not loop.enqueue_channel_profile_run(channel_id):
            return jsonify({"error": "Already queued or running"}), 409
        return jsonify({"ok": True})

    @bp.route("/channels/<channel_id>/tracking", methods=["PATCH"])
    def set_channel_tracking(channel_id: str):
        if not db.get_channel(channel_id):
            return jsonify({"error": f"{noun} not found"}), 404
        body    = request.get_json(silent=True) or {}
        enabled = body.get("enabled")
        if not isinstance(enabled, bool):
            return jsonify({"error": "enabled must be a boolean"}), 400
        db.set_channel_tracking_enabled(channel_id, enabled)
        return jsonify({"ok": True})

    @bp.route("/channels/<channel_id>/star", methods=["PATCH"])
    def set_channel_star(channel_id: str):
        if not db.get_channel(channel_id):
            return jsonify({"error": f"{noun} not found"}), 404
        body    = request.get_json(silent=True) or {}
        starred = body.get("starred")
        if not isinstance(starred, bool):
            return jsonify({"error": "starred must be a boolean"}), 400
        db.set_channel_starred(channel_id, starred)
        return jsonify({"ok": True})

    @bp.route("/channels/<channel_id>/comment", methods=["PATCH"])
    def set_channel_comment(channel_id: str):
        if not db.get_channel(channel_id):
            return jsonify({"error": f"{noun} not found"}), 404
        body    = request.get_json(silent=True) or {}
        comment = body.get("comment", "")
        if not isinstance(comment, str):
            return jsonify({"error": "comment must be a string"}), 400
        db.set_channel_comment(channel_id, comment.strip())
        return jsonify({"ok": True})

    @bp.route("/channels/<channel_id>/profile-history", methods=["GET"])
    def channel_profile_history(channel_id: str):
        return jsonify(db.get_profile_history(channel_id))

    # ── Avatar and banner ─────────────────────────────────────────────────────

    @bp.route("/channels/<channel_id>/avatar", methods=["GET"])
    def channel_avatar(channel_id: str):
        path = os.path.join(DATA_DIR, platform, "avatars", f"{channel_id}.avif")
        if os.path.exists(path):
            return send_file(path, mimetype="image/avif", max_age=300)
        jpg = os.path.join(DATA_DIR, platform, "avatars", f"{channel_id}.jpg")
        if os.path.exists(jpg):
            return send_file(jpg, mimetype="image/jpeg", max_age=300)
        return ("", 404)

    @bp.route("/channels/<channel_id>/banner", methods=["GET"])
    def channel_banner(channel_id: str):
        path = os.path.join(DATA_DIR, platform, "banners", f"{channel_id}.avif")
        if os.path.exists(path):
            return send_file(path, mimetype="image/avif")
        return ("", 404)

    # ── Video API ─────────────────────────────────────────────────────────────

    @bp.route("/videos/<video_id>/thumbnail", methods=["GET"])
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

    @bp.route("/videos/<video_id>/file", methods=["GET"])
    def video_file(video_id: str):
        video = db.get_video(video_id)
        if not video or not video.get("file_path"):
            return ("", 404)
        path = video["file_path"]
        if not os.path.exists(path):
            return ("", 404)
        ext  = os.path.splitext(path)[1].lower()
        mime = _VIDEO_MIME.get(ext, "video/mp4")
        return send_file(path, mimetype=mime, conditional=True)

    def _sibling_files(video) -> list[str]:
        """Media files of a post: multi-media posts store numbered siblings with the
        first file as file_path ({id}_01.ext on Twitter, {id}_1.ext on Instagram);
        single-file posts store {id}.ext."""
        main   = video["file_path"]
        vid_id = video["video_id"]
        if not os.path.basename(main).startswith(f"{vid_id}_"):
            return [main] if os.path.exists(main) else []
        rx = _re.compile(_re.escape(vid_id) + r"_(\d+)\.\w+$")
        files = []
        for path in _glob.glob(os.path.join(_glob.escape(os.path.dirname(main)),
                                            _glob.escape(vid_id) + "_*")):
            m = rx.fullmatch(os.path.basename(path))
            if m and os.path.splitext(path)[1].lower() in _VIDEO_MIME:
                files.append((int(m.group(1)), path))
        return [path for _, path in sorted(files)]

    @bp.route("/videos/<video_id>/files", methods=["GET"])
    def video_files(video_id: str):
        video = db.get_video(video_id)
        if not video or not video.get("file_path"):
            return ("", 404)
        files = _sibling_files(video)
        if not files:
            return ("", 404)
        items = []
        for i, path in enumerate(files):
            ext  = os.path.splitext(path)[1].lower()
            mime = _VIDEO_MIME.get(ext, "video/mp4")
            items.append({
                "name": os.path.basename(path),
                "type": "image" if mime.startswith("image/") else "video",
                "url":  f"/api/{platform}/videos/{video_id}/files/{i}",
            })
        return jsonify({"files": items, "count": len(items)})

    @bp.route("/videos/<video_id>/files/<int:n>", methods=["GET"])
    def video_file_n(video_id: str, n: int):
        video = db.get_video(video_id)
        if not video or not video.get("file_path"):
            return ("", 404)
        files = _sibling_files(video)
        if n < 0 or n >= len(files):
            return ("", 404)
        ext = os.path.splitext(files[n])[1].lower()
        return send_file(files[n], mimetype=_VIDEO_MIME.get(ext, "video/mp4"), conditional=True)

    # ── Stories ───────────────────────────────────────────────────────────────

    @bp.route("/channels/<channel_id>/stories", methods=["GET"])
    def channel_stories(channel_id: str):
        now  = int(time.time())
        rows = db.get_stories_for_channel(channel_id)
        for s in rows:
            s["live"] = bool(s.get("expires_at") and s["expires_at"] > now)
            s["url"]  = f"/api/{platform}/stories/{s['story_id']}/file"
        return jsonify(rows)

    @bp.route("/channels/<channel_id>/stories/calendar", methods=["GET"])
    def channel_stories_calendar(channel_id: str):
        return jsonify(db.get_story_day_counts(channel_id))

    @bp.route("/stories/<story_id>/file", methods=["GET"])
    def story_file(story_id: str):
        story = db.get_story(story_id)
        if not story or not story.get("file_path") or not os.path.exists(story["file_path"]):
            return ("", 404)
        ext = os.path.splitext(story["file_path"])[1].lower()
        return send_file(story["file_path"], mimetype=_VIDEO_MIME.get(ext, "video/mp4"), conditional=True)

    # ── Diagnostics ───────────────────────────────────────────────────────────

    @bp.route("/db/query", methods=["POST"])
    def db_query():
        body = request.get_json(silent=True) or {}
        sql  = (body.get("sql") or "").strip()
        if not sql:
            return jsonify({"error": "sql is required"}), 400
        try:
            with db.get_db() as conn:
                cursor = conn.execute(sql)
                if cursor.description:
                    cols   = [d[0] for d in cursor.description]
                    rows   = cursor.fetchall()
                    lines  = ["\t".join(cols)]
                    lines += ["\t".join("" if v is None else str(v) for v in row) for row in rows]
                    total   = len(rows)
                    summary = f"{total} row{'s' if total != 1 else ''} returned"
                else:
                    affected = cursor.rowcount
                    lines    = [f"OK - {affected} row{'s' if affected != 1 else ''} affected"]
                    total    = 1
                    summary  = lines[0]
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 400
        filename = _write_report(f"{adapter.prefix}-db-query", f"SQL: {sql}", lines)
        preview  = lines[:12]
        return jsonify({"ok": True, "report_file": filename, "preview": preview, "total": total, "summary": summary})

    @bp.route("/reports/<path:filename>", methods=["GET"])
    def download_report(filename: str):
        if "/" in filename or "\\" in filename or ".." in filename:
            return ("", 400)
        path = os.path.join(REPORTS_DIR, filename)
        if not os.path.exists(path):
            return ("", 404)
        as_attachment = request.args.get("download") == "1"
        return send_file(path, mimetype="text/plain", as_attachment=as_attachment, download_name=filename)

    # ── Stats and recent activity ─────────────────────────────────────────────

    # Walking a large media library takes a moment, so the size is cached and
    # refreshed at most every 15 minutes even though stats poll every 60 s
    _media_size_cache = {"ts": 0.0, "size": 0}

    def _media_size_bytes() -> int:
        now = time.time()
        if now - _media_size_cache["ts"] > 900:
            total = 0
            for dirpath, _dirs, files in os.walk(os.path.join(MEDIA_DIR, platform)):
                for name in files:
                    try:
                        total += os.path.getsize(os.path.join(dirpath, name))
                    except OSError:
                        pass
            _media_size_cache.update(ts=now, size=total)
        return _media_size_cache["size"]

    @bp.route("/stats", methods=["GET"])
    def get_aggregate_stats():
        stats = db.get_aggregate_stats()
        stats["media_size_bytes"] = _media_size_bytes()
        return jsonify(stats)

    @bp.route("/recent", methods=["GET"])
    def get_recent():
        return jsonify(db.get_recent_activity())

    @bp.route("/recent/deletions", methods=["GET"])
    def get_recent_deletions():
        offset = int(request.args.get("offset", 0))
        limit  = int(request.args.get("limit",  50))
        return jsonify(db.get_deletion_history_grouped(offset=offset, limit=limit))

    @bp.route("/recent/profile-changes", methods=["GET"])
    def get_recent_profile_changes():
        offset = int(request.args.get("offset", 0))
        limit  = int(request.args.get("limit",  50))
        return jsonify(db.get_profile_change_history(offset=offset, limit=limit))

    @bp.route("/recent/saved", methods=["GET"])
    def get_recent_saved():
        offset = int(request.args.get("offset", 0))
        limit  = int(request.args.get("limit",  50))
        return jsonify(db.get_saved_history(offset=offset, limit=limit))

    # ── DB cleanup ────────────────────────────────────────────────────────────

    @bp.route("/db/cleanup", methods=["GET"])
    def get_cleanup_status():
        with _cleanup_lock:
            return jsonify(dict(_cleanup_state))

    @bp.route("/db/cleanup", methods=["POST"])
    def start_cleanup():
        with _cleanup_lock:
            if _cleanup_state["running"]:
                return jsonify({"error": "Already running"}), 409
        threading.Thread(target=_run_cleanup, daemon=True, name=f"{adapter.prefix}-db-cleanup").start()
        return jsonify({"ok": True})

    # ── Loop API ──────────────────────────────────────────────────────────────

    @bp.route("/status", methods=["GET"])
    def get_status():
        state = loop.get_state_snapshot()
        if adapter.extend_status:
            adapter.extend_status(engine, state)
        return jsonify(state)

    def _check_trigger_preconditions():
        """Return (issues, is_running) for the loop trigger endpoints."""
        from config import get_path_issues
        return get_path_issues(), loop.is_running()

    @bp.route("/trigger/next", methods=["POST"])
    def trigger_next_now():
        issues, running = _check_trigger_preconditions()
        if issues:
            return jsonify({"error": issues[0]["message"]}), 503
        if running:
            return jsonify({"error": "Loop is already running"}), 409
        from scheduling import get_channels_due_for_check
        due = get_channels_due_for_check(db, int(time.time()))
        loop.set_trigger_scope("next")
        loop.trigger_event.set()
        return jsonify({"ok": True, "queued": len(due), "mode": "next"})

    @bp.route("/trigger", methods=["POST"])
    def trigger_now():
        issues, running = _check_trigger_preconditions()
        if issues:
            return jsonify({"error": issues[0]["message"]}), 503
        if running:
            return jsonify({"error": "Loop is already running"}), 409
        from scheduling import prime_starred_channels
        n = prime_starred_channels(db)
        loop.set_trigger_scope("starred")
        loop.trigger_event.set()
        return jsonify({"ok": True, "queued": n, "mode": "starred"})

    @bp.route("/trigger/half", methods=["POST"])
    def trigger_half_now():
        issues, running = _check_trigger_preconditions()
        if issues:
            return jsonify({"error": issues[0]["message"]}), 503
        if running:
            return jsonify({"error": "Loop is already running"}), 409
        from scheduling import prime_half_channels
        n = prime_half_channels(db)
        loop.set_trigger_scope("half")
        loop.trigger_event.set()
        return jsonify({"ok": True, "queued": n, "mode": "half"})

    @bp.route("/trigger/all", methods=["POST"])
    def trigger_all_now():
        issues, running = _check_trigger_preconditions()
        if issues:
            return jsonify({"error": issues[0]["message"]}), 503
        if running:
            return jsonify({"error": "Loop is already running"}), 409
        from scheduling import prime_all_channels
        n = prime_all_channels(db)
        loop.set_trigger_scope("all")
        loop.trigger_event.set()
        return jsonify({"ok": True, "queued": n, "mode": "all"})

    @bp.route("/stop", methods=["POST"])
    def stop_loop():
        if not loop.is_running():
            return jsonify({"error": "Loop is not running"}), 409
        loop.request_stop()
        return jsonify({"ok": True})

    @bp.route("/pause", methods=["POST"])
    def set_pause():
        # Paused skips scheduled sessions; manual triggers and runs still work.
        body   = request.get_json(silent=True) or {}
        paused = bool(body.get("paused"))
        db.set_setting("loop_paused", "1" if paused else "0")
        return jsonify({"paused": paused})

    # ── Settings ──────────────────────────────────────────────────────────────

    @bp.route("/settings", methods=["GET"])
    def get_settings():
        from scheduling import platform_defaults
        defaults = platform_defaults(platform)
        out = {key: int(db.get_setting(key, defaults[key])) for key in _SCHEDULE_KEYS}
        for key, default in (adapter.extra_settings or {}).items():
            out[key] = int(db.get_setting(key, default))
        return jsonify(out)

    @bp.route("/settings", methods=["PATCH"])
    def update_settings():
        body    = request.get_json(silent=True) or {}
        changed = False
        extra_changed: list[str] = []
        for key in list(_SCHEDULE_KEYS) + list(adapter.extra_settings or {}):
            if key in body:
                val = body[key]
                if not isinstance(val, int) or val < 1:
                    return jsonify({"error": f"{key} must be a positive integer"}), 400
                db.set_setting(key, val)
                if key in _SCHEDULE_KEYS:
                    changed = True
                else:
                    extra_changed.append(key)
        if changed:
            loop.reschedule_loop()
        if extra_changed and adapter.on_settings_changed:
            adapter.on_settings_changed(engine, extra_changed)
        return jsonify({"ok": True})

    # ── Platform-specific extras (cookies, session login, debug routes) ──────

    if adapter.register_extra_routes:
        adapter.register_extra_routes(bp, engine)

    return bp
