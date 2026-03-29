# TikTok Downloader

Automatically downloads new videos from a list of TikTok accounts. Tracks deletions and username changes. Stores metadata in the database and embedded in each video file.

Managed through a web UI. All state lives on the server, so opening it from any device shows the same thing.

---

## How it works

A background loop runs on a fixed interval (default: 30 minutes, recommended: 3 hours for large libraries). Each iteration:

1. Loads all tracked users from the database
2. For each user:
   - Fetches their profile info via TikTokApi (Playwright/Chromium) and detects username changes
   - Fetches their full public video list via yt-dlp — no browser session needed
   - Compares it against the database
   - Downloads any new videos via yt-dlp, embedding metadata into the file; photo posts are downloaded as individual `.jpg` images
   - Marks any previously-seen videos that have disappeared as deleted
   - Marks any previously-deleted videos that have reappeared as restored

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

Open the web UI and click **Upload cookies.txt** in the Authentication section. Select the file you exported from your browser. The status pill will turn green once it's stored.

### 4. Add accounts

Type a TikTok username (with or without `@`) into the **Track a user** field and click **Add**. The username is queued immediately — the input clears so you can add the next one right away. Each queued lookup runs in the background; a pending indicator appears below the form while it resolves.

### 5. Wait or trigger a run

The loop runs automatically on startup and then on the interval you configured. Click **Run Now** in the header to trigger an immediate run without waiting.

---

## Caddy integration

If Caddy runs directly on the host (not in Docker):

```caddy
tiktok.yourdomain.com {
    reverse_proxy localhost:5000
}
```

If Caddy is also a Docker container, run both on a shared network. Full example:

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

  caddy:
    image: caddy:latest
    container_name: caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
      - caddy_config:/config
    networks:
      - caddy_net

networks:
  caddy_net:
    external: false

volumes:
  caddy_data:
  caddy_config:
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
| `DATA_DIR` | `/app/data` | Where the database and cookies.txt are stored. |
| `VIDEOS_DIR` | `/app/videos` | Where downloaded videos are saved. |
| `TZ` | `UTC` | Container timezone for log timestamps, e.g. `Europe/Oslo`. |
| `ms_token` | — | Fallback: provide the raw `msToken` cookie value if not using a cookies file. |

---

## Data layout

```
./data/
  tiktok.db        # SQLite database (users, videos, username history)
  cookies.txt      # TikTok session cookies (uploaded via UI)
  logs/
    transcript.log # Daily-rotating full output log

./videos/
  @username/
    1234567890.mp4      # Video post, named by TikTok video ID
    1234567890_01.jpg   # Photo post, one file per image
    1234567890_02.jpg
    ...
```

### What's stored in the database

**Users:** TikTok ID, current username, display name, bio, follower/following/video counts, join date, account status (active / banned), date added, date last checked.

**Username history:** Every username change is recorded with a timestamp, so you always know what an account used to be called.

**Videos:** Video ID, type (video or photo carousel), description, upload date, download date, file path, and status — `up`, `deleted` (disappeared from TikTok), or `undeleted` (reappeared after being deleted), with timestamps for each status change.

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
