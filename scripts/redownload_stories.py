#!/usr/bin/env python3
"""Re-download afflicted TikTok stories on the server, outside the running app.

The stories table stores no media URL (TikTok signs them with a short expiry,
so a saved one would be dead). It does store the story_id, and a video story's
page is at https://www.tiktok.com/@{handle}/video/{id} (story ids share the
video id space), which yt-dlp's TikTok extractor fetches and downloads
self-consistently: the media URL is signed for yt-dlp's own request, so no
cookies and no CDN 403s. It must be /video/, not /story/, which yt-dlp does not
match. This tool handles video stories only; photo stories have no such page
and are left for the app's next check.

Hard limit: stories expire 24h after posting. Anything past expires_at is gone
from TikTok and cannot be recovered; this tool can only report or purge those.

Afflicted = a story row whose file is missing OR whose file fails ffprobe. The
missing-file class is also retried by the app's normal loop (a failed download
leaves no row, so it re-fetches as new); the corrupt-but-present class is not
(the row exists and the file is present), so this tool is the way to repair it.

Run inside the container so it shares the app's env, cookies, and yt-dlp:
  docker compose exec social-downloader python3 /app/scripts/redownload_stories.py            # dry run, reports only
  docker compose exec social-downloader python3 /app/scripts/redownload_stories.py --run       # actually re-download live afflicted videos
  docker compose exec social-downloader python3 /app/scripts/redownload_stories.py --run --purge-expired   # also delete unrecoverable corrupt rows+files

Safe to run while the app is running: SQLite WAL allows a concurrent writer, and
the yt-dlp path uses no browser, so it never contends for the profile lock.
"""
from __future__ import annotations

import argparse
import os
import sys
import time

APP = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "app")
sys.path.insert(0, APP)

from engine.database import ChannelDB                      # noqa: E402
from engine.tracker import scan_afflicted_stories, purge_afflicted_stories  # noqa: E402
from platforms.tiktok.tracker import redownload_story_row  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description="Re-download afflicted TikTok stories.")
    ap.add_argument("--run", action="store_true", help="actually re-download (default: dry run)")
    ap.add_argument("--purge-expired", action="store_true",
                    help="delete rows + files for unrecoverable (expired) afflicted stories")
    ap.add_argument("--gap", type=float, default=3.0, help="seconds between downloads (default 3)")
    args = ap.parse_args()

    db  = ChannelDB("tiktok")
    afflicted = scan_afflicted_stories(db)

    live_vid = [r for r in afflicted if r["live"] and r["content_type"] != "photo"]
    live_img = [r for r in afflicted if r["live"] and r["content_type"] == "photo"]
    expired  = [r for r in afflicted if not r["live"]]

    print(f"Afflicted stories: {len(afflicted)} "
          f"({len(live_vid)} live video, {len(live_img)} live photo, {len(expired)} expired)")
    if live_img:
        print(f"  {len(live_img)} live photo stories can only be recovered by the app's "
              f"next check of their user (no standalone page to re-fetch).")
    if not args.run:
        for r in live_vid:
            print(f"  would re-download @{r['handle']} story {r['story_id']} ({r['ailment']})")
        print("\nDry run. Re-run with --run to download." if live_vid else "\nNothing to re-download.")
        if expired and not args.purge_expired:
            print(f"{len(expired)} expired afflicted stories are unrecoverable; "
                  f"add --purge-expired to remove their rows and files.")
        return 0

    ok = fail = 0
    for r in live_vid:
        if redownload_story_row(db, r, log=print):
            ok += 1
        else:
            fail += 1
        time.sleep(args.gap)

    if args.purge_expired and expired:
        purged = purge_afflicted_stories(db, expired)
        print(f"Purged {purged} expired afflicted story rows.")

    print(f"\nDone: {ok} recovered, {fail} still failing, "
          f"{len(live_img)} live photos left for the app.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
