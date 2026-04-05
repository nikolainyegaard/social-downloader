# TikTok Downloader

Automatically downloads new videos from a list of TikTok accounts. Tracks deletions and username changes. Stores metadata in the database and embedded in each video file.

Managed through a web UI. All state lives on the server, so opening it from any device shows the same thing.

---

## How it works

A background loop runs on a fixed interval (default: 30 minutes, recommended: 3 hours for large libraries). Each iteration:

1. Loads all tracked users from the database
2. For each user:
   - Fetches their profile info via TikTokApi (Playwright/Chromium) and detects profile changes (username, display name, bio, avatar)
   - Fetches their full public video list via yt-dlp — no browser session needed
   - Compares it against the database
   - Downloads any new videos via yt-dlp, embedding metadata into the file; photo posts are downloaded as individual `.jpg` images
   - Tracks videos that have disappeared — after 3 consecutive loop runs without the video appearing, it is marked as deleted and its file is prefixed with `del_`
   - Tracks banned accounts similarly — confirmed after 3 consecutive checks
   - Immediately marks any previously-deleted videos or banned accounts as restored/active if they reappear

The first run for an account with many videos will take a while. Subsequent runs are fast.

---

## Prerequisites

- **Docker** and **Docker Compose** (for the recommended deployment)
- A TikTok account and a way to export its cookies (see below)
- A reverse proxy such as **Caddy** or **nginx** if you want to expose the UI over the internet

---

## Getting your TikTok cookies

TikTokApi (used to browse video lists) and yt-dlp (used to download) both need your TikTok session cookies to work. These are read from a single `cookies.txt` file in Netscape format.

**How to export:**

