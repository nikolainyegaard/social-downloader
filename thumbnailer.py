"""
Thumbnail and avatar generation — all output in AVIF format.

Thumbnails are stored as AVIF files at:
    VIDEOS_DIR/@username/thumbs/{video_id}.avif

Avatars are stored as AVIF files at:
    AVATARS_DIR/{tiktok_id}.avif

For video files:  ffmpeg seeks to 1s, extracts one frame, encodes as AVIF.
For image files:  ffmpeg scales the source image directly to AVIF.

GPU acceleration:
    THUMBNAIL_USE_GPU=1 enables -hwaccel cuda for INPUT decode only (faster
    frame extraction from video). AVIF encoding always runs on CPU.
"""

from __future__ import annotations

import concurrent.futures
import hashlib
import os
import shutil
import subprocess
import time
import urllib.request
from datetime import datetime

import database as db
from config import VIDEOS_DIR, AVATARS_DIR, THUMBNAIL_WORKERS, THUMBNAIL_USE_GPU
from photo_converter import encode_avif, CRF_THUMB, CRF_AVATAR

THUMB_WIDTH = 360   # px


def _ts() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


# ── Path helpers ──────────────────────────────────────────────────────────────

def thumb_path_for(video_id: str, file_path: str) -> str:
    """Return the expected AVIF thumbnail path for a given source file."""
    folder = os.path.dirname(file_path)
    return os.path.join(folder, "thumbs", f"{video_id}.avif")


def avatar_path(tiktok_id: str) -> str:
    return os.path.join(AVATARS_DIR, f"{tiktok_id}.avif")


def _thumb_exists(video_id: str, file_path: str) -> bool:
    """Return True if an AVIF *or* legacy JPEG thumbnail already exists."""
    avif = thumb_path_for(video_id, file_path)
    jpg  = avif.replace(".avif", ".jpg")
    return os.path.exists(avif) or os.path.exists(jpg)


# ── Avatar caching ────────────────────────────────────────────────────────────

def cache_avatar(tiktok_id: str, avatar_url: str) -> str | bool:
    """
    Download avatar_url, convert to AVIF, and save to the avatars cache.
    If the image differs from the cached version, the old file is archived as
    {tiktok_id}_{timestamp}.avif and the change is recorded in profile_history.
    Returns "changed", "unchanged", or False on failure.
    """
    if not avatar_url:
        return False
    os.makedirs(AVATARS_DIR, exist_ok=True)

    path      = avatar_path(tiktok_id)       # .avif
    jpg_tmp   = path + ".jpg.tmp"
    avif_tmp  = path + ".avif.tmp"

    # Download source JPEG
    try:
        urllib.request.urlretrieve(avatar_url, jpg_tmp)
    except Exception:
        _try_remove(jpg_tmp)
        return False

    # Convert to AVIF
    if not encode_avif(jpg_tmp, avif_tmp, CRF_AVATAR):
        _try_remove(jpg_tmp)
        _try_remove(avif_tmp)
        return False
    _try_remove(jpg_tmp)

    try:
        def _md5(p: str) -> str:
            h = hashlib.md5()
            with open(p, "rb") as f:
                for chunk in iter(lambda: f.read(65536), b""):
                    h.update(chunk)
            return h.hexdigest()

        changed = False
        if os.path.exists(path):
            if _md5(path) != _md5(avif_tmp):
                ts   = int(time.time())
                arch = os.path.join(AVATARS_DIR, f"{tiktok_id}_{ts}.avif")
                shutil.copy2(path, arch)
                db.record_profile_change(tiktok_id, "avatar", f"{tiktok_id}_{ts}.avif")
                changed = True

        os.replace(avif_tmp, path)
        return "changed" if changed else "unchanged"
    except Exception:
        _try_remove(avif_tmp)
        return False


def _try_remove(path: str) -> None:
    try:
        if path and os.path.exists(path):
            os.remove(path)
    except OSError:
        pass


# ── Thumbnail generation ──────────────────────────────────────────────────────

def generate_thumbnail(video_id: str, file_path: str) -> str | None:
    """
    Generate an AVIF thumbnail for a video or image file.
    Returns the thumbnail path on success, None on failure.
    Skips if any thumbnail (AVIF or legacy JPEG) already exists.
    """
    if not file_path or not os.path.exists(file_path):
        return None

    if _thumb_exists(video_id, file_path):
        # Already have a thumbnail — AVIF or JPEG (JPEG will be converted by photo_converter)
        return thumb_path_for(video_id, file_path)

    out_path = thumb_path_for(video_id, file_path)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    is_image = file_path.lower().endswith((".jpg", ".jpeg", ".avif", ".webp", ".png"))

    avif_encode_args = [
        "-vf", f"scale={THUMB_WIDTH}:-1",
        "-c:v", "libaom-av1",
        "-still-picture", "1",
        "-crf", str(CRF_THUMB),
        "-b:v", "0",
        "-cpu-used", "6",
    ]

    if is_image:
        cmd = ["ffmpeg", "-i", file_path, *avif_encode_args, "-y", out_path]
    elif THUMBNAIL_USE_GPU:
        cmd = [
            "ffmpeg",
            "-hwaccel", "cuda",
            "-ss", "1",
            "-i", file_path,
            "-vframes", "1",
            *avif_encode_args,
            "-y", out_path,
        ]
    else:
        cmd = [
            "ffmpeg",
            "-ss", "1",
            "-i", file_path,
            "-vframes", "1",
            *avif_encode_args,
            "-y", out_path,
        ]

    try:
        result = subprocess.run(cmd, capture_output=True, timeout=60)
        if result.returncode == 0 and os.path.exists(out_path):
            return out_path
    except subprocess.TimeoutExpired:
        pass
    except Exception:
        pass

    _try_remove(out_path)
    return None


# ── Startup backfill ──────────────────────────────────────────────────────────

def backfill_thumbnails() -> None:
    """
    Check every video in the database and generate thumbnails for any that
    are missing one entirely (no .avif and no legacy .jpg).
    Videos that have a .jpg thumbnail will have it converted to AVIF by
    photo_converter — no need to regenerate from the source here.
    """
    print(f"[{_ts()}] Thumbnail backfill: scanning database…")
    t0 = time.monotonic()

    all_videos = db.get_all_videos()
    total = len(all_videos)

    missing = [
        (v["video_id"], v["file_path"])
        for v in all_videos
        if v.get("file_path")
        and os.path.exists(v["file_path"])
        and not _thumb_exists(v["video_id"], v["file_path"])
    ]

    no_file = sum(
        1 for v in all_videos
        if v.get("file_path") and not os.path.exists(v["file_path"])
    )

    gpu_note = " (GPU decode enabled)" if THUMBNAIL_USE_GPU else ""
    print(
        f"[{_ts()}] Thumbnail backfill: {len(missing)} missing"
        f" / {total} total / {no_file} files not on disk"
        f" — {THUMBNAIL_WORKERS} workers{gpu_note}"
    )

    if not missing:
        print(f"[{_ts()}] Thumbnail backfill: nothing to do.")
        return

    done = failed = 0
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
            if done % 50 == 0 or done == len(missing):
                print(
                    f"[{_ts()}] Thumbnail backfill: {done}/{len(missing)}"
                    f" — {done - failed} ok, {failed} failed"
                )

    elapsed = time.monotonic() - t0
    print(
        f"[{_ts()}] Thumbnail backfill complete:"
        f" {len(missing) - failed} generated, {failed} failed ({elapsed:.1f}s)."
    )
