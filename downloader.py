from __future__ import annotations

import os
import time
import requests
import yt_dlp
from datetime import datetime
from typing import Any
from yt_dlp.utils import DownloadError

from config import VIDEOS_DIR, COOKIES_PATH

MIN_VALID_SIZE_BYTES = 10_000


def _ts():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def download_video(*, video_id: str, username: str, tiktok_id: str,
                   display_name: str, description: str,
                   upload_date: int, download_date: int) -> str | None:
    """
    Download a TikTok video using yt-dlp and embed metadata into the file.
    Returns the final file path on success, None on failure.
    """
    author_folder = os.path.join(VIDEOS_DIR, f"@{username}")
    os.makedirs(author_folder, exist_ok=True)

    output_template = os.path.join(author_folder, f"{video_id}.%(ext)s")
    video_url = f"https://www.tiktok.com/@{username}/video/{video_id}"

    upload_str   = (datetime.fromtimestamp(upload_date).strftime("%Y-%m-%d")
                    if upload_date else "")
    download_str = datetime.fromtimestamp(download_date).strftime("%Y-%m-%d %H:%M:%S")

    ydl_opts: dict[str, Any] = {
        "outtmpl":             output_template,
        "format":              "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "merge_output_format": "mp4",
        "socket_timeout":      30,
        "retries":             3,
        "quiet":               True,
        "no_warnings":         False,
        **({"cookiefile": COOKIES_PATH} if os.path.exists(COOKIES_PATH) else {}),
        "postprocessors": [
            {"key": "FFmpegMetadata", "add_metadata": True},
        ],
        "postprocessor_args": {
            "ffmpegmetadata": [
                "-metadata", f"title={description or ''}",
                "-metadata", f"artist={username}",
                "-metadata", f"album_artist={display_name or username}",
                "-metadata", f"date={upload_str}",
                "-metadata", (
                    f"comment="
                    f"video_id={video_id}|"
                    f"author_id={tiktok_id}|"
                    f"author_username={username}|"
                    f"author_display_name={display_name or ''}|"
                    f"upload_date={upload_str}|"
                    f"download_date={download_str}"
                ),
            ]
        },
    }

    print(f"[{_ts()}] Downloading {video_id} from @{username}...")
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:  # type: ignore[arg-type]
            ydl.download([video_url])
    except DownloadError as e:
        print(f"[{_ts()}] yt-dlp error for {video_id}: {e}")
        _remove_corrupt(author_folder, video_id)
        return None
    except Exception as e:
        print(f"[{_ts()}] Unexpected error for {video_id} ({type(e).__name__}): {e}")
        _remove_corrupt(author_folder, video_id)
        return None

    actual_path = _find_output(author_folder, video_id)
    if actual_path is None:
        print(f"[{_ts()}] Output file not found after download of {video_id}")
        return None

    file_size = os.path.getsize(actual_path)
    if file_size < MIN_VALID_SIZE_BYTES:
        print(f"[{_ts()}] File too small ({file_size} bytes) for {video_id}, removing.")
        os.remove(actual_path)
        return None

    print(f"[{_ts()}] Saved {video_id} ({file_size:,} bytes) → {actual_path}")
    if upload_date:
        os.utime(actual_path, (upload_date, upload_date))
    return actual_path


def _load_cookies() -> dict[str, str]:
    """Parse cookies.txt and return a name→value dict for HTTP requests."""
    result: dict[str, str] = {}
    try:
        with open(COOKIES_PATH, encoding="utf-8", errors="ignore") as f:
            for line in f:
                if line.startswith("#") or not line.strip():
                    continue
                parts = line.strip().split("\t")
                if len(parts) == 7:
                    result[parts[5]] = parts[6]
    except FileNotFoundError:
        pass
    return result


def download_photos(*, video_id: str, username: str,
                    image_urls: list[str], upload_date: int) -> str | None:
    """
    Download each image from a TikTok photo post directly.
    Files are saved as {video_id}_01.jpg, {video_id}_02.jpg, …
    Returns the path of the first image on success, None if all fail.
    """
    author_folder = os.path.join(VIDEOS_DIR, f"@{username}")
    os.makedirs(author_folder, exist_ok=True)

    cookies    = _load_cookies()
    first_path: str | None = None
    total      = len(image_urls)

    for i, url in enumerate(image_urls, 1):
        fpath = os.path.join(author_folder, f"{video_id}_{i:02d}.jpg")
        try:
            resp = requests.get(url, cookies=cookies, timeout=30)
            resp.raise_for_status()
            with open(fpath, "wb") as f:
                f.write(resp.content)
            if upload_date:
                os.utime(fpath, (upload_date, upload_date))
            if first_path is None:
                first_path = fpath
            print(f"[{_ts()}] Photo {i}/{total} saved → {fpath}")
        except Exception as e:
            print(f"[{_ts()}] Failed to download photo {i}/{total} for {video_id}: {e}")

    return first_path


def _get_video_files(folder: str, video_id: str) -> list[str]:
    """Return paths of all files in folder whose name starts with video_id."""
    return [
        os.path.join(folder, fname)
        for fname in os.listdir(folder)
        if fname.startswith(video_id)
    ]


def prefix_video_files(video_id: str, username: str) -> str | None:
    """Add del_ prefix to all files for video_id. Returns new path of first file."""
    folder = os.path.join(VIDEOS_DIR, f"@{username}")
    if not os.path.isdir(folder):
        return None
    files = sorted(_get_video_files(folder, video_id))
    new_first = None
    for fpath in files:
        new_path = os.path.join(folder, f"del_{os.path.basename(fpath)}")
        os.rename(fpath, new_path)
        if new_first is None:
            new_first = new_path
    return new_first


def unprefix_video_files(video_id: str, username: str) -> str | None:
    """Remove del_ prefix from all files for video_id. Returns new path of first file."""
    folder = os.path.join(VIDEOS_DIR, f"@{username}")
    if not os.path.isdir(folder):
        return None
    files = sorted(_get_video_files(folder, f"del_{video_id}"))
    new_first = None
    for fpath in files:
        new_fname = os.path.basename(fpath)[4:]  # strip "del_"
        new_path  = os.path.join(folder, new_fname)
        os.rename(fpath, new_path)
        if new_first is None:
            new_first = new_path
    return new_first


def rename_user_folder(old_username: str, new_username: str) -> bool:
    """Rename @old_username → @new_username on disk.
    If the target folder already exists, files are moved individually (merge).
    Returns True on success or if old folder doesn't exist; False on error.
    """
    old_folder = os.path.join(VIDEOS_DIR, f"@{old_username}")
    new_folder = os.path.join(VIDEOS_DIR, f"@{new_username}")
    if not os.path.isdir(old_folder):
        return True
    try:
        if os.path.exists(new_folder):
            for fname in os.listdir(old_folder):
                os.rename(os.path.join(old_folder, fname),
                          os.path.join(new_folder, fname))
            os.rmdir(old_folder)
        else:
            os.rename(old_folder, new_folder)
        return True
    except Exception as e:
        print(f"[{_ts()}] Failed to rename folder @{old_username} → @{new_username}: {e}")
        return False


def _find_output(folder: str, video_id: str) -> str | None:
    files = _get_video_files(folder, video_id)
    return files[0] if files else None


def _remove_corrupt(folder: str, video_id: str):
    for fpath in _get_video_files(folder, video_id):
        if os.path.getsize(fpath) < MIN_VALID_SIZE_BYTES:
            os.remove(fpath)
