"""Channel platform Flask Blueprint factory: all /api/{platform}/* routes.

create_channel_blueprint(engine) replaces the per-platform web.py clones.
Platform-specific routes (Twitter cookies, Instagram session login, YouTube
debug) are added by the adapter's register_extra_routes hook.
"""

from __future__ import annotations

import glob as _glob
import json as _json
import os
import queue as _queue_module
import re as _re
import shutil
import threading
import time
import traceback
from flask import Blueprint, Response, jsonify, request, send_file

from config import DATA_DIR, MEDIA_DIR
from thumbnailer import thumb_path_for

REPORTS_DIR = os.path.join(DATA_DIR, "reports")
os.makedirs(REPORTS_DIR, exist_ok=True)

# Individual media files by extension: one post can hold 20 photos, so these
# counts differ from post counts. Thumbnails are excluded wherever they apply.
_PHOTO_EXTS = {".avif", ".jpg", ".jpeg", ".png", ".webp"}
_VIDEO_EXTS = {".mp4", ".webm", ".mov", ".m4v", ".mkv", ".gif", ".ts"}


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

    # Disabled platform (Settings > General): every route on this blueprint,
    # including the adapter extras, is rejected so nothing can start work.
    @bp.before_request
    def _reject_when_disabled():
        from config import platform_enabled
        if not platform_enabled(platform):
            return jsonify({"error": f"{adapter.label} is disabled in Settings"}), 403

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
        loop._log(f"Add: looking up @{handle}...")
        try:
            info = adapter.lookup_profile(handle)
        except Exception as e:
            # The exception chain carries the real cause (e.g. instaloader masks
            # a 403 on graphql/query as "Profile does not exist")
            loop._log(f"Add lookup failed for {handle}: {e}\n{traceback.format_exc().rstrip()}")
            db.add_queue_resolve(handle, "error", _classify_error(str(e)), f"Lookup error: {e}")
            return

        channel_id = info.get("channel_id")
        if not channel_id:
            loop._log(f"Add: @{handle} not found")
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
                loop._log(f"Add: @{handle} was already known from sound discovery; now fully tracked")
                db.add_queue_resolve(handle, "ok")
                loop.enqueue_channel_run(channel_id, mode="full")
                return
            # Already tracked. If the lookup resolved to a different current handle
            # than we have stored, the account was renamed on the platform: the id
            # is unchanged but the old handle no longer resolves, so searching for
            # the new one comes up empty. A username only resolves to an id when it
            # is the account's current handle, so this new handle is authoritative.
            # Apply the same rename path the loop uses when it finds a new handle
            # organically, then treat the add as done instead of a duplicate error.
            _new = (info.get("handle") or "").lstrip("@")
            _old = (existing.get("handle") or "").lstrip("@")
            if _new and _new.lower() != _old.lower():
                from engine.tracker import _update_profile
                _update_profile(engine, existing, info, loop._log)
                loop._log(f"Add: @{_old} was renamed to @{_new}; updated the tracked handle")
                db.add_queue_resolve(handle, "ok")
                loop.enqueue_channel_run(channel_id, mode="quick")
                return
            loop._log(f"Add: @{handle} is already being tracked")
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
        loop._log(f"Add: @{info.get('handle') or handle} added; running a first check")
        db.add_queue_resolve(handle, "ok")
        # Kick off a Full fetch right away so a freshly added creator gets its
        # whole archive (and, for a re-added unbanned account, its ban lifecycle
        # cleared) without waiting for the next scheduled session.
        loop.enqueue_channel_run(channel_id, mode="full")

    def _add_worker() -> None:
        from config import platform_enabled
        while True:
            handle = _add_queue.get()
            # Disabled platform: park pending lookups until re-enabled
            while not platform_enabled(platform):
                time.sleep(5)
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
                _cleanup_state["current"] = "Checking for missing story files..."
            n = db.delete_missing_story_files()
            steps.append(f"Removed {n} story row{'s' if n != 1 else ''} with missing files (re-saved next check if still live)")
            removed += n
            with _cleanup_lock:
                _cleanup_state["steps"] = list(steps)

            with _cleanup_lock:
                _cleanup_state["current"] = "Scanning thumbnails..."
            video_ids   = db.get_all_video_ids()
            thumb_count = 0
            thumb_bytes = 0
            for thumbs_dir in _glob.glob(os.path.join(MEDIA_DIR, platform, "*", "thumbs")):
                for thumb in _glob.glob(os.path.join(thumbs_dir, "*.avif")):
                    vid_id = os.path.splitext(os.path.basename(thumb))[0]
                    if vid_id not in video_ids:
                        try:
                            sz = os.path.getsize(thumb)
                            os.remove(thumb)
                            thumb_count += 1
                            thumb_bytes += sz
                        except OSError:
                            pass
            n = thumb_count

            def _fmt_size(b: int) -> str:
                mb = b / 1_048_576
                return f"{mb / 1024:.2f} GB" if mb >= 1024 else f"{mb:.1f} MB"

            steps.append(f"Removed {n} orphaned thumbnail{'s' if n != 1 else ''}"
                         + (f" ({_fmt_size(thumb_bytes)} freed)" if thumb_bytes else ""))
            removed += n
            with _cleanup_lock:
                _cleanup_state["steps"] = list(steps)

            with _cleanup_lock:
                _cleanup_state["current"] = "Vacuuming database..."
            size_before = os.path.getsize(db.DB_PATH) if os.path.exists(db.DB_PATH) else 0
            db.vacuum()
            size_after  = os.path.getsize(db.DB_PATH) if os.path.exists(db.DB_PATH) else 0
            db_freed    = max(0, size_before - size_after)

            if db_freed:
                steps.append(f"Database vacuumed ({_fmt_size(size_before)} -> {_fmt_size(size_after)})")
            else:
                steps.append("Database vacuumed (no size change)")

            # The missing-file steps free no disk (those files are already gone);
            # the real reclamation is the deleted thumbnails plus the vacuum.
            steps.append(f"Reclaimed {_fmt_size(thumb_bytes + db_freed)} of disk space")
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
        story_counts  = db.get_all_story_counts()  if adapter.has_stories else {}
        media_sizes   = _media_sizes_by_handle()
        for ch in channels:
            cid   = ch["channel_id"]
            ch["media_size_bytes"]      = media_sizes.get(ch["handle"], 0)
            stats = all_stats.get(cid, {})
            ch["live_stories"]          = live_stories.get(cid, 0)
            ch["story_count"]           = story_counts.get(cid, 0)
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
            return jsonify({"error": f"{noun} is already being tracked", "kind": "duplicate"}), 409

        if not _enqueue_add(handle):
            return jsonify({"error": "Already queued"}), 409
        return jsonify({"queued": True, "handle": handle}), 202

    def _queue_snapshot() -> dict:
        # Newest state per handle: pending lookups plus resolutions from the
        # last 10 minutes, so the frontend toasts catch changes between polls.
        rows = db.add_queue_recent(since=int(time.time()) - 600)
        return {
            r["handle"]: {"status": r["status"], "kind": r["error_kind"], "message": r["error_detail"]}
            for r in rows
        }

    @bp.route("/queue", methods=["GET"])
    def get_queue():
        return jsonify(_queue_snapshot())

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
        # ?delete_media=1 also deletes the creator's media folder from disk.
        # Default (no flag) keeps the files, matching the historical behaviour.
        delete_media = request.args.get("delete_media") == "1"
        ch = db.get_channel(channel_id) if delete_media else None
        db.remove_channel(channel_id)
        if delete_media and ch and ch.get("handle"):
            shutil.rmtree(os.path.join(MEDIA_DIR, platform, f"@{ch['handle']}"), ignore_errors=True)
        return jsonify({"ok": True})

    @bp.route("/channels/<channel_id>/storage", methods=["GET"])
    def channel_storage(channel_id: str):
        """Size and individual photo/video file counts of this creator's media
        folder, computed on demand (only when the modal opens, so no cost on
        the channel list)."""
        ch = db.get_channel(channel_id)
        if not ch:
            return jsonify({"error": "Not found"}), 404
        folder = os.path.join(MEDIA_DIR, platform, f"@{ch['handle']}")
        total = photos = videos = 0
        for dirpath, _dirs, files in os.walk(folder):
            is_thumbs = os.path.basename(dirpath) == "thumbs"
            for name in files:
                try:
                    total += os.path.getsize(os.path.join(dirpath, name))
                except OSError:
                    continue
                if is_thumbs:
                    continue
                ext = os.path.splitext(name)[1].lower()
                if ext in _PHOTO_EXTS:
                    photos += 1
                elif ext in _VIDEO_EXTS:
                    videos += 1
        return jsonify({"bytes": total, "photo_files": photos, "video_files": videos})

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

    @bp.route("/channels/<channel_id>/bookmark", methods=["PATCH"])
    def set_channel_bookmark(channel_id: str):
        ch = db.get_channel(channel_id)
        if not ch:
            return jsonify({"error": f"{noun} not found"}), 404
        body       = request.get_json(silent=True) or {}
        bookmarked = body.get("bookmarked")
        if not isinstance(bookmarked, bool):
            return jsonify({"error": "bookmarked must be a boolean"}), 400
        if not bookmarked and ch.get("starred"):
            return jsonify({"error": f"Starred {noun}s stay bookmarked"}), 409
        db.set_channel_bookmarked(channel_id, bookmarked)
        return jsonify({"ok": True})

    @bp.route("/channels/<channel_id>/pin", methods=["PATCH"])
    def set_channel_pin(channel_id: str):
        if not db.get_channel(channel_id):
            return jsonify({"error": f"{noun} not found"}), 404
        body   = request.get_json(silent=True) or {}
        pinned = body.get("pinned")
        if not isinstance(pinned, bool):
            return jsonify({"error": "pinned must be a boolean"}), 400
        db.set_channel_pinned(channel_id, pinned)
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

    @bp.route("/channels/<channel_id>/stats-history", methods=["GET"])
    def channel_stats_history(channel_id: str):
        # Daily stats snapshots (followers, following, on-platform posts,
        # locally saved posts), oldest first; feeds the profile stats graphs
        return jsonify(db.get_stats_history(channel_id))

    # ── Connected channels ────────────────────────────────────────────────────
    # Two-way links between creators on this platform (a person's second
    # channel). Creating a connection takes the other side's handle; both
    # channels must already be tracked here.

    @bp.route("/channels/<channel_id>/connections", methods=["GET"])
    def channel_connections(channel_id: str):
        return jsonify(db.get_connections(channel_id))

    @bp.route("/channels/<channel_id>/connections", methods=["POST"])
    def channel_connections_add(channel_id: str):
        if not db.get_channel(channel_id):
            return jsonify({"error": f"Unknown {adapter.creator_noun}"}), 404
        body   = request.get_json(silent=True) or {}
        handle = str(body.get("handle") or "").strip().lstrip("@")
        if not handle:
            return jsonify({"error": "handle required"}), 400
        other = db.get_channel_by_handle(handle)
        if not other:
            return jsonify({"error": f"@{handle} is not a tracked {adapter.creator_noun}"}), 404
        if other["channel_id"] == channel_id:
            return jsonify({"error": f"Cannot connect a {adapter.creator_noun} to itself"}), 400
        db.add_connection(channel_id, other["channel_id"])
        return jsonify({"ok": True, "connections": db.get_connections(channel_id)})

    @bp.route("/channels/<channel_id>/connections/<other_id>", methods=["DELETE"])
    def channel_connections_remove(channel_id: str, other_id: str):
        db.remove_connection(channel_id, other_id)
        return jsonify({"ok": True, "connections": db.get_connections(channel_id)})

    # ── Avatar and banner ─────────────────────────────────────────────────────

    @bp.route("/channels/<channel_id>/avatar", methods=["GET"])
    def channel_avatar(channel_id: str):
        # ?size=thumb serves a small cached variant, generated lazily. The
        # full-size originals are wasteful for the 20 to 48 px UI avatars.
        if request.args.get("size") == "thumb":
            from thumbnailer import avatar_thumb
            thumb = avatar_thumb(platform, channel_id)
            if thumb:
                return send_file(thumb, mimetype="image/avif", max_age=300)
        path = os.path.join(DATA_DIR, platform, "avatars", f"{channel_id}.avif")
        if os.path.exists(path):
            return send_file(path, mimetype="image/avif", max_age=300)
        jpg = os.path.join(DATA_DIR, platform, "avatars", f"{channel_id}.jpg")
        if os.path.exists(jpg):
            return send_file(jpg, mimetype="image/jpeg", max_age=300)
        return ("", 404)

    @bp.route("/channels/<channel_id>/avatar-history/<filename>", methods=["GET"])
    def channel_avatar_history(channel_id: str, filename: str):
        # Archived avatars: {channel_id}_{ts}.avif written by cache_avatar. The
        # strict pattern keeps the path inside the avatars dir.
        if not _re.fullmatch(r"[A-Za-z0-9_-]+_[0-9]+\.(jpg|avif)", filename):
            return ("", 400)
        path = os.path.join(DATA_DIR, platform, "avatars", filename)
        if not os.path.exists(path):
            return ("", 404)
        mime = "image/avif" if filename.endswith(".avif") else "image/jpeg"
        return send_file(path, mimetype=mime)

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

    # Walking a large media library takes a moment, so one walk buckets every
    # file under its @handle folder and the result is cached for 15 minutes
    # (stats poll every 60 s, the channel list every 15 s). Both the aggregate
    # size and the per-creator card sizes are served from this one map.
    _media_size_cache = {"ts": 0.0, "by_handle": {}, "total": 0, "video_files": 0, "photo_files": 0}

    def _media_sizes_by_handle() -> dict:
        now = time.time()
        if now - _media_size_cache["ts"] > 900:
            by_handle: dict = {}
            video_files = photo_files = 0
            root = os.path.join(MEDIA_DIR, platform)
            for dirpath, _dirs, files in os.walk(root):
                top = os.path.relpath(dirpath, root).split(os.sep)[0]
                if not top.startswith("@"):
                    continue
                handle    = top[1:]
                is_thumbs = os.path.basename(dirpath) == "thumbs"
                for name in files:
                    try:
                        by_handle[handle] = by_handle.get(handle, 0) + os.path.getsize(os.path.join(dirpath, name))
                    except OSError:
                        continue
                    if is_thumbs:
                        continue                 # thumbnails size storage but are not saved media
                    ext = os.path.splitext(name)[1].lower()
                    if ext in _PHOTO_EXTS:
                        photo_files += 1
                    elif ext in _VIDEO_EXTS:
                        video_files += 1
            _media_size_cache.update(ts=now, by_handle=by_handle, total=sum(by_handle.values()),
                                     video_files=video_files, photo_files=photo_files)
        return _media_size_cache["by_handle"]

    def _media_size_bytes() -> int:
        _media_sizes_by_handle()  # refresh the cache if stale
        return _media_size_cache["total"]

    @bp.route("/stats", methods=["GET"])
    def get_aggregate_stats():
        stats = db.get_aggregate_stats()
        stats["media_size_bytes"]  = _media_size_bytes()  # refreshes the cache
        stats["media_video_files"] = _media_size_cache["video_files"]
        stats["media_photo_files"] = _media_size_cache["photo_files"]
        return jsonify(stats)

    @bp.route("/recent", methods=["GET"])
    def get_recent():
        return jsonify(db.get_recent_activity())

    @bp.route("/recent/feed", methods=["GET"])
    def get_recent_feed():
        before = request.args.get("before", type=int)
        limit  = min(request.args.get("limit", 40, type=int) or 40, 100)
        kind   = request.args.get("kind") or None
        return jsonify(db.get_activity_feed(
            before=before, limit=limit, kind=kind,
            starred=request.args.get("starred") == "1",
            bookmarked=request.args.get("bookmarked") == "1"))

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

    def _status_snapshot() -> dict:
        state = loop.get_state_snapshot()
        if adapter.extend_status:
            adapter.extend_status(engine, state)
        return state

    @bp.route("/status", methods=["GET"])
    def get_status():
        return jsonify(_status_snapshot())

    # Panels served by plain GET routes, mapped to the tables whose writes
    # invalidate them (creators = /channels, recent = /recent/feed, stats =
    # /stats, sounds = the TikTok catalog; the sound tables never bump on the
    # other platforms so the domain just stays quiet there). The SSE stream
    # sums each domain's table write-versions once a second and names the
    # changed domains in a 'changed' event; the frontend refetches only those.
    _DATA_DOMAINS = {
        "creators": ("channels", "videos", "profile_history", "stories", "channel_stats_history", "channel_connections"),
        "recent":   ("channels", "videos", "profile_history"),
        "stats":    ("channels", "videos"),
        "sounds":   ("sounds", "sound_videos"),
    }

    @bp.route("/events", methods=["GET"])
    def events():
        """SSE stream: pushes 'status' and 'queue' snapshots whenever they
        change and a 'changed' event naming data domains whose tables were
        written, checked server-side once a second. The frontend keeps one
        stream open for the active platform tab and falls back to slow
        polling on hidden tabs, so at most one stream runs per browser tab
        and the werkzeug thread it holds is bounded."""
        def _gen():
            last: dict[str, str | None] = {"status": None, "queue": None}
            # Seeded silently: the client fetched everything at page load, so
            # the first 'changed' should mean a real write after connect.
            versions = {d: db.tables_version(*t) for d, t in _DATA_DOMAINS.items()}
            queue_ver = db.tables_version("add_queue")
            ticks = 0
            yield "retry: 3000\n\n"
            while True:
                data = _json.dumps(_status_snapshot(), default=str)
                if data != last["status"]:
                    last["status"] = data
                    yield f"event: status\ndata: {data}\n\n"
                # The queue snapshot is a DB query; only run it when add_queue
                # was written, plus every 30 s so rows falling out of its
                # 10-minute window still clear their toasts on an idle page.
                qv = db.tables_version("add_queue")
                if qv != queue_ver or ticks % 30 == 0 or last["queue"] is None:
                    queue_ver = qv
                    data = _json.dumps(_queue_snapshot(), default=str)
                    if data != last["queue"]:
                        last["queue"] = data
                        yield f"event: queue\ndata: {data}\n\n"
                changed = []
                for domain, tabs in _DATA_DOMAINS.items():
                    v = db.tables_version(*tabs)
                    if v != versions[domain]:
                        versions[domain] = v
                        changed.append(domain)
                if changed:
                    yield f"event: changed\ndata: {_json.dumps(changed)}\n\n"
                ticks += 1
                if ticks % 15 == 0:
                    # Comment frame: keeps proxies from idling the connection
                    # out and makes a vanished client fail the write, which
                    # ends this generator and frees the thread.
                    yield ": ping\n\n"
                time.sleep(1)

        return Response(_gen(), mimetype="text/event-stream",
                        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    def _check_trigger_preconditions():
        """Return (issues, is_running) for the loop trigger endpoints."""
        from config import get_path_issues
        return get_path_issues(), loop.is_running()

    def _trigger_nothing_to_run(mode: str, detail: str):
        """Respond to a manual trigger that has nothing to process.

        The trigger event is deliberately NOT fired: an empty run would only
        wake the scheduler to skip. Without a run the loop state never
        changes, so no status event reaches the page; the message in the
        response is the frontend's cue to toast and re-enable the button,
        and the log line is the trail in the loop console and run log."""
        message = f"Manual {mode} trigger: {detail}; loop not started"
        loop._log(message)
        return jsonify({"ok": True, "queued": 0, "mode": mode, "message": message})

    @bp.route("/trigger/next", methods=["POST"])
    def trigger_next_now():
        issues, running = _check_trigger_preconditions()
        if issues:
            return jsonify({"error": issues[0]["message"]}), 503
        if running:
            return jsonify({"error": "Loop is already running"}), 409
        from scheduling import get_channels_due_for_check
        due = get_channels_due_for_check(db, int(time.time()))
        if not due:
            return _trigger_nothing_to_run("next", f"no {adapter.creator_noun}s are due for a check")
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
        if not n:
            return _trigger_nothing_to_run("starred", f"no starred {adapter.creator_noun}s to check")
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
        if not n:
            return _trigger_nothing_to_run("half", f"no enabled {adapter.creator_noun}s to check")
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
        if not n:
            return _trigger_nothing_to_run("all", f"no enabled {adapter.creator_noun}s to check")
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
