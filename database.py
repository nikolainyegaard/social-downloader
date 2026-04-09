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
    # WAL is a persistent property; set it once rather than on every connection.
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
                privacy_status      TEXT DEFAULT 'public',
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

            CREATE TABLE IF NOT EXISTS profile_history (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                tiktok_id  TEXT NOT NULL,
                field      TEXT NOT NULL,
                old_value  TEXT,
                changed_at INTEGER NOT NULL,
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

            CREATE TABLE IF NOT EXISTS sounds (
                sound_id     TEXT PRIMARY KEY,
                label        TEXT,
                added_at     INTEGER NOT NULL,
                last_checked INTEGER,
                enabled      INTEGER NOT NULL DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS sound_videos (
                sound_id  TEXT NOT NULL,
                video_id  TEXT NOT NULL,
                added_at  INTEGER NOT NULL,
                PRIMARY KEY (sound_id, video_id),
                FOREIGN KEY (sound_id) REFERENCES sounds(sound_id),
                FOREIGN KEY (video_id) REFERENCES videos(video_id)
            );

            CREATE INDEX IF NOT EXISTS idx_sound_videos_sound
                ON sound_videos(sound_id);

            CREATE INDEX IF NOT EXISTS idx_videos_tiktok_id
                ON videos(tiktok_id);

            CREATE INDEX IF NOT EXISTS idx_videos_status
                ON videos(status);

            CREATE INDEX IF NOT EXISTS idx_profile_history_tiktok_id
                ON profile_history(tiktok_id);
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
        "ALTER TABLE users  ADD COLUMN privacy_status TEXT DEFAULT 'public'",
        "ALTER TABLE videos ADD COLUMN view_count     INTEGER",
        "ALTER TABLE videos ADD COLUMN like_count     INTEGER",
        "ALTER TABLE videos ADD COLUMN comment_count  INTEGER",
        "ALTER TABLE videos ADD COLUMN share_count    INTEGER",
        "ALTER TABLE videos ADD COLUMN save_count     INTEGER",
        "ALTER TABLE videos ADD COLUMN duration       REAL",
        "ALTER TABLE videos ADD COLUMN width          INTEGER",
        "ALTER TABLE videos ADD COLUMN height         INTEGER",
        "ALTER TABLE videos ADD COLUMN music_title    TEXT",
        "ALTER TABLE videos ADD COLUMN music_artist   TEXT",
        "ALTER TABLE videos ADD COLUMN raw_video_data TEXT",
        "ALTER TABLE videos ADD COLUMN ytdlp_data     TEXT",
        "ALTER TABLE users  ADD COLUMN verified       INTEGER DEFAULT 0",
        "ALTER TABLE users  ADD COLUMN avatar_url     TEXT",
        "ALTER TABLE users  ADD COLUMN raw_user_data  TEXT",
        "ALTER TABLE videos ADD COLUMN stats_backfilled_at INTEGER",
        "ALTER TABLE videos ADD COLUMN stats_error_count  INTEGER DEFAULT 0",
        "ALTER TABLE videos ADD COLUMN stats_last_error   TEXT",
        "ALTER TABLE users  ADD COLUMN banned_at          INTEGER",
        "ALTER TABLE videos ADD COLUMN music_id           TEXT",
        "ALTER TABLE users  ADD COLUMN tracking_enabled   INTEGER NOT NULL DEFAULT 1",
        "ALTER TABLE sounds ADD COLUMN tracking_enabled   INTEGER NOT NULL DEFAULT 1",
        "ALTER TABLE videos ADD COLUMN deleted_reason     TEXT",
        "ALTER TABLE videos ADD COLUMN stats_updated_at   INTEGER",
        "ALTER TABLE users  ADD COLUMN avatar_cached      INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE users  ADD COLUMN comment            TEXT",
    ]
    for sql in migrations:
        try:
            conn.execute(sql)
        except sqlite3.OperationalError:
            pass  # column already exists

    # Assign deleted_reason to all previously deleted videos that predate this column.
    # Only touches rows where deleted_reason IS NULL so user_banned rows are never overwritten.
    conn.execute("""
        UPDATE videos
        SET deleted_reason = 'video_deleted'
        WHERE status = 'deleted' AND deleted_reason IS NULL
    """)

    # Index depends on stats_backfilled_at which may have been added by migration above.
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_videos_stats_backfilled_at
            ON videos(stats_backfilled_at)
    """)

    # One-time stamp for videos that are already fully complete (have both view_count
    # and raw_video_data, meaning they were downloaded with v1.5.0+ and already have
    # all backfillable fields). Leaves v1-backfill victims and pre-stats videos as
    # NULL so they get one re-run to fill the fields the old backfill missed.
    conn.execute("""
        UPDATE videos
        SET stats_backfilled_at = COALESCE(download_date, CAST(strftime('%s','now') AS INTEGER))
        WHERE stats_backfilled_at IS NULL
          AND view_count    IS NOT NULL
          AND raw_video_data IS NOT NULL
          AND file_path IS NOT NULL
    """)

    # Clear the backfill stamp on any rows that were incorrectly marked as done
    # but are actually missing stats (view_count NULL). This surfaces them in the
    # header pill and makes them eligible for the next backfill run.
    conn.execute("""
        UPDATE videos
        SET stats_backfilled_at = NULL
        WHERE stats_backfilled_at IS NOT NULL
          AND view_count IS NULL
          AND COALESCE(stats_error_count, 0) < 3
          AND file_path IS NOT NULL
    """)

    # Backfill music_id from the stored raw JSON blob for any rows that have it
    conn.execute("""
        UPDATE videos
        SET music_id = json_extract(raw_video_data, '$.music.id')
        WHERE music_id IS NULL
          AND raw_video_data IS NOT NULL
    """)


# Tracking toggle

def set_user_enabled(tiktok_id: str, enabled: bool) -> None:
    """Set the enabled flag (whether the user appears in the tracked-user list)."""
    with get_db() as conn:
        conn.execute(
            "UPDATE users SET enabled = ? WHERE tiktok_id = ?",
            (1 if enabled else 0, tiktok_id),
        )


def set_user_tracking_enabled(tiktok_id: str, enabled: bool) -> None:
    with get_db() as conn:
        conn.execute(
            "UPDATE users SET tracking_enabled = ? WHERE tiktok_id = ?",
            (1 if enabled else 0, tiktok_id),
        )


def set_user_comment(tiktok_id: str, comment: str) -> None:
    with get_db() as conn:
        conn.execute(
            "UPDATE users SET comment = ? WHERE tiktok_id = ?",
            (comment or None, tiktok_id),
        )


def set_sound_tracking_enabled(sound_id: str, enabled: bool) -> None:
    with get_db() as conn:
        conn.execute(
            "UPDATE sounds SET tracking_enabled = ? WHERE sound_id = ?",
            (1 if enabled else 0, sound_id),
        )


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


def record_profile_change(tiktok_id: str, field: str, old_value: str | None) -> None:
    """Record that a profile field changed, storing the old value."""
    with get_db() as conn:
        conn.execute(
            "INSERT INTO profile_history (tiktok_id, field, old_value, changed_at) VALUES (?, ?, ?, ?)",
            (tiktok_id, field, old_value, int(time.time()))
        )


def set_avatar_cached(tiktok_id: str, cached: bool) -> None:
    with get_db() as conn:
        conn.execute("UPDATE users SET avatar_cached = ? WHERE tiktok_id = ?",
                     (1 if cached else 0, tiktok_id))


def backfill_avatar_cached() -> int:
    """
    Scan the avatars directory and set avatar_cached=1 for any user whose file
    already exists on disk. Called at startup so existing deployments don't lose
    avatars after the column is added with DEFAULT 0.
    Returns the number of files found.
    """
    from config import AVATARS_DIR
    if not os.path.isdir(AVATARS_DIR):
        return 0
    cached_ids = [
        os.path.splitext(fname)[0]
        for fname in os.listdir(AVATARS_DIR)
        if os.path.splitext(fname)[1].lower() in (".avif", ".jpg", ".jpeg")
        and "_" not in os.path.splitext(fname)[0]
    ]
    if not cached_ids:
        return 0
    with get_db() as conn:
        conn.executemany(
            "UPDATE users SET avatar_cached = 1 WHERE tiktok_id = ?",
            [(tid,) for tid in cached_ids]
        )
    return len(cached_ids)


def get_profile_history(tiktok_id: str) -> list[dict]:
    """Return all profile history entries for a user, newest first."""
    with get_db() as conn:
        return [dict(r) for r in conn.execute(
            """SELECT id, field, old_value, changed_at
               FROM profile_history
               WHERE tiktok_id = ?
               ORDER BY changed_at DESC""",
            (tiktok_id,)
        ).fetchall()]


def get_all_profile_history_counts() -> dict:
    """Return a dict of {tiktok_id: count} for all profile_history entries."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT tiktok_id, COUNT(*) AS cnt FROM profile_history GROUP BY tiktok_id"
        ).fetchall()
    return {r["tiktok_id"]: r["cnt"] for r in rows}


