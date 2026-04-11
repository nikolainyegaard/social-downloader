# TikTok Downloader

Automatically downloads new videos from a list of TikTok accounts and tracked sounds. Tracks deletions and username changes. Stores metadata in the database and embedded in each video file.

Managed through a web UI. All state lives on the server, so opening it from any device shows the same thing.

---

## How it works

Two independent background loops run on separate intervals (user loop default: 3 hours, sound loop default: 1 hour). Intervals are configurable per-loop in the Settings panel and are persisted across restarts. If both loops are due at the same time, the second waits for the first to finish plus a 5-minute buffer before starting.

The **user loop** runs on its own schedule. Each iteration:

1. Loads all tracked users from the database
2. For each user:
   - Fetches their profile info via TikTokApi (Playwright/Chromium) and detects profile changes (username, display name, bio, avatar, account status, privacy status)
   - Fetches their full public video list via TikTokApi `item_list` (reusing the same browser session); falls back to yt-dlp if item_list returns nothing
   - Compares it against the database
   - Downloads any new videos via yt-dlp, embedding metadata into the file; photo posts are downloaded as individual AVIF images
   - Tracks videos that have disappeared. After 3 consecutive loop runs without the video appearing, it is marked as deleted
   - Detects banned or removed accounts immediately (TikTok API status 10202). All active videos are marked deleted. If the account becomes reachable again in a future run, those videos are automatically restored. Accounts that stay banned for 14 consecutive days are automatically set to inactive so they stop being checked each loop
   - Immediately marks any previously-deleted videos as restored if they reappear

The first run for an account with many videos will take a while. Subsequent runs are fast.

The **sound loop** runs independently on its own schedule:

3. Loads all tracked sounds from the database
4. For each tracked sound:
   - Fetches all video IDs that use the sound via TikTokApi (up to 3000 videos)
   - Compares against already-known videos for that sound
   - Downloads any new videos not already in the library
   - For each new video's author, creates an `enabled=0` user row if the account is not already tracked (data is stored without starting full tracking)
   - Links all known videos (existing and new) to the sound via a junction table

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
      USER_LOOP_INTERVAL_MINUTES: "180"
      SOUND_LOOP_INTERVAL_MINUTES: "60"
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

If no cookies file is present, a red warning banner appears below the header. Clicking it opens the Cookies section directly.

### 4. Add accounts

Type a TikTok username (with or without `@`) into the **Track a user** field and click **Add**. The input clears immediately so you can add the next one. Each queued lookup runs in the background; a pending indicator appears below the form while it resolves.

### 5. Wait or trigger a run

Neither loop runs on startup. Each waits for its first interval to elapse. A **Loops** panel in the top dashboard row shows the last run time, next scheduled run, and a **Run Now** button for each loop independently.

To process a single user immediately, click the **Run** button on their card. Multiple users can be queued this way and run in order.

Use the **Sort** dropdown and direction toggle in the Tracked users header to order cards by username, display name, followers, saved/deleted video counts, or date added. The **search bar** in the nav bar filters both users (by username, display name, or ID) and sounds (by label or ID) in real time.

### Tracking sounds

Paste a TikTok sound URL (e.g. `https://www.tiktok.com/music/some-sound-7123456789`) or a raw numeric sound ID into the **Track a sound** field and click **Add**. Optionally give the sound a label to recognise it later.

Each sound card shows its label (or sound ID), a video count, and Run/Remove buttons. Click the card to open the sound detail modal with a sortable, filterable video list. It includes an **Author** column: already-tracked authors appear as blue clickable chips that open the user modal; authors discovered through sound tracking but not yet actively tracked appear as muted chips.

Click **Edit label** in the sound modal header to rename a sound. Click **Run** on the card or in the modal to trigger an immediate sound run without waiting for the next loop.

Use the filter buttons next to the sort control to narrow the user list. The **Privacy** filter has pills for Public / Private / Banned. The **Tracking** filter has pills for All / Active / Inactive (inactive = tracking paused).

Each user card has a **tracking toggle** in its footer. Turning it off pauses new-video downloads for that account without removing it — profile changes and deletion/ban detection continue running. The card dims to show the paused state.

Click anywhere on a user card (other than the Run/Remove/toggle buttons) to open a detail view showing their full profile info, profile change history, and a complete, sortable, filterable list of all their downloaded videos with thumbnails. Use the **search box** in the toolbar to filter by video ID or description. A **comment field** below the profile header lets you add a free-text note for the account. From the video list:

- **Click a thumbnail** to play the video or open the photo carousel (for photo posts).
- **Click the image-preview button** (next to the thumbnail) to view the still thumbnail full-size.
- **Toggle the grid view** button in the toolbar to switch between list and thumbnail grid; grid cells show view counts and video/photo type badges.

Videos that have disappeared from TikTok but are not yet confirmed deleted show a **Missing** status; they become Deleted after 3 consecutive loop runs without reappearing.

