# social-downloader

Self-hosted social media archiver. Monitors creators across multiple platforms, detects new, deleted, and restored content each loop cycle, and downloads it with embedded metadata. Managed from a browser-based UI.

**Platform support:**
- TikTok: users, sounds, and stories (sign in with a QR code from the UI)
- YouTube: channels
- Twitter/X: accounts (requires an uploaded cookies.txt from a logged-in account)
- Instagram: profiles and stories (requires an uploaded cookies.txt from a logged-in browser session)

---

## Running

```
docker compose up -d
```

Open [http://localhost:5000](http://localhost:5000).

The app binds to `127.0.0.1:5000` by default. Put a reverse proxy (Caddy, nginx) in front if you want it on a domain.

---

## Configuration

Key environment variables (set in `docker-compose.yml`). The scheduling variables exist per platform; replace `{P}` with `TIKTOK`, `YOUTUBE`, `TWITTER`, or `INSTAGRAM`:

| Variable | Default | Description |
|----------|---------|-------------|
| `{P}_SESSIONS_PER_DAY` | `4` | Check sessions per 24-hour window; fire times are randomised within each segment |
| `{P}_HIGH_PRIORITY_CHECK_HOURS` | `6` | Check interval for starred creators (hours) |
| `{P}_ACTIVE_CHECK_HOURS` | `24` | Check interval for active creators (posted within 30 days) |
| `{P}_INACTIVE_CHECK_HOURS` | `72` | Check interval for inactive creators |
| `{P}_FULL_REFRESH_DAYS` | `7` | Days between full deletion-detecting checks per creator |
| `TIKTOK_SOUND_LOOP_INTERVAL_MINUTES` | `60` | How often to check tracked TikTok sounds |
| `TZ` | system | Timezone for log timestamps (e.g. `Europe/Oslo`) |
| `WEB_PORT` | `5000` | Flask listen port |

All loop settings can also be changed from the UI without restarting; the UI value wins over the env var.

---

## Volumes

| Path | Purpose |
|------|---------|
| `./data` | Databases, cookies, avatars, logs; back this up |
| `./media` | Downloaded videos and photos |

---

## Signing in

**TikTok:** Settings > Accounts > TikTok has a QR code sign-in. Scan it with the TikTok app on your phone; the session is created inside the app's own browser profile, so it carries the right fingerprint from birth. The Reset session button signs out fully by deleting both the cookies and the browser identity, which is also the recovery move when TikTok has flagged the current identity.

**Twitter and Instagram:** upload a `cookies.txt` exported from a logged-in browser session under Settings > Accounts, using the [Get cookies.txt LOCALLY](https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc) extension (Netscape format). The Instagram file must include the `sessionid` and `csrftoken` cookies.

**YouTube:** no sign-in needed.

---

## TikTok VPN / proxy (optional)

Settings > Network can route all TikTok traffic (browser, page fetches, downloads) through a proxy while the web UI and the other platforms stay on the server's own connection. Two modes: any HTTP proxy address, or a [gluetun](https://github.com/qdm12/gluetun) VPN sidecar. For gluetun, add a service named exactly `gluetun` next to the app (the app targets its fixed address `http://gluetun:8888`):

```yaml
services:
  gluetun:
    image: qmcgaw/gluetun
    container_name: gluetun
    cap_add:
      - NET_ADMIN
    environment:
      - VPN_SERVICE_PROVIDER=custom
      - VPN_TYPE=wireguard
      - HTTPPROXY=on
    volumes:
      - ./data/gluetun:/gluetun
```

WireGuard credentials are managed in Settings > Network (paste your provider's config file and the fields fill in); the app writes a clean `wg0.conf` under `./data/gluetun/wireguard/`, which gluetun reads at its next container restart.

**Docker socket (optional):** uncommenting the `/var/run/docker.sock` volume line in `docker-compose.yml` lets the app offer a "Restart gluetun now" action after saving credentials, so new VPN credentials apply without shell access. Be aware of what this grants: the Docker socket gives the container full control of the Docker daemon, equivalent to root on the host. Leave it out unless you use the gluetun setup and accept that tradeoff.

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

6. Open the web UI, go to **Settings** (gear icon) > **Jobs** > **TikTok**
7. Click **Scan database** in the path migration card; it detects the old `/app/videos` prefix automatically
8. The new prefix auto-fills as `/app/media/tiktok`; click **Rewrite paths**
9. Done; existing videos play immediately without re-downloading

If the old docker-compose used `LOOP_INTERVAL_MINUTES`, the app still accepts it but logs a deprecation warning. Replace it with `TIKTOK_USER_LOOP_INTERVAL_MINUTES` and `TIKTOK_SOUND_LOOP_INTERVAL_MINUTES`.