def get_user(tiktok_id):
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM users WHERE tiktok_id = ?", (tiktok_id,)
        ).fetchone()
        return dict(row) if row else None


def get_user_by_username(username: str):
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM users WHERE username = ?", (username,)
        ).fetchone()
        return dict(row) if row else None


def update_user_info(tiktok_id, username, display_name, bio,
                     follower_count, following_count, video_count,
                     sec_uid=None, verified=None, avatar_url=None, raw_user_data=None):
    with get_db() as conn:
        conn.execute("""
            UPDATE users SET
                sec_uid         = COALESCE(?, sec_uid),
                username        = ?,
                display_name    = ?,
                bio             = ?,
                follower_count  = ?,
                following_count = ?,
                video_count     = ?,
                verified        = COALESCE(?, verified),
                avatar_url      = COALESCE(?, avatar_url),
                raw_user_data   = COALESCE(?, raw_user_data),
                last_checked    = ?
            WHERE tiktok_id = ?
        """, (sec_uid, username, display_name, bio, follower_count, following_count,
              video_count, verified, avatar_url, raw_user_data, int(time.time()), tiktok_id))


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


def add_video(video_id, tiktok_id, video_type, description, upload_date,
              view_count=None, like_count=None, comment_count=None,
              share_count=None, save_count=None,
              duration=None, width=None, height=None,
              music_title=None, music_artist=None, music_id=None,
              raw_video_data=None):
    with get_db() as conn:
        conn.execute("""
            INSERT OR IGNORE INTO videos
                (video_id, tiktok_id, type, description, upload_date,
                 view_count, like_count, comment_count, share_count, save_count,
                 duration, width, height, music_title, music_artist, music_id,
                 raw_video_data, stats_backfilled_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (video_id, tiktok_id, video_type, description, upload_date,
              view_count, like_count, comment_count, share_count, save_count,
              duration, width, height, music_title, music_artist, music_id,
              raw_video_data,
              int(time.time()) if view_count is not None else None))


def update_video_downloaded(video_id, file_path, ytdlp_data=None):
    with get_db() as conn:
        conn.execute("""
            UPDATE videos SET download_date = ?, file_path = ?, ytdlp_data = ?
            WHERE video_id = ?
        """, (int(time.time()), file_path, ytdlp_data, video_id))


def mark_video_deleted(video_id):
    with get_db() as conn:
        conn.execute("""
            UPDATE videos
            SET status                 = 'deleted',
                deleted_reason         = 'video_deleted',
                deleted_at             = COALESCE(pending_deletion_since, ?),
                pending_deletion_count = 0,
                pending_deletion_since = NULL
            WHERE video_id = ? AND status IN ('up', 'undeleted')
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


def get_all_videos() -> list[dict]:
    """Return all video rows (used by the thumbnail backfill scan)."""
    with get_db() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT video_id, tiktok_id, type, file_path FROM videos"
        ).fetchall()]


