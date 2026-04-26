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
                ytdlp_data             TEXT,
                FOREIGN KEY (channel_id) REFERENCES channels(channel_id)
            );

            CREATE INDEX IF NOT EXISTS idx_videos_channel_id
                ON videos(channel_id);

            CREATE INDEX IF NOT EXISTS idx_videos_status
                ON videos(status);

            CREATE INDEX IF NOT EXISTS idx_profile_history_channel_id
                ON profile_history(channel_id);
        """)
        _migrate_db(conn)


def _migrate_db(conn):
    """Add columns introduced after the initial schema. Safe to run on existing DBs."""
    migrations: list[str] = [
        "ALTER TABLE channels ADD COLUMN banner_url       TEXT",
        "ALTER TABLE channels ADD COLUMN banner_cached    INTEGER DEFAULT 0",
        "ALTER TABLE channels ADD COLUMN raw_channel_data TEXT",
        "ALTER TABLE videos   ADD COLUMN content_type     TEXT DEFAULT 'video'",
        "ALTER TABLE videos   ADD COLUMN raw_video_data   TEXT",
    ]
    for sql in migrations:
        try:
            conn.execute(sql)
        except sqlite3.OperationalError:
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
              content_type: str | None = None,
              raw_video_data: str | None = None) -> None:
    with get_db() as conn:
        conn.execute("""
            INSERT OR IGNORE INTO videos
                (video_id, channel_id, title, upload_date, view_count, duration, content_type, raw_video_data)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (video_id, channel_id, title, upload_date, view_count, duration, content_type or "video", raw_video_data))


def update_video_downloaded(video_id: str, file_path: str, ytdlp_data: str | None = None) -> None:
    with get_db() as conn:
        conn.execute("""
            UPDATE videos SET download_date = ?, file_path = ?, ytdlp_data = ?
            WHERE video_id = ?
        """, (int(time.time()), file_path, ytdlp_data, video_id))


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
        return dict(row) if row else None


def backfill_upload_dates() -> int:
    """Parse upload_date from ytdlp_data for rows where upload_date IS NULL. Returns rows updated."""
    updated = 0
    with get_db() as conn:
        rows = conn.execute(
            "SELECT video_id, ytdlp_data FROM videos WHERE upload_date IS NULL AND ytdlp_data IS NOT NULL"
        ).fetchall()
        for row in rows:
            try:
                data = json.loads(row["ytdlp_data"])
                ts: int | None = None
                raw_date = data.get("upload_date")
                if raw_date:
                    try:
                        ts = int(datetime.strptime(str(raw_date), "%Y%m%d").timestamp())
                    except (ValueError, TypeError):
                        pass
                if ts is None:
                    raw_ts = data.get("timestamp")
                    if raw_ts:
                        try:
                            ts = int(raw_ts)
                        except (ValueError, TypeError):
                            pass
                if ts:
                    conn.execute("UPDATE videos SET upload_date = ? WHERE video_id = ?", (ts, row["video_id"]))
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
