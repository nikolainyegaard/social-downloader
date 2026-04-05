"""
Background AVIF conversion for all image assets.

Converts existing JPEG files to AVIF in three passes:
  1. Photo post images  — videos/@username/{video_id}_NN.jpg  → .avif
  2. Thumbnails         — videos/@username/thumbs/{video_id}.jpg → .avif
  3. Profile avatars    — data/avatars/{tiktok_id}[_ts].jpg   → .avif

Runs automatically at startup and skips already-converted files, so it is
safe to restart mid-run — it will pick up where it left off.
Also callable on demand via the Jobs settings panel.

CRF values (libaom-av1; lower = better quality / larger file):
  CRF_PHOTO  = 30  — photo post content (people view these full-size)
  CRF_THUMB  = 40  — grid thumbnails (small UI elements)
  CRF_AVATAR = 35  — profile avatars
"""

from __future__ import annotations

import glob as _glob
import os
import re as _re
import subprocess
import threading
import time
from datetime import datetime

import database as db
from config import VIDEOS_DIR, AVATARS_DIR

CRF_PHOTO  = 30
CRF_THUMB  = 40
CRF_AVATAR = 35

# Photo post filename pattern: {video_id}_{index}.jpg
_PHOTO_RE = _re.compile(r'^(\d+)_\d+\.(jpg|jpeg)$', _re.IGNORECASE)

_state_lock = threading.Lock()
_state: dict = {
    "running": False,
    "phase":   "",    # "photos" | "thumbnails" | "avatars" | ""
    "done":    0,
    "total":   0,
    "errors":  0,
}


def get_state() -> dict:
    with _state_lock:
        return dict(_state)


def _set(**kwargs) -> None:
    with _state_lock:
        _state.update(kwargs)


def _inc_done() -> None:
    with _state_lock:
        _state["done"] += 1


def _inc_errors() -> None:
    with _state_lock:
        _state["errors"] += 1


def _ts() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


# ── Core encoder ─────────────────────────────────────────────────────────────

def encode_avif(src: str, dst: str, crf: int) -> bool:
    """
    Convert any image to AVIF via libaom-av1.
    Writes to a temp file first; replaces dst atomically on success.
    Preserves source mtime on the output file.
    Returns True on success.
    """
    tmp = dst + ".tmp"
    try:
        result = subprocess.run(
            [
                "ffmpeg", "-y",
                "-i", src,
                "-c:v", "libaom-av1",
                "-still-picture", "1",
                "-crf", str(crf),
                "-b:v", "0",
                "-cpu-used", "6",
                "-loglevel", "error",
                tmp,
            ],
            capture_output=True,
            timeout=180,
        )
        if result.returncode != 0 or not os.path.exists(tmp):
            _try_remove(tmp)
            return False
        try:
            st = os.stat(src)
            os.utime(tmp, (st.st_atime, st.st_mtime))
        except OSError:
            pass
        os.replace(tmp, dst)
        return True
    except Exception as e:
        print(f"[{_ts()}] [converter] encode_avif failed for {src}: {e}")
        _try_remove(tmp)
        return False


def _try_remove(path: str) -> None:
    try:
        if path and os.path.exists(path):
            os.remove(path)
    except OSError:
        pass


# ── Count helpers ─────────────────────────────────────────────────────────────

def count_pending() -> int:
    """Count JPEG image files still awaiting AVIF conversion."""
    n = 0
    # Photo post images: {video_id}_{NN}.jpg in user folders
    for user_dir in _glob.glob(os.path.join(VIDEOS_DIR, "@*")):
        if not os.path.isdir(user_dir):
            continue
        for fname in os.listdir(user_dir):
            if _PHOTO_RE.match(fname):
                n += 1
    # Thumbnails
    for thumbs_dir in _glob.glob(os.path.join(VIDEOS_DIR, "*", "thumbs")):
        n += len(_glob.glob(os.path.join(thumbs_dir, "*.jpg")))
    # Avatars (current + history)
    if os.path.isdir(AVATARS_DIR):
        n += len(_glob.glob(os.path.join(AVATARS_DIR, "*.jpg")))
    return n


# ── Conversion passes ─────────────────────────────────────────────────────────