def get_video(video_id: str) -> dict | None:
    """Return a single video row by video_id."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM videos WHERE video_id = ?", (video_id,)
        ).fetchone()
        return dict(row) if row else None


def get_all_video_stats() -> dict:
    """Return video stats keyed by tiktok_id."""
    with get_db() as conn:
        rows = conn.execute("""
            SELECT
                tiktok_id,
                COUNT(*)                                                                          AS video_total,
                COUNT(download_date)                                                              AS video_downloaded,
                SUM(CASE WHEN status = 'deleted'                              THEN 1 ELSE 0 END) AS video_deleted,
                SUM(CASE WHEN status = 'undeleted'                            THEN 1 ELSE 0 END) AS video_undeleted,
                SUM(CASE WHEN status = 'up' AND pending_deletion_count > 0    THEN 1 ELSE 0 END) AS video_missing
            FROM videos
            GROUP BY tiktok_id
        """).fetchall()
    return {r["tiktok_id"]: dict(r) for r in rows}


def update_user_privacy_status(tiktok_id: str, status: str):
    """status: 'public' | 'private_accessible' | 'private_blocked'"""
    with get_db() as conn:
        conn.execute(
            "UPDATE users SET privacy_status = ? WHERE tiktok_id = ?",
            (status, tiktok_id),
        )


def set_user_account_status(tiktok_id: str, status: str):
    with get_db() as conn:
        if status == "banned":
            conn.execute(
                "UPDATE users SET account_status = ?, banned_at = COALESCE(banned_at, ?) WHERE tiktok_id = ?",
                (status, int(time.time()), tiktok_id),
            )
        else:
            conn.execute(
                "UPDATE users SET account_status = ? WHERE tiktok_id = ?",
                (status, tiktok_id),
            )


def ban_user_videos(tiktok_id: str) -> int:
    """Mark all active videos for a user as deleted with reason 'user_banned'.
    Only affects videos with status 'up' or 'undeleted'. Already-deleted videos
    (deleted_reason='video_deleted') are left untouched.
    Returns the number of videos affected.
    """
    with get_db() as conn:
        conn.execute("""
            UPDATE videos
            SET status         = 'deleted',
                deleted_reason = 'user_banned',
                deleted_at     = ?
            WHERE tiktok_id = ? AND status IN ('up', 'undeleted')
        """, (int(time.time()), tiktok_id))
        row = conn.execute(
            "SELECT changes() AS n"
        ).fetchone()
    return row["n"] if row else 0


def restore_banned_videos(tiktok_id: str) -> int:
    """Re-activate all videos deleted by a ban (deleted_reason='user_banned').
    Videos individually deleted before the ban (deleted_reason='video_deleted')
    are left untouched. Returns the number of videos restored.
    """
    with get_db() as conn:
        conn.execute("""
            UPDATE videos
            SET status         = 'undeleted',
                deleted_reason = NULL,
                undeleted_at   = ?
            WHERE tiktok_id = ? AND deleted_reason = 'user_banned'
        """, (int(time.time()), tiktok_id))
        row = conn.execute(
            "SELECT changes() AS n"
        ).fetchone()
    return row["n"] if row else 0


def get_sound_active_video_ids(sound_id: str) -> set:
    """Video IDs linked to a sound that are currently active (up or undeleted)."""
    with get_db() as conn:
        rows = conn.execute("""
            SELECT v.video_id FROM videos v
            JOIN sound_videos sv ON v.video_id = sv.video_id
            WHERE sv.sound_id = ? AND v.status IN ('up', 'undeleted')
        """, (sound_id,)).fetchall()
    return {r["video_id"] for r in rows}


def get_sound_pending_deletion_video_ids(sound_id: str) -> set:
    """Video IDs linked to a sound that have a pending deletion counter."""
    with get_db() as conn:
        rows = conn.execute("""
            SELECT v.video_id FROM videos v
            JOIN sound_videos sv ON v.video_id = sv.video_id
            WHERE sv.sound_id = ? AND v.pending_deletion_count > 0
        """, (sound_id,)).fetchall()
    return {r["video_id"] for r in rows}


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
    """Return all past usernames keyed by tiktok_id, oldest first. Reads from profile_history."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT tiktok_id, old_value FROM profile_history WHERE field = 'username' ORDER BY changed_at"
        ).fetchall()
    result: dict = {}
    for row in rows:
        result.setdefault(row["tiktok_id"], []).append(row["old_value"])
    return result


