#!/usr/bin/env python3
"""Delete the spurious avatar profile-history entries from the 8-9 Jul 2026 bug.

A build in that window hashed the AVIF re-encode (not byte-stable across runs)
for avatar change detection, so nearly every profile check recorded a bogus
avatar change and archived a duplicate. cache_avatar now hashes the source
image via a sidecar, so this cannot recur, but the DB still holds the bad rows:
hundreds of "avatar changed" entries whose two sides are the same picture.

The bogus rows cannot be told apart from a genuine avatar change in the same
window (the archived AVIFs are real re-encodes, just of an identical source),
so this blanket-deletes every field='avatar' profile_history row in the date
range across all platform DBs, and removes each row's archived avatar file. A
real avatar change on those two days is rare collateral.

Run inside the container so DATA_DIR and the DB files match the app:
  docker compose exec social-downloader python3 /app/scripts/clean_false_avatar_history.py            # dry run, reports only
  docker compose exec social-downloader python3 /app/scripts/clean_false_avatar_history.py --run       # delete the rows + archived files
  docker compose exec social-downloader python3 /app/scripts/clean_false_avatar_history.py --start 2026-07-08 --end 2026-07-09 --run

Dates are inclusive and read in the container's local timezone (same clock the
history UI shows). Safe to run while the app is up: SQLite WAL allows a
concurrent writer.
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from datetime import datetime

APP = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "app")
sys.path.insert(0, APP)

from config import DATA_DIR  # noqa: E402

PLATFORMS = ("tiktok", "youtube", "twitter", "instagram")


def _day_bounds(start: str, end: str) -> tuple[int, int]:
    """Inclusive [start 00:00:00, end 23:59:59] as local-time unix seconds."""
    s = datetime.strptime(start, "%Y-%m-%d").replace(hour=0, minute=0, second=0)
    e = datetime.strptime(end, "%Y-%m-%d").replace(hour=23, minute=59, second=59)
    return int(s.timestamp()), int(e.timestamp())


def main() -> int:
    ap = argparse.ArgumentParser(description="Delete spurious avatar history from the 8-9 Jul 2026 bug.")
    ap.add_argument("--start", default="2026-07-08", help="first day, inclusive (YYYY-MM-DD)")
    ap.add_argument("--end",   default="2026-07-09", help="last day, inclusive (YYYY-MM-DD)")
    ap.add_argument("--run",   action="store_true", help="actually delete (default: dry run)")
    args = ap.parse_args()

    lo, hi = _day_bounds(args.start, args.end)
    print(f"Window: {args.start} 00:00 .. {args.end} 23:59 local  ({lo}..{hi})")
    print(f"Mode:   {'DELETE' if args.run else 'dry run'}\n")

    total_rows = total_files = 0
    for platform in PLATFORMS:
        db_path = os.path.join(DATA_DIR, platform, f"{platform}.db")
        if not os.path.exists(db_path):
            continue
        avatars_dir = os.path.join(DATA_DIR, platform, "avatars")

        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT id, channel_id, old_value FROM profile_history "
            "WHERE field = 'avatar' AND changed_at BETWEEN ? AND ?",
            (lo, hi),
        ).fetchall()

        removed_files = 0
        for r in rows:
            # old_value is the archived filename ({channel_id}_{ts}.avif); it
            # only ever lives in the avatars dir, so join-and-check is safe.
            fn = r["old_value"]
            if not fn:
                continue
            fp = os.path.join(avatars_dir, os.path.basename(fn))
            if os.path.exists(fp):
                removed_files += 1
                if args.run:
                    try:
                        os.remove(fp)
                    except OSError as ex:
                        print(f"  ! could not remove {fp}: {ex}")

        if args.run and rows:
            conn.execute(
                "DELETE FROM profile_history "
                "WHERE field = 'avatar' AND changed_at BETWEEN ? AND ?",
                (lo, hi),
            )
            conn.commit()
        conn.close()

        print(f"{platform:10s} rows: {len(rows):5d}   archived files: {removed_files:5d}")
        total_rows += len(rows)
        total_files += removed_files

    verb = "deleted" if args.run else "would delete"
    print(f"\nTotal {verb}: {total_rows} history rows, {total_files} archived avatar files")
    if not args.run and total_rows:
        print("Re-run with --run to apply.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
