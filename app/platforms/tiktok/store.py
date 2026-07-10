"""TikTok-specific database operations over the shared engine ChannelDB.

Covers everything the engine has no equivalent for: sound tracking (sounds and
sound_videos tables), the video stats backfill machinery, ban and privacy
status handling, the two-strike deletion confirmation flow, and the TikTok
scheduler extras (quick video ID memory, refresh batches).

The underlying SQLite file is the folded-in TikTok database: the schema was
migrated in place to the engine vocabulary (users renamed to channels;
tiktok_id renamed to channel_id; username, bio, follower_count, raw_user_data
renamed to handle, description, subscriber_count, raw_channel_data on the
channels table; videos.type and videos.description renamed to content_type
and title). All queries here use that engine vocabulary.
"""

from __future__ import annotations

import json
import sqlite3
import time

_STATS_ERROR_THRESHOLD = 3  # give up after this many consecutive fetch failures

_GROUP_SCAN = 2500  # raw rows scanned per page; generous enough to yield >= 50 groups


class TikTokStore:

    def __init__(self, db):
        """db is the engine ChannelDB instance for the tiktok platform."""
        self.db = db

    def init_tables(self) -> None:
        """Create the TikTok-only tables and indexes if missing.

        Run after ChannelDB.init_db(); the engine owns the shared tables
        (channels, videos, profile_history, settings)."""
        with self.db.get_db() as conn:
            conn.executescript("""
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
            """)

            migrations = [
                "ALTER TABLE sounds ADD COLUMN tracking_enabled INTEGER NOT NULL DEFAULT 1",
                "ALTER TABLE sounds ADD COLUMN starred          INTEGER NOT NULL DEFAULT 0",
                "ALTER TABLE sounds ADD COLUMN comment          TEXT",
            ]
            for sql in migrations:
                try:
                    conn.execute(sql)
                except sqlite3.OperationalError:
                    pass  # column already exists

            conn.executescript("""
                CREATE INDEX IF NOT EXISTS idx_sound_videos_sound
                    ON sound_videos(sound_id);

                CREATE INDEX IF NOT EXISTS idx_videos_channel_id
                    ON videos(channel_id);

                CREATE INDEX IF NOT EXISTS idx_videos_status
                    ON videos(status);

                CREATE INDEX IF NOT EXISTS idx_profile_history_channel_id
                    ON profile_history(channel_id);

                CREATE INDEX IF NOT EXISTS idx_videos_stats_backfilled_at
                    ON videos(stats_backfilled_at);

                CREATE INDEX IF NOT EXISTS idx_channels_next_check_at
                    ON channels(next_check_at);
            """)

    # Sound tracking

    def add_sound(self, sound_id: str, label: str | None = None) -> bool:
        """Add a sound to track. Returns True if newly added, False if already present."""
        with self.db.get_db() as conn:
            cur = conn.execute(
                "INSERT OR IGNORE INTO sounds (sound_id, label, added_at) VALUES (?, ?, ?)",
                (sound_id, label, int(time.time())),
            )
            return cur.rowcount > 0

    def remove_sound(self, sound_id: str) -> None:
        with self.db.get_db() as conn:
            conn.execute("DELETE FROM sounds WHERE sound_id = ?", (sound_id,))

    def get_all_sounds(self) -> list[dict]:
        with self.db.get_db() as conn:
            rows = conn.execute("""
                SELECT s.*,
                       COUNT(sv.video_id)                                              AS video_count,
                       SUM(CASE WHEN v.status = 'deleted'   THEN 1 ELSE 0 END)        AS video_deleted,
                       SUM(CASE WHEN v.status = 'undeleted' THEN 1 ELSE 0 END)        AS video_undeleted,
                       MAX(v.download_date)                                            AS last_saved
                FROM sounds s
                LEFT JOIN sound_videos sv ON sv.sound_id = s.sound_id
                LEFT JOIN videos v        ON v.video_id  = sv.video_id
                WHERE s.enabled = 1
                GROUP BY s.sound_id
                ORDER BY s.added_at
            """).fetchall()
        return [dict(r) for r in rows]

    def get_sound_videos(self, sound_id: str) -> list[dict]:
        """Return all video rows associated with a sound, newest first.
        Includes author_handle from the channels table (NULL for untracked authors)."""
        with self.db.get_db() as conn:
            return [dict(r) for r in conn.execute("""
                SELECT v.*, c.handle AS author_handle, c.enabled AS author_enabled
                FROM videos v
                JOIN sound_videos sv ON sv.video_id   = v.video_id
                LEFT JOIN channels c ON c.channel_id  = v.channel_id
                WHERE sv.sound_id = ?
                ORDER BY v.upload_date DESC
            """, (sound_id,)).fetchall()]

    def update_sound_label(self, sound_id: str, label: str | None) -> None:
        with self.db.get_db() as conn:
            conn.execute(
                "UPDATE sounds SET label = ? WHERE sound_id = ?",
                (label, sound_id),
            )

    def get_sound(self, sound_id: str) -> dict | None:
        with self.db.get_db() as conn:
            row = conn.execute(
                "SELECT * FROM sounds WHERE sound_id = ?", (sound_id,)
            ).fetchone()
        return dict(row) if row else None

    def update_sound_last_checked(self, sound_id: str) -> None:
        with self.db.get_db() as conn:
            conn.execute(
                "UPDATE sounds SET last_checked = ? WHERE sound_id = ?",
                (int(time.time()), sound_id),
            )

    def add_sound_video(self, sound_id: str, video_id: str) -> bool:
        """Link a video to a sound in the junction table. Returns True if newly added."""
        with self.db.get_db() as conn:
            cur = conn.execute(
                "INSERT OR IGNORE INTO sound_videos (sound_id, video_id, added_at) VALUES (?, ?, ?)",
                (sound_id, video_id, int(time.time())),
            )
            return cur.rowcount > 0

    def get_sound_video_ids(self, sound_id: str) -> set:
        """Return all known video IDs for a sound (from junction table)."""
        with self.db.get_db() as conn:
            rows = conn.execute(
                "SELECT video_id FROM sound_videos WHERE sound_id = ?", (sound_id,)
            ).fetchall()
        return {r["video_id"] for r in rows}

    def get_sound_active_video_ids(self, sound_id: str) -> set:
        """Video IDs linked to a sound that are currently active (up or undeleted)."""
        with self.db.get_db() as conn:
            rows = conn.execute("""
                SELECT v.video_id FROM videos v
                JOIN sound_videos sv ON v.video_id = sv.video_id
                WHERE sv.sound_id = ? AND v.status IN ('up', 'undeleted')
            """, (sound_id,)).fetchall()
        return {r["video_id"] for r in rows}

    def get_sound_pending_deletion_video_ids(self, sound_id: str) -> set:
        """Video IDs linked to a sound that are possibly deleted (seen missing once, not yet confirmed)."""
        with self.db.get_db() as conn:
            rows = conn.execute("""
                SELECT v.video_id FROM videos v
                JOIN sound_videos sv ON v.video_id = sv.video_id
                WHERE sv.sound_id = ? AND v.status = 'deleted' AND v.deletion_confirmed = 0
            """, (sound_id,)).fetchall()
        return {r["video_id"] for r in rows}

    def set_sound_comment(self, sound_id: str, comment: str) -> None:
        with self.db.get_db() as conn:
            conn.execute(
                "UPDATE sounds SET comment = ? WHERE sound_id = ?",
                (comment or None, sound_id),
            )

    def set_sound_starred(self, sound_id: str, starred: bool) -> None:
        with self.db.get_db() as conn:
            conn.execute(
                "UPDATE sounds SET starred = ? WHERE sound_id = ?",
                (1 if starred else 0, sound_id),
            )

    def set_sound_tracking_enabled(self, sound_id: str, enabled: bool) -> None:
        with self.db.get_db() as conn:
            conn.execute(
                "UPDATE sounds SET tracking_enabled = ? WHERE sound_id = ?",
                (1 if enabled else 0, sound_id),
            )

    def ensure_sound_channel(self, channel_id: str, handle: str,
                             sec_uid: str | None = None) -> bool:
        """Ensure a channel row exists for a sound-discovered author.
        Adds with enabled=0 if not present. Returns True if newly inserted."""
        with self.db.get_db() as conn:
            existing = conn.execute(
                "SELECT channel_id FROM channels WHERE channel_id = ?", (channel_id,)
            ).fetchone()
            if existing:
                return False
            conn.execute("""
                INSERT INTO channels (channel_id, sec_uid, handle, added_at, enabled)
                VALUES (?, ?, ?, ?, 0)
            """, (channel_id, sec_uid, handle, int(time.time())))
            return True

    # Stats backfill

    def get_videos_missing_stats(self) -> list[dict]:
        """Return downloaded, non-deleted videos that have never had a full stats fetch,
        joined to get the owner's current handle. Excludes videos that have failed
        too many times (permanently inaccessible on TikTok)."""
        with self.db.get_db() as conn:
            return [dict(r) for r in conn.execute(
                """SELECT v.video_id, v.channel_id, c.handle
                   FROM videos v
                   JOIN channels c ON c.channel_id = v.channel_id
                   WHERE v.stats_backfilled_at IS NULL
                     AND COALESCE(v.stats_error_count, 0) < ?
                     AND v.file_path IS NOT NULL
                     AND v.status NOT IN ('deleted', 'undeleted')
                   ORDER BY v.download_date""",
                (_STATS_ERROR_THRESHOLD,)
            ).fetchall()]

    def count_videos_missing_stats(self) -> int:
        """Count of downloaded, non-deleted videos that have never had a full stats fetch
        and belong to a currently-tracked channel (matches what get_videos_missing_stats returns)."""
        with self.db.get_db() as conn:
            row = conn.execute(
                """SELECT COUNT(*) FROM videos v
                   JOIN channels c ON c.channel_id = v.channel_id
                   WHERE v.stats_backfilled_at IS NULL
                     AND COALESCE(v.stats_error_count, 0) < ?
                     AND v.file_path IS NOT NULL
                     AND v.status NOT IN ('deleted', 'undeleted')""",
                (_STATS_ERROR_THRESHOLD,)
            ).fetchone()
        return row[0] if row else 0

    def get_videos_stats_failed(self) -> list[dict]:
        """Return videos permanently abandoned by backfill, with handle and last error."""
        with self.db.get_db() as conn:
            return [dict(r) for r in conn.execute(
                """SELECT v.video_id, c.handle, v.stats_error_count, v.stats_last_error
                   FROM videos v
                   JOIN channels c ON c.channel_id = v.channel_id
                   WHERE v.stats_backfilled_at IS NULL
                     AND COALESCE(v.stats_error_count, 0) >= ?
                     AND v.file_path IS NOT NULL
                     AND v.status != 'deleted'
                   ORDER BY v.stats_error_count DESC""",
                (_STATS_ERROR_THRESHOLD,)
            ).fetchall()]

    def count_videos_stats_failed(self) -> int:
        """Count of videos that have been permanently abandoned by backfill (too many errors)."""
        with self.db.get_db() as conn:
            row = conn.execute(
                """SELECT COUNT(*) FROM videos v
                   JOIN channels c ON c.channel_id = v.channel_id
                   WHERE v.stats_backfilled_at IS NULL
                     AND COALESCE(v.stats_error_count, 0) >= ?
                     AND v.file_path IS NOT NULL
                     AND v.status != 'deleted'""",
                (_STATS_ERROR_THRESHOLD,)
            ).fetchone()
        return row[0] if row else 0

    def update_video_stats(self, video_id: str, view_count=None, like_count=None,
                           comment_count=None, share_count=None, save_count=None,
                           repost_count=None, duration=None, width=None, height=None,
                           music_title=None, music_artist=None):
        with self.db.get_db() as conn:
            conn.execute("""
                UPDATE videos SET
                    view_count         = ?,
                    like_count         = ?,
                    comment_count      = ?,
                    share_count        = ?,
                    save_count         = ?,
                    repost_count       = COALESCE(?, repost_count),
                    duration           = COALESCE(?, duration),
                    width              = COALESCE(?, width),
                    height             = COALESCE(?, height),
                    music_title        = COALESCE(?, music_title),
                    music_artist       = COALESCE(?, music_artist),
                    stats_backfilled_at = ?
                WHERE video_id = ?
            """, (view_count, like_count, comment_count, share_count, save_count,
                  repost_count, duration, width, height, music_title, music_artist,
                  int(time.time()), video_id))

    def update_video_stats_loop(self, video_id: str, view_count=None, like_count=None,
                                comment_count=None, share_count=None,
                                save_count=None, repost_count=None) -> None:
        """Lightweight stats upsert called during the channel loop (from item_list data).

        Uses COALESCE so a None from TikTok never overwrites an existing stored value.
        Sets stats_updated_at and stamps stats_backfilled_at (via COALESCE so an existing
        timestamp is preserved) so these videos don't show up as missing stats.
        """
        now = int(time.time())
        with self.db.get_db() as conn:
            conn.execute("""
                UPDATE videos SET
                    view_count          = COALESCE(?, view_count),
                    like_count          = COALESCE(?, like_count),
                    comment_count       = COALESCE(?, comment_count),
                    share_count         = COALESCE(?, share_count),
                    save_count          = COALESCE(?, save_count),
                    repost_count        = COALESCE(?, repost_count),
                    stats_updated_at    = ?,
                    stats_backfilled_at = COALESCE(stats_backfilled_at, ?)
                WHERE video_id = ?
            """, (view_count, like_count, comment_count, share_count, save_count,
                  repost_count, now, now, video_id))

    def increment_stats_error(self, video_id: str, error_msg: str = "") -> int:
        """Increment the fetch-failure counter for a video. Returns the new count."""
        with self.db.get_db() as conn:
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

    def reset_backfill_errors(self) -> int:
        """Clear stats_error_count and stats_last_error for all permanently-failed videos,
        making them eligible for the next backfill run. Returns the number of rows affected."""
        with self.db.get_db() as conn:
            cur = conn.execute(
                """UPDATE videos
                   SET stats_error_count = 0, stats_last_error = NULL
                   WHERE COALESCE(stats_error_count, 0) >= ?""",
                (_STATS_ERROR_THRESHOLD,),
            )
            return cur.rowcount

    def reset_backfill_status(self) -> int:
        """Set stats_backfilled_at = NULL on every video, making all eligible for re-backfill.
        Returns the number of rows affected."""
        with self.db.get_db() as conn:
            cur = conn.execute("UPDATE videos SET stats_backfilled_at = NULL")
            return cur.rowcount

    # Profile and account status

    def update_channel_profile(self, channel_id, handle, display_name, description,
                               subscriber_count, following_count, video_count,
                               sec_uid=None, verified=None, avatar_url=None,
                               raw_channel_data=None, relation=None, bio_link=None):
        with self.db.get_db() as conn:
            conn.execute("""
                UPDATE channels SET
                    sec_uid          = COALESCE(?, sec_uid),
                    handle           = ?,
                    display_name     = ?,
                    description      = ?,
                    bio_link         = ?,
                    subscriber_count = ?,
                    following_count  = ?,
                    video_count      = ?,
                    verified         = COALESCE(?, verified),
                    avatar_url       = COALESCE(?, avatar_url),
                    raw_channel_data = COALESCE(?, raw_channel_data),
                    relation         = COALESCE(?, relation),
                    last_checked     = ?
                WHERE channel_id = ?
            """, (sec_uid, handle, display_name, description, bio_link,
                  subscriber_count, following_count, video_count, verified,
                  avatar_url, raw_channel_data, relation,
                  int(time.time()), channel_id))

    def update_channel_from_item_list(self, channel_id, handle, display_name,
                                      description, sec_uid=None, avatar_url=None):
        """Update profile fields recoverable from item_list author data.

        Used for private accounts (TikTok 10222) where the profile endpoint returns no data.
        Follower/following/video counts are not available and are preserved via COALESCE.
        """
        with self.db.get_db() as conn:
            conn.execute("""
                UPDATE channels SET
                    sec_uid      = COALESCE(?, sec_uid),
                    handle       = ?,
                    display_name = ?,
                    description  = ?,
                    avatar_url   = COALESCE(?, avatar_url),
                    last_checked = ?
                WHERE channel_id = ?
            """, (sec_uid, handle, display_name, description,
                  avatar_url, int(time.time()), channel_id))

    def update_privacy_status(self, channel_id: str, status: str):
        """status: 'public' | 'private_accessible' | 'private_blocked' | 'blocked'"""
        with self.db.get_db() as conn:
            row = conn.execute(
                "SELECT privacy_status FROM channels WHERE channel_id = ?", (channel_id,)
            ).fetchone()
            old_status = row["privacy_status"] if row else None
            conn.execute(
                "UPDATE channels SET privacy_status = ? WHERE channel_id = ?",
                (status, channel_id),
            )
            if old_status and old_status != status:
                conn.execute(
                    "INSERT INTO profile_history (channel_id, field, old_value, changed_at) VALUES (?, 'privacy_status', ?, ?)",
                    (channel_id, old_status, int(time.time()))
                )

    def set_account_status(self, channel_id: str, status: str):
        with self.db.get_db() as conn:
            row = conn.execute(
                "SELECT account_status FROM channels WHERE channel_id = ?", (channel_id,)
            ).fetchone()
            old_status = row["account_status"] if row else None
            if status == "banned":
                conn.execute(
                    "UPDATE channels SET account_status = ?, banned_at = COALESCE(banned_at, ?) WHERE channel_id = ?",
                    (status, int(time.time()), channel_id),
                )
            else:
                conn.execute(
                    "UPDATE channels SET account_status = ? WHERE channel_id = ?",
                    (status, channel_id),
                )
            if old_status and old_status != status:
                conn.execute(
                    "INSERT INTO profile_history (channel_id, field, old_value, changed_at) VALUES (?, 'account_status', ?, ?)",
                    (channel_id, old_status, int(time.time()))
                )

    def increment_profile_fail_count(self, channel_id: str) -> int:
        """Increment the consecutive profile-fetch failure counter. Returns the new count."""
        with self.db.get_db() as conn:
            conn.execute(
                "UPDATE channels SET profile_fail_count = COALESCE(profile_fail_count, 0) + 1 WHERE channel_id = ?",
                (channel_id,),
            )
            row = conn.execute(
                "SELECT COALESCE(profile_fail_count, 0) FROM channels WHERE channel_id = ?",
                (channel_id,),
            ).fetchone()
        return row[0] if row else 0

    def reset_profile_fail_count(self, channel_id: str) -> None:
        """Reset the consecutive profile-fetch failure counter after a successful fetch."""
        with self.db.get_db() as conn:
            conn.execute(
                "UPDATE channels SET profile_fail_count = 0 WHERE channel_id = ?",
                (channel_id,),
            )

    def ban_channel_videos(self, channel_id: str) -> int:
        """Mark all active videos for a channel as deleted with reason 'user_banned'.
        Only affects videos with status 'up' or 'undeleted'. Already-deleted videos
        (deleted_reason='video_deleted') are left untouched.
        Returns the number of videos affected.
        """
        with self.db.get_db() as conn:
            conn.execute("""
                UPDATE videos
                SET status             = 'deleted',
                    deleted_reason     = 'user_banned',
                    deleted_at         = COALESCE(deleted_at, ?),
                    deletion_confirmed = 1
                WHERE channel_id = ? AND status IN ('up', 'undeleted')
            """, (int(time.time()), channel_id))
            row = conn.execute(
                "SELECT changes() AS n"
            ).fetchone()
        return row["n"] if row else 0

    def restore_banned_videos(self, channel_id: str) -> int:
        """Re-activate all videos deleted by a ban (deleted_reason='user_banned').
        Videos individually deleted before the ban (deleted_reason='video_deleted')
        are left untouched. Returns the number of videos restored.
        """
        with self.db.get_db() as conn:
            conn.execute("""
                UPDATE videos
                SET status         = 'undeleted',
                    deleted_reason = NULL,
                    undeleted_at   = ?
                WHERE channel_id = ? AND deleted_reason = 'user_banned'
            """, (int(time.time()), channel_id))
            row = conn.execute(
                "SELECT changes() AS n"
            ).fetchone()
        return row["n"] if row else 0

    def get_ban_history(self, offset: int = 0, limit: int = 50) -> list[dict]:
        """Return paginated ban history (newest first)."""
        with self.db.get_db() as conn:
            rows = conn.execute(
                """SELECT channel_id, handle, banned_at, starred
                   FROM channels
                   WHERE account_status = 'banned' AND banned_at IS NOT NULL
                   ORDER BY banned_at DESC LIMIT ? OFFSET ?""",
                (limit, offset),
            ).fetchall()
        return [dict(r) for r in rows]

    # Deletion confirmation machinery

    def mark_video_possibly_deleted(self, video_id: str) -> None:
        """First absence: set status='deleted', stamp deleted_at, leave deletion_confirmed=0."""
        with self.db.get_db() as conn:
            conn.execute("""
                UPDATE videos
                SET status             = 'deleted',
                    deleted_reason     = 'video_deleted',
                    deleted_at         = COALESCE(deleted_at, ?)
                WHERE video_id = ? AND status IN ('up', 'undeleted')
            """, (int(time.time()), video_id))

    def confirm_video_deletion(self, video_id: str) -> None:
        """Second consecutive absence: confirm the deletion."""
        with self.db.get_db() as conn:
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
        with self.db.get_db() as conn:
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

    # Scheduling extras (quick video ID memory, refresh batches)

    def get_last_quick_video_ids(self, channel_id: str) -> list:
        """Return the ordered video ID list from the last quick-mode fetch, or []."""
        with self.db.get_db() as conn:
            row = conn.execute(
                "SELECT last_quick_video_ids FROM channels WHERE channel_id = ?",
                (channel_id,),
            ).fetchone()
        if not row or not row[0]:
            return []
        try:
            return json.loads(row[0])
        except Exception:
            return []

    def set_last_quick_video_ids(self, channel_id: str, ordered_ids: list) -> None:
        """Store the ordered list of video IDs from the last quick-mode fetch."""
        with self.db.get_db() as conn:
            conn.execute(
                "UPDATE channels SET last_quick_video_ids = ? WHERE channel_id = ?",
                (json.dumps(ordered_ids) if ordered_ids else None, channel_id),
            )

    def touch_last_checked(self, channel_id: str) -> None:
        """Write last_checked = now without touching any other fields.

        Used when TikTok responded but no full profile data is available (banned accounts,
        10222 private accounts with inaccessible item_list).
        """
        with self.db.get_db() as conn:
            conn.execute(
                "UPDATE channels SET last_checked = ? WHERE channel_id = ?",
                (int(time.time()), channel_id),
            )

    def set_channel_enabled(self, channel_id: str, enabled: bool) -> None:
        """Set the enabled flag (whether the channel appears in the tracked list)."""
        with self.db.get_db() as conn:
            conn.execute(
                "UPDATE channels SET enabled = ? WHERE channel_id = ?",
                (1 if enabled else 0, channel_id),
            )

    def assign_refresh_batches(self, n_days: int) -> int:
        """Start a new full-refresh cycle.

        Sorts all enabled channels by last_full_refresh_at ASC (never-refreshed channels
        first), divides them into n_days equal batches, writes refresh_batch (1..n_days)
        to each channel, then immediately activates batch 1 (full_refresh_pending = 1).
        Resets the pending flag for all other channels so no stale flags carry over from
        the previous cycle.

        Stores refresh_cycle_start and refresh_cycle_activated_batch in settings.

        Returns the total number of channels assigned.
        """
        now = int(time.time())
        with self.db.get_db() as conn:
            channels = conn.execute(
                """SELECT channel_id FROM channels WHERE enabled = 1
                   ORDER BY COALESCE(last_full_refresh_at, 0) ASC"""
            ).fetchall()
            n = len(channels)
            if not n:
                return 0
            conn.execute("UPDATE channels SET full_refresh_pending = 0 WHERE enabled = 1")
            for i, channel in enumerate(channels):
                batch = (i * n_days) // n + 1
                conn.execute(
                    "UPDATE channels SET refresh_batch = ?, full_refresh_pending = ? WHERE channel_id = ?",
                    (batch, 1 if batch == 1 else 0, channel["channel_id"]),
                )
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES ('refresh_cycle_start', ?)",
                (str(now),),
            )
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES"
                " ('refresh_cycle_activated_batch', '1')",
            )
        return n

    def activate_refresh_batch(self, batch_num: int) -> int:
        """Flag all channels in the given batch for a full refresh.

        Sets full_refresh_pending = 1 for every enabled channel whose refresh_batch
        matches batch_num, and advances the refresh_cycle_activated_batch setting.

        Returns the number of channels flagged.
        """
        with self.db.get_db() as conn:
            result = conn.execute(
                "UPDATE channels SET full_refresh_pending = 1 WHERE enabled = 1 AND refresh_batch = ?",
                (batch_num,),
            )
            n = result.rowcount
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES"
                " ('refresh_cycle_activated_batch', ?)",
                (str(batch_num),),
            )
        return n

    def clear_full_refresh_pending(self, channel_id: str) -> None:
        """Clear the full-refresh flag after a successful full run."""
        with self.db.get_db() as conn:
            conn.execute(
                "UPDATE channels SET full_refresh_pending = 0 WHERE channel_id = ?",
                (channel_id,),
            )

    def get_last_check_time(self) -> int | None:
        """Return MAX(last_checked) across all enabled channels, or None if none checked."""
        with self.db.get_db() as conn:
            row = conn.execute(
                "SELECT MAX(last_checked) FROM channels WHERE enabled = 1"
            ).fetchone()
            return row[0] if row and row[0] else None

    # Misc

    def get_username_history(self, channel_id: str) -> list:
        """Return all past usernames for a channel, oldest first (legacy table)."""
        with self.db.get_db() as conn:
            return [dict(r) for r in conn.execute(
                """SELECT old_username, new_username, changed_at
                   FROM username_history
                   WHERE channel_id = ?
                   ORDER BY changed_at""",
                (channel_id,)
            ).fetchall()]

    def get_all_username_history(self) -> dict:
        """Return all past usernames keyed by channel_id, oldest first. Reads from profile_history."""
        with self.db.get_db() as conn:
            rows = conn.execute(
                "SELECT channel_id, old_value FROM profile_history WHERE field = 'username' ORDER BY changed_at"
            ).fetchall()
        result: dict = {}
        for row in rows:
            result.setdefault(row["channel_id"], []).append(row["old_value"])
        return result

    def update_video_file_path(self, video_id: str, file_path: str) -> None:
        """Update the stored file path for a video (e.g. after format conversion)."""
        with self.db.get_db() as conn:
            conn.execute(
                "UPDATE videos SET file_path = ? WHERE video_id = ?",
                (file_path, video_id),
            )

    def add_video_full(self, video_id, channel_id, content_type, title, upload_date,
                       view_count=None, like_count=None, comment_count=None,
                       share_count=None, save_count=None, repost_count=None,
                       duration=None, width=None, height=None,
                       music_title=None, music_artist=None, music_id=None):
        """Insert a video row with the full TikTok stats column set.

        Stamps stats_backfilled_at when stats are present so the backfill job
        skips rows that were downloaded with complete stats."""
        with self.db.get_db() as conn:
            conn.execute("""
                INSERT OR IGNORE INTO videos
                    (video_id, channel_id, content_type, title, upload_date,
                     view_count, like_count, comment_count, share_count, save_count, repost_count,
                     duration, width, height, music_title, music_artist, music_id,
                     stats_backfilled_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (video_id, channel_id, content_type, title, upload_date,
                  view_count, like_count, comment_count, share_count, save_count, repost_count,
                  duration, width, height, music_title, music_artist, music_id,
                  int(time.time()) if view_count is not None else None))
