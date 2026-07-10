"""One-way schema migration: legacy TikTok schema to the engine vocabulary.

Renames the users table to channels and the TikTok column names to the
engine's (channel_id, handle, description, subscriber_count, content_type,
title). Runs once at startup, before ChannelDB.init_db; a backup copy of the
DB file is written next to it before any change. All renames run in one
transaction, so a crash mid-migration leaves the legacy schema intact and the
migration simply reruns on the next start. A DB without a users table is left
untouched.
"""

from __future__ import annotations

import os
import shutil
import sqlite3


def _columns(conn, table: str) -> set[str]:
    try:
        return {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
    except sqlite3.OperationalError:
        return set()


def _tables(conn) -> set[str]:
    return {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table'"
    )}


# (table, old column, new column); the table name is the POST-rename name for
# channels since the table rename runs first.
_COLUMN_RENAMES = [
    ("channels",         "tiktok_id",      "channel_id"),
    ("channels",         "username",       "handle"),
    ("channels",         "bio",            "description"),
    ("channels",         "follower_count", "subscriber_count"),
    ("channels",         "raw_user_data",  "raw_channel_data"),
    ("videos",           "tiktok_id",      "channel_id"),
    ("videos",           "type",           "content_type"),
    ("videos",           "description",    "title"),
    ("profile_history",  "tiktok_id",      "channel_id"),
    ("username_history", "tiktok_id",      "channel_id"),
]


def migrate_legacy_tiktok_schema(db_path: str) -> bool:
    """Migrate a legacy tiktok.db in place. Returns True if the migration ran."""
    if not os.path.exists(db_path):
        return False

    conn = sqlite3.connect(db_path)
    try:
        tables = _tables(conn)
        if "users" not in tables:
            return False
        if "channels" in tables:
            raise RuntimeError(
                "tiktok.db has both a users and a channels table; the fold-in "
                "migration cannot proceed. Restore from the .pre-engine backup "
                "or remove the empty channels table manually."
            )
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    finally:
        conn.close()

    backup = db_path + ".pre-engine"
    if not os.path.exists(backup):
        shutil.copy2(db_path, backup)

    conn = sqlite3.connect(db_path)
    conn.isolation_level = None
    try:
        cur = conn.cursor()
        cur.execute("BEGIN IMMEDIATE")
        cur.execute("ALTER TABLE users RENAME TO channels")
        tables = _tables(conn)
        for table, old, new in _COLUMN_RENAMES:
            if table not in tables:
                continue
            cols = _columns(conn, table)
            if old in cols and new not in cols:
                cur.execute(f"ALTER TABLE {table} RENAME COLUMN {old} TO {new}")
        cur.execute("COMMIT")
    except Exception:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.OperationalError:
            pass
        raise
    finally:
        conn.close()

    print(f"[tiktok] Legacy schema migrated to engine vocabulary "
          f"(backup: {os.path.basename(backup)})")
    return True