The **Recent** panel on the main page shows the last few deleted videos, profile changes, bans, and recently saved videos. In the Recently Saved section, consecutive downloads from the same user are grouped into a single row (e.g. "@user 12x"). Click any entry to jump to that user. Click a section heading (e.g. "Recently deleted") to open a full scrollable log of all historical events of that type.

If you have videos downloaded before v1.5.0, their engagement stats and technical metadata will be missing. The header shows how many videos need backfilling (e.g. `942 missing`). Click **Backfill Stats** to fetch the missing data from TikTok without re-downloading any files — this covers views, likes, comments, shares, saves, duration, dimensions, and music info. Progress is shown inline; the operation runs in the background and does not interrupt the download loop. Videos downloaded with the current version are never eligible for backfill as all fields are captured at download time.

All profile pictures, thumbnails, and photo posts are stored as **AVIF** images (50–70% smaller than JPEG at equivalent quality). On first startup, a background job automatically converts any existing JPEG images to AVIF. You can also trigger this manually from the **Jobs** section in Settings.

The **Jobs** section also has a **File integrity check**: a **Scan** button shows which videos have a database record but no file on disk (dry run, no changes). A **Purge** button removes those records from the database, allowing the loop to re-download them. A full report is written to disk and can be downloaded or viewed in the UI. The same check runs automatically at midnight and noon each day.

The **Utilities** section has one-off maintenance actions: delete all cached avatar images (re-downloaded on the next loop without triggering change history), delete all thumbnails (regenerated on next startup), and remove leftover audio-only files from before video-only downloads were enforced.

The **Database** section has a SQL query runner. SELECT statements return a paginated result table with a full-report viewer and download link. Other statements (INSERT, UPDATE, DELETE, etc.) are committed and report rows affected.

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
      USER_LOOP_INTERVAL_MINUTES: "180"
      SOUND_LOOP_INTERVAL_MINUTES: "60"
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
| `USER_LOOP_INTERVAL_MINUTES` | `180` | Minutes between user loop runs. |
| `SOUND_LOOP_INTERVAL_MINUTES` | `60` | Minutes between sound loop runs. |
| `LOOP_INTERVAL_MINUTES` | (none) | Legacy alias for `USER_LOOP_INTERVAL_MINUTES`. Ignored if `USER_LOOP_INTERVAL_MINUTES` is set. |
| `WEB_PORT` | `5000` | Port the web UI listens on inside the container. |
| `DATA_DIR` | `/app/data` | Where the database, cookies.txt, and avatars are stored. |
| `VIDEOS_DIR` | `/app/videos` | Where downloaded videos are saved. |
| `THUMBNAIL_WORKERS` | `min(cpu_count, 12)` | Parallel ffmpeg workers for thumbnail generation. |
| `THUMBNAIL_USE_GPU` | `0` | Set to `1` to use NVDEC hardware decode for thumbnail extraction (requires CUDA-enabled ffmpeg). |
| `TZ` | `UTC` | Container timezone for log timestamps, e.g. `Europe/Oslo`. |
| `ms_token` | (none) | Fallback: provide the raw `msToken` cookie value if not using a cookies file. |

---

## Data layout

```
./data/
  tiktok.db        # SQLite database (users, videos, username history)
  cookies.txt      # TikTok session cookies (uploaded via UI)
  avatars/
    {tiktok_id}.avif           # Current cached profile picture, refreshed each loop run
    {tiktok_id}_{ts}.avif      # Archived previous avatars (created on change detection)
  logs/
    transcript.log   # Daily-rotating full output log

./videos/
  @username/
    1234567890.mp4       # Video post, named by TikTok video ID
    1234567890_01.avif   # Photo post, one file per image (AVIF format)
    1234567890_02.avif
    thumbs/
      1234567890.avif    # Auto-generated AVIF thumbnail (360px wide)
      ...
    ...
```

On first startup, a background thread scans all existing video files and generates any missing thumbnails in parallel, and a second background job converts any existing JPEG photos/thumbnails/avatars to AVIF. Progress for both is logged to the console.

### What's stored in the database

**Users:** TikTok ID, current username, display name, bio, follower/following/video counts, join date, verified status, account status (active / banned), date added, date last checked. The full raw API response is stored as a JSON blob for future use.

**Profile history:** Every change to a user's username, display name, bio, or avatar is recorded with a timestamp. Visible in the Profile History tab of the user detail panel.

**Videos:** Video ID, type (video or photo carousel), description, upload date, download date, file path, status (`up` / `deleted` / `undeleted`), engagement stats (views, likes, comments, shares, saves), dimensions (width, height, duration), music info (title, artist, and sound ID), and the full raw TikTok page data + yt-dlp metadata as JSON blobs. Stats are captured at download time from the TikTok page — use **Backfill Stats** in the UI to populate these for videos downloaded before v1.5.0.

**Sounds:** Sound ID, optional label, date added, date last checked. Many-to-many relationship with videos via a junction table.

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
