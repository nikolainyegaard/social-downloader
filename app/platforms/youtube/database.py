import json
import sqlite3
import time
import os
from contextlib import contextmanager
from datetime import datetime

from config import DATA_DIR, MEDIA_DIR  # noqa: F401

YOUTUBE_DATA_DIR = os.path.join(DATA_DIR, "youtube")
DB_PATH          = os.path.join(YOUTUBE_DATA_DIR, "youtube.db")


@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    os.makedirs(YOUTUBE_DATA_DIR, exist_ok=True)
    _conn = sqlite3.connect(DB_PATH)
    try:
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.commit()
    finally:
        _conn.close()
    needs_vacuum = False
    with get_db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT
            );

            CREATE TABLE IF NOT EXISTS channels (
                channel_id       TEXT PRIMARY KEY,
                handle           TEXT NOT NULL,
                display_name     TEXT,
                description      TEXT,
                subscriber_count INTEGER,
                video_count      INTEGER,
                added_at         INTEGER NOT NULL,
                last_checked     INTEGER,
                enabled          INTEGER DEFAULT 1,
                tracking_enabled INTEGER DEFAULT 1,
                starred          INTEGER DEFAULT 0,
                comment          TEXT,
                avatar_url       TEXT,
                avatar_cached    INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS profile_history (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                channel_id TEXT NOT NULL,
                field      TEXT NOT NULL,
                old_value  TEXT,
                changed_at INTEGER NOT NULL,
                FOREIGN KEY (channel_id) REFERENCES channels(channel_id)
            );

            CREATE TABLE IF NOT EXISTS videos (
                video_id               TEXT PRIMARY KEY,
                channel_id             TEXT NOT NULL,
                title                  TEXT,
                upload_date            INTEGER,
                download_date          INTEGER,
                file_path              TEXT,
                status                 TEXT DEFAULT 'up',
                deleted_at             INTEGER,
                undeleted_at           INTEGER,
                pending_deletion_count INTEGER DEFAULT 0,
                pending_deletion_since INTEGER,
                view_count             INTEGER,
                like_count             INTEGER,
                comment_count          INTEGER,
                duration               REAL,
                width                  INTEGER,
                height                 INTEGER,
                FOREIGN KEY (channel_id) REFERENCES channels(channel_id)
            );

            CREATE INDEX IF NOT EXISTS idx_videos_channel_id
                ON videos(channel_id);

            CREATE INDEX IF NOT EXISTS idx_videos_status
                ON videos(status);

            CREATE INDEX IF NOT EXISTS idx_profile_history_channel_id
                ON profile_history(channel_id);
        """)
        needs_vacuum = _migrate_db(conn)
    if needs_vacuum:
        vacuum()


def _migrate_db(conn) -> bool:
    """Add columns introduced after the initial schema. Safe to run on existing DBs."""
    migrations: list[str] = [
        "ALTER TABLE channels ADD COLUMN banner_url             TEXT",
        "ALTER TABLE channels ADD COLUMN banner_cached          INTEGER DEFAULT 0",
        "ALTER TABLE channels ADD COLUMN raw_channel_data       TEXT",
        "ALTER TABLE videos   ADD COLUMN content_type           TEXT DEFAULT 'video'",
        "ALTER TABLE videos   ADD COLUMN raw_video_data         TEXT",
        "ALTER TABLE videos   ADD COLUMN ytdlp_data             TEXT",
        # Video metadata extracted from yt-dlp info dict
        "ALTER TABLE videos   ADD COLUMN description            TEXT",
        "ALTER TABLE videos   ADD COLUMN tags                   TEXT",
        "ALTER TABLE videos   ADD COLUMN categories             TEXT",
        "ALTER TABLE videos   ADD COLUMN fps                    INTEGER",
        "ALTER TABLE videos   ADD COLUMN vcodec                 TEXT",
        "ALTER TABLE videos   ADD COLUMN acodec                 TEXT",
        "ALTER TABLE videos   ADD COLUMN filesize_approx        INTEGER",
        "ALTER TABLE videos   ADD COLUMN age_limit              INTEGER DEFAULT 0",
        "ALTER TABLE videos   ADD COLUMN channel_follower_count INTEGER",
        "ALTER TABLE videos   ADD COLUMN availability           TEXT",
        "ALTER TABLE videos   ADD COLUMN was_live               INTEGER DEFAULT 0",
        "ALTER TABLE videos   ADD COLUMN language               TEXT",
        "ALTER TABLE videos   ADD COLUMN dynamic_range          TEXT",
        "ALTER TABLE videos   ADD COLUMN chapters               TEXT",
        "ALTER TABLE videos   ADD COLUMN timestamp              INTEGER",
        "ALTER TABLE videos   ADD COLUMN tbr                    REAL",
        "ALTER TABLE videos   ADD COLUMN vbr                    REAL",
        "ALTER TABLE videos   ADD COLUMN abr                    REAL",
        "ALTER TABLE videos   ADD COLUMN asr                    INTEGER",
        "ALTER TABLE videos   ADD COLUMN audio_channels         INTEGER",
        "ALTER TABLE videos   ADD COLUMN aspect_ratio           REAL",
        "ALTER TABLE videos   ADD COLUMN format                 TEXT",
        "ALTER TABLE videos   ADD COLUMN format_id              TEXT",
        "ALTER TABLE videos   ADD COLUMN format_note            TEXT",
        "ALTER TABLE videos   ADD COLUMN resolution             TEXT",
        "ALTER TABLE videos   ADD COLUMN duration_string        TEXT",
        "ALTER TABLE videos   ADD COLUMN channel_url            TEXT",
        "ALTER TABLE videos   ADD COLUMN webpage_url            TEXT",
        "ALTER TABLE videos   ADD COLUMN original_url           TEXT",
        "ALTER TABLE videos   ADD COLUMN uploader_url           TEXT",
        "ALTER TABLE videos   ADD COLUMN channel_name           TEXT",
        "ALTER TABLE videos   ADD COLUMN uploader               TEXT",
        "ALTER TABLE videos   ADD COLUMN uploader_id            TEXT",
        "ALTER TABLE videos   ADD COLUMN channel_is_verified    INTEGER DEFAULT 0",
    ]
    for sql in migrations:
        try:
            conn.execute(sql)
        except sqlite3.OperationalError:
            pass

    # ── ONE-TIME MIGRATION: backfill dedicated columns from raw JSON blobs ────────
    # Migrates the dev database from the "store raw ytdlp JSON" approach to
    # dedicated columns, then drops the two blob columns. Runs once and becomes
    # a no-op on any DB that has already been migrated (or was created fresh after
    # this version). Remove this block (and _one_time_backfill_ytdlp_columns) once
    # the migration has run on all relevant databases. See CLAUDE.md for details.
    _one_time_backfill_ytdlp_columns(conn)
    dropped = False
    for col in ("ytdlp_data", "raw_video_data"):
        try:
            conn.execute(f"ALTER TABLE videos DROP COLUMN {col}")
            dropped = True
        except sqlite3.OperationalError:
            pass
    # ── END ONE-TIME MIGRATION ─────────────────────────────────────────────────────
    return dropped


def _one_time_backfill_ytdlp_columns(conn) -> None:
    """Extract individual fields from ytdlp_data JSON blobs into dedicated columns."""
    try:
        rows = conn.execute(
            "SELECT video_id, ytdlp_data FROM videos WHERE ytdlp_data IS NOT NULL"
        ).fetchall()
    except sqlite3.OperationalError:
        return  # column doesn't exist; nothing to backfill
    for row in rows:
        try:
            d = json.loads(row["ytdlp_data"])
        except Exception:
            continue
        try:
            conn.execute("""
                UPDATE videos SET
                    description            = COALESCE(description, ?),
                    tags                   = COALESCE(tags, ?),
                    categories             = COALESCE(categories, ?),
                    fps                    = COALESCE(fps, ?),
                    vcodec                 = COALESCE(vcodec, ?),
                    acodec                 = COALESCE(acodec, ?),
                    filesize_approx        = COALESCE(filesize_approx, ?),
                    age_limit              = COALESCE(age_limit, ?),
                    channel_follower_count = COALESCE(channel_follower_count, ?),
                    availability           = COALESCE(availability, ?),
                    was_live               = COALESCE(was_live, ?),
                    language               = COALESCE(language, ?),
                    dynamic_range          = COALESCE(dynamic_range, ?),
                    chapters               = COALESCE(chapters, ?),
                    timestamp              = COALESCE(timestamp, ?),
                    tbr                    = COALESCE(tbr, ?),
                    vbr                    = COALESCE(vbr, ?),
                    abr                    = COALESCE(abr, ?),
                    asr                    = COALESCE(asr, ?),
                    audio_channels         = COALESCE(audio_channels, ?),
                    aspect_ratio           = COALESCE(aspect_ratio, ?),
                    format                 = COALESCE(format, ?),
                    format_id              = COALESCE(format_id, ?),
                    format_note            = COALESCE(format_note, ?),
                    resolution             = COALESCE(resolution, ?),
                    duration_string        = COALESCE(duration_string, ?),
                    channel_url            = COALESCE(channel_url, ?),
                    webpage_url            = COALESCE(webpage_url, ?),
                    original_url           = COALESCE(original_url, ?),
                    uploader_url           = COALESCE(uploader_url, ?),
                    channel_name           = COALESCE(channel_name, ?),
                    uploader               = COALESCE(uploader, ?),
                    uploader_id            = COALESCE(uploader_id, ?),
                    channel_is_verified    = COALESCE(channel_is_verified, ?)
                WHERE video_id = ?
            """, (
                d.get("description"),
                json.dumps(d["tags"])       if d.get("tags")       else None,
                json.dumps(d["categories"]) if d.get("categories") else None,
                d.get("fps"),
                d.get("vcodec"),
                d.get("acodec"),
                d.get("filesize_approx"),
                d.get("age_limit"),
                d.get("channel_follower_count"),
                d.get("availability"),
                1 if d.get("was_live") else None,
                d.get("language"),
                d.get("dynamic_range"),
                json.dumps(d["chapters"])   if d.get("chapters")   else None,
                d.get("timestamp"),
                d.get("tbr"),
                d.get("vbr"),
                d.get("abr"),
                d.get("asr"),
                d.get("audio_channels"),
                d.get("aspect_ratio"),
                d.get("format"),
                d.get("format_id"),
                d.get("format_note"),
                d.get("resolution"),
                d.get("duration_string"),
                d.get("channel_url"),
                d.get("webpage_url"),
                d.get("original_url"),
                d.get("uploader_url"),
                d.get("channel"),
                d.get("uploader"),
                d.get("uploader_id"),
                1 if d.get("channel_is_verified") else None,
                row["video_id"],
            ))
        except Exception:
            pass


# Channel operations

def add_channel(channel_id: str, handle: str, display_name: str | None = None,
                description: str | None = None, subscriber_count: int | None = None,
                video_count: int | None = None, avatar_url: str | None = None,
                banner_url: str | None = None,
                raw_channel_data: str | None = None) -> None:
    with get_db() as conn:
        conn.execute("""
            INSERT OR IGNORE INTO channels
                (channel_id, handle, display_name, description, subscriber_count,
                 video_count, avatar_url, banner_url, raw_channel_data, added_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (channel_id, handle, display_name, description, subscriber_count,
              video_count, avatar_url, banner_url, raw_channel_data, int(time.time())))


def remove_channel(channel_id: str) -> None:
    with get_db() as conn:
        conn.execute("DELETE FROM channels WHERE channel_id = ?", (channel_id,))


def get_all_channels() -> list[dict]:
    with get_db() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM channels WHERE enabled = 1 ORDER BY handle"
        ).fetchall()]


