from __future__ import annotations

import json
import os
import time
import requests
import yt_dlp
from datetime import datetime
from typing import Any
from yt_dlp.utils import DownloadError

from config import MEDIA_DIR, _ts
from thumbnailer import generate_thumbnail
from photo_converter import encode_avif, CRF_PHOTO

MIN_VALID_SIZE_BYTES = 10_000

_YTDLP_STRIP_KEYS = frozenset({
    "formats", "thumbnails", "thumbnail", "url", "http_headers",
    "_format_sort_fields", "requested_formats", "requested_downloads",
    "_filename", "_type", "webpage_url_basename", "webpage_url_domain",
    "protocol", "__files_to_move", "__postprocessors",
})


def _clean_ytdlp_info(info: dict | None) -> str | None:
    """Return a JSON string of the yt-dlp info dict with large/expiring fields removed."""
    if not info:
        return None
    cleaned = {k: v for k, v in info.items() if k not in _YTDLP_STRIP_KEYS}
    try:
        return json.dumps(cleaned, default=str)
    except Exception:
        return None


def download_video(*, video_id: str, username: str, tiktok_id: str,
                   display_name: str, description: str,
                   upload_date: int, download_date: int,
                   platform: str = "tiktok",
                   url: str | None = None,
                   cookies_path: str | None = None) -> dict | None:
    """
    Download a video using yt-dlp and embed metadata into the file.
    Returns {'file_path': ..., 'ytdlp_data': ...} on success, None on failure.
    """
    author_folder = os.path.join(MEDIA_DIR, platform, f"@{username}")
    os.makedirs(author_folder, exist_ok=True)

    output_template = os.path.join(author_folder, f"{video_id}.%(ext)s")
    video_url = url if url is not None else f"https://www.tiktok.com/@{username}/video/{video_id}"

    upload_str   = (datetime.fromtimestamp(upload_date).strftime("%Y-%m-%d")
                    if upload_date else "")
    download_str = datetime.fromtimestamp(download_date).strftime("%Y-%m-%d %H:%M:%S")

    if platform == "youtube":
        fmt          = "bestvideo[height<=1080]+bestaudio/best"
        merge_fmt    = {}
    else:
        fmt          = "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]"
        merge_fmt    = {"merge_output_format": "mp4"}

    ydl_opts: dict[str, Any] = {
        "outtmpl":        output_template,
        "format":         fmt,
        **merge_fmt,
        "socket_timeout": 30,
        "retries":        3,
        "quiet":          True,
        "no_warnings":    False,
        **({"cookiefile": cookies_path} if cookies_path and os.path.exists(cookies_path) else {}),
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
            ydl_info = ydl.extract_info(video_url, download=True)
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

    # Reject audio-only downloads -- yt-dlp's final /best fallback was removed, but
    # some edge cases (very old posts, inaccessible video streams) can still produce
    # audio files.  Storing them as videos would pollute the library.
    _audio_exts = (".mp3", ".m4a", ".m4b", ".aac", ".ogg", ".wav", ".flac", ".opus")
    if actual_path.lower().endswith(_audio_exts):
        print(f"[{_ts()}] Rejected audio-only file for {video_id} ({os.path.basename(actual_path)}), removing.")
        os.remove(actual_path)
        return None

    print(f"[{_ts()}] Saved {video_id} ({file_size:,} bytes) -> {actual_path}")
    if upload_date:
        os.utime(actual_path, (upload_date, upload_date))
    thumb = generate_thumbnail(video_id, actual_path)
    if thumb:
        print(f"[{_ts()}] Thumbnail OK: {os.path.basename(thumb)}")
    else:
        print(f"[{_ts()}] Thumbnail FAILED for {video_id} (see [thumb] lines above)")
    ytdlp_data = _clean_ytdlp_info(ydl_info)
    extracted_upload_date: int | None = None
    if ydl_info:
        raw_date = ydl_info.get("upload_date")  # "YYYYMMDD" string
        if raw_date:
            try:
                extracted_upload_date = int(datetime.strptime(str(raw_date), "%Y%m%d").timestamp())
            except (ValueError, TypeError):
                pass
        if extracted_upload_date is None:
            ts = ydl_info.get("timestamp")
            if ts:
                try:
                    extracted_upload_date = int(ts)
                except (ValueError, TypeError):
                    pass
    return {"file_path": actual_path, "ytdlp_data": ytdlp_data, "upload_date": extracted_upload_date}


def _load_cookies(cookies_path: str) -> dict[str, str]:
    """Parse cookies.txt and return a name->value dict for HTTP requests."""
    result: dict[str, str] = {}
    try:
        with open(cookies_path, encoding="utf-8", errors="ignore") as f:
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
                    image_urls: list[str], upload_date: int,
                    platform: str = "tiktok",
                    cookies_path: str | None = None) -> str | None:
    """
    Download each image from a TikTok photo post directly.
    Files are saved as {video_id}_01.jpg, {video_id}_02.jpg, ...
    Returns the path of the first image on success, None if all fail.
    """
    author_folder = os.path.join(MEDIA_DIR, platform, f"@{username}")
    os.makedirs(author_folder, exist_ok=True)

    cookies    = _load_cookies(cookies_path) if cookies_path else {}
    first_path: str | None = None
    total      = len(image_urls)

    for i, url in enumerate(image_urls, 1):
        jpg_path  = os.path.join(author_folder, f"{video_id}_{i:02d}.jpg")
        avif_path = os.path.join(author_folder, f"{video_id}_{i:02d}.avif")
        try:
            resp = requests.get(url, cookies=cookies, timeout=30)
            resp.raise_for_status()
            with open(jpg_path, "wb") as f:
                f.write(resp.content)
            if upload_date:
                os.utime(jpg_path, (upload_date, upload_date))

            # Convert to AVIF immediately; keep JPEG only as fallback if encode fails
            if encode_avif(jpg_path, avif_path, CRF_PHOTO):
                if upload_date:
                    os.utime(avif_path, (upload_date, upload_date))
                try:
                    os.remove(jpg_path)
                except OSError:
                    pass
                saved_path = avif_path
            else:
                saved_path = jpg_path  # keep JPEG; photo_converter will retry later

            if first_path is None:
                first_path = saved_path
            print(f"[{_ts()}] Photo {i}/{total} saved -> {saved_path}")
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


def rename_creator_folder(platform: str, old_username: str, new_username: str) -> bool:
    """Rename {platform}/@old_username -> {platform}/@new_username on disk.
    If the target folder already exists, files are moved individually (merge).
    Returns True on success or if old folder doesn't exist; False on error.
    """
    old_folder = os.path.join(MEDIA_DIR, platform, f"@{old_username}")
    new_folder = os.path.join(MEDIA_DIR, platform, f"@{new_username}")
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
        print(f"[{_ts()}] Failed to rename folder @{old_username} -> @{new_username}: {e}")
        return False


_VIDEO_EXTS = (".mp4", ".mkv", ".webm", ".mov")


def _find_output(folder: str, video_id: str) -> str | None:
    files = _get_video_files(folder, video_id)
    # Prefer recognised video containers over .part, .ytdl, audio, or other temp files.
    video_files = [f for f in files if f.lower().endswith(_VIDEO_EXTS)]
    return video_files[0] if video_files else (files[0] if files else None)


def _remove_corrupt(folder: str, video_id: str):
    for fpath in _get_video_files(folder, video_id):
        if os.path.getsize(fpath) < MIN_VALID_SIZE_BYTES:
            os.remove(fpath)
