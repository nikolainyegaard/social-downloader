#!/usr/bin/env python3
"""Strip raw HTML from OnlyFans rows stored before the clean_html fix.

The first OnlyFans build stored user.about and post.text verbatim, so bios
and post titles in the DB carry <br /> / <p> tags and HTML entities like
&lt;3. The fetch path now flattens them via api.clean_html; this repairs the
rows written before that existed: channels.description, videos.title, and
profile_history old_value rows for the description field.

Run inside the container so DATA_DIR and the DB file match the app:
  docker compose exec social-downloader python3 /app/scripts/clean_onlyfans_html.py         # dry run, reports only
  docker compose exec social-downloader python3 /app/scripts/clean_onlyfans_html.py --run   # rewrite the rows

Safe to run while the app is up: SQLite WAL allows a concurrent writer. Safe
to run twice: already-clean rows are left untouched.
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys

APP = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "app")
sys.path.insert(0, APP)

from config import DATA_DIR  # noqa: E402
from platforms.onlyfans.api import clean_html  # noqa: E402

# (table, id column, text column, extra WHERE)
TARGETS = [
    ("channels",        "channel_id", "description", ""),
    ("videos",          "video_id",   "title",       ""),
    ("profile_history", "id",         "old_value",   "AND field IN ('description', 'bio')"),
]


def main() -> int:
    ap = argparse.ArgumentParser(description="Strip stored HTML from OnlyFans bios and post titles.")
    ap.add_argument("--run", action="store_true", help="actually rewrite (default: dry run)")
    args = ap.parse_args()

    db_path = os.path.join(DATA_DIR, "onlyfans", "onlyfans.db")
    if not os.path.exists(db_path):
        print(f"No DB at {db_path}, nothing to do.")
        return 0
    print(f"DB:   {db_path}")
    print(f"Mode: {'REWRITE' if args.run else 'dry run'}\n")

    conn = sqlite3.connect(db_path)
    total = 0
    for table, id_col, col, extra in TARGETS:
        rows = conn.execute(
            f"SELECT {id_col}, {col} FROM {table} WHERE {col} IS NOT NULL AND {col} != '' {extra}"
        ).fetchall()
        changed = [(clean_html(v), rid) for rid, v in rows if clean_html(v) != v]
        if args.run and changed:
            conn.executemany(f"UPDATE {table} SET {col} = ? WHERE {id_col} = ?", changed)
            conn.commit()
        print(f"{table + '.' + col:30s} rows: {len(rows):5d}   dirty: {len(changed):5d}")
        total += len(changed)

    conn.close()
    verb = "rewrote" if args.run else "would rewrite"
    print(f"\nTotal {verb}: {total} rows")
    if not args.run and total:
        print("Re-run with --run to apply.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
