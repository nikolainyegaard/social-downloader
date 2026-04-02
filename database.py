import sqlite3
import time
import os
from contextlib import contextmanager

from config import DATA_DIR

DB_PATH = os.path.join(DATA_DIR, "tiktok.db")


@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    with get_db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                tiktok_id           TEXT PRIMARY KEY,
                sec_uid             TEXT,
                username            TEXT NOT NULL,
                display_name        TEXT,
                bio                 TEXT,
                follower_count      INTEGER DEFAULT 0,
                following_count     INTEGER DEFAULT 0,
                video_count         INTEGER DEFAULT 0,
                join_date           INTEGER,
                account_status      TEXT DEFAULT 'active',
                added_at            INTEGER NOT NULL,
                last_checked        INTEGER,
                enabled             INTEGER DEFAULT 1,
                pending_ban_count   INTEGER NOT NULL DEFAULT 0,
                pending_ban_since   INTEGER
            );

            CREATE TABLE IF NOT EXISTS username_history (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                tiktok_id    TEXT NOT NULL,
                old_username TEXT NOT NULL,
                new_username TEXT NOT NULL,
                changed_at   INTEGER NOT NULL,
                FOREIGN KEY (tiktok_id) REFERENCES users(tiktok_id)
            );

            CREATE TABLE IF NOT EXISTS videos (
                video_id                TEXT PRIMARY KEY,
                tiktok_id               TEXT NOT NULL,
                type                    TEXT DEFAULT 'video',
                description             TEXT,
                upload_date             INTEGER,
                download_date           INTEGER,
                file_path               TEXT,
                status                  TEXT DEFAULT 'up',
                deleted_at              INTEGER,
                undeleted_at            INTEGER,
                pending_deletion_count  INTEGER NOT NULL DEFAULT 0,
                pending_deletion_since  INTEGER,
                FOREIGN KEY (tiktok_id) REFERENCES users(tiktok_id)
            );
        """)
        _migrate_db(conn)


def _migrate_db(conn):
    """Add columns introduced after the initial schema. Safe to run on existing DBs."""
    migrations = [
        "ALTER TABLE users  ADD COLUMN sec_uid            TEXT",
        "ALTER TABLE users  ADD COLUMN pending_ban_count  INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE users  ADD COLUMN pending_ban_since  INTEGER",
        "ALTER TABLE videos ADD COLUMN pending_deletion_count INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE videos ADD COLUMN pending_deletion_since INTEGER",
    ]
    for sql in migrations:
        try:
            conn.execute(sql)
        except sqlite3.OperationalError:
            pass  # column already exists


# User operations

def add_user(tiktok_id, username, display_name=None, bio=None,
             follower_count=0, following_count=0, video_count=0,
             join_date=None, sec_uid=None):
    with get_db() as conn:
        conn.execute("""
            INSERT OR IGNORE INTO users
                (tiktok_id, sec_uid, username, display_name, bio, follower_count,
                 following_count, video_count, join_date, added_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (tiktok_id, sec_uid, username, display_name, bio,
              follower_count, following_count, video_count, join_date,
              int(time.time())))


def remove_user(tiktok_id):
    with get_db() as conn:
        conn.execute("DELETE FROM users WHERE tiktok_id = ?", (tiktok_id,))


def get_all_users():
    with get_db() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM users WHERE enabled = 1 ORDER BY username"
        ).fetchall()]


def get_username_history(tiktok_id: str) -> list:
    """Return all past usernames for a user, oldest first."""
    with get_db() as conn:
        return [dict(r) for r in conn.execute(
            """SELECT old_username, new_username, changed_at
               FROM username_history
               WHERE tiktok_id = ?
               ORDER BY changed_at""",
            (tiktok_id,)
        ).fetchall()]


def get_user(tiktok_id):
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM users WHERE tiktok_id = ?", (tiktok_id,)
        ).fetchone()
        return dict(row) if row else None


def update_user_info(tiktok_id, username, display_name, bio,
                     follower_count, following_count, video_count, sec_uid=None):
    with get_db() as conn:
        existing = conn.execute(
            "SELECT username FROM users WHERE tiktok_id = ?", (tiktok_id,)
        ).fetchone()
        if existing and existing["username"] != username:
            conn.execute("""
                INSERT INTO username_history (tiktok_id, old_username, new_username, changed_at)
                VALUES (?, ?, ?, ?)
            """, (tiktok_id, existing["username"], username, int(time.time())))
        conn.execute("""
            UPDATE users SET
                sec_uid         = COALESCE(?, sec_uid),
                username        = ?,
                display_name    = ?,
                bio             = ?,
                follower_count  = ?,
                following_count = ?,
                video_count     = ?,
                last_checked    = ?
            WHERE tiktok_id = ?
        """, (sec_uid, username, display_name, bio, follower_count, following_count,
              video_count, int(time.time()), tiktok_id))


# Video operations