def get_channel(channel_id: str) -> dict | None:
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM channels WHERE channel_id = ?", (channel_id,)
        ).fetchone()
        return dict(row) if row else None


def get_channel_by_handle(handle: str) -> dict | None:
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM channels WHERE handle = ?", (handle,)
        ).fetchone()
        return dict(row) if row else None


def update_channel_info(channel_id: str, handle: str, display_name: str | None,
                        description: str | None, subscriber_count: int | None,
                        video_count: int | None, avatar_url: str | None = None,
                        banner_url: str | None = None,
                        raw_channel_data: str | None = None) -> None:
    with get_db() as conn:
        conn.execute("""
            UPDATE channels SET
                handle           = ?,
                display_name     = ?,
                description      = ?,
                subscriber_count = COALESCE(?, subscriber_count),
                video_count      = COALESCE(?, video_count),
                avatar_url       = COALESCE(?, avatar_url),
                banner_url       = COALESCE(?, banner_url),
                raw_channel_data = COALESCE(?, raw_channel_data),
                last_checked     = ?
            WHERE channel_id = ?
        """, (handle, display_name, description, subscriber_count, video_count,
              avatar_url, banner_url, raw_channel_data, int(time.time()), channel_id))


def record_profile_change(channel_id: str, field: str, old_value: str | None) -> None:
    with get_db() as conn:
        conn.execute(
            "INSERT INTO profile_history (channel_id, field, old_value, changed_at) VALUES (?, ?, ?, ?)",
            (channel_id, field, old_value, int(time.time()))
        )