def migrate_username_history_to_profile_history() -> int:
    """Copy username_history rows into profile_history. Safe to run multiple times (skips rows already present)."""
    with get_db() as conn:
        conn.execute("""
            INSERT INTO profile_history (tiktok_id, field, old_value, changed_at)
            SELECT uh.tiktok_id, 'username', uh.old_username, uh.changed_at
            FROM username_history uh
            WHERE NOT EXISTS (
                SELECT 1 FROM profile_history ph
                WHERE ph.tiktok_id  = uh.tiktok_id
                  AND ph.field      = 'username'
                  AND ph.old_value  = uh.old_username
                  AND ph.changed_at = uh.changed_at
            )
        """)
        return conn.execute(
            "SELECT COUNT(*) FROM profile_history WHERE field = 'username'"
        ).fetchone()[0]


_STATS_ERROR_THRESHOLD = 3  # give up after this many consecutive fetch failures


def get_videos_missing_stats() -> list[dict]:
    """Return downloaded, non-deleted videos that have never had a full stats fetch,
    joined to get the owner's current username. Excludes videos that have failed
    too many times (permanently inaccessible on TikTok)."""
    with get_db() as conn:
        return [dict(r) for r in conn.execute(
            """SELECT v.video_id, v.tiktok_id, u.username
               FROM videos v
               JOIN users u ON u.tiktok_id = v.tiktok_id
               WHERE v.stats_backfilled_at IS NULL
                 AND COALESCE(v.stats_error_count, 0) < ?
                 AND v.file_path IS NOT NULL
                 AND v.status != 'deleted'
                 AND v.pending_deletion_count = 0
               ORDER BY v.download_date""",
            (_STATS_ERROR_THRESHOLD,)
        ).fetchall()]


def count_downloaded_videos() -> int:
    with get_db() as conn:
        return conn.execute("SELECT COUNT(*) FROM videos WHERE file_path IS NOT NULL").fetchone()[0]


def count_videos_missing_stats() -> int:
    """Count of downloaded, non-deleted videos that have never had a full stats fetch
    and belong to a currently-tracked user (matches what get_videos_missing_stats returns)."""
    with get_db() as conn:
        row = conn.execute(
            """SELECT COUNT(*) FROM videos v
               JOIN users u ON u.tiktok_id = v.tiktok_id
               WHERE v.stats_backfilled_at IS NULL
                 AND COALESCE(v.stats_error_count, 0) < ?
                 AND v.file_path IS NOT NULL
                 AND v.status != 'deleted'
                 AND v.pending_deletion_count = 0""",
            (_STATS_ERROR_THRESHOLD,)
        ).fetchone()
    return row[0] if row else 0


def count_videos_stats_failed() -> int:
    """Count of videos that have been permanently abandoned by backfill (too many errors)."""
    with get_db() as conn:
        row = conn.execute(
            """SELECT COUNT(*) FROM videos v
               JOIN users u ON u.tiktok_id = v.tiktok_id
               WHERE v.stats_backfilled_at IS NULL
                 AND COALESCE(v.stats_error_count, 0) >= ?
                 AND v.file_path IS NOT NULL
                 AND v.status != 'deleted'""",
            (_STATS_ERROR_THRESHOLD,)
        ).fetchone()
    return row[0] if row else 0


