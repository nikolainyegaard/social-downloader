# TikTok Downloader

Automatically downloads new videos from a list of TikTok accounts and tracked sounds. Tracks deletions and username changes. Stores metadata in the database and embedded in each video file.

Managed through a web UI. All state lives on the server, so opening it from any device shows the same thing.

[![Support me on Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/nikolainyegaard)

---

## How it works

Two background loops run on configurable intervals. The **user loop** (default: every 3 hours) checks each tracked account for new videos, downloads them, and detects deletions, bans, and profile changes. The **sound loop** (default: every hour) fetches all videos using a tracked sound and downloads any new ones not already in the library. Both loops can be triggered manually from the UI at any time.

---

## Prerequisites

- Docker and Docker Compose
- A TikTok account and a way to export its cookies (see below)
- A reverse proxy if you want to expose the UI over the internet

---

## Getting your TikTok cookies

TikTokApi (used to browse video lists) and yt-dlp (used to download) both need your TikTok session cookies to work. These are read from a single `cookies.txt` file in Netscape format.

**How to export:**

1. Install the browser extension **Get cookies.txt LOCALLY**
   ([Chrome](https://chrome.google.com/webstore/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc) / [Firefox](https://addons.mozilla.org/firefox/addon/get-cookies-txt-locally/))
2. Log in to [TikTok](https://www.tiktok.com) in your browser
3. Click the extension icon while on tiktok.com and export; save the file as `cookies.txt`
4. Upload it through the web UI (see below)

> Cookies expire periodically. If downloads start failing, re-export and re-upload.

---

## Setup

### 1. Get the docker-compose file

Create a folder on your server and drop in a `docker-compose.yml`:

```yaml
services:
  tiktok-downloader:
    image: ghcr.io/nikolainyegaard/tiktok-downloader:latest
    container_name: tiktok-downloader
    restart: unless-stopped
    volumes:
      - ./data:/app/data      # database + cookies.txt
      - ./videos:/app/videos  # downloaded video files
    environment:
      USER_LOOP_INTERVAL_MINUTES: "180"
      SOUND_LOOP_INTERVAL_MINUTES: "60"
    ports:
      - "127.0.0.1:5000:5000"
```

### 2. Start the container

```bash
docker compose up -d
```

The web UI will be available at `http://localhost:5000` (or via your reverse proxy).

### 3. Upload cookies

Open the web UI, go to Settings (gear icon, top-right), then the **Cookies** section. Click **Upload cookies.txt** and select the exported file. The status pill turns green once stored.

If no cookies file is present, a red warning banner appears below the header. Clicking it opens the Cookies section directly.

### 4. Add accounts

Type a TikTok username (with or without `@`) into the **Track a user** field and click **Add**. Each lookup runs in the background; a pending indicator appears while it resolves.

### 5. Wait or trigger a run

Neither loop runs on startup. Each waits for its first interval to elapse. The **Loops** panel shows the last run time, next scheduled run, and a **Run Now** button for each loop. To process a single user immediately, click the **Run** button on their card.

### Tracking sounds

Paste a TikTok sound URL or raw numeric sound ID into the **Track a sound** field and click **Add**. Optionally give the sound a label.

Each sound card shows the label (or ID), video count, and Run/Remove buttons. Click the card to open a video list for that sound. Authors already being tracked appear as clickable chips; authors discovered through sound tracking but not actively tracked appear as muted chips.

### User cards and detail view

Each user card has a **tracking toggle** in its footer. Turning it off pauses video downloads for that account without removing it; profile change and deletion/ban detection continue running.

Click a user card to open a detail view with their profile info, profile change history, and a full list of downloaded videos. Videos that have disappeared from TikTok show a **Missing** status until confirmed deleted over several consecutive loop runs.

The **Recent** panel on the main page shows the last few deleted videos, profile changes, bans, and recently saved videos. Click any entry to jump to that user, or click a section heading to open the full historical log for that event type.

### Settings and maintenance

The **Jobs** section in Settings has a **File integrity check**: Scan shows which videos have a database record but no file on disk; Purge removes those records so the loop can re-download them.

The **Utilities** section has one-off maintenance actions for clearing cached avatars and thumbnails.

The **Database** section has a SQL query runner. SELECT statements return a paginated result table with a download link. Other statements are committed and report rows affected.

---

## Configuration

All configuration is via environment variables in `docker-compose.yml`.

| Variable | Default | Description |
|---|---|---|
| `USER_LOOP_INTERVAL_MINUTES` | `180` | Minutes between user loop runs. |
| `SOUND_LOOP_INTERVAL_MINUTES` | `60` | Minutes between sound loop runs. |
| `LOOP_INTERVAL_MINUTES` | (none) | Legacy alias for `USER_LOOP_INTERVAL_MINUTES`. Ignored if `USER_LOOP_INTERVAL_MINUTES` is set. |
| `WEB_PORT` | `5000` | Port the web UI listens on inside the container. |
| `DATA_DIR` | `/app/data` | Where the database, cookies.txt, and avatars are stored. |
| `VIDEOS_DIR` | `/app/videos` | Where downloaded videos are saved. |
| `THUMBNAIL_WORKERS` | `min(cpu_count, 12)` | Parallel ffmpeg workers for thumbnail generation. |
| `THUMBNAIL_USE_GPU` | `0` | Set to `1` to use NVDEC hardware decode for thumbnail extraction (requires CUDA-enabled ffmpeg). |
| `TZ` | `UTC` | Container timezone for log timestamps, e.g. `America/New_York`. |
| `ms_token` | (none) | Fallback: provide the raw `msToken` cookie value if not using a cookies file. |

---

## Data layout

```
./data/
  tiktok.db        # SQLite database (users, videos, sounds, profile history)
  cookies.txt      # TikTok session cookies (uploaded via UI)
  avatars/
    {tiktok_id}.avif           # Current cached profile picture
    {tiktok_id}_{ts}.avif      # Archived previous avatars
  logs/
    transcript.log   # Daily-rotating full output log

./videos/
  @username/
    1234567890.mp4       # Video post, named by TikTok video ID
    1234567890_01.avif   # Photo post, one file per image
    1234567890_02.avif
    thumbs/
      1234567890.avif    # Auto-generated thumbnail
```

### Metadata embedded in video files

Each downloaded file has its **modification date set to the TikTok upload date**, so files sort chronologically in the file system.

MP4 files also have the following tags written by ffmpeg:

| Tag | Content |
|---|---|
| `title` | Post description |
| `artist` | Username at time of download |
| `album_artist` | Display name |
| `date` | Upload date (YYYY-MM-DD) |
| `comment` | Video ID, author ID, username, display name, upload date, and download date |

---

## Local development

```bash
pip install -r requirements.txt
playwright install chromium --with-deps
python main.py
```

Open `http://localhost:5000`.

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md).