def set_avatar_cached(channel_id: str, cached: bool) -> None:
    with get_db() as conn:
        conn.execute(
            "UPDATE channels SET avatar_cached = ? WHERE channel_id = ?",
            (1 if cached else 0, channel_id)
        )


def set_banner_cached(channel_id: str, cached: bool) -> None:
    with get_db() as conn:
        conn.execute(
            "UPDATE channels SET banner_cached = ? WHERE channel_id = ?",
            (1 if cached else 0, channel_id)
        )


def set_channel_tracking_enabled(channel_id: str, enabled: bool) -> None:
    with get_db() as conn:
        conn.execute(
            "UPDATE channels SET tracking_enabled = ? WHERE channel_id = ?",
            (1 if enabled else 0, channel_id)
        )


def set_channel_starred(channel_id: str, starred: bool) -> None:
    with get_db() as conn:
        conn.execute(
            "UPDATE channels SET starred = ? WHERE channel_id = ?",
            (1 if starred else 0, channel_id)
        )


def set_channel_comment(channel_id: str, comment: str | None) -> None:
    with get_db() as conn:
        conn.execute(
            "UPDATE channels SET comment = ? WHERE channel_id = ?",
            (comment or None, channel_id)
        )


def get_profile_history(channel_id: str) -> list[dict]:
    with get_db() as conn:
        return [dict(r) for r in conn.execute(
            """SELECT id, field, old_value, changed_at
               FROM profile_history
               WHERE channel_id = ?
               ORDER BY changed_at DESC""",
            (channel_id,)
        ).fetchall()]


