#!/usr/bin/env python3
"""Strip raw HTML from OnlyFans rows stored before the clean_html fix.

The first OnlyFans build stored user.about and post.text verbatim, so bios
and post titles in the DB carry <br /> / <p> tags and HTML entities like
&lt;3. The fetch path now flattens them via api.clean_html; this repairs the
rows written before that existed. Same job as the Strip stored HTML card in
Settings > OnlyFans > Jobs, plus a dry-run mode.

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
from platforms.onlyfans.api import clean_stored_html  # noqa: E402


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
    results = clean_stored_html(conn, apply=args.run)
    if args.run:
        conn.commit()
    conn.close()

    for r in results:
        print(f"{r['column']:30s} rows: {r['rows']:5d}   dirty: {r['dirty']:5d}")
    total = sum(r["dirty"] for r in results)
    verb = "rewrote" if args.run else "would rewrite"
    print(f"\nTotal {verb}: {total} rows")
    if not args.run and total:
        print("Re-run with --run to apply.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