def increment_stats_error(video_id: str, error_msg: str = "") -> int:
    """Increment the fetch-failure counter for a video. Returns the new count."""
    with get_db() as conn:
        conn.execute(
            """UPDATE videos
               SET stats_error_count = COALESCE(stats_error_count, 0) + 1,
                   stats_last_error  = ?
               WHERE video_id = ?""",
            (error_msg[:500] if error_msg else None, video_id)
        )
        row = conn.execute(
            "SELECT COALESCE(stats_error_count, 0) FROM videos WHERE video_id = ?",
            (video_id,)
        ).fetchone()
    return row[0] if row else 0


def get_videos_stats_failed() -> list[dict]:
    """Return videos permanently abandoned by backfill, with username and last error."""
    with get_db() as conn:
        return [dict(r) for r in conn.execute(
            """SELECT v.video_id, u.username, v.stats_error_count, v.stats_last_error
               FROM videos v
               JOIN users u ON u.tiktok_id = v.tiktok_id
               WHERE v.stats_backfilled_at IS NULL
                 AND COALESCE(v.stats_error_count, 0) >= ?
                 AND v.file_path IS NOT NULL
                 AND v.status != 'deleted'
               ORDER BY v.stats_error_count DESC""",
            (_STATS_ERROR_THRESHOLD,)
        ).fetchall()]


def update_video_stats(video_id: str, view_count=None, like_count=None,
                       comment_count=None, share_count=None, save_count=None,
                       duration=None, width=None, height=None,
                       music_title=None, music_artist=None, raw_video_data=None):
    with get_db() as conn:
        conn.execute("""
            UPDATE videos SET
                view_count         = ?,
                like_count         = ?,
                comment_count      = ?,
                share_count        = ?,
                save_count         = ?,
                duration           = COALESCE(?, duration),
                width              = COALESCE(?, width),
                height             = COALESCE(?, height),
                music_title        = COALESCE(?, music_title),
                music_artist       = COALESCE(?, music_artist),
                raw_video_data     = COALESCE(?, raw_video_data),
                stats_backfilled_at = ?
            WHERE video_id = ?
        """, (view_count, like_count, comment_count, share_count, save_count,
              duration, width, height, music_title, music_artist, raw_video_data,
              int(time.time()), video_id))


def update_video_stats_loop(video_id: str, view_count=None, like_count=None,
                            comment_count=None, share_count=None,
                            save_count=None) -> None:
    """Lightweight stats upsert called during the user loop (from item_list data).

    Uses COALESCE so a None from TikTok never overwrites an existing stored value.
    Sets stats_updated_at and stamps stats_backfilled_at (via COALESCE so an existing
    timestamp is preserved) so these videos don't show up as missing stats.
    """
    now = int(time.time())
    with get_db() as conn:
        conn.execute("""
            UPDATE videos SET
                view_count          = COALESCE(?, view_count),
                like_count          = COALESCE(?, like_count),
                comment_count       = COALESCE(?, comment_count),
                share_count         = COALESCE(?, share_count),
                save_count          = COALESCE(?, save_count),
                stats_updated_at    = ?,
                stats_backfilled_at = COALESCE(stats_backfilled_at, ?)
            WHERE video_id = ?
        """, (view_count, like_count, comment_count, share_count, save_count,
              now, now, video_id))


def delete_video(video_id: str) -> bool:
    """Hard-delete a video row and its sound junction entries. Returns True if a row was removed."""
    with get_db() as conn:
        conn.execute("DELETE FROM sound_videos WHERE video_id = ?", (video_id,))
        cur = conn.execute("DELETE FROM videos WHERE video_id = ?", (video_id,))
        return cur.rowcount > 0


def get_all_video_ids() -> set:
    """Return the set of all video_ids currently in the database."""
    with get_db() as conn:
        return {row[0] for row in conn.execute("SELECT video_id FROM videos").fetchall()}


def get_all_user_ids() -> set:
    """Return the set of all tiktok_ids currently in the users table."""
    with get_db() as conn:
        return {row[0] for row in conn.execute("SELECT tiktok_id FROM users").fetchall()}


def _group_consecutive_by_user(rows: list[dict], date_key: str) -> list[dict]:
    """Collapse a newest-first row list into groups of consecutive same-user entries.

    Each output dict has: tiktok_id, username, {date_key} (most recent in group), count.
    """
    groups: list[dict] = []
    for row in rows:
        if groups and groups[-1]["tiktok_id"] == row["tiktok_id"]:
            groups[-1]["count"] += 1
        else:
            groups.append({
                "tiktok_id": row["tiktok_id"],
                "username":  row["username"],
                "enabled":   row.get("enabled", 1),
                "video_id":  row.get("video_id"),
                "sound_id":  row.get("sound_id"),
                date_key:    row[date_key],
                "count":     1,
            })
    return groups


