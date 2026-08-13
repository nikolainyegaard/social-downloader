from __future__ import annotations

import json
import os
import subprocess
import time
import requests
import yt_dlp
from datetime import datetime
from typing import Any
from yt_dlp.utils import DownloadError

from config import MEDIA_DIR, DATA_DIR, _ts
from thumbnailer import generate_thumbnail
from photo_converter import encode_avif, CRF_PHOTO
import transcoder

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
                   cookies_path: str | None = None,
                   proxy: str | None = None) -> dict | None:
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
        fmt          = "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"
        merge_fmt    = {"merge_output_format": "mp4"}

    ydl_opts: dict[str, Any] = {
        "outtmpl":        output_template,
        "format":         fmt,
        **merge_fmt,
        "socket_timeout": 30,
        "retries":        3,
        # TikTok bot detection rejects yt-dlp's default UA since 2026-08-10
        # (yt-dlp #17403); a current Chrome UA passes. Harmless elsewhere.
        "http_headers": {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        },
        "quiet":          True,
        "no_warnings":    False,
        **({"proxy": proxy} if proxy else {}),
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

    _audio_exts = (".mp3", ".m4a", ".m4b", ".aac", ".ogg", ".wav", ".flac", ".opus")
    if actual_path.lower().endswith(_audio_exts):
        print(f"[{_ts()}] Audio-only post {video_id} ({os.path.basename(actual_path)}), skipping.")
        os.remove(actual_path)
        return {"audio_only": True}

    print(f"[{_ts()}] Saved {video_id} ({file_size:,} bytes) -> {actual_path}")
    if upload_date:
        os.utime(actual_path, (upload_date, upload_date))
    thumb = generate_thumbnail(video_id, actual_path)
    if thumb:
        print(f"[{_ts()}] Thumbnail OK: {os.path.basename(thumb)}")
    else:
        print(f"[{_ts()}] Thumbnail FAILED for {video_id} (see [thumb] lines above)")
    transcoder.maybe_enqueue(actual_path)
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
                    cookies_path: str | None = None,
                    proxy: str | None = None) -> str | None:
    """
    Download each image from a TikTok photo post directly.
    Files are saved as {video_id}_01.jpg, {video_id}_02.jpg, ...
    Returns the path of the first image on success, None if all fail.
    """
    author_folder = os.path.join(MEDIA_DIR, platform, f"@{username}")
    os.makedirs(author_folder, exist_ok=True)

    cookies    = _load_cookies(cookies_path) if cookies_path else {}
    proxies    = {"http": proxy, "https": proxy} if proxy else None
    first_path: str | None = None
    total      = len(image_urls)

    for i, url in enumerate(image_urls, 1):
        jpg_path  = os.path.join(author_folder, f"{video_id}_{i:02d}.jpg")
        avif_path = os.path.join(author_folder, f"{video_id}_{i:02d}.avif")
        try:
            resp = requests.get(url, cookies=cookies, proxies=proxies, timeout=30)
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


class StoryDownloadError(Exception):
    """All URL candidates for a story failed. The message is a short reason
    fit for the UI log; per-candidate detail goes to the run log."""


_STORY_QUARANTINE_DIR = os.path.join(DATA_DIR, "story_debug")
_STORY_QUARANTINE_KEEP = 60