def get_video_id_sets(tiktok_id) -> tuple[set, set]:
    """Return (known_ids, active_ids) for a user."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT video_id, status FROM videos WHERE tiktok_id = ?", (tiktok_id,)
        ).fetchall()
    known  = {r["video_id"] for r in rows}
    active = {r["video_id"] for r in rows if r["status"] in ("up", "undeleted")}
    return known, active


def add_video(video_id, tiktok_id, video_type, description, upload_date):
    with get_db() as conn:
        conn.execute("""
            INSERT OR IGNORE INTO videos (video_id, tiktok_id, type, description, upload_date)
            VALUES (?, ?, ?, ?, ?)
        """, (video_id, tiktok_id, video_type, description, upload_date))


def update_video_downloaded(video_id, file_path):
    with get_db() as conn:
        conn.execute("""
            UPDATE videos SET download_date = ?, file_path = ?
            WHERE video_id = ?
        """, (int(time.time()), file_path, video_id))


def update_video_file_path(video_id, file_path):
    with get_db() as conn:
        conn.execute(
            "UPDATE videos SET file_path = ? WHERE video_id = ?",
            (file_path, video_id),
        )


def mark_video_deleted(video_id):
    with get_db() as conn:
        conn.execute("""
            UPDATE videos
            SET status                 = 'deleted',
                deleted_at             = COALESCE(pending_deletion_since, ?),
                pending_deletion_count = 0,
                pending_deletion_since = NULL
            WHERE video_id = ? AND status = 'up'
        """, (int(time.time()), video_id))


def mark_video_undeleted(video_id):
    with get_db() as conn:
        conn.execute("""
            UPDATE videos
            SET status                 = 'undeleted',
                undeleted_at           = ?,
                pending_deletion_count = 0,
                pending_deletion_since = NULL
            WHERE video_id = ? AND status = 'deleted'
        """, (int(time.time()), video_id))


def get_videos_for_user(tiktok_id):
    with get_db() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM videos WHERE tiktok_id = ? ORDER BY upload_date DESC",
            (tiktok_id,)
        ).fetchall()]


def get_all_video_stats() -> dict:
    """Return video stats keyed by tiktok_id."""
    with get_db() as conn:
        rows = conn.execute("""
            SELECT
                tiktok_id,
                COUNT(*)                                              AS video_total,
                COUNT(download_date)                                  AS video_downloaded,
                SUM(CASE WHEN status = 'deleted'   THEN 1 ELSE 0 END) AS video_deleted,
                SUM(CASE WHEN status = 'undeleted' THEN 1 ELSE 0 END) AS video_undeleted
            FROM videos
            GROUP BY tiktok_id
        """).fetchall()
    return {r["tiktok_id"]: dict(r) for r in rows}


def set_user_account_status(tiktok_id: str, status: str):
    with get_db() as conn:
        conn.execute(
            "UPDATE users SET account_status = ? WHERE tiktok_id = ?",
            (status, tiktok_id),
        )


def increment_user_pending_ban(tiktok_id: str) -> int:
    with get_db() as conn:
        conn.execute("""
            UPDATE users
            SET pending_ban_count = pending_ban_count + 1,
                pending_ban_since = COALESCE(pending_ban_since, ?)
            WHERE tiktok_id = ?
        """, (int(time.time()), tiktok_id))
        row = conn.execute(
            "SELECT pending_ban_count FROM users WHERE tiktok_id = ?", (tiktok_id,)
        ).fetchone()
    return row["pending_ban_count"] if row else 0


def clear_user_pending_ban(tiktok_id: str):
    with get_db() as conn:
        conn.execute(
            "UPDATE users SET pending_ban_count = 0, pending_ban_since = NULL WHERE tiktok_id = ?",
            (tiktok_id,),
        )


def get_pending_deletion_video_ids(tiktok_id: str) -> set:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT video_id FROM videos WHERE tiktok_id = ? AND pending_deletion_count > 0",
            (tiktok_id,),
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


def clear_video_pending_deletion(video_id: str):
    with get_db() as conn:
        conn.execute(
            "UPDATE videos SET pending_deletion_count = 0, pending_deletion_since = NULL WHERE video_id = ?",
            (video_id,),
        )


def rename_user_video_paths(tiktok_id: str, old_username: str, new_username: str):
    """Update all file_path values in videos when a user's folder is renamed."""
    with get_db() as conn:
        conn.execute("""
            UPDATE videos SET file_path = REPLACE(file_path, ?, ?)
            WHERE tiktok_id = ? AND file_path IS NOT NULL
        """, (f"@{old_username}/", f"@{new_username}/", tiktok_id))


def get_all_username_history() -> dict:
    """Return all past usernames keyed by tiktok_id, oldest first."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT tiktok_id, old_username FROM username_history ORDER BY changed_at"
        ).fetchall()
    result: dict = {}
    for row in rows:
        result.setdefault(row["tiktok_id"], []).append(row["old_username"])
    return result