def get_recent_activity() -> dict:
    """Return recent deletions, profile changes, bans, and saves for the Recent panel."""
    with get_db() as conn:
        deletions = [dict(r) for r in conn.execute(
            """SELECT v.video_id, v.deleted_at, u.username, u.tiktok_id, u.enabled,
                      (SELECT sv.sound_id FROM sound_videos sv WHERE sv.video_id = v.video_id LIMIT 1) AS sound_id
               FROM videos v JOIN users u ON u.tiktok_id = v.tiktok_id
               WHERE v.status = 'deleted' AND v.deleted_at IS NOT NULL
                 AND v.deleted_reason = 'video_deleted'
               ORDER BY v.deleted_at DESC LIMIT 3"""
        ).fetchall()]
        profile_changes = [dict(r) for r in conn.execute(
            """SELECT ph.field, ph.changed_at, u.username, u.tiktok_id
               FROM profile_history ph JOIN users u ON u.tiktok_id = ph.tiktok_id
               ORDER BY ph.changed_at DESC LIMIT 3"""
        ).fetchall()]
        bans = [dict(r) for r in conn.execute(
            """SELECT tiktok_id, username, banned_at
               FROM users
               WHERE account_status = 'banned' AND banned_at IS NOT NULL
               ORDER BY banned_at DESC LIMIT 1"""
        ).fetchall()]
        saved_rows = [dict(r) for r in conn.execute(
            """SELECT v.download_date, u.username, u.tiktok_id, u.enabled, v.video_id,
                      (SELECT sv.sound_id FROM sound_videos sv WHERE sv.video_id = v.video_id LIMIT 1) AS sound_id
               FROM videos v JOIN users u ON u.tiktok_id = v.tiktok_id
               WHERE v.download_date IS NOT NULL AND v.file_path IS NOT NULL
               ORDER BY v.download_date DESC LIMIT 2000"""
        ).fetchall()]
    saved = _group_consecutive_by_user(saved_rows, "download_date")[:9]
    return {"deletions": deletions, "profile_changes": profile_changes, "bans": bans, "saved": saved}


def get_deletion_history(offset: int = 0, limit: int = 50) -> list[dict]:
    """Return paginated video deletion history (newest first), excluding user_banned."""
    with get_db() as conn:
        rows = conn.execute(
            """SELECT v.video_id, v.deleted_at, u.username, u.tiktok_id, u.enabled,
                      (SELECT sv.sound_id FROM sound_videos sv WHERE sv.video_id = v.video_id LIMIT 1) AS sound_id
               FROM videos v JOIN users u ON u.tiktok_id = v.tiktok_id
               WHERE v.status = 'deleted' AND v.deleted_at IS NOT NULL
                 AND v.deleted_reason = 'video_deleted'
               ORDER BY v.deleted_at DESC LIMIT ? OFFSET ?""",
            (limit, offset),
        ).fetchall()
    return [dict(r) for r in rows]


def get_profile_change_history(offset: int = 0, limit: int = 50) -> list[dict]:
    """Return paginated profile change history (newest first)."""
    with get_db() as conn:
        rows = conn.execute(
            """SELECT ph.field, ph.old_value, ph.changed_at, u.username, u.tiktok_id
               FROM profile_history ph JOIN users u ON u.tiktok_id = ph.tiktok_id
               ORDER BY ph.changed_at DESC LIMIT ? OFFSET ?""",
            (limit, offset),
        ).fetchall()
    return [dict(r) for r in rows]


def get_ban_history(offset: int = 0, limit: int = 50) -> list[dict]:
    """Return paginated ban history (newest first)."""
    with get_db() as conn:
        rows = conn.execute(
            """SELECT tiktok_id, username, banned_at
               FROM users
               WHERE account_status = 'banned' AND banned_at IS NOT NULL
               ORDER BY banned_at DESC LIMIT ? OFFSET ?""",
            (limit, offset),
        ).fetchall()
    return [dict(r) for r in rows]


_GROUP_SCAN = 2500  # raw rows scanned per page; generous enough to yield ≥50 groups

def get_saved_history(offset: int = 0, limit: int = 50) -> dict:
    """Return paginated grouped download history (newest first).

    Consecutive downloads by the same user are collapsed into one group.
    Returns {"items": [...groups...], "rows_consumed": N} where rows_consumed
    is the total raw rows spanned by the returned groups — the caller should
    advance its raw-row offset by this value for the next page.
    """
    with get_db() as conn:
        rows = [dict(r) for r in conn.execute(
            """SELECT v.download_date, u.username, u.tiktok_id, u.enabled, v.video_id,
                      (SELECT sv.sound_id FROM sound_videos sv WHERE sv.video_id = v.video_id LIMIT 1) AS sound_id
               FROM videos v JOIN users u ON u.tiktok_id = v.tiktok_id
               WHERE v.download_date IS NOT NULL AND v.file_path IS NOT NULL
               ORDER BY v.download_date DESC LIMIT ? OFFSET ?""",
            (_GROUP_SCAN, offset),
        ).fetchall()]
    groups = _group_consecutive_by_user(rows, "download_date")[:limit]
    return {"items": groups, "rows_consumed": sum(g["count"] for g in groups)}