def _quarantine_story(story_id: str, kind: str, data: bytes, trace: dict) -> None:
    """Preserve a rejected story download plus a full context trace instead of
    deleting it, so a real corrupt sample can be inspected and sent for
    diagnosis rather than reasoned about from source. Bounded to the last
    _STORY_QUARANTINE_KEEP files so it cannot grow without limit. Best-effort:
    a failure here never affects the download flow."""
    try:
        os.makedirs(_STORY_QUARANTINE_DIR, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        base  = os.path.join(_STORY_QUARANTINE_DIR, f"{stamp}_{kind}_{story_id}")
        trace = {
            **trace,
            "story_id": story_id, "kind": kind,
            "bytes": len(data),
            "magic": data[:16].hex(),
            "head":  data[:200].decode("latin-1", "replace"),
        }
        with open(base + ".bin", "wb") as f:
            f.write(data[:2_000_000])  # cap: the header is all we need to classify
        with open(base + ".json", "w") as f:
            json.dump(trace, f, indent=2, default=str)
        files = sorted(
            f for f in os.listdir(_STORY_QUARANTINE_DIR) if f.endswith((".bin", ".json"))
        )
        while len(files) > _STORY_QUARANTINE_KEEP * 2:
            try:
                os.remove(os.path.join(_STORY_QUARANTINE_DIR, files.pop(0)))
            except OSError:
                break
        print(f"[{_ts()}] Story {story_id} quarantined a rejected {kind} download to {base}.bin")
    except Exception as e:
        print(f"[{_ts()}] Story {story_id} quarantine failed: {type(e).__name__}: {e}")


def _probe_media_file(path: str) -> str | None:
    """ffprobe gate for downloaded story videos. Returns None when the file is
    a valid, decodable video, or a short reason string when it is not. TikTok's
    CDN sometimes answers 200 with a truncated body, which saves as a corrupt
    mp4 (moov atom missing) that no browser can play. Beyond a clean exit we
    also require at least one video stream, so an audio-only or empty container
    is rejected too."""
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=codec_name", "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=30,
        )
    except Exception as e:
        return f"ffprobe failed to run: {type(e).__name__}"
    if r.returncode != 0:
        err = (r.stderr or "").strip().splitlines()
        return err[-1] if err else f"ffprobe exit {r.returncode}"
    if not (r.stdout or "").strip():
        return "no video stream"
    return None


def _valid_media_file(path: str) -> bool:
    return _probe_media_file(path) is None