def get_all_profile_history_counts() -> dict:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT channel_id, COUNT(*) AS cnt FROM profile_history GROUP BY channel_id"
        ).fetchall()
    return {r["channel_id"]: r["cnt"] for r in rows}


# Video operations

def get_video_id_sets(channel_id: str) -> tuple[set, set]:
    """Return (known_ids, active_ids) for a channel."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT video_id, status FROM videos WHERE channel_id = ?", (channel_id,)
        ).fetchall()
    known  = {r["video_id"] for r in rows}
    active = {r["video_id"] for r in rows if r["status"] in ("up", "undeleted")}
    return known, active


def add_video(video_id: str, channel_id: str, title: str | None, upload_date: int | None,
              view_count: int | None = None, duration: float | None = None,
              content_type: str | None = None) -> None:
    with get_db() as conn:
        conn.execute("""
            INSERT OR IGNORE INTO videos
                (video_id, channel_id, title, upload_date, view_count, duration, content_type)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (video_id, channel_id, title, upload_date, view_count, duration, content_type or "video"))


def update_video_downloaded(video_id: str, file_path: str, ytdlp_data_json: str | None = None) -> None:
    d: dict = {}
    if ytdlp_data_json:
        try:
            d = json.loads(ytdlp_data_json)
        except Exception:
            pass

    now = int(time.time())

    if not d:
        with get_db() as conn:
            conn.execute(
                "UPDATE videos SET download_date = ?, file_path = ? WHERE video_id = ?",
                (now, file_path, video_id)
            )
        return

    with get_db() as conn:
        conn.execute("""
            UPDATE videos SET
                download_date          = ?,
                file_path              = ?,
                title                  = COALESCE(?, title),
                view_count             = COALESCE(?, view_count),
                like_count             = ?,
                comment_count          = COALESCE(?, comment_count),
                width                  = COALESCE(?, width),
                height                 = COALESCE(?, height),
                duration               = COALESCE(?, duration),
                description            = ?,
                tags                   = ?,
                categories             = ?,
                fps                    = ?,
                vcodec                 = ?,
                acodec                 = ?,
                filesize_approx        = ?,
                age_limit              = ?,
                channel_follower_count = ?,
                availability           = ?,
                was_live               = ?,
                language               = ?,
                dynamic_range          = ?,
                chapters               = ?,
                timestamp              = COALESCE(?, timestamp),
                tbr                    = ?,
                vbr                    = ?,
                abr                    = ?,
                asr                    = ?,
                audio_channels         = ?,
                aspect_ratio           = ?,
                format                 = ?,
                format_id              = ?,
                format_note            = ?,
                resolution             = ?,
                duration_string        = ?,
                channel_url            = ?,
                webpage_url            = ?,
                original_url           = ?,
                uploader_url           = ?,
                channel_name           = ?,
                uploader               = ?,
                uploader_id            = ?,
                channel_is_verified    = ?
            WHERE video_id = ?
        """, (
            now,
            file_path,
            d.get("title"),
            d.get("view_count"),
            d.get("like_count"),
            d.get("comment_count"),
            d.get("width"),
            d.get("height"),
            d.get("duration"),
            d.get("description"),
            json.dumps(d["tags"])       if d.get("tags")       else None,
            json.dumps(d["categories"]) if d.get("categories") else None,
            d.get("fps"),
            d.get("vcodec"),
            d.get("acodec"),
            d.get("filesize_approx"),
            d.get("age_limit"),
            d.get("channel_follower_count"),
            d.get("availability"),
            1 if d.get("was_live") else 0,
            d.get("language"),
            d.get("dynamic_range"),
            json.dumps(d["chapters"])   if d.get("chapters")   else None,
            d.get("timestamp"),
            d.get("tbr"),
            d.get("vbr"),
            d.get("abr"),
            d.get("asr"),
            d.get("audio_channels"),
            d.get("aspect_ratio"),
            d.get("format"),
            d.get("format_id"),
            d.get("format_note"),
            d.get("resolution"),
            d.get("duration_string"),
            d.get("channel_url"),
            d.get("webpage_url"),
            d.get("original_url"),
            d.get("uploader_url"),
            d.get("channel"),
            d.get("uploader"),
            d.get("uploader_id"),
            1 if d.get("channel_is_verified") else 0,
            video_id,
        ))