def get_aggregate_stats() -> dict:
    """Return aggregate statistics across all tracked users and downloaded videos."""
    with get_db() as conn:
        urow = conn.execute("SELECT COUNT(*) FROM users").fetchone()
        vrow = conn.execute("""
            SELECT
                SUM(CASE WHEN type = 'video'   THEN 1 ELSE 0 END) AS video_count,
                SUM(CASE WHEN type = 'photo'   THEN 1 ELSE 0 END) AS photo_count,
                SUM(CASE WHEN status != 'deleted' THEN 1 ELSE 0 END) AS saved_count,
                SUM(CASE WHEN status =  'deleted' THEN 1 ELSE 0 END) AS deleted_count,
                COALESCE(SUM(view_count), 0)                       AS total_views,
                COALESCE(SUM(like_count), 0)                       AS total_likes,
                MAX(download_date)                                 AS latest_download
            FROM videos
            WHERE file_path IS NOT NULL
        """).fetchone()
    return {
        "user_count":      urow[0],
        "video_count":     vrow["video_count"]   or 0,
        "photo_count":     vrow["photo_count"]   or 0,
        "saved_count":     vrow["saved_count"]   or 0,
        "deleted_count":   vrow["deleted_count"] or 0,
        "total_views":     vrow["total_views"]   or 0,
        "total_likes":     vrow["total_likes"]   or 0,
        "latest_download": vrow["latest_download"],
    }


def delete_orphaned_records() -> int:
    """Delete video, username_history, and profile_history rows for users no longer in
    the users table. Does NOT touch files on disk. Returns the number of rows deleted."""
    with get_db() as conn:
        videos   = conn.execute(
            "DELETE FROM videos WHERE tiktok_id NOT IN (SELECT tiktok_id FROM users)"
        ).rowcount
        history  = conn.execute(
            "DELETE FROM username_history WHERE tiktok_id NOT IN (SELECT tiktok_id FROM users)"
        ).rowcount
        profile  = conn.execute(
            "DELETE FROM profile_history WHERE tiktok_id NOT IN (SELECT tiktok_id FROM users)"
        ).rowcount
    return videos + history + profile


def reset_backfill_status() -> int:
    """Set stats_backfilled_at = NULL on every video, making all eligible for re-backfill.
    Returns the number of rows affected."""
    with get_db() as conn:
        cur = conn.execute("UPDATE videos SET stats_backfilled_at = NULL")
        return cur.rowcount


def reset_backfill_errors() -> int:
    """Clear stats_error_count and stats_last_error for all permanently-failed videos,
    making them eligible for the next backfill run. Returns the number of rows affected."""
    with get_db() as conn:
        cur = conn.execute(
            """UPDATE videos
               SET stats_error_count = 0, stats_last_error = NULL
               WHERE COALESCE(stats_error_count, 0) >= ?""",
            (_STATS_ERROR_THRESHOLD,),
        )
        return cur.rowcount


# Sound tracking

def add_sound(sound_id: str, label: str | None = None) -> bool:
    """Add a sound to track. Returns True if newly added, False if already present."""
    with get_db() as conn:
        cur = conn.execute(
            "INSERT OR IGNORE INTO sounds (sound_id, label, added_at) VALUES (?, ?, ?)",
            (sound_id, label, int(time.time())),
        )
        return cur.rowcount > 0


def remove_sound(sound_id: str) -> None:
    with get_db() as conn:
        conn.execute("DELETE FROM sounds WHERE sound_id = ?", (sound_id,))


def get_all_sounds() -> list[dict]:
    with get_db() as conn:
        rows = conn.execute("""
            SELECT s.*,
                   COUNT(sv.video_id)                                              AS video_count,
                   SUM(CASE WHEN v.status = 'deleted'   THEN 1 ELSE 0 END)        AS video_deleted,
                   SUM(CASE WHEN v.status = 'undeleted' THEN 1 ELSE 0 END)        AS video_undeleted
            FROM sounds s
            LEFT JOIN sound_videos sv ON sv.sound_id = s.sound_id
            LEFT JOIN videos v        ON v.video_id  = sv.video_id
            WHERE s.enabled = 1
            GROUP BY s.sound_id
            ORDER BY s.added_at
        """).fetchall()
    return [dict(r) for r in rows]


