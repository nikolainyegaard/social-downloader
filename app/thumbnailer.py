"""
Thumbnail and avatar generation — all output in AVIF format.

Thumbnails are stored as AVIF files at:
    MEDIA_DIR/@username/thumbs/{video_id}.avif

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
from platforms.tiktok import database as db
from config import MEDIA_DIR, THUMBNAIL_WORKERS, THUMBNAIL_USE_GPU, _ts
from platforms.tiktok.config import AVATARS_DIR
from photo_converter import encode_avif, CRF_THUMB, CRF_AVATAR

THUMB_WIDTH = 360   # px


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

def cache_avatar(creator_id: str, avatar_url: str, platform: str = "tiktok") -> str | bool:
    """
    Download avatar_url, convert to AVIF, and save to the platform's avatars cache.
    If the image differs from the cached version, the old file is archived and the
    change is recorded in profile_history.
    Returns "changed", "unchanged", or False on failure.
    """
    if not avatar_url:
        return False

    if platform == "tiktok":
        _avatars_dir = AVATARS_DIR
        _db = db
    elif platform == "youtube":
        from config import DATA_DIR as _DATA_DIR
        _avatars_dir = os.path.join(_DATA_DIR, "youtube", "avatars")
        from platforms.youtube import database as _db
    else:
        return False

    os.makedirs(_avatars_dir, exist_ok=True)

    path     = os.path.join(_avatars_dir, f"{creator_id}.avif")
    jpg_tmp  = path + ".jpg.tmp"
    avif_tmp = path + ".avif.tmp"

    try:
        urllib.request.urlretrieve(avatar_url, jpg_tmp)
    except Exception:
        _try_remove(jpg_tmp)
        return False

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
                arch = os.path.join(_avatars_dir, f"{creator_id}_{ts}.avif")
                shutil.copy2(path, arch)
                _db.record_profile_change(creator_id, "avatar", f"{creator_id}_{ts}.avif")
                changed = True

        os.replace(avif_tmp, path)
        _db.set_avatar_cached(creator_id, True)
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
        # Already have a thumbnail — return whichever format exists.
        # JPEG thumbnails will eventually be converted to AVIF by photo_converter;
        # return the JPEG path now so callers don't get a nonexistent AVIF path.
        avif = thumb_path_for(video_id, file_path)
        jpg  = avif.replace(".avif", ".jpg")
        return avif if os.path.exists(avif) else jpg

    print(f"[{_ts()}] [thumb] Generating thumbnail for {video_id} ({os.path.basename(file_path)})")
    out_path = thumb_path_for(video_id, file_path)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    is_audio = file_path.lower().endswith((".mp3", ".m4a", ".m4b", ".aac", ".ogg", ".wav", ".flac", ".opus"))
    if is_audio:
        # Audio-only files have no video stream; thumbnail generation is not possible.
        return None

    is_image = file_path.lower().endswith((".jpg", ".jpeg", ".avif", ".webp", ".png"))

    avif_encode_args = [
        # scale to target width, keep aspect ratio, force even height (-2).
        # format=yuv420p normalises the pixel format for libaom-av1.
        "-vf", f"scale={THUMB_WIDTH}:-2,format=yuv420p",
        "-c:v", "libaom-av1",
        "-still-picture", "1",
        "-crf", str(CRF_THUMB),
        "-b:v", "0",
        "-cpu-used", "6",
        "-threads", "2",
    ]

    def _build_cmd(bsf: str | None = None) -> list[str]:
        # bsf: optional bitstream filter string placed before -i to patch
        # "reserved/reserved" colour primaries before the decoder reads them.
        # FFmpeg 7's buffersrc rejects such streams with "Invalid colour space".
        bsf_args = ["-bsf:v", bsf] if bsf else []
        if is_image:
            return ["ffmpeg", "-i", file_path, *avif_encode_args, "-y", out_path]
        if THUMBNAIL_USE_GPU:
            return ["ffmpeg", "-hwaccel", "cuda", "-ss", "1", *bsf_args, "-i", file_path,
                    "-vframes", "1", *avif_encode_args, "-y", out_path]
        return ["ffmpeg", "-ss", "1", *bsf_args, "-i", file_path,
                "-vframes", "1", *avif_encode_args, "-y", out_path]

    def _run(cmd: list[str]) -> tuple[int, str]:
        result = subprocess.run(cmd, capture_output=True, timeout=120)
        stderr = (result.stderr or b"").decode(errors="replace").strip()
        # Strip the ffmpeg version/config banner so only actual error lines remain.
        error_lines = [
            ln for ln in stderr.splitlines()
            if ln and not ln.startswith(("ffmpeg version", "built with", "configuration:", "  lib"))
        ]
        return result.returncode, "\n".join(error_lines).strip() or "(no error detail)"

    try:
        cmd = _build_cmd()
        returncode, error_text = _run(cmd)

        # FFmpeg 7 rejects streams with "reserved/reserved" colour primaries at
        # the filter-graph input stage ("Invalid colour space").  This affects
        # both HEVC and H.264 TikTok videos.  Detect the codec from the failed
        # run's stderr and retry with the matching metadata BSF, which patches
        # the bitstream before decoding so the decoder emits BT.709-tagged frames.
        if returncode != 0 and "Invalid color space" in error_text:
            if "Video: hevc" in error_text:
                bsf = "hevc_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1"
                codec_label = "hevc"
            elif "Video: h264" in error_text:
                bsf = "h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1"
                codec_label = "h264"
            else:
                bsf = None
                codec_label = None

            if bsf:
                print(f"[{_ts()}] [thumb] Retrying {video_id} with {codec_label}_metadata BSF (reserved colour primaries)")
                _try_remove(out_path)
                cmd = _build_cmd(bsf=bsf)
                returncode, error_text = _run(cmd)

        if returncode == 0 and os.path.exists(out_path):
            return out_path
        if returncode != 0:
            print(
                f"[{_ts()}] [thumb] FAILED {video_id}"
                f" — ffmpeg exit {returncode}: {error_text}"
            )
        else:
            # ffmpeg exited 0 but wrote no output file (e.g. -ss past end of video)
            print(
                f"[{_ts()}] [thumb] FAILED {video_id}"
                f" — ffmpeg exit 0, no output file: {error_text}"
            )
    except subprocess.TimeoutExpired:
        print(f"[{_ts()}] [thumb] TIMEOUT {video_id} (>{120}s)")
    except Exception as e:
        print(f"[{_ts()}] [thumb] ERROR {video_id}: {e}")

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
    print(f"[{_ts()}] Thumbnail backfill: scanning database...")
    t0 = time.monotonic()

    all_videos = list(db.get_all_videos())
    try:
        from platforms.youtube import database as _yt_db
        all_videos.extend(_yt_db.get_all_videos())
    except Exception:
        pass
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