def mark_video_deleted(video_id: str) -> None:
    with get_db() as conn:
        conn.execute("""
            UPDATE videos
            SET status                 = 'deleted',
                deleted_at             = COALESCE(pending_deletion_since, ?),
                pending_deletion_count = 0,
                pending_deletion_since = NULL
            WHERE video_id = ? AND status IN ('up', 'undeleted')
        """, (int(time.time()), video_id))


def mark_video_undeleted(video_id: str) -> None:
    with get_db() as conn:
        conn.execute("""
            UPDATE videos
            SET status                 = 'undeleted',
                undeleted_at           = ?,
                pending_deletion_count = 0,
                pending_deletion_since = NULL
            WHERE video_id = ? AND status = 'deleted'
        """, (int(time.time()), video_id))


def get_videos_for_channel(channel_id: str) -> list[dict]:
    with get_db() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM videos WHERE channel_id = ? ORDER BY upload_date DESC",
            (channel_id,)
        ).fetchall()]


def get_video(video_id: str) -> dict | None:
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM videos WHERE video_id = ?", (video_id,)
        ).fetchone()
        if not row:
            return None
        result = dict(row)
        if result.get("file_path"):
            result["file_path"] = os.path.abspath(result["file_path"])
        return result


def backfill_upload_dates() -> int:
    """Fill upload_date from stored timestamp for rows where upload_date IS NULL."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT video_id, timestamp FROM videos WHERE upload_date IS NULL AND timestamp IS NOT NULL"
        ).fetchall()
        updated = 0
        for row in rows:
            try:
                conn.execute(
                    "UPDATE videos SET upload_date = ? WHERE video_id = ?",
                    (int(row["timestamp"]), row["video_id"])
                )
                updated += 1
            except Exception:
                pass
    return updated


def get_all_videos() -> list[dict]:
    """Return all video rows (used by the thumbnail backfill scan)."""
    with get_db() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT video_id, channel_id, file_path FROM videos"
        ).fetchall()]


def get_all_video_stats() -> dict:
    with get_db() as conn:
        rows = conn.execute("""
            SELECT
                channel_id,
                COUNT(*)                                                                          AS video_total,
                COUNT(download_date)                                                              AS video_downloaded,
                SUM(CASE WHEN status = 'deleted'                              THEN 1 ELSE 0 END) AS video_deleted,
                SUM(CASE WHEN status = 'undeleted'                            THEN 1 ELSE 0 END) AS video_undeleted,
                SUM(CASE WHEN status = 'up' AND pending_deletion_count > 0    THEN 1 ELSE 0 END) AS video_missing
            FROM videos
            GROUP BY channel_id
        """).fetchall()
    return {r["channel_id"]: dict(r) for r in rows}


def get_pending_deletion_video_ids(channel_id: str) -> set:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT video_id FROM videos WHERE channel_id = ? AND pending_deletion_count > 0",
            (channel_id,),
        ).fetchall()
    return {r["video_id"] for r in rows}


def increment_video_pending_deletion(video_id: str) -> int:
    with get_db() as conn:
        conn.execute("""
            UPDATE videos
            SET pending_deletion_count = pending_deletion_count + 1,
                pending_deletion_since = COALESCE(pending_deletion_since, ?)
            WHERE video_id = ?
        """, (int(time.time()), video_id))
        row = conn.execute(
            "SELECT pending_deletion_count FROM videos WHERE video_id = ?", (video_id,)
        ).fetchone()
    return row["pending_deletion_count"] if row else 0


def clear_video_pending_deletion(video_id: str) -> None:
    with get_db() as conn:
        conn.execute(
            "UPDATE videos SET pending_deletion_count = 0, pending_deletion_since = NULL WHERE video_id = ?",
            (video_id,),
        )


def rename_channel_video_paths(channel_id: str, old_handle: str, new_handle: str) -> None:
    with get_db() as conn:
        conn.execute("""
            UPDATE videos SET file_path = REPLACE(file_path, ?, ?)
            WHERE channel_id = ? AND file_path IS NOT NULL
        """, (f"youtube/@{old_handle}/", f"youtube/@{new_handle}/", channel_id))


def count_downloaded_videos() -> int:
    with get_db() as conn:
        return conn.execute("SELECT COUNT(*) FROM videos WHERE file_path IS NOT NULL").fetchone()[0]


def get_aggregate_stats() -> dict:
    with get_db() as conn:
        crow = conn.execute("SELECT COUNT(*) FROM channels WHERE enabled = 1").fetchone()
        vrow = conn.execute("""
            SELECT
                SUM(CASE WHEN status != 'deleted' THEN 1 ELSE 0 END) AS saved_count,
                SUM(CASE WHEN status =  'deleted' THEN 1 ELSE 0 END) AS deleted_count,
                COALESCE(SUM(view_count), 0)                         AS total_views,
                MAX(download_date)                                   AS latest_download
            FROM videos
            WHERE file_path IS NOT NULL
        """).fetchone()
    return {
        "channel_count":   crow[0],
        "saved_count":     (vrow["saved_count"]   or 0) if vrow else 0,
        "deleted_count":   (vrow["deleted_count"] or 0) if vrow else 0,
        "total_views":     (vrow["total_views"]    or 0) if vrow else 0,
        "latest_download": vrow["latest_download"]       if vrow else None,
    }


def _group_consecutive_by_channel(rows: list[dict], date_key: str) -> list[dict]:
    groups: list[dict] = []
    for row in rows:
        if groups and groups[-1]["channel_id"] == row["channel_id"]:
            groups[-1]["count"] += 1
        else:
            groups.append({
                "channel_id": row["channel_id"],
                "handle":     row["handle"],
                "enabled":    row.get("enabled", 1),
                "video_id":   row.get("video_id"),
                date_key:     row[date_key],
                "count":      1,
            })
    return groups


def get_recent_activity() -> dict:
    with get_db() as conn:
        deletions = [dict(r) for r in conn.execute("""
            SELECT v.video_id, v.deleted_at, c.handle, c.channel_id, c.enabled
            FROM videos v JOIN channels c ON c.channel_id = v.channel_id
            WHERE v.status = 'deleted' AND v.deleted_at IS NOT NULL
            ORDER BY v.deleted_at DESC LIMIT 3
        """).fetchall()]
        profile_changes = [dict(r) for r in conn.execute("""
            SELECT ph.field, ph.changed_at, c.handle, c.channel_id
            FROM profile_history ph JOIN channels c ON c.channel_id = ph.channel_id
            ORDER BY ph.changed_at DESC LIMIT 3
        """).fetchall()]
        saved_rows = [dict(r) for r in conn.execute("""
            SELECT v.download_date, c.handle, c.channel_id, c.enabled, v.video_id
            FROM videos v JOIN channels c ON c.channel_id = v.channel_id
            WHERE v.download_date IS NOT NULL AND v.file_path IS NOT NULL
            ORDER BY v.download_date DESC LIMIT 2000
        """).fetchall()]
    saved = _group_consecutive_by_channel(saved_rows, "download_date")[:9]
    return {"deletions": deletions, "profile_changes": profile_changes, "saved": saved}


def get_all_video_ids() -> set:
    with get_db() as conn:
        return {row[0] for row in conn.execute("SELECT video_id FROM videos").fetchall()}


def get_all_channel_ids() -> set:
    with get_db() as conn:
        return {row[0] for row in conn.execute("SELECT channel_id FROM channels").fetchall()}


def delete_orphaned_records() -> int:
    with get_db() as conn:
        videos  = conn.execute(
            "DELETE FROM videos WHERE channel_id NOT IN (SELECT channel_id FROM channels)"
        ).rowcount
        history = conn.execute(
            "DELETE FROM profile_history WHERE channel_id NOT IN (SELECT channel_id FROM channels)"
        ).rowcount
    return videos + history


def delete_video(video_id: str) -> bool:
    with get_db() as conn:
        cur = conn.execute("DELETE FROM videos WHERE video_id = ?", (video_id,))
        return cur.rowcount > 0


def find_missing_video_files() -> list[dict]:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT video_id, file_path FROM videos WHERE file_path IS NOT NULL"
        ).fetchall()
    return [
        {"video_id": row[0], "file_path": row[1]}
        for row in rows
        if not os.path.exists(row[1])
    ]


def delete_missing_video_files() -> int:
    missing = find_missing_video_files()
    for entry in missing:
        delete_video(entry["video_id"])
    return len(missing)


def vacuum() -> None:
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute("VACUUM")
    finally:
        conn.close()


def get_setting(key: str, default: str | None = None) -> str | None:
    with get_db() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row[0] if row else default


def set_setting(key: str, value) -> None:
    with get_db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, str(value))
        )
