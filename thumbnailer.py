"""
Thumbnail generation for downloaded videos and photo posts.

Thumbnails are stored as JPEG files at:
    VIDEOS_DIR/@username/thumbs/{video_id}.jpg

For video files:  ffmpeg seeks to 1s and extracts one frame.
For photo files:  ffmpeg scales the first image (same pipeline, no seeking needed).

GPU acceleration:
    Set THUMBNAIL_USE_GPU=1 in the environment to add -hwaccel cuda to ffmpeg
    commands for video files. Requires ffmpeg built with CUDA support and
    NVIDIA drivers accessible in the container.
"""

from __future__ import annotations

import os
import subprocess
import concurrent.futures
import time
from datetime import datetime

import database as db
from config import VIDEOS_DIR, AVATARS_DIR, THUMBNAIL_WORKERS, THUMBNAIL_USE_GPU

THUMB_WIDTH   = 360   # px — wide enough for a grid thumbnail
THUMB_QUALITY = 3     # ffmpeg JPEG quality scale (1–31, lower = better; 3 ≈ ~85% JPEG)


# ── Avatar caching ───────────────────────────────────────────────────────────

def avatar_path(tiktok_id: str) -> str:
    return os.path.join(AVATARS_DIR, f"{tiktok_id}.jpg")


def cache_avatar(tiktok_id: str, avatar_url: str) -> bool:
    """
    Download avatar_url and save it to the local avatars cache.
    Called each time user info is refreshed so the cached file stays current.
    Returns True on success, False on failure.
    """
    if not avatar_url:
        return False
    import urllib.request
    os.makedirs(AVATARS_DIR, exist_ok=True)
    path = avatar_path(tiktok_id)
    try:
        urllib.request.urlretrieve(avatar_url, path)
        return True
    except Exception:
        try:
            if os.path.exists(path):
                os.remove(path)
        except OSError:
            pass
        return False


def _ts() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def thumb_path_for(video_id: str, file_path: str) -> str:
    """Return the expected thumbnail path for a given source file."""
    folder = os.path.dirname(file_path)
    return os.path.join(folder, "thumbs", f"{video_id}.jpg")


def generate_thumbnail(video_id: str, file_path: str) -> str | None:
    """
    Generate a JPEG thumbnail for a video or photo file.
    Returns the thumbnail path on success, None on failure.
    Silently skips if the thumbnail already exists.
    """
    if not file_path or not os.path.exists(file_path):
        return None

    out_path = thumb_path_for(video_id, file_path)
    if os.path.exists(out_path):
        return out_path

    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    is_image = file_path.lower().endswith((".jpg", ".jpeg"))

    if is_image:
        # Photo post: scale the source image directly
        cmd = [
            "ffmpeg", "-i", file_path,
            "-vf", f"scale={THUMB_WIDTH}:-1",
            "-q:v", str(THUMB_QUALITY),
            "-y", out_path,
        ]
    elif THUMBNAIL_USE_GPU:
        # Video with GPU-accelerated decode (NVDEC)
        cmd = [
            "ffmpeg",
            "-hwaccel", "cuda",
            "-ss", "1",
            "-i", file_path,
            "-vframes", "1",
            "-vf", f"scale={THUMB_WIDTH}:-1",
            "-q:v", str(THUMB_QUALITY),
            "-y", out_path,
        ]
    else:
        # Video, CPU decode
        cmd = [
            "ffmpeg",
            "-ss", "1",       # seek before -i for fast keyframe seek
            "-i", file_path,
            "-vframes", "1",
            "-vf", f"scale={THUMB_WIDTH}:-1",
            "-q:v", str(THUMB_QUALITY),
            "-y", out_path,
        ]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            timeout=30,
        )
        if result.returncode == 0 and os.path.exists(out_path):
            return out_path
    except subprocess.TimeoutExpired:
        pass
    except Exception:
        pass

    # Clean up any partial output
    try:
        if os.path.exists(out_path):
            os.remove(out_path)
    except OSError:
        pass

    return None


def backfill_thumbnails() -> None:
    """
    Check every video in the database and generate thumbnails for any that
    are missing one. Runs at startup in a background thread.
    Uses a thread pool sized by THUMBNAIL_WORKERS for parallelism.
    """
    print(f"[{_ts()}] Thumbnail backfill: scanning database...")
    t0 = time.monotonic()

    all_videos = db.get_all_videos()
    total = len(all_videos)

    # Filter to videos that have a file on disk but no thumbnail yet
    missing = [
        (v["video_id"], v["file_path"])
        for v in all_videos
        if v.get("file_path")
        and os.path.exists(v["file_path"])
        and not os.path.exists(thumb_path_for(v["video_id"], v["file_path"]))
    ]

    no_file = sum(
        1 for v in all_videos
        if v.get("file_path") and not os.path.exists(v["file_path"])
    )

    gpu_note = " (GPU decode enabled)" if THUMBNAIL_USE_GPU else ""
    print(
        f"[{_ts()}] Thumbnail backfill: {len(missing)} missing"
        f" / {total} total videos"
        f" / {no_file} files not on disk"
        f" — {THUMBNAIL_WORKERS} workers{gpu_note}"
    )

    if not missing:
        print(f"[{_ts()}] Thumbnail backfill: nothing to do.")
        return


    done   = 0
    failed = 0

    with concurrent.futures.ThreadPoolExecutor(
        max_workers=THUMBNAIL_WORKERS,
        thread_name_prefix="thumb",
    ) as pool:
        futs = {
            pool.submit(generate_thumbnail, vid, path): vid
            for vid, path in missing
        }
        for fut in concurrent.futures.as_completed(futs):
            done += 1
            if fut.result() is None:
                failed += 1
            # Progress line every 50 completions and at the end
            if done % 50 == 0 or done == len(missing):
                ok_so_far = done - failed
                print(
                    f"[{_ts()}] Thumbnail backfill: {done}/{len(missing)}"
                    f" — {ok_so_far} ok, {failed} failed"
                )

    elapsed = time.monotonic() - t0
    ok = len(missing) - failed
    print(
        f"[{_ts()}] Thumbnail backfill complete:"
        f" {ok} generated, {failed} failed"
        f" ({elapsed:.1f}s)."
    )