def _convert_photo_posts() -> None:
    """Convert all JPEG photo post images to AVIF and update DB file_path."""
    # Group JPEG files by video_id so we can update the DB after all images convert
    by_video: dict[str, list[str]] = {}
    for user_dir in _glob.glob(os.path.join(VIDEOS_DIR, "@*")):
        if not os.path.isdir(user_dir):
            continue
        for fname in sorted(os.listdir(user_dir)):
            m = _PHOTO_RE.match(fname)
            if m:
                by_video.setdefault(m.group(1), []).append(
                    os.path.join(user_dir, fname)
                )

    for video_id, jpg_paths in by_video.items():
        new_first: str | None = None
        for jpg in sorted(jpg_paths):
            avif = os.path.splitext(jpg)[0] + ".avif"
            if os.path.exists(avif):
                _try_remove(jpg)
                if new_first is None:
                    new_first = avif
                _inc_done()
                continue
            if not os.path.exists(jpg):
                _inc_done()
                continue
            if encode_avif(jpg, avif, CRF_PHOTO):
                _try_remove(jpg)
                if new_first is None:
                    new_first = avif
            else:
                _inc_errors()
            _inc_done()

        # Update DB if first image path needs updating
        if new_first:
            video = db.get_video(video_id)
            if video and video.get("file_path", "").lower().endswith((".jpg", ".jpeg")):
                db.update_video_file_path(video_id, new_first)


def _convert_thumbnails() -> None:
    """Convert all JPEG thumbnails to AVIF in-place."""
    for thumbs_dir in _glob.glob(os.path.join(VIDEOS_DIR, "*", "thumbs")):
        for jpg in _glob.glob(os.path.join(thumbs_dir, "*.jpg")):
            avif = os.path.splitext(jpg)[0] + ".avif"
            if os.path.exists(avif):
                _try_remove(jpg)
                _inc_done()
                continue
            if encode_avif(jpg, avif, CRF_THUMB):
                _try_remove(jpg)
            else:
                _inc_errors()
            _inc_done()


def _convert_avatars() -> None:
    """Convert all JPEG avatars (current and history) to AVIF."""
    if not os.path.isdir(AVATARS_DIR):
        return
    for jpg in _glob.glob(os.path.join(AVATARS_DIR, "*.jpg")):
        avif = os.path.splitext(jpg)[0] + ".avif"
        if os.path.exists(avif):
            _try_remove(jpg)
            _inc_done()
            continue
        if encode_avif(jpg, avif, CRF_AVATAR):
            _try_remove(jpg)
        else:
            _inc_errors()
        _inc_done()


# ── Public job interface ──────────────────────────────────────────────────────

def run_conversion(triggered_by: str = "startup") -> None:
    """
    Run a full AVIF conversion pass. Already-converted files are skipped.
    Designed to be called in a daemon thread.
    """
    with _state_lock:
        if _state["running"]:
            return
        _state.update({"running": True, "done": 0, "errors": 0,
                        "phase": "counting", "total": 0})

    print(f"[{_ts()}] [converter] Starting AVIF conversion ({triggered_by})…")
    t0 = time.monotonic()

    try:
        total = count_pending()
        _set(total=total)
        print(f"[{_ts()}] [converter] {total} image(s) pending conversion")

        if total == 0:
            print(f"[{_ts()}] [converter] Nothing to convert.")
            return

        _set(phase="photos")
        _convert_photo_posts()

        _set(phase="thumbnails")
        _convert_thumbnails()

        _set(phase="avatars")
        _convert_avatars()

        elapsed = time.monotonic() - t0
        with _state_lock:
            done   = _state["done"]
            errors = _state["errors"]
        print(
            f"[{_ts()}] [converter] Done: {done} converted"
            f", {errors} error(s) ({elapsed:.1f}s)"
        )
    except Exception as e:
        print(f"[{_ts()}] [converter] Unexpected error: {e}")
    finally:
        _set(running=False, phase="")


def start() -> bool:
    """
    Trigger a conversion run in a background thread.
    Returns False if a run is already in progress.
    """
    with _state_lock:
        if _state["running"]:
            return False
    threading.Thread(
        target=run_conversion, args=("manual",),
        daemon=True, name="photo-converter",
    ).start()
    return True


# Auto-run at startup (after a short delay so the DB is initialised first)
def _startup() -> None:
    time.sleep(8)
    run_conversion("startup")

threading.Thread(target=_startup, daemon=True, name="photo-converter-startup").start()
