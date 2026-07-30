# Configuration, data layout, Docker

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATA_DIR` | `/app/data` | Root for DBs, cookies, avatars, logs |
| `MEDIA_DIR` | `/app/media` | Downloaded media root |
| `WEB_PORT` | `5000` | Flask listen port |
| `TZ` | (system) | Log timestamp timezone (e.g. `Europe/Oslo`) |
| `THUMBNAIL_WORKERS` | `min(cpu//4, 4)` | Parallel thumbnail workers |
| `THUMBNAIL_USE_GPU` | `0` | `1` enables NVDEC decode in ffmpeg |
| `APP_VERSION` | `dev` | Injected at build time via the `BUILD_VERSION` ARG |
| `ms_token` | | TikTok: fallback msToken when no cookies.txt |
| `TIKTOK_PROXY` | | Seeds the TikTok proxy setting and enables routing until the UI writes its own |
| `TIKTOK_SOUND_LOOP_INTERVAL_MINUTES` | `60` | Sound loop interval |
| `TIKTOK_STATS_REFRESH_DAYS` | `7` | Days between full item_list stats refreshes per user |
| `TIKTOK_USER_LOOP_INTERVAL_MINUTES` | `180` | Legacy, superseded by the session scheduler |
| `OAUTH_FORCE_DISABLE` | `false` | `true` bypasses auth enforcement without editing oauth.json; use when locked out |
| `TRANSCODE_FFMPEG` | `/opt/ffmpeg/ffmpeg` if present, else `ffmpeg` | ffmpeg binary the AV1 transcode job uses (needs SVT-AV1 and libvmaf) |

Per-platform scheduling vars, `{P}` = `TIKTOK`, `YOUTUBE`, `INSTAGRAM`, `TWITTER`, `ONLYFANS`:

| Variable | Default | Description |
|----------|---------|-------------|
| `{P}_SESSIONS_PER_DAY` | `4` | Check sessions per 24h window |
| `{P}_HIGH_PRIORITY_CHECK_HOURS` | `6` | Interval for starred creators |
| `{P}_ACTIVE_CHECK_HOURS` | `24` | Interval for active creators (posted within 30 days) |
| `{P}_INACTIVE_CHECK_HOURS` | `72` | Interval for inactive creators (no post in 60+ days) |
| `{P}_FULL_REFRESH_DAYS` | `7` | Days between full deletion-detecting checks (TikTok uses its own `STATS_REFRESH_DAYS`) |
| `{P}_SESSION_GAP_MEAN_SECS` | `90` | Mean of the exponential inter-creator gap |

All of these are also settable in the Settings UI (stored per-platform in the DB); the DB value wins.

## Data layout

```
data/
  logs/
    run_current.log             everything printed this run (all loops + Flask); stdout/stderr tee
    runs/run_YYYYMMDD.log       midnight rotation
    runs/run_YYYYMMDD_HHMMSS.log  startup rotation (last 50 kept)
  {platform}/                   one dir per platform
    {platform}.db
    loop_state.json             session scheduler state
    cookies.txt + cookies.timestamp   tiktok, twitter, instagram, onlyfans (auth.json content for OnlyFans)
    avatars/{id}.avif           plus {id}_{ts}.avif archives and thumbs/{id}.avif lazy small variants
    banners/{id}.avif           youtube, onlyfans
  tiktok/
    browser_profile/            persistent Chrome user-data-dir: one stable device identity
    sound_loop_state.json       (falls back to legacy sound_* keys in loop_state.json)
  gluetun/wireguard/wg0.conf    composed by Settings > Network; the gluetun container reads it
  story_debug/                  quarantined rejected story downloads: {ts}_{cdn|ytdlp}_{story_id}.bin
                                + .json trace, bounded to the most recent failures
  reports/                      DB query pane reports ({prefix}-db-query-*.txt)
  backups/{platform}_YYYYMMDD.db   all platform DBs, 14-day retention
  sessions/                     flask-session store; always present (no-op when OAuth disabled)
  platforms.json                disabled-platform set (Settings > General)
  transcode.json                AV1 transcode job settings (Settings > General > Jobs)
  transcode.db                  transcode queue + history; derived state, rebuilt by Backfill
  oauth.json                    OAuth config (enabled, client_id, client_secret, discovery_url, lifetime)
  .secret_key                   auto-generated Flask session secret, first startup, never user-managed

media/{platform}/@handle/
  {video_id}.mp4
  {video_id}_01.avif            photo or multi-media post, numbered _01, _02, ... (AVIF, .jpg fallback)
  del_{video_id}.mp4            deleted video (TikTok prefix)
  stories/{YYYYMMDD_HHMMSS}_{story_id}.mp4|.avif   timestamped by post time
  thumbs/{video_id}.avif
```

**Log routing:** every loop's `_log` prints to stdout and appends to its own in-memory deque (the per-app log console, `/api/{p}/status`). Stdout and stderr are teed to `data/logs/run_current.log`, which rotates at midnight and on startup. There are no per-platform log files.

## Docker

**Image:** `ghcr.io/nikolainyegaard/social-downloader`. **Base:** `python:3.12-slim-bookworm`. **Port:** 5000 (bound to `127.0.0.1:5000` in docker-compose.yml).

Build notes:
- ffmpeg (libaom-av1 is in the Bookworm package), plus `xdotool` for the in-app viewer's input injection
- A second, static ffmpeg at `/opt/ffmpeg/` (BtbN build, bound to a major ffmpeg line so image builds pick up patch updates) used only by the AV1 transcode job: the Bookworm package carries SVT-AV1 1.4 and no libvmaf. The apt ffmpeg stays for everything else because its x11grab backs the in-app browser viewer, which static builds do not reliably include
- Browser per arch: Google Chrome on amd64 (better bot-detection resistance, no arm64 build exists), patchright's Chromium on arm64 (`patchright install chromium`). config.py detects google-chrome at startup and falls back to the bundled Chromium, so call sites work on both arches
- `ARG BUILD_VERSION=dev` / `ENV APP_VERSION=${BUILD_VERSION}`
- `ENV MEDIA_DIR=/app/media` pins the media path; without it the fallback `./media` depends on CWD and 404s video/thumbnail serving
- CMD starts `Xvfb :99` in the background and `exec`s python (python stays PID 1), with `DISPLAY=:99` in ENV, so the TikTok browser runs headed (headless Chrome has its own fingerprint class). It removes the previous run's `/tmp/.X99-lock` and X socket first. Do NOT use xvfb-run: see the Xvfb gotcha in [tiktok.md](tiktok.md)

Volumes: `./data:/app/data` (DBs, cookies, avatars, logs, back this up) and `./media:/app/media`.

## Reverse proxy (Caddy)

```caddy
social.yourdomain.com {
    reverse_proxy localhost:5000
}
```

For a containerized Caddy use `reverse_proxy social-downloader:5000`, `expose: ["5000"]` instead of `ports`, and both services on Caddy's external network.