def _download_story_via_ytdlp(*, story_id: str, page_url: str, stories_dir: str,
                              stamp: str, posted_at: int | None,
                              cookies_path: str | None = None,
                              proxy: str | None = None) -> str | None:
    """Video stories: let yt-dlp fetch the story page and download the media
    itself, so the URL is signed for the client that uses it. This sidesteps
    the CDN 403s that hit pre-signed URLs reused by a second client. Returns
    the saved path, or None so the caller falls back to the direct CDN GETs.
    Not used for photo stories: yt-dlp returns audio-only for TikTok images.
    """
    output_template = os.path.join(stories_dir, f"{stamp}_{story_id}.%(ext)s")
    ydl_opts: dict[str, Any] = {
        "outtmpl":        output_template,
        "format":         "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "merge_output_format": "mp4",
        "socket_timeout": 30,
        "retries":        2,
        "quiet":          True,
        "no_warnings":    True,
        **({"proxy": proxy} if proxy else {}),
        **({"cookiefile": cookies_path} if cookies_path and os.path.exists(cookies_path) else {}),
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.extract_info(page_url, download=True)
    except Exception as e:
        print(f"[{_ts()}] Story {story_id} yt-dlp attempt failed: {e}")
        return None
    for ext in ("mp4", "webm", "mkv", "mov"):
        path = os.path.join(stories_dir, f"{stamp}_{story_id}.{ext}")
        if os.path.exists(path):
            # Validate before accepting: yt-dlp can leave a truncated or
            # half-merged file behind without raising, and this path runs
            # before the CDN candidates, so an unchecked bad file here is
            # exactly how corrupt stories keep slipping through.
            reason = _probe_media_file(path)
            if reason:
                kb = os.path.getsize(path) // 1024
                print(f"[{_ts()}] Story {story_id} yt-dlp produced an invalid file "
                      f"({kb} KB, {reason}), discarding and falling back to CDN")
                try:
                    with open(path, "rb") as f:
                        _quarantine_story(story_id, "ytdlp", f.read(), {
                            "page_url": page_url, "ext": ext, "reason": reason,
                            "size_bytes": os.path.getsize(path), "proxy": bool(proxy),
                        })
                except OSError:
                    pass
                try:
                    os.remove(path)
                except OSError:
                    pass
                return None
            if posted_at:
                os.utime(path, (posted_at, posted_at))
            print(f"[{_ts()}] Story {story_id} saved via yt-dlp -> {path}")
            return path
    print(f"[{_ts()}] Story {story_id} yt-dlp reported success but produced no file")
    return None


def download_story(*, story_id: str, username: str, platform: str,
                   media_url: str, content_type: str, posted_at: int | None,
                   media_urls: list[str] | None = None,
                   page_url: str | None = None,
                   cookies: dict | None = None,
                   cookies_path: str | None = None,
                   headers: dict | None = None,
                   proxy: str | None = None) -> str:
    """
    Download one story item (video or image) into the creator's stories folder.

    Stories live on expiring CDN URLs that yt-dlp cannot resolve (story pages
    404 for logged-out clients), so this is a direct GET like photo posts.
    media_urls carries every URL candidate the platform offered (TikTok items
    list up to three hosts per video); each is tried in order because a single
    CDN host 403ing is common. Files are named {YYYYMMDD_HHMMSS}_{story_id}.{ext}
    from the post time. Returns the saved path; raises StoryDownloadError with
    a short reason when every candidate fails.
    """
    from urllib.parse import urlparse
    from curl_cffi import requests as curl_requests

    stories_dir = os.path.join(MEDIA_DIR, platform, f"@{username}", "stories")
    os.makedirs(stories_dir, exist_ok=True)

    stamp   = (datetime.fromtimestamp(posted_at).strftime("%Y%m%d_%H%M%S")
               if posted_at else datetime.now().strftime("%Y%m%d_%H%M%S"))

    # Video stories with a page URL go to yt-dlp first: it fetches the page
    # and downloads with its own session, so the media URL is signed for the
    # client actually using it. The direct CDN GETs below stay as fallback.
    if page_url and content_type == "video":
        path = _download_story_via_ytdlp(
            story_id=story_id, page_url=page_url, stories_dir=stories_dir,
            stamp=stamp, posted_at=posted_at, cookies_path=cookies_path, proxy=proxy,
        )
        if path:
            transcoder.maybe_enqueue(path)
            return path

    # A live cookies dict (the fetching session's jar) wins over cookies.txt:
    # TikTok's CDN signs story URLs against the session's tt_chain_token
    if not cookies:
        cookies = _load_cookies(cookies_path) if cookies_path else {}

    # TikTok's story CDN often 403s a plain library client; a browser-shaped
    # request with a Referer gets through (same treatment as the page scrapes).
    # Other platforms' story CDNs get no cross-site Referer.
    _headers = {
        "Accept-Language": "en-US,en;q=0.9",
        **({"Referer": "https://www.tiktok.com/"} if platform == "tiktok" else {}),
        **(headers or {}),
    }

    candidates  = [u for u in (media_urls or []) if u] or [media_url]
    cookie_note = f"cookies: {', '.join(sorted(cookies)[:10]) or 'none'}"
    resp        = None
    last_reason = "no URL candidates"
    for i, url in enumerate(candidates, 1):
        host = urlparse(url).netloc
        try:
            r = curl_requests.get(
                url, cookies=cookies, headers=_headers,
                impersonate="chrome120", timeout=60,
                **({"proxies": {"http": proxy, "https": proxy}} if proxy else {}),
            )
        except Exception as e:
            # curl raises IncompleteRead when a declared Content-Length is not
            # fully delivered: the clearest possible truncation signal, so
            # record it with the same trace as the other rejections.
            last_reason = type(e).__name__
            print(f"[{_ts()}] Story {story_id} candidate {i}/{len(candidates)} ({host}): "
                  f"{type(e).__name__}: {e} ({cookie_note})")
            _quarantine_story(story_id, "cdn", b"", {
                "candidate": f"{i}/{len(candidates)}", "host": host, "url": url,
                "reason": f"transfer error: {type(e).__name__}", "error_detail": str(e),
                "cookies": sorted(cookies), "proxy": bool(proxy),
            })
            continue
        # Content-Length vs bytes actually received bisects the failure: a
        # short read is a transfer truncated mid-stream (network, proxy,
        # timeout); a full read that still will not decode is the CDN serving
        # genuinely bad bytes (or a non-video error page).
        clen = r.headers.get("Content-Length") or r.headers.get("content-length")
        got  = len(r.content or b"")
        try:
            clen_int = int(clen) if clen is not None else None
        except ValueError:
            clen_int = None
        xfer = ("short read" if clen_int and got < clen_int
                else "size ok" if clen_int else "no content-length")
        transfer_note = f"CL={clen or '?'} got={got} ({xfer})"

        def _quarantine(reason):
            _quarantine_story(story_id, "cdn", r.content or b"", {
                "candidate": f"{i}/{len(candidates)}", "host": host, "url": url,
                "http_status": r.status_code, "reason": reason,
                "content_length": clen, "content_type_header": r.headers.get("Content-Type"),
                "transfer": xfer, "cookies": sorted(cookies), "proxy": bool(proxy),
            })

        if r.status_code != 200:
            last_reason = f"HTTP {r.status_code}"
            body_head = (r.content or b"")[:120]
            print(f"[{_ts()}] Story {story_id} candidate {i}/{len(candidates)} ({host}): "
                  f"HTTP {r.status_code}, body {body_head!r} ({cookie_note})")
            _quarantine(f"HTTP {r.status_code}")
            continue
        if not r.content:
            last_reason = "empty body"
            print(f"[{_ts()}] Story {story_id} candidate {i}/{len(candidates)} ({host}): "
                  f"HTTP 200 with empty body, {transfer_note} ({cookie_note})")
            continue
        if content_type != "photo":
            # A 200 is not proof of a valid video: TikTok's CDN sometimes
            # delivers a truncated body. Validate before accepting the
            # candidate so a garbage response falls through to the next URL.
            mp4_path = os.path.join(stories_dir, f"{stamp}_{story_id}.mp4")
            with open(mp4_path, "wb") as f:
                f.write(r.content)
            probe_reason = _probe_media_file(mp4_path)
            if probe_reason:
                last_reason = "invalid video data"
                try:
                    os.remove(mp4_path)
                except OSError:
                    pass
                print(f"[{_ts()}] Story {story_id} candidate {i}/{len(candidates)} ({host}): "
                      f"HTTP 200 but invalid video data ({got // 1024} KB, {transfer_note}, "
                      f"{probe_reason}, {cookie_note})")
                _quarantine(probe_reason)
                continue
            if posted_at:
                os.utime(mp4_path, (posted_at, posted_at))
            if i > 1:
                print(f"[{_ts()}] Story {story_id} saved via fallback candidate {i} ({host})")
            print(f"[{_ts()}] Story {story_id} saved ({len(r.content) // 1024} KB) -> {mp4_path}")
            transcoder.maybe_enqueue(mp4_path)
            return mp4_path
        resp = r
        if i > 1:
            print(f"[{_ts()}] Story {story_id} saved via fallback candidate {i} ({host})")
        break
    if resp is None:
        raise StoryDownloadError(last_reason)

    jpg_path  = os.path.join(stories_dir, f"{stamp}_{story_id}.jpg")
    avif_path = os.path.join(stories_dir, f"{stamp}_{story_id}.avif")
    with open(jpg_path, "wb") as f:
        f.write(resp.content)
    if posted_at:
        os.utime(jpg_path, (posted_at, posted_at))
    saved = jpg_path  # keep JPEG if encode fails; photo_converter retries later
    if encode_avif(jpg_path, avif_path, CRF_PHOTO):
        if posted_at:
            os.utime(avif_path, (posted_at, posted_at))
        try:
            os.remove(jpg_path)
        except OSError:
            pass
        saved = avif_path
    print(f"[{_ts()}] Story {story_id} saved ({len(resp.content) // 1024} KB) -> {saved}")
    return saved


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