1. Install the browser extension **Get cookies.txt LOCALLY**
   ([Chrome](https://chrome.google.com/webstore/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc) / [Firefox](https://addons.mozilla.org/firefox/addon/get-cookies-txt-locally/))
2. Log in to [TikTok](https://www.tiktok.com) in your browser
3. Click the extension icon while on tiktok.com and export — save the file as `cookies.txt`
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
      LOOP_INTERVAL_MINUTES: "180"
    ports:
      - "127.0.0.1:5000:5000"
```

Replace `ghcr.io/nikolainyegaard/tiktok-downloader:latest` with the actual published image name.

### 2. Start the container

```bash
docker compose up -d
```

The web UI will be available at `http://localhost:5000` (or via your reverse proxy).

### 3. Upload cookies

Open the web UI, click the **⚙ gear icon** in the top-right corner of the header to open Settings, then go to the **Cookies** section. Click **Upload cookies.txt** and select the file you exported from your browser. The status pill will turn green once it's stored.

If no cookies file is present, a red warning banner appears below the header — clicking it opens the Cookies section directly.

### 4. Add accounts

Type a TikTok username (with or without `@`) into the **Track a user** field and click **Add**. The username is queued immediately — the input clears so you can add the next one right away. Each queued lookup runs in the background; a pending indicator appears below the form while it resolves.

### 5. Wait or trigger a run

The loop does not run automatically on startup — it waits for the first interval to elapse. Click **Run Now** in the header to trigger an immediate full run without waiting.

To process a single user immediately, click the **Run** button on their card. Multiple users can be queued this way — they run in order, one at a time.

Use the **Sort** dropdown and direction toggle in the Tracked users header to order cards by username, display name, followers, saved/deleted video counts, or date added.

Use the filter buttons (Public/Private, Active/Banned) next to the sort control to narrow the user list.

Click anywhere on a user card (other than the Run/Remove buttons) to open a detail view showing their full profile info, profile change history, and a complete, sortable, filterable list of all their downloaded videos with thumbnails. From the video list:

- **Click a thumbnail** to preview the image full-size in an overlay.
- **Click the ▶ button** (video posts only) to play the video directly in the browser.

The **Recent** panel on the main page shows the last few deleted videos, profile changes, and bans. Click any entry to jump straight to the relevant user and video. Click a section heading (e.g. "Recently deleted") to open a full scrollable log of all historical events of that type.

If you have videos downloaded before v1.5.0, their engagement stats and technical metadata will be missing. The header shows how many videos need backfilling (e.g. `942 missing`). Click **Backfill Stats** to fetch the missing data from TikTok without re-downloading any files — this covers views, likes, comments, shares, saves, duration, dimensions, and music info. Progress is shown inline; the operation runs in the background and does not interrupt the download loop. Videos downloaded with the current version are never eligible for backfill as all fields are captured at download time.

---

## Caddy integration

If Caddy runs directly on the host (not in Docker):

```caddy
tiktok.yourdomain.com {
    reverse_proxy localhost:5000
}
```

If Caddy is a Docker container on the same host, attach the downloader to Caddy's network and drop the `ports` block:

**docker-compose.yml**
```yaml
services:
  tiktok-downloader:
    image: ghcr.io/nikolainyegaard/tiktok-downloader:latest
    container_name: tiktok-downloader
    restart: unless-stopped
    volumes:
      - ./data:/app/data
      - ./videos:/app/videos
    environment:
      LOOP_INTERVAL_MINUTES: "180"
      TZ: "Europe/Oslo"
    expose:
      - "5000"
    networks:
      - caddy_net

networks:
  caddy_net:
    external: true  # must match the name of the network Caddy is on
```

**Caddyfile**
```caddy
tiktok.yourdomain.com {
    reverse_proxy tiktok-downloader:5000
}
```

---

## Building and publishing the image

```bash
# Build
docker build -t ghcr.io/nikolainyegaard/tiktok-downloader:latest .

# Push to GitHub Container Registry
docker push ghcr.io/nikolainyegaard/tiktok-downloader:latest
```

To authenticate with GHCR, see the [GitHub docs](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

---

## Configuration

All configuration is via environment variables in `docker-compose.yml`.

| Variable | Default | Description |
|---|---|---|
| `LOOP_INTERVAL_MINUTES` | `30` | Minutes between download loop runs. `180` is recommended for large libraries. |
| `WEB_PORT` | `5000` | Port the web UI listens on inside the container. |
| `DATA_DIR` | `/app/data` | Where the database, cookies.txt, and avatars are stored. |
| `VIDEOS_DIR` | `/app/videos` | Where downloaded videos are saved. |
| `THUMBNAIL_WORKERS` | `min(cpu_count, 12)` | Parallel ffmpeg workers for thumbnail generation. |
| `THUMBNAIL_USE_GPU` | `0` | Set to `1` to use NVDEC hardware decode for thumbnail extraction (requires CUDA-enabled ffmpeg). |
| `TZ` | `UTC` | Container timezone for log timestamps, e.g. `Europe/Oslo`. |
| `ms_token` | — | Fallback: provide the raw `msToken` cookie value if not using a cookies file. |

---

## Data layout

```
./data/
  tiktok.db        # SQLite database (users, videos, username history)
  cookies.txt      # TikTok session cookies (uploaded via UI)
  avatars/
    {tiktok_id}.jpg           # Current cached profile picture, refreshed each loop run
    {tiktok_id}_{ts}.jpg      # Archived previous avatars (created on change detection)
  logs/
    transcript.log   # Daily-rotating full output log

./videos/
  @username/
    1234567890.mp4      # Video post, named by TikTok video ID
    1234567890_01.jpg   # Photo post, one file per image
    1234567890_02.jpg
    thumbs/
      1234567890.jpg    # Auto-generated JPEG thumbnail (360px wide)
      ...
    ...
```

On first startup, a background thread scans all existing video files and generates any missing thumbnails in parallel. Progress is logged to the console.

### What's stored in the database

**Users:** TikTok ID, current username, display name, bio, follower/following/video counts, join date, verified status, account status (active / banned), date added, date last checked. The full raw API response is stored as a JSON blob for future use.

**Profile history:** Every change to a user's username, display name, bio, or avatar is recorded with a timestamp. Visible in the Profile History tab of the user detail panel.

**Videos:** Video ID, type (video or photo carousel), description, upload date, download date, file path, status (`up` / `deleted` / `undeleted`), engagement stats (views, likes, comments, shares, saves), dimensions (width, height, duration), music info (title and artist), and the full raw TikTok page data + yt-dlp metadata as JSON blobs. Stats are captured at download time from the TikTok page — use **Backfill Stats** in the UI to populate these for videos downloaded before v1.5.0.

### Metadata embedded in video files

Each downloaded file has its **modification date set to the TikTok upload date**, so files sort chronologically in the file system.

MP4 files also have the following tags written by ffmpeg:

| Tag | Content |
|---|---|
| `title` | Post description |
| `artist` | Username at time of download |
| `album_artist` | Display name |
| `date` | Upload date (YYYY-MM-DD) |
| `comment` | Pipe-separated key=value string with video ID, author ID, username, display name, upload date, and download date |
