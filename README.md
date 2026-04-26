# social-downloader

Self-hosted social media archiver. Monitors creators across multiple platforms, detects new, deleted, and restored content each loop cycle, and downloads it with embedded metadata. Managed from a browser-based UI.

**Platform support:**
- TikTok: users and sounds
- YouTube: channels (in development)
- Instagram, X: planned

---

## Running

```
docker compose up -d
```

Open [http://localhost:5000](http://localhost:5000).

The app binds to `127.0.0.1:5000` by default. Put a reverse proxy (Caddy, nginx) in front if you want it on a domain.

---

## Configuration

Key environment variables (set in `docker-compose.yml`):

| Variable | Default | Description |
|----------|---------|-------------|
| `TIKTOK_USER_LOOP_INTERVAL_MINUTES` | `180` | How often to check tracked TikTok users |
| `TIKTOK_SOUND_LOOP_INTERVAL_MINUTES` | `60` | How often to check tracked TikTok sounds |
| `YOUTUBE_LOOP_INTERVAL_MINUTES` | `180` | How often to check tracked YouTube channels |
| `TZ` | system | Timezone for log timestamps (e.g. `Europe/Oslo`) |
| `WEB_PORT` | `5000` | Flask listen port |

Loop intervals can also be changed from the UI without restarting.

---

## Volumes

| Path | Purpose |
|------|---------|
| `./data` | Databases, cookies, avatars, logs -- back this up |
| `./media` | Downloaded videos and photos |

---

## Migrating from tiktok-downloader

**Before starting:**
1. Stop the old container
2. Back up your data: `cp -r ./data ./data.backup && cp -r ./videos ./videos.backup`
3. Rename the videos folder: `mv videos media`

**Switch to social-downloader:**

4. Replace your `docker-compose.yml` with the one from this repo (the volume for `./media:/app/media` replaces the old `./videos:/app/videos`)
5. Start the new container: `docker compose up -d`

On first startup, the app automatically moves files from the old layout into the new one:
- `data/tiktok.db` and `data/cookies.txt` move into `data/tiktok/`
- `data/avatars/` moves into `data/tiktok/avatars/`
- `media/@username/` folders move into `media/tiktok/@username/`

**Fix database paths:**

6. Open the web UI, go to **Settings** (gear icon) > **Migration**
7. Click **Scan database** -- it detects the old `/app/videos` prefix automatically
8. The new prefix auto-fills as `/app/media/tiktok`; click **Rewrite paths**
9. Done -- existing videos play immediately without re-downloading

If the old docker-compose used `LOOP_INTERVAL_MINUTES`, the app still accepts it but logs a deprecation warning. Replace it with `TIKTOK_USER_LOOP_INTERVAL_MINUTES` and `TIKTOK_SOUND_LOOP_INTERVAL_MINUTES`.

---

## TikTok cookies

TikTok requires a valid session cookie. Upload `cookies.txt` from the **Settings > Cookies** panel. Export using the [Get cookies.txt LOCALLY](https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc) extension (Netscape format, must include `msToken`). Refresh cookies regularly -- stale cookies are the primary cause of bot detection.