def get_sound_videos(sound_id: str) -> list[dict]:
    """Return all video rows associated with a sound, newest first.
    Includes author_username from the users table (NULL for untracked authors)."""
    with get_db() as conn:
        return [dict(r) for r in conn.execute("""
            SELECT v.*, u.username AS author_username, u.enabled AS author_enabled
            FROM videos v
            JOIN sound_videos sv ON sv.video_id  = v.video_id
            LEFT JOIN users u    ON u.tiktok_id  = v.tiktok_id
            WHERE sv.sound_id = ?
            ORDER BY v.upload_date DESC
        """, (sound_id,)).fetchall()]


def update_sound_label(sound_id: str, label: str | None) -> None:
    with get_db() as conn:
        conn.execute(
            "UPDATE sounds SET label = ? WHERE sound_id = ?",
            (label, sound_id),
        )


def get_sound(sound_id: str) -> dict | None:
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM sounds WHERE sound_id = ?", (sound_id,)
        ).fetchone()
    return dict(row) if row else None


def update_sound_last_checked(sound_id: str) -> None:
    with get_db() as conn:
        conn.execute(
            "UPDATE sounds SET last_checked = ? WHERE sound_id = ?",
            (int(time.time()), sound_id),
        )


def add_sound_video(sound_id: str, video_id: str) -> bool:
    """Link a video to a sound in the junction table. Returns True if newly added."""
    with get_db() as conn:
        cur = conn.execute(
            "INSERT OR IGNORE INTO sound_videos (sound_id, video_id, added_at) VALUES (?, ?, ?)",
            (sound_id, video_id, int(time.time())),
        )
        return cur.rowcount > 0


def get_sound_video_ids(sound_id: str) -> set:
    """Return all known video IDs for a sound (from junction table)."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT video_id FROM sound_videos WHERE sound_id = ?", (sound_id,)
        ).fetchall()
    return {r["video_id"] for r in rows}


def ensure_sound_user(tiktok_id: str, username: str,
                      sec_uid: str | None = None) -> bool:
    """Ensure a user row exists for a sound-discovered author.
    Adds with enabled=0 if not present. Returns True if newly inserted."""
    with get_db() as conn:
        existing = conn.execute(
            "SELECT tiktok_id FROM users WHERE tiktok_id = ?", (tiktok_id,)
        ).fetchone()
        if existing:
            return False
        conn.execute("""
            INSERT INTO users (tiktok_id, sec_uid, username, added_at, enabled)
            VALUES (?, ?, ?, ?, 0)
        """, (tiktok_id, sec_uid, username, int(time.time())))
        return True


def vacuum() -> None:
    """Run VACUUM on the database to reclaim freed space. Opens its own connection
    because VACUUM cannot run inside an active transaction."""
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute("VACUUM")
    finally:
        conn.close()


# Settings (generic key/value store)

def get_setting(key: str, default: str | None = None) -> str | None:
    with get_db() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row[0] if row else default


def set_setting(key: str, value: str | None) -> None:
    with get_db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, value)
        )


def update_video_file_path(video_id: str, file_path: str) -> None:
    """Update the stored file path for a video (e.g. after format conversion)."""
    with get_db() as conn:
        conn.execute(
            "UPDATE videos SET file_path = ? WHERE video_id = ?",
            (file_path, video_id),
        )


def find_missing_video_files() -> list[dict]:
    """Return a list of DB rows whose local file no longer exists on disk.

    Each entry: {video_id, file_path}. Does not modify the database.
    """
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
    """Delete DB rows for videos whose local file no longer exists on disk.

    Calls find_missing_video_files() then hard-deletes each via delete_video()
    (which also removes sound_videos junction entries). Returns the count removed.
    """
    missing = find_missing_video_files()
    for entry in missing:
        delete_video(entry["video_id"])
    return len(missing)


def migrate_del_prefix() -> int:
    """Remove the del_ filename prefix from video files on disk and update file_path in the DB.
    Safe to run multiple times; skips videos without a del_-prefixed path.
    Returns the number of records updated.
    """
    with get_db() as conn:
        rows = conn.execute(
            "SELECT video_id, file_path FROM videos WHERE file_path IS NOT NULL"
        ).fetchall()

    updates: list[tuple] = []
    for row in rows:
        video_id, file_path = row[0], row[1]
        folder   = os.path.dirname(file_path)
        basename = os.path.basename(file_path)

        if not basename.startswith("del_"):
            continue

        # Rename every del_{video_id}* file in the folder (covers multi-image photo posts)
        if os.path.isdir(folder):
            try:
                for fname in sorted(os.listdir(folder)):
                    if not fname.startswith(f"del_{video_id}"):
                        continue
                    src = os.path.join(folder, fname)
                    dst = os.path.join(folder, fname[4:])  # strip "del_"
                    if os.path.exists(src) and not os.path.exists(dst):
                        os.rename(src, dst)
            except OSError:
                pass

        new_path = os.path.join(folder, basename[4:])  # strip "del_" from stored path
        updates.append((new_path, video_id))

    if updates:
        with get_db() as conn:
            conn.executemany(
                "UPDATE videos SET file_path = ? WHERE video_id = ?", updates
            )

    return len(updates)
