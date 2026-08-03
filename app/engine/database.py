"""Channel platform database: one SQLite file per platform, identical schema.

ChannelDB replaces the per-platform database.py clones (twitter, instagram,
youtube). Each engine instance owns one ChannelDB; all methods match the old
module-level function signatures so callers moved over unchanged.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
import os
from contextlib import contextmanager

from config import DATA_DIR

# Authorizer action codes for statements that write a table
_WRITE_ACTIONS = (sqlite3.SQLITE_INSERT, sqlite3.SQLITE_UPDATE, sqlite3.SQLITE_DELETE)


class ChannelDB:

    _GROUP_SCAN = 2500  # raw rows scanned per page; generous enough to yield >= 50 groups

    def __init__(self, platform: str):
        self.platform = platform
        self.data_dir = os.path.join(DATA_DIR, platform)
        self.DB_PATH  = os.path.join(self.data_dir, f"{platform}.db")
        # Per-table write-version counters, bumped after every committed
        # get_db() block that wrote the table. The SSE stream sums them into
        # per-panel versions, so the frontend refetches a panel the moment
        # any writer (loop thread, add worker, web route) commits a change
        # instead of polling on timers. In-memory only: versions restart at 0
        # on relaunch, which is fine because the stream diffs against what it
        # already sent on the same connection.
        self._table_versions: dict[str, int] = {}
        self._versions_lock = threading.Lock()

    @contextmanager
    def get_db(self):
        conn = sqlite3.connect(self.DB_PATH)
        conn.row_factory = sqlite3.Row
        written: set[str] = set()

        def _track_writes(action, arg1, _arg2, _dbname, _source):
            # Fires at statement compile time: a table lands in `written`
            # even when the statement ends up matching zero rows. That only
            # over-signals (a no-op refetch downstream), never misses.
            if action in _WRITE_ACTIONS and arg1:
                written.add(arg1)
            return sqlite3.SQLITE_OK

        conn.set_authorizer(_track_writes)
        try:
            yield conn
            conn.commit()
            if written:
                with self._versions_lock:
                    for table in written:
                        self._table_versions[table] = self._table_versions.get(table, 0) + 1
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def tables_version(self, *tables: str) -> int:
        """Combined write-version of the given tables. Monotonic, so equality
        with a previously seen value means none of them were written since."""
        with self._versions_lock:
            return sum(self._table_versions.get(t, 0) for t in tables)


    def init_db(self):
        os.makedirs(self.data_dir, exist_ok=True)
        _conn = sqlite3.connect(self.DB_PATH)
        try:
            _conn.execute("PRAGMA journal_mode=WAL")
            _conn.commit()
        finally:
            _conn.close()
        needs_vacuum = False
        with self.get_db() as conn:
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

                CREATE TABLE IF NOT EXISTS stories (
                    story_id     TEXT PRIMARY KEY,
                    channel_id   TEXT NOT NULL,
                    content_type TEXT DEFAULT 'video',
                    posted_at    INTEGER,
                    expires_at   INTEGER,
                    saved_at     INTEGER,
                    file_path    TEXT,
                    FOREIGN KEY (channel_id) REFERENCES channels(channel_id)
                );

                CREATE INDEX IF NOT EXISTS idx_stories_channel_id
                    ON stories(channel_id);

                CREATE INDEX IF NOT EXISTS idx_videos_channel_id
                    ON videos(channel_id);

                CREATE INDEX IF NOT EXISTS idx_videos_status
                    ON videos(status);

                CREATE INDEX IF NOT EXISTS idx_profile_history_channel_id
                    ON profile_history(channel_id);

                CREATE TABLE IF NOT EXISTS add_queue (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    handle       TEXT NOT NULL,
                    status       TEXT NOT NULL DEFAULT 'pending',
                    error_kind   TEXT,
                    error_detail TEXT,
                    created_at   INTEGER NOT NULL,
                    updated_at   INTEGER NOT NULL
                );

                -- Time series behind the profile stats graphs: one row per
                -- creator per local calendar day, upserted by every profile
                -- check that day so the day carries its latest values.
                CREATE TABLE IF NOT EXISTS channel_stats_history (
                    channel_id       TEXT NOT NULL,
                    day              TEXT NOT NULL,
                    ts               INTEGER NOT NULL,
                    subscriber_count INTEGER,
                    following_count  INTEGER,
                    video_count      INTEGER,
                    saved_count      INTEGER,
                    PRIMARY KEY (channel_id, day),
                    FOREIGN KEY (channel_id) REFERENCES channels(channel_id)
                );

                -- Two-way links between creators on this platform (a person's
                -- second channel, alt account, ...). One row per pair, stored
                -- with channel_a < channel_b so a pair cannot exist twice.
                CREATE TABLE IF NOT EXISTS channel_connections (
                    channel_a  TEXT NOT NULL,
                    channel_b  TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY (channel_a, channel_b),
                    FOREIGN KEY (channel_a) REFERENCES channels(channel_id),
                    FOREIGN KEY (channel_b) REFERENCES channels(channel_id)
                );
            """)
            needs_vacuum = self._migrate_db(conn)
            # One-time backfill: seed the add history from already tracked
            # channels so the panel starts populated instead of empty. A no-op
            # once add_queue has any rows.
            if not conn.execute("SELECT 1 FROM add_queue LIMIT 1").fetchone():
                conn.execute("""
                    INSERT INTO add_queue (handle, status, created_at, updated_at)
                    SELECT handle, 'ok', added_at, added_at FROM channels
                    WHERE enabled = 1 ORDER BY added_at
                """)
            # Invariant: starred channels are always bookmarked. Cheap and
            # idempotent, so it also repairs pre-bookmark databases on launch.
            conn.execute("UPDATE channels SET bookmarked = 1 WHERE starred = 1 AND bookmarked = 0")
            # Backfill bans recorded before transitions to banned were written
            # to profile_history (July 2026 fix): any channel with a banned_at
            # stamp but no recorded to-banned transition gets a synthetic
            # account_status row at banned_at, so the modal's Profile History
            # shows the ban. Idempotent: the inserted row satisfies the NOT
            # EXISTS on the next launch.
            conn.execute("""
                INSERT INTO profile_history (channel_id, field, old_value, changed_at)
                SELECT c.channel_id, 'account_status', 'active', c.banned_at
                FROM channels c
                WHERE c.banned_at IS NOT NULL
                  AND NOT EXISTS (
                      SELECT 1 FROM profile_history ph
                      WHERE ph.channel_id = c.channel_id
                        AND ph.field = 'account_status'
                        AND ph.old_value != 'banned'
                  )
            """)
        if needs_vacuum:
            self.vacuum()


    def _migrate_db(self, conn) -> bool:
        """Add columns introduced after the initial schema. Safe to run on existing DBs."""
        migrations: list[str] = [
            "ALTER TABLE channels ADD COLUMN banner_url             TEXT",
            "ALTER TABLE channels ADD COLUMN banner_cached          INTEGER DEFAULT 0",
            "ALTER TABLE channels ADD COLUMN raw_channel_data       TEXT",
            # Pure filter flag: no loop or scheduling logic reads it
            "ALTER TABLE channels ADD COLUMN bookmarked             INTEGER DEFAULT 0",
            # Quick Access pin; NULL = unpinned, set time orders the row
            "ALTER TABLE channels ADD COLUMN pinned_at              INTEGER",
            "ALTER TABLE videos   ADD COLUMN content_type           TEXT DEFAULT 'video'",
            "ALTER TABLE videos   ADD COLUMN raw_video_data         TEXT",
            "ALTER TABLE videos   ADD COLUMN ytdlp_data             TEXT",
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
            "ALTER TABLE channels ADD COLUMN last_video_at          INTEGER",
            "ALTER TABLE channels ADD COLUMN next_check_at          INTEGER",
            "ALTER TABLE channels ADD COLUMN check_interval_secs    INTEGER",
            "ALTER TABLE channels ADD COLUMN last_full_refresh_at   INTEGER",
            # Engine domain model: availability, privacy, and viewer relations.
            # Populated per platform according to adapter capabilities; a NULL
            # or default value means "not applicable or not yet observed".
            "ALTER TABLE channels ADD COLUMN account_status         TEXT DEFAULT 'active'",
            "ALTER TABLE channels ADD COLUMN banned_at              INTEGER",
            "ALTER TABLE channels ADD COLUMN privacy_status         TEXT",
            "ALTER TABLE channels ADD COLUMN viewer_relations       TEXT",
            # Present in the engine's initial schema but absent from a folded-in
            # TikTok DB, whose own migration history dropped them.
            "ALTER TABLE videos   ADD COLUMN pending_deletion_count INTEGER DEFAULT 0",
            "ALTER TABLE videos   ADD COLUMN pending_deletion_since INTEGER",
            # Creator profile fields shared by cookie-authenticated platforms
            # (populated where the platform exposes them; TikTok fold-in).
            "ALTER TABLE channels ADD COLUMN sec_uid                TEXT",
            "ALTER TABLE channels ADD COLUMN following_count        INTEGER",
            "ALTER TABLE channels ADD COLUMN join_date              INTEGER",
            "ALTER TABLE channels ADD COLUMN verified               INTEGER DEFAULT 0",
            "ALTER TABLE channels ADD COLUMN bio_link               TEXT",
            "ALTER TABLE channels ADD COLUMN relation               INTEGER",
            "ALTER TABLE channels ADD COLUMN profile_fail_count     INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE channels ADD COLUMN last_quick_video_ids   TEXT",
            "ALTER TABLE channels ADD COLUMN full_refresh_pending   INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE channels ADD COLUMN refresh_batch          INTEGER",
            # Story viewed state: set when the story viewer shows the story;
            # drives the grey vs colored avatar ring in the frontend
            "ALTER TABLE stories  ADD COLUMN viewed_at              INTEGER",
            "ALTER TABLE videos   ADD COLUMN share_count            INTEGER",
            "ALTER TABLE videos   ADD COLUMN save_count             INTEGER",
            "ALTER TABLE videos   ADD COLUMN repost_count           INTEGER",
            "ALTER TABLE videos   ADD COLUMN music_title            TEXT",
            "ALTER TABLE videos   ADD COLUMN music_artist           TEXT",
            "ALTER TABLE videos   ADD COLUMN music_id               TEXT",
            "ALTER TABLE videos   ADD COLUMN stats_backfilled_at    INTEGER",
            "ALTER TABLE videos   ADD COLUMN stats_error_count      INTEGER DEFAULT 0",
            "ALTER TABLE videos   ADD COLUMN stats_last_error       TEXT",
            "ALTER TABLE videos   ADD COLUMN stats_updated_at       INTEGER",
            "ALTER TABLE videos   ADD COLUMN deleted_reason         TEXT",
            "ALTER TABLE videos   ADD COLUMN deletion_confirmed     INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE videos   ADD COLUMN false_positive_count   INTEGER NOT NULL DEFAULT 0",
            # Added via a direct post URL rather than discovered in a profile
            # listing (e.g. TikTok subscriber-only posts, invisible to scraping).
            # Exempt from listing-based deletion detection.
            "ALTER TABLE videos   ADD COLUMN direct_added           INTEGER NOT NULL DEFAULT 0",
        ]
        for sql in migrations:
            try:
                conn.execute(sql)
            except sqlite3.OperationalError:
                pass

        # One-time backfill: videos marked deleted under the retired counter
        # model never got deletion_confirmed set, which the pending/revert
        # logic would misread as "seen missing once". TikTok always maintained
        # the flag, so its unconfirmed rows are genuinely pending and stay.
        if self.platform != "tiktok":
            done = conn.execute(
                "SELECT 1 FROM settings WHERE key = 'deletion_confirmed_backfilled'"
            ).fetchone()
            if not done:
                conn.execute(
                    "UPDATE videos SET deletion_confirmed = 1 WHERE status = 'deleted' AND deletion_confirmed = 0"
                )
                conn.execute(
                    "INSERT INTO settings (key, value) VALUES ('deletion_confirmed_backfilled', '1')"
                )

        return False


    # Channel operations

    def add_channel(self, channel_id: str, handle: str, display_name: str | None = None,
                    description: str | None = None, subscriber_count: int | None = None,
                    video_count: int | None = None, avatar_url: str | None = None,
                    banner_url: str | None = None,
                    raw_channel_data: str | None = None,
                    following_count: int | None = None, join_date: int | None = None,
                    sec_uid: str | None = None, verified: int | None = None,
                    bio_link: str | None = None) -> None:
        with self.get_db() as conn:
            conn.execute("""
                INSERT OR IGNORE INTO channels
                    (channel_id, handle, display_name, description, subscriber_count,
                     video_count, avatar_url, banner_url, raw_channel_data,
                     following_count, join_date, sec_uid, verified, bio_link, added_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (channel_id, handle, display_name, description, subscriber_count,
                  video_count, avatar_url, banner_url, raw_channel_data,
                  following_count, join_date, sec_uid, verified or 0, bio_link,
                  int(time.time())))


    def remove_channel(self, channel_id: str) -> None:
        with self.get_db() as conn:
            conn.execute("DELETE FROM channels WHERE channel_id = ?", (channel_id,))
            conn.execute("DELETE FROM channel_connections WHERE ? IN (channel_a, channel_b)",
                         (channel_id,))


    def get_all_channels(self) -> list[dict]:
        with self.get_db() as conn:
            return [dict(r) for r in conn.execute(
                "SELECT * FROM channels WHERE enabled = 1 ORDER BY handle"
            ).fetchall()]


    def get_channel(self, channel_id: str) -> dict | None:
        with self.get_db() as conn:
            row = conn.execute(
                "SELECT * FROM channels WHERE channel_id = ?", (channel_id,)
            ).fetchone()
            return dict(row) if row else None


    def get_channel_by_handle(self, handle: str) -> dict | None:
        with self.get_db() as conn:
            row = conn.execute(
                "SELECT * FROM channels WHERE handle = ?", (handle,)
            ).fetchone()
            return dict(row) if row else None


    def update_channel_info(self, channel_id: str, handle: str, display_name: str | None,
                            description: str | None, subscriber_count: int | None,
                            video_count: int | None, avatar_url: str | None = None,
                            banner_url: str | None = None,
                            raw_channel_data: str | None = None) -> None:
        with self.get_db() as conn:
            conn.execute("""
                UPDATE channels SET
                    handle           = ?,
                    display_name     = COALESCE(?, display_name),
                    description      = COALESCE(?, description),
                    subscriber_count = COALESCE(?, subscriber_count),
                    video_count      = COALESCE(?, video_count),
                    avatar_url       = COALESCE(?, avatar_url),
                    banner_url       = COALESCE(?, banner_url),
                    raw_channel_data = COALESCE(?, raw_channel_data),
                    last_checked     = ?
                WHERE channel_id = ?
            """, (handle, display_name, description, subscriber_count, video_count,
                  avatar_url, banner_url, raw_channel_data, int(time.time()), channel_id))


    # Add queue operations
    # One row per add attempt. The newest row per handle is its current state,
    # and rows persist across restarts as the Add history panel's data.

    def add_queue_set_pending(self, handle: str) -> int:
        """Flip the newest unresolved row for the handle back to pending
        (a retry), or insert a fresh row. Returns the row id."""
        now = int(time.time())
        with self.get_db() as conn:
            row = conn.execute("""
                SELECT id FROM add_queue
                WHERE handle = ? AND status IN ('pending', 'error')
                ORDER BY id DESC LIMIT 1
            """, (handle,)).fetchone()
            if row:
                conn.execute("""
                    UPDATE add_queue SET status = 'pending', error_kind = NULL,
                        error_detail = NULL, updated_at = ?
                    WHERE id = ?
                """, (now, row["id"]))
                return row["id"]
            cur = conn.execute(
                "INSERT INTO add_queue (handle, status, created_at, updated_at) VALUES (?, 'pending', ?, ?)",
                (handle, now, now)
            )
            return cur.lastrowid


    def add_queue_resolve(self, handle: str, status: str, error_kind: str | None = None,
                          error_detail: str | None = None) -> None:
        with self.get_db() as conn:
            conn.execute("""
                UPDATE add_queue SET status = ?, error_kind = ?, error_detail = ?, updated_at = ?
                WHERE id = (SELECT id FROM add_queue
                            WHERE handle = ? AND status = 'pending'
                            ORDER BY id DESC LIMIT 1)
            """, (status, error_kind, error_detail, int(time.time()), handle))


    def add_queue_pending_handles(self) -> list[str]:
        with self.get_db() as conn:
            return [r["handle"] for r in conn.execute(
                "SELECT handle FROM add_queue WHERE status = 'pending' ORDER BY id"
            ).fetchall()]


    def add_queue_recent(self, since: int) -> list[dict]:
        """Newest row per handle, limited to pending lookups and rows resolved
        after `since`. Feeds the /queue poll that drives the add toasts."""
        with self.get_db() as conn:
            return [dict(r) for r in conn.execute("""
                SELECT * FROM add_queue
                WHERE id IN (SELECT MAX(id) FROM add_queue GROUP BY handle)
                  AND (status = 'pending' OR updated_at >= ?)
            """, (since,)).fetchall()]


    def add_queue_history(self, before_id: int | None, limit: int) -> list[dict]:
        with self.get_db() as conn:
            if before_id is not None:
                rows = conn.execute(
                    "SELECT * FROM add_queue WHERE id < ? ORDER BY id DESC LIMIT ?",
                    (before_id, limit)
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM add_queue ORDER BY id DESC LIMIT ?", (limit,)
                ).fetchall()
            return [dict(r) for r in rows]


    def add_queue_get(self, entry_id: int) -> dict | None:
        with self.get_db() as conn:
            row = conn.execute("SELECT * FROM add_queue WHERE id = ?", (entry_id,)).fetchone()
            return dict(row) if row else None


    def add_queue_delete(self, entry_id: int) -> None:
        with self.get_db() as conn:
            conn.execute("DELETE FROM add_queue WHERE id = ?", (entry_id,))


    def record_profile_change(self, channel_id: str, field: str, old_value: str | None) -> None:
        with self.get_db() as conn:
            conn.execute(
                "INSERT INTO profile_history (channel_id, field, old_value, changed_at) VALUES (?, ?, ?, ?)",
                (channel_id, field, old_value, int(time.time()))
            )


    def set_avatar_cached(self, channel_id: str, cached: bool) -> None:
        with self.get_db() as conn:
            conn.execute(
                "UPDATE channels SET avatar_cached = ? WHERE channel_id = ?",
                (1 if cached else 0, channel_id)
            )


    def set_banner_cached(self, channel_id: str, cached: bool) -> None:
        with self.get_db() as conn:
            conn.execute(
                "UPDATE channels SET banner_cached = ? WHERE channel_id = ?",
                (1 if cached else 0, channel_id)
            )


    def set_channel_tracking_enabled(self, channel_id: str, enabled: bool) -> None:
        with self.get_db() as conn:
            conn.execute(
                "UPDATE channels SET tracking_enabled = ? WHERE channel_id = ?",
                (1 if enabled else 0, channel_id)
            )


    def touch_last_checked(self, channel_id: str) -> None:
        with self.get_db() as conn:
            conn.execute(
                "UPDATE channels SET last_checked = ? WHERE channel_id = ?",
                (int(time.time()), channel_id)
            )


    def set_account_status(self, channel_id: str, status: str) -> None:
        """Set account_status; 'banned' also stamps banned_at (COALESCE, never
        overwritten). Every status transition is recorded in profile_history so
        the modal's Profile History tab shows the full ban lifecycle; the
        activity feed hides the to-banned rows (its own banned event covers
        those, see get_activity_feed)."""
        with self.get_db() as conn:
            row = conn.execute(
                "SELECT account_status FROM channels WHERE channel_id = ?", (channel_id,)
            ).fetchone()
            old_status = row["account_status"] if row else None
            if status == "banned":
                conn.execute(
                    "UPDATE channels SET account_status = ?, banned_at = COALESCE(banned_at, ?) WHERE channel_id = ?",
                    (status, int(time.time()), channel_id)
                )
            else:
                conn.execute(
                    "UPDATE channels SET account_status = ? WHERE channel_id = ?",
                    (status, channel_id)
                )
            if old_status and old_status != status:
                conn.execute(
                    "INSERT INTO profile_history (channel_id, field, old_value, changed_at) VALUES (?, 'account_status', ?, ?)",
                    (channel_id, old_status, int(time.time()))
                )


    def ban_channel_videos(self, channel_id: str) -> int:
        """Mark all active videos deleted with reason 'user_banned'. Videos already
        deleted individually keep their video_deleted reason. Returns the count."""
        with self.get_db() as conn:
            conn.execute("""
                UPDATE videos
                SET status             = 'deleted',
                    deleted_reason     = 'user_banned',
                    deleted_at         = COALESCE(deleted_at, ?),
                    deletion_confirmed = 1
                WHERE channel_id = ? AND status IN ('up', 'undeleted')
            """, (int(time.time()), channel_id))
            row = conn.execute("SELECT changes() AS n").fetchone()
        return row["n"] if row else 0


    def restore_banned_videos(self, channel_id: str) -> int:
        """Re-activate all videos hidden by a ban, back to plain active status.
        A ban never actually deleted them, so they are not marked 'Restored'
        (undeleted); the deletion metadata the ban stamped is simply cleared.
        Videos deleted before the ban (deleted_reason='video_deleted') are left
        untouched. Returns the count."""
        with self.get_db() as conn:
            conn.execute("""
                UPDATE videos
                SET status             = 'up',
                    deleted_reason     = NULL,
                    deleted_at         = NULL,
                    deletion_confirmed = 0,
                    undeleted_at       = NULL
                WHERE channel_id = ? AND deleted_reason = 'user_banned'
            """, (channel_id,))
            row = conn.execute("SELECT changes() AS n").fetchone()
        return row["n"] if row else 0


    def set_channel_starred(self, channel_id: str, starred: bool) -> None:
        with self.get_db() as conn:
            if starred:
                # Starring implies bookmarking. Unstarring leaves the bookmark.
                conn.execute(
                    "UPDATE channels SET starred = 1, bookmarked = 1 WHERE channel_id = ?",
                    (channel_id,)
                )
            else:
                conn.execute(
                    "UPDATE channels SET starred = 0 WHERE channel_id = ?",
                    (channel_id,)
                )


    def set_channel_bookmarked(self, channel_id: str, bookmarked: bool) -> None:
        with self.get_db() as conn:
            conn.execute(
                "UPDATE channels SET bookmarked = ? WHERE channel_id = ?",
                (1 if bookmarked else 0, channel_id)
            )


    def set_channel_pinned(self, channel_id: str, pinned: bool) -> None:
        with self.get_db() as conn:
            conn.execute(
                "UPDATE channels SET pinned_at = ? WHERE channel_id = ?",
                (int(time.time()) if pinned else None, channel_id)
            )


    def set_channel_comment(self, channel_id: str, comment: str | None) -> None:
        with self.get_db() as conn:
            conn.execute(
                "UPDATE channels SET comment = ? WHERE channel_id = ?",
                (comment or None, channel_id)
            )


    def get_profile_history(self, channel_id: str) -> list[dict]:
        with self.get_db() as conn:
            return [dict(r) for r in conn.execute(
                """SELECT id, field, old_value, changed_at
                   FROM profile_history
                   WHERE channel_id = ?
                   ORDER BY changed_at DESC""",
                (channel_id,)
            ).fetchall()]


    def record_stats_snapshot(self, channel_id: str, subscriber_count=None,
                              following_count=None, video_count=None) -> None:
        """Append today's stats snapshot for the creator, called after every
        successful profile fetch. One row per creator per local calendar day:
        a later check the same day updates that row (COALESCE, so a sparse
        fetch never wipes values recorded earlier in the day). saved_count is
        derived from the videos table at write time. Skipped entirely when the
        fetch carried no stats at all."""
        if subscriber_count is None and following_count is None and video_count is None:
            return
        import datetime
        day = datetime.datetime.now().strftime("%Y-%m-%d")
        with self.get_db() as conn:
            saved = conn.execute(
                "SELECT COUNT(*) FROM videos WHERE channel_id = ? AND file_path IS NOT NULL",
                (channel_id,)).fetchone()[0]
            conn.execute("""
                INSERT INTO channel_stats_history
                    (channel_id, day, ts, subscriber_count, following_count, video_count, saved_count)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(channel_id, day) DO UPDATE SET
                    ts               = excluded.ts,
                    subscriber_count = COALESCE(excluded.subscriber_count, subscriber_count),
                    following_count  = COALESCE(excluded.following_count,  following_count),
                    video_count      = COALESCE(excluded.video_count,      video_count),
                    saved_count      = excluded.saved_count
            """, (channel_id, day, int(time.time()),
                  subscriber_count, following_count, video_count, saved))


    def get_stats_history(self, channel_id: str) -> list[dict]:
        """Daily stats snapshots for the profile graphs, oldest first."""
        with self.get_db() as conn:
            return [dict(r) for r in conn.execute(
                """SELECT day, ts, subscriber_count, following_count, video_count, saved_count
                   FROM channel_stats_history
                   WHERE channel_id = ?
                   ORDER BY day""",
                (channel_id,)
            ).fetchall()]

    # ── Channel connections ───────────────────────────────────────────────────
    # Two-way links between creators (a person's second channel). Pairs are
    # stored once, ordered channel_a < channel_b; every accessor takes either
    # side.

    def add_connection(self, channel_id: str, other_id: str) -> None:
        a, b = sorted((str(channel_id), str(other_id)))
        with self.get_db() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO channel_connections (channel_a, channel_b, created_at) VALUES (?, ?, ?)",
                (a, b, int(time.time())))

    def remove_connection(self, channel_id: str, other_id: str) -> None:
        a, b = sorted((str(channel_id), str(other_id)))
        with self.get_db() as conn:
            conn.execute(
                "DELETE FROM channel_connections WHERE channel_a = ? AND channel_b = ?",
                (a, b))

    def get_connections(self, channel_id: str) -> list[dict]:
        """The channels connected to channel_id, with the fields the modal
        panel renders (avatar, names), alphabetical by handle."""
        with self.get_db() as conn:
            return [dict(r) for r in conn.execute(
                """SELECT c.channel_id, c.handle, c.display_name, c.avatar_cached,
                          c.enabled, c.tracking_enabled, c.account_status
                   FROM channel_connections cc
                   JOIN channels c ON c.channel_id =
                        CASE WHEN cc.channel_a = ? THEN cc.channel_b ELSE cc.channel_a END
                   WHERE ? IN (cc.channel_a, cc.channel_b)
                   ORDER BY c.handle COLLATE NOCASE""",
                (channel_id, channel_id)
            ).fetchall()]


    def get_legacy_path_prefixes(self) -> dict:
        """Return counts of file_path values not under MEDIA_DIR, grouped by prefix before /@."""
        from config import MEDIA_DIR
        media_norm = os.path.normpath(MEDIA_DIR)
        with self.get_db() as conn:
            rows = conn.execute(
                "SELECT file_path FROM videos WHERE file_path IS NOT NULL"
            ).fetchall()
        counts: dict[str, int] = {}
        for (path,) in rows:
            norm = os.path.normpath(path)
            if norm == media_norm or norm.startswith(media_norm + os.sep):
                continue
            idx = path.find("/@")
            prefix = path[:idx] if idx >= 0 else path
            counts[prefix] = counts.get(prefix, 0) + 1
        return {"prefixes": counts, "media_dir": MEDIA_DIR, "total_legacy": sum(counts.values())}


    def rewrite_file_paths(self, old_prefix: str, new_prefix: str) -> int:
        """Replace old_prefix with new_prefix at the start of every file_path in the videos table."""
        with self.get_db() as conn:
            cur = conn.execute(
                "UPDATE videos SET file_path = ? || SUBSTR(file_path, ?) WHERE file_path LIKE ?",
                (new_prefix, len(old_prefix) + 1, f"{old_prefix}%"),
            )
        return cur.rowcount


    def get_all_profile_history_for_search(self) -> dict:
        """Historical handle, display_name, and description values keyed by
        channel_id and field. Accepts both the engine field names and the
        pre-fold-in TikTok names (username, bio) still present in old rows."""
        _canon = {"username": "handle", "bio": "description"}
        out: dict = {}
        with self.get_db() as conn:
            rows = conn.execute("""
                SELECT channel_id, field, old_value FROM profile_history
                WHERE field IN ('handle', 'username', 'display_name', 'description', 'bio')
                  AND old_value IS NOT NULL
                ORDER BY changed_at
            """).fetchall()
        for r in rows:
            field = _canon.get(r["field"], r["field"])
            out.setdefault(r["channel_id"], {}).setdefault(field, []).append(r["old_value"])
        return out


    def get_all_profile_history_counts(self) -> dict:
        with self.get_db() as conn:
            rows = conn.execute(
                "SELECT channel_id, COUNT(*) AS cnt FROM profile_history GROUP BY channel_id"
            ).fetchall()
        return {r["channel_id"]: r["cnt"] for r in rows}


    # Video operations

    def get_video_id_sets(self, channel_id: str) -> tuple[set, set, set]:
        """Return (known_ids, active_ids, pending_ids) for a channel.

        active_ids:  status in ('up', 'undeleted'); videos we believe are currently live
        pending_ids: status='deleted' AND deletion_confirmed=0; seen missing once, not yet confirmed

        Direct-added videos (saved via post URL, absent from profile listings by
        nature) stay in known_ids but are excluded from active/pending so the
        listing diff never flags them as deleted.
        """
        with self.get_db() as conn:
            rows = conn.execute(
                "SELECT video_id, status, deletion_confirmed, direct_added FROM videos WHERE channel_id = ?",
                (channel_id,)
            ).fetchall()
        known   = {r["video_id"] for r in rows}
        active  = {r["video_id"] for r in rows
                   if r["status"] in ("up", "undeleted") and not r["direct_added"]}
        pending = {r["video_id"] for r in rows
                   if r["status"] == "deleted" and not r["deletion_confirmed"] and not r["direct_added"]}
        return known, active, pending


    def update_video_view_counts(self, counts: dict) -> int:
        """Set view_count for {video_id: count}, writing only rows whose stored
        value differs. Fed the fresh per-post counts from each fetched listing
        (views, or likes on OnlyFans) so archived posts do not freeze at their
        add-time numbers. Returns the number of rows updated."""
        if not counts:
            return 0
        ids = list(counts)
        changed: list[tuple] = []
        with self.get_db() as conn:
            for i in range(0, len(ids), 500):
                chunk = ids[i:i + 500]
                rows = conn.execute(
                    f"SELECT video_id, view_count FROM videos "
                    f"WHERE video_id IN ({','.join('?' * len(chunk))})",
                    chunk).fetchall()
                changed += [(counts[r["video_id"]], r["video_id"])
                            for r in rows if r["view_count"] != counts[r["video_id"]]]
            if changed:
                conn.executemany("UPDATE videos SET view_count = ? WHERE video_id = ?", changed)
        return len(changed)


    def get_video_ids_missing_file(self, channel_id: str) -> set:
        """Videos recorded without a media file (the download failed after
        add_video): retry candidates whenever they reappear in a listing."""
        with self.get_db() as conn:
            rows = conn.execute(
                "SELECT video_id FROM videos WHERE channel_id = ? "
                "AND file_path IS NULL AND status IN ('up', 'undeleted')",
                (channel_id,)
            ).fetchall()
        return {r["video_id"] for r in rows}


    def get_video_file_paths(self, channel_id: str) -> dict:
        """{video_id: file_path} for a channel's downloaded videos."""
        with self.get_db() as conn:
            rows = conn.execute(
                "SELECT video_id, file_path FROM videos "
                "WHERE channel_id = ? AND file_path IS NOT NULL",
                (channel_id,)
            ).fetchall()
        return {r["video_id"]: r["file_path"] for r in rows}


    def add_video(self, video_id: str, channel_id: str, title: str | None, upload_date: int | None,
                  view_count: int | None = None, duration: float | None = None,
                  content_type: str | None = None) -> None:
        with self.get_db() as conn:
            conn.execute("""
                INSERT OR IGNORE INTO videos
                    (video_id, channel_id, title, upload_date, view_count, duration, content_type)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (video_id, channel_id, title, upload_date, view_count, duration, content_type or "video"))


    def update_video_downloaded(self, video_id: str, file_path: str, ytdlp_data_json: str | None = None) -> None:
        d: dict = {}
        if ytdlp_data_json:
            try:
                d = json.loads(ytdlp_data_json)
            except Exception:
                pass

        now = int(time.time())

        if not d:
            with self.get_db() as conn:
                conn.execute(
                    "UPDATE videos SET download_date = ?, file_path = ? WHERE video_id = ?",
                    (now, file_path, video_id)
                )
            return

        with self.get_db() as conn:
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


    def mark_video_possibly_deleted(self, video_id: str) -> None:
        """First absence: set status='deleted', stamp deleted_at, leave deletion_confirmed=0."""
        with self.get_db() as conn:
            conn.execute("""
                UPDATE videos
                SET status             = 'deleted',
                    deleted_reason     = 'video_deleted',
                    deleted_at         = COALESCE(deleted_at, ?)
                WHERE video_id = ? AND status IN ('up', 'undeleted')
            """, (int(time.time()), video_id))


    def confirm_video_deletion(self, video_id: str) -> None:
        """Second consecutive absence: confirm the deletion."""
        with self.get_db() as conn:
            conn.execute("""
                UPDATE videos SET deletion_confirmed = 1
                WHERE video_id = ? AND status = 'deleted'
            """, (video_id,))


    def revert_or_undelete_video(self, video_id: str) -> str:
        """Handle a deleted video that is visible again.

        deletion_confirmed=0 (false positive): silently revert to 'up', clear deleted_at,
          increment false_positive_count. Returns 'reverted'.
        deletion_confirmed=1 (genuine recovery): mark as 'undeleted', record undeleted_at.
          Returns 'undeleted'.
        """
        with self.get_db() as conn:
            row = conn.execute(
                "SELECT deletion_confirmed FROM videos WHERE video_id = ?", (video_id,)
            ).fetchone()
            if not row:
                return "reverted"
            if row["deletion_confirmed"]:
                conn.execute("""
                    UPDATE videos
                    SET status       = 'undeleted',
                        undeleted_at = ?
                    WHERE video_id = ? AND status = 'deleted'
                """, (int(time.time()), video_id))
                return "undeleted"
            else:
                conn.execute("""
                    UPDATE videos
                    SET status               = 'up',
                        deleted_at           = NULL,
                        deletion_confirmed   = 0,
                        false_positive_count = false_positive_count + 1
                    WHERE video_id = ? AND status = 'deleted'
                """, (video_id,))
                return "reverted"


    # Blob columns excluded from list queries: ytdlp_data averages hundreds of KB
    # per YouTube video, so SELECT * would read megabytes off disk per request.
    _VIDEO_LIST_EXCLUDE = ("raw_video_data", "ytdlp_data", "chapters")

    def get_videos_for_channel(self, channel_id: str) -> list[dict]:
        with self.get_db() as conn:
            cols   = [r[1] for r in conn.execute("PRAGMA table_info(videos)")]
            select = ", ".join(c for c in cols if c not in self._VIDEO_LIST_EXCLUDE)
            return [dict(r) for r in conn.execute(
                f"SELECT {select} FROM videos WHERE channel_id = ? ORDER BY upload_date DESC",
                (channel_id,)
            ).fetchall()]


    def get_video(self, video_id: str) -> dict | None:
        with self.get_db() as conn:
            row = conn.execute(
                "SELECT * FROM videos WHERE video_id = ?", (video_id,)
            ).fetchone()
            if not row:
                return None
            result = dict(row)
            if result.get("file_path"):
                result["file_path"] = os.path.abspath(result["file_path"])
            return result


    def backfill_upload_dates(self) -> int:
        """Fill upload_date from stored timestamp for rows where upload_date IS NULL."""
        with self.get_db() as conn:
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


    def get_all_videos(self) -> list[dict]:
        """Return all video rows (used by the thumbnail backfill scan)."""
        with self.get_db() as conn:
            return [dict(r) for r in conn.execute(
                "SELECT video_id, channel_id, file_path FROM videos"
            ).fetchall()]


    def get_all_video_stats(self) -> dict:
        with self.get_db() as conn:
            rows = conn.execute("""
                SELECT
                    channel_id,
                    COUNT(*)                                                                          AS video_total,
                    COUNT(download_date)                                                              AS video_downloaded,
                    MAX(download_date)                                                                AS last_saved,
                    SUM(CASE WHEN status = 'deleted' AND deletion_confirmed = 1   THEN 1 ELSE 0 END) AS video_deleted,
                    SUM(CASE WHEN status = 'undeleted'                            THEN 1 ELSE 0 END) AS video_undeleted,
                    SUM(CASE WHEN status = 'deleted' AND deletion_confirmed = 0   THEN 1 ELSE 0 END) AS video_missing
                FROM videos
                GROUP BY channel_id
            """).fetchall()
        return {r["channel_id"]: dict(r) for r in rows}


    def rename_channel_video_paths(self, channel_id: str, old_handle: str, new_handle: str) -> None:
        with self.get_db() as conn:
            conn.execute("""
                UPDATE videos SET file_path = REPLACE(file_path, ?, ?)
                WHERE channel_id = ? AND file_path IS NOT NULL
            """, (f"{self.platform}/@{old_handle}/", f"{self.platform}/@{new_handle}/", channel_id))
            conn.execute("""
                UPDATE stories SET file_path = REPLACE(file_path, ?, ?)
                WHERE channel_id = ? AND file_path IS NOT NULL
            """, (f"{self.platform}/@{old_handle}/", f"{self.platform}/@{new_handle}/", channel_id))


    # ── Stories ───────────────────────────────────────────────────────────────
    # Ephemeral platform stories, saved permanently. expires_at drives the
    # "live" state in the UI; expired stories keep their files and rows.

    def add_story(self, story_id: str, channel_id: str, content_type: str,
                  posted_at: int | None, expires_at: int | None,
                  file_path: str) -> None:
        with self.get_db() as conn:
            conn.execute("""
                INSERT OR REPLACE INTO stories
                    (story_id, channel_id, content_type, posted_at, expires_at, saved_at, file_path)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (story_id, channel_id, content_type, posted_at, expires_at,
                  int(time.time()), file_path))


    def get_known_story_ids(self, channel_id: str) -> set:
        with self.get_db() as conn:
            rows = conn.execute(
                "SELECT story_id FROM stories WHERE channel_id = ?", (channel_id,)
            ).fetchall()
        return {r[0] for r in rows}


    def get_story(self, story_id: str) -> dict | None:
        with self.get_db() as conn:
            row = conn.execute(
                "SELECT * FROM stories WHERE story_id = ?", (story_id,)
            ).fetchone()
        if not row:
            return None
        story = dict(row)
        if story.get("file_path"):
            story["file_path"] = os.path.abspath(story["file_path"])
        return story


    def get_stories_for_channel(self, channel_id: str) -> list[dict]:
        with self.get_db() as conn:
            rows = conn.execute("""
                SELECT story_id, channel_id, content_type, posted_at, expires_at, saved_at
                FROM stories WHERE channel_id = ?
                ORDER BY posted_at DESC, story_id DESC
            """, (channel_id,)).fetchall()
        return [dict(r) for r in rows]


    def get_live_story_counts(self) -> dict:
        """{channel_id: live story count} for stories whose expiry is in the future."""
        with self.get_db() as conn:
            rows = conn.execute("""
                SELECT channel_id, COUNT(*) FROM stories
                WHERE expires_at > ? GROUP BY channel_id
            """, (int(time.time()),)).fetchall()
        return {r[0]: r[1] for r in rows}


    def get_unviewed_live_story_counts(self) -> dict:
        """{channel_id: live stories not yet viewed in the app}. Drives the
        colored (unviewed) vs grey (all viewed) avatar story ring."""
        with self.get_db() as conn:
            rows = conn.execute("""
                SELECT channel_id, COUNT(*) FROM stories
                WHERE expires_at > ? AND viewed_at IS NULL GROUP BY channel_id
            """, (int(time.time()),)).fetchall()
        return {r[0]: r[1] for r in rows}


    def mark_story_viewed(self, story_id: str) -> bool:
        """Stamp a story as viewed in the app; idempotent."""
        with self.get_db() as conn:
            cur = conn.execute(
                "UPDATE stories SET viewed_at = ? WHERE story_id = ? AND viewed_at IS NULL",
                (int(time.time()), story_id))
        return cur.rowcount > 0


    def get_all_story_counts(self) -> dict:
        """{channel_id: total saved story count}, live and expired alike."""
        with self.get_db() as conn:
            rows = conn.execute(
                "SELECT channel_id, COUNT(*) FROM stories GROUP BY channel_id"
            ).fetchall()
        return {r[0]: r[1] for r in rows}


    def delete_missing_story_files(self) -> int:
        """Remove story rows whose file is gone from disk. A still-live story
        is re-saved at the channel's next check; expired ones stay gone."""
        with self.get_db() as conn:
            rows = conn.execute("SELECT story_id, file_path FROM stories").fetchall()
            gone = [r["story_id"] for r in rows
                    if not (r["file_path"] and os.path.exists(os.path.abspath(r["file_path"])))]
            if gone:
                conn.execute(
                    f"DELETE FROM stories WHERE story_id IN ({','.join('?' * len(gone))})",
                    gone,
                )
        return len(gone)


    def get_story_day_counts(self, channel_id: str) -> dict:
        """{'YYYY-MM-DD': story count} across all saved stories of a channel."""
        with self.get_db() as conn:
            rows = conn.execute("""
                SELECT date(posted_at, 'unixepoch', 'localtime') AS day, COUNT(*)
                FROM stories WHERE channel_id = ? AND posted_at IS NOT NULL
                GROUP BY day
            """, (channel_id,)).fetchall()
        return {r[0]: r[1] for r in rows}


    def count_downloaded_videos(self) -> int:
        with self.get_db() as conn:
            return conn.execute("SELECT COUNT(*) FROM videos WHERE file_path IS NOT NULL").fetchone()[0]


    def get_aggregate_stats(self) -> dict:
        with self.get_db() as conn:
            # channel_count is actively tracked creators only: soft-disabled
            # stubs and tracking-disabled creators stay out of the stat tile
            crow = conn.execute(
                "SELECT COUNT(*) FROM channels WHERE enabled = 1 AND tracking_enabled = 1").fetchone()
            vrow = conn.execute("""
                SELECT
                    SUM(CASE WHEN status != 'deleted' THEN 1 ELSE 0 END) AS saved_count,
                    SUM(CASE WHEN status =  'deleted' THEN 1 ELSE 0 END) AS deleted_count,
                    SUM(CASE WHEN status != 'deleted' AND COALESCE(content_type, 'video') = 'video'
                             THEN 1 ELSE 0 END)                          AS video_count,
                    SUM(CASE WHEN status != 'deleted' AND content_type IN ('photo', 'image')
                             THEN 1 ELSE 0 END)                          AS photo_count,
                    COALESCE(SUM(view_count), 0)                         AS total_views,
                    COALESCE(SUM(like_count), 0)                         AS total_likes,
                    MAX(download_date)                                   AS latest_download
                FROM videos
                WHERE file_path IS NOT NULL
            """).fetchone()
        return {
            "channel_count":   crow[0],
            "saved_count":     (vrow["saved_count"]   or 0) if vrow else 0,
            "deleted_count":   (vrow["deleted_count"] or 0) if vrow else 0,
            "video_count":     (vrow["video_count"]   or 0) if vrow else 0,
            "photo_count":     (vrow["photo_count"]   or 0) if vrow else 0,
            "total_views":     (vrow["total_views"]    or 0) if vrow else 0,
            "total_likes":     (vrow["total_likes"]    or 0) if vrow else 0,
            "latest_download": vrow["latest_download"]       if vrow else None,
        }


    def _group_consecutive_by_channel(self, rows: list[dict], date_key: str) -> list[dict]:
        """Collapse a newest-first row list into per-channel groups. A row joins
        its channel's most recent group when the gap to that group's previous
        row is 5 minutes or less; rows from OTHER channels in between do not
        break the group. Grouping used to require strict adjacency, so two
        creators downloading in parallel shredded each other's runs into
        hundreds of 1-item lines. Groups are ordered by their newest row."""
        groups: list[dict] = []
        open_by_channel: dict = {}
        for row in rows:
            g = open_by_channel.get(row["channel_id"])
            if g is not None and g["_last_ts"] - row[date_key] <= 300:
                g["count"] += 1
                g["_last_ts"] = row[date_key]
            else:
                g = {
                    "channel_id":     row["channel_id"],
                    "handle":         row["handle"],
                    "enabled":        row.get("enabled", 1),
                    "starred":        row.get("starred", 0),
                    "account_status": row.get("account_status"),
                    "video_id":       row.get("video_id"),
                    "sound_id":       row.get("sound_id"),
                    date_key:         row[date_key],
                    "_last_ts":       row[date_key],
                    "count":          1,
                }
                groups.append(g)
                open_by_channel[row["channel_id"]] = g
        for g in groups:
            del g["_last_ts"]
        return groups


    def _sound_id_select(self, conn) -> str:
        """Subselect exposing the owning sound for sound-discovered videos.
        Falls back to NULL on platforms without the TikTok sound tables."""
        has = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sound_videos'"
        ).fetchone()
        if has:
            return "(SELECT sv.sound_id FROM sound_videos sv WHERE sv.video_id = v.video_id LIMIT 1)"
        return "NULL"


    def get_recent_activity(self) -> dict:
        with self.get_db() as conn:
            _sound = self._sound_id_select(conn)
            del_rows = [dict(r) for r in conn.execute(f"""
                SELECT v.video_id, v.deleted_at, c.handle, c.channel_id, c.enabled,
                       c.starred, c.account_status, {_sound} AS sound_id
                FROM videos v JOIN channels c ON c.channel_id = v.channel_id
                WHERE v.status = 'deleted' AND v.deleted_at IS NOT NULL
                  AND (v.deleted_reason IS NULL OR v.deleted_reason != 'user_banned')
                ORDER BY v.deleted_at DESC LIMIT 300
            """).fetchall()]
            profile_changes = [dict(r) for r in conn.execute("""
                SELECT ph.field, ph.changed_at, c.handle, c.channel_id, c.starred, c.account_status
                FROM profile_history ph JOIN channels c ON c.channel_id = ph.channel_id
                ORDER BY ph.changed_at DESC LIMIT 3
            """).fetchall()]
            bans = [dict(r) for r in conn.execute("""
                SELECT channel_id, handle, banned_at, starred
                FROM channels
                WHERE account_status = 'banned' AND banned_at IS NOT NULL
                ORDER BY banned_at DESC LIMIT 1
            """).fetchall()]
            saved_rows = [dict(r) for r in conn.execute(f"""
                SELECT v.download_date, c.handle, c.channel_id, c.enabled,
                       c.starred, c.account_status, v.video_id, {_sound} AS sound_id
                FROM videos v JOIN channels c ON c.channel_id = v.channel_id
                WHERE v.download_date IS NOT NULL AND v.file_path IS NOT NULL
                ORDER BY v.download_date DESC LIMIT 2000
            """).fetchall()]
        deletions = self._group_consecutive_by_channel(del_rows, "deleted_at")[:3]
        saved     = self._group_consecutive_by_channel(saved_rows, "download_date")[:9]
        return {"deletions": deletions, "profile_changes": profile_changes,
                "bans": bans, "saved": saved}


    def get_activity_feed(self, before: int | None = None, limit: int = 40,
                          kind: str | None = None, starred: bool = False,
                          bookmarked: bool = False) -> dict:
        """Unified chronological activity feed for the dashboard panel: saved
        and deletion groups, profile changes, and bans merged newest first.
        Keyset pagination via `before` (event unix ts). `kind` restricts to one
        event type (saved, story, deleted, changed, banned). Each source fetches
        limit+1 events so has_more stays correct when one source dominates.
        ponytail: a strict before cursor can drop one of two adjacent events
        sharing an identical timestamp across a page boundary."""
        cap    = limit + 1
        events = []
        # Flag filters on the joined channels table (bare column names for the
        # bans query, which selects from channels directly)
        flags   = ("AND c.starred = 1 " if starred else "") + ("AND c.bookmarked = 1 " if bookmarked else "")
        flags_b = ("AND starred = 1 "   if starred else "") + ("AND bookmarked = 1 "   if bookmarked else "")
        with self.get_db() as conn:
            _sound = self._sound_id_select(conn)
            if kind in (None, "saved"):
                w    = f"{flags}" + ("AND v.download_date < ?" if before else "")
                args = (before, self._GROUP_SCAN) if before else (self._GROUP_SCAN,)
                rows = [dict(r) for r in conn.execute(f"""
                    SELECT v.download_date, c.handle, c.channel_id, c.enabled,
                           c.starred, c.account_status, v.video_id, {_sound} AS sound_id
                    FROM videos v JOIN channels c ON c.channel_id = v.channel_id
                    WHERE v.download_date IS NOT NULL AND v.file_path IS NOT NULL {w}
                    ORDER BY v.download_date DESC LIMIT ?""", args).fetchall()]
                for g in self._group_consecutive_by_channel(rows, "download_date")[:cap]:
                    events.append({"ts": g["download_date"], "kind": "saved", "item": g})
            if kind in (None, "story"):
                w    = f"{flags}" + ("AND s.saved_at < ?" if before else "")
                args = (before, self._GROUP_SCAN) if before else (self._GROUP_SCAN,)
                rows = [dict(r) for r in conn.execute(f"""
                    SELECT s.saved_at, c.handle, c.channel_id, c.enabled,
                           c.starred, c.account_status
                    FROM stories s JOIN channels c ON c.channel_id = s.channel_id
                    WHERE s.saved_at IS NOT NULL {w}
                    ORDER BY s.saved_at DESC LIMIT ?""", args).fetchall()]
                for g in self._group_consecutive_by_channel(rows, "saved_at")[:cap]:
                    events.append({"ts": g["saved_at"], "kind": "story", "item": g})
            if kind in (None, "deleted"):
                w    = f"{flags}" + ("AND v.deleted_at < ?" if before else "")
                args = (before, self._GROUP_SCAN) if before else (self._GROUP_SCAN,)
                rows = [dict(r) for r in conn.execute(f"""
                    SELECT v.video_id, v.deleted_at, c.handle, c.channel_id, c.enabled,
                           c.starred, c.account_status, {_sound} AS sound_id
                    FROM videos v JOIN channels c ON c.channel_id = v.channel_id
                    WHERE v.status = 'deleted' AND v.deleted_at IS NOT NULL
                      AND (v.deleted_reason IS NULL OR v.deleted_reason != 'user_banned') {w}
                    ORDER BY v.deleted_at DESC LIMIT ?""", args).fetchall()]
                for g in self._group_consecutive_by_channel(rows, "deleted_at")[:cap]:
                    events.append({"ts": g["deleted_at"], "kind": "deleted", "item": g})
            if kind in (None, "changed"):
                w    = f"{flags}" + ("AND ph.changed_at < ?" if before else "")
                args = (before, cap) if before else (cap,)
                # Transitions to banned (an account_status row whose old value
                # is not 'banned') are hidden here: the feed's banned event
                # already shows them, so the row would be a duplicate. The
                # unban (old_value = 'banned') stays visible.
                rows = conn.execute(f"""
                    SELECT ph.field, ph.changed_at, c.handle, c.channel_id, c.starred, c.account_status
                    FROM profile_history ph JOIN channels c ON c.channel_id = ph.channel_id
                    WHERE NOT (ph.field = 'account_status' AND ph.old_value != 'banned') {w}
                    ORDER BY ph.changed_at DESC LIMIT ?""", args).fetchall()
                events += [{"ts": r["changed_at"], "kind": "changed", "item": dict(r)} for r in rows]
            if kind in (None, "banned"):
                w    = f"{flags_b}" + ("AND banned_at < ?" if before else "")
                args = (before, cap) if before else (cap,)
                # enabled and account_status ride along for the frontend's
                # name styling, same as the other event sources; without them
                # a banned row's handle rendered in the default colour
                rows = conn.execute(f"""
                    SELECT channel_id, handle, banned_at, starred, enabled, account_status
                    FROM channels
                    WHERE account_status = 'banned' AND banned_at IS NOT NULL {w}
                    ORDER BY banned_at DESC LIMIT ?""", args).fetchall()
                events += [{"ts": r["banned_at"], "kind": "banned", "item": dict(r)} for r in rows]
        events.sort(key=lambda e: e["ts"], reverse=True)
        return {"items": events[:limit], "has_more": len(events) > limit}


    def get_deletion_history(self, offset: int = 0, limit: int = 50) -> list[dict]:
        with self.get_db() as conn:
            rows = conn.execute(
                """SELECT v.video_id, v.deleted_at, c.handle, c.channel_id, c.enabled
                   FROM videos v JOIN channels c ON c.channel_id = v.channel_id
                   WHERE v.status = 'deleted' AND v.deleted_at IS NOT NULL
                   ORDER BY v.deleted_at DESC LIMIT ? OFFSET ?""",
                (limit, offset),
            ).fetchall()
        return [dict(r) for r in rows]


    def get_deletion_history_grouped(self, offset: int = 0, limit: int = 50) -> dict:
        """Paginated grouped deletion history (newest first), excluding user_banned.
        Consecutive deletions for the same channel collapse into one group.
        Returns {"items": [...groups...], "rows_consumed": N}."""
        with self.get_db() as conn:
            _sound = self._sound_id_select(conn)
            rows = [dict(r) for r in conn.execute(f"""
                SELECT v.video_id, v.deleted_at, c.handle, c.channel_id, c.enabled,
                       c.starred, c.account_status, {_sound} AS sound_id
                FROM videos v JOIN channels c ON c.channel_id = v.channel_id
                WHERE v.status = 'deleted' AND v.deleted_at IS NOT NULL
                  AND (v.deleted_reason IS NULL OR v.deleted_reason != 'user_banned')
                ORDER BY v.deleted_at DESC LIMIT ? OFFSET ?""",
                (self._GROUP_SCAN, offset),
            ).fetchall()]
        groups = self._group_consecutive_by_channel(rows, "deleted_at")[:limit]
        return {"items": groups, "rows_consumed": sum(g["count"] for g in groups)}


    def get_profile_change_history(self, offset: int = 0, limit: int = 50) -> list[dict]:
        with self.get_db() as conn:
            rows = conn.execute(
                """SELECT ph.field, ph.old_value, ph.changed_at, c.handle, c.channel_id,
                          c.starred, c.account_status
                   FROM profile_history ph JOIN channels c ON c.channel_id = ph.channel_id
                   ORDER BY ph.changed_at DESC LIMIT ? OFFSET ?""",
                (limit, offset),
            ).fetchall()
        return [dict(r) for r in rows]


    def get_saved_history(self, offset: int = 0, limit: int = 50) -> dict:
        """Return paginated grouped download history (newest first).

        Consecutive downloads by the same channel are collapsed into one group.
        Returns {"items": [...groups...], "rows_consumed": N} where rows_consumed
        is the total raw rows spanned by the returned groups -- the caller should
        advance its raw-row offset by this value for the next page.
        """
        with self.get_db() as conn:
            _sound = self._sound_id_select(conn)
            rows = [dict(r) for r in conn.execute(f"""
                SELECT v.download_date, c.handle, c.channel_id, c.enabled,
                       c.starred, c.account_status, v.video_id, {_sound} AS sound_id
                FROM videos v JOIN channels c ON c.channel_id = v.channel_id
                WHERE v.download_date IS NOT NULL AND v.file_path IS NOT NULL
                ORDER BY v.download_date DESC LIMIT ? OFFSET ?""",
                (self._GROUP_SCAN, offset),
            ).fetchall()]
        groups = self._group_consecutive_by_channel(rows, "download_date")[:limit]
        return {"items": groups, "rows_consumed": sum(g["count"] for g in groups)}


    def get_all_video_ids(self) -> set:
        with self.get_db() as conn:
            return {row[0] for row in conn.execute("SELECT video_id FROM videos").fetchall()}


    def get_all_channel_ids(self) -> set:
        with self.get_db() as conn:
            return {row[0] for row in conn.execute("SELECT channel_id FROM channels").fetchall()}


    def delete_orphaned_records(self) -> int:
        with self.get_db() as conn:
            videos  = conn.execute(
                "DELETE FROM videos WHERE channel_id NOT IN (SELECT channel_id FROM channels)"
            ).rowcount
            history = conn.execute(
                "DELETE FROM profile_history WHERE channel_id NOT IN (SELECT channel_id FROM channels)"
            ).rowcount
        return videos + history


    def delete_video(self, video_id: str) -> bool:
        with self.get_db() as conn:
            cur = conn.execute("DELETE FROM videos WHERE video_id = ?", (video_id,))
            return cur.rowcount > 0


    def find_missing_video_files(self) -> list[dict]:
        with self.get_db() as conn:
            rows = conn.execute(
                "SELECT video_id, file_path FROM videos WHERE file_path IS NOT NULL"
            ).fetchall()
        return [
            {"video_id": row[0], "file_path": row[1]}
            for row in rows
            if not os.path.exists(row[1])
        ]


    def delete_missing_video_files(self) -> int:
        missing = self.find_missing_video_files()
        for entry in missing:
            self.delete_video(entry["video_id"])
        return len(missing)


    def vacuum(self) -> None:
        conn = sqlite3.connect(self.DB_PATH)
        try:
            conn.execute("VACUUM")
        finally:
            conn.close()


    def get_setting(self, key: str, default: str | None = None) -> str | None:
        with self.get_db() as conn:
            row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return row[0] if row else default


    def set_setting(self, key: str, value) -> None:
        with self.get_db() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, str(value))
            )
