# social-downloader

Self-hosted social media archiver. Monitors creators across multiple platforms, detects new, deleted, and restored content each loop cycle, and downloads it with embedded metadata. Managed from a browser-based UI.

**Platform support:**
- TikTok: users and sounds
- YouTube: channels
- X/Twitter: accounts (requires an uploaded cookies.txt from a logged-in account)
- Instagram: profiles (built, currently untested)

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
| `{PLATFORM}_SESSIONS_PER_DAY` | `4` | Check sessions per 24-hour window; fire times are randomised within each segment. `{PLATFORM}` is `TIKTOK`, `YOUTUBE`, `TWITTER`, or `INSTAGRAM` |
| `{PLATFORM}_HIGH_PRIORITY_CHECK_HOURS` | `6` | Check interval for starred creators (hours) |
| `{PLATFORM}_ACTIVE_CHECK_HOURS` | `24` | Check interval for active creators (posted within 30 days) |
| `{PLATFORM}_INACTIVE_CHECK_HOURS` | `72` | Check interval for inactive creators |
| `{PLATFORM}_FULL_REFRESH_DAYS` | `7` | Days between full deletion-detecting checks per creator (YouTube, Twitter, Instagram) |
| `TIKTOK_SOUND_LOOP_INTERVAL_MINUTES` | `60` | How often to check tracked TikTok sounds |
| `TZ` | system | Timezone for log timestamps (e.g. `Europe/Oslo`) |
| `WEB_PORT` | `5000` | Flask listen port |
| `OAUTH_FORCE_DISABLE` | `false` | Set `true` to bypass OAuth enforcement without changing the saved config; use when locked out due to OIDC provider failure |

All loop settings can also be changed from the UI without restarting.

---

## Authentication

Optional. Disabled by default; existing deployments need no changes.

To enable OAuth2/OIDC (tested with Authentik, works with any standard OIDC provider):

1. Create an OAuth2 provider in your OIDC provider with redirect URI `https://your-domain/auth/callback`
2. Open **Settings > Authentication** in the UI
3. Paste the Discovery URL from your provider (e.g. `https://authentik.example.com/application/o/app-name/.well-known/openid-configuration`)
4. Enter your Client ID and Client Secret
5. Enable authentication and save; the app must restart for the change to take effect

If you are locked out because the OIDC provider is unreachable, set `OAUTH_FORCE_DISABLE=true` in your environment and restart. Auth enforcement is bypassed without touching the saved config. Remove the variable and restart again to re-enable.

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

## Cookies

TikTok signs in with a QR code in **Settings > Accounts > TikTok**: generate a code, scan it with the TikTok app on your phone, and the session is created inside the app's own browser with the matching cookies file saved automatically. No password is ever entered or stored. The session is born with the browser fingerprint that uses it, which is what makes it resistant to bot detection. A cookies file exported from your desktop browser carries the wrong fingerprint, so the old upload flow was removed. The Reset session button signs out and discards the browser identity entirely. Use it before signing in again if TikTok has flagged the current one.

### Watching the TikTok browser (captchas)

If TikTok serves a rotate captcha or a verification wall, you can solve it by hand from the UI. Open **Settings > Accounts > TikTok** and click **Open browser view**. It shows a live view of the app's TikTok browser and forwards your mouse to it, so you can complete the challenge as if you were sitting at the machine. The view is black unless a session is running, since the browser only exists during checks, lookups, and logins: start a QR login or trigger a check first, then watch and interact.

The viewer rides the app's own web interface, so it needs no extra port and is protected by whatever authentication you already have in front of the app. It refreshes a few times a second rather than at full video rate, which is fine for the slow deliberate drag a captcha needs.

### Routing TikTok through a VPN (gluetun)

If TikTok rate limits or flags your server's IP, all TikTok traffic (the browser, page fetches, and downloads) can be routed through a proxy while the rest of the app, including the web UI and the other platforms, stays on your normal connection. **Settings > Network > TikTok** has two modes: **Gluetun VPN container** targets the gluetun sidecar below at its fixed address (`http://gluetun:8888`) and manages its WireGuard credentials in the same panel, while **Other proxy** takes any HTTP proxy address (a residential proxy, a phone sharing mobile data, or a gluetun container under a different name). Flip the routing toggle and it applies from the next browser session with no restart. The Test connection button verifies the path regardless of the toggle: it fetches the exit IP through the proxy, compares it with the server's own IP, and warns when they match (the proxy is reachable but not changing the address). The `TIKTOK_PROXY` env var seeds a custom proxy address for fresh installs.

The intended pairing is a [gluetun](https://github.com/qdm12/gluetun) container with its built-in HTTP proxy enabled, on the same Docker network as the app:

```yaml
services:
  gluetun:
    image: qmcgaw/gluetun:v3.40
    cap_add:
      - NET_ADMIN
    devices:
      - /dev/net/tun:/dev/net/tun
    volumes:
      - ./data/gluetun:/gluetun
    environment:
      - VPN_SERVICE_PROVIDER=custom
      - VPN_TYPE=wireguard
      - HTTPPROXY=on
    restart: unless-stopped
```

With that service in the app's docker-compose.yml (or both containers on one shared network), gluetun mode reaches it automatically; the service must be named `gluetun` for the fixed address to resolve. The proxy port never needs to be published on the host; the app reaches it over the Docker network.

With `VPN_SERVICE_PROVIDER=custom`, the WireGuard credentials do not go in the environment: gluetun reads a WireGuard config from `/gluetun/wireguard/wg0.conf` inside its volume. With the volume above (`./data/gluetun`, inside the app's data folder), the app manages that file for you from **Settings > Network > TikTok > WireGuard config**: four fields (private key, address, server public key, endpoint), or the **Paste full config** button, which takes the file your VPN provider gives you (ProtonVPN: account page > Downloads > WireGuard configuration) and fills the fields automatically. Only what gluetun needs is kept; comments and IPv6 entries are discarded (gluetun refuses IPv6 addresses on hosts without IPv6, a crash-loop this rules out). Gluetun only loads the config at startup, so restart the gluetun container after saving. Managing the file by hand at `data/gluetun/wireguard/wg0.conf` still works.

Generate a dedicated config for this container rather than reusing one from another gluetun instance; a WireGuard server keeps one session per key, so two tunnels on the same config kick each other off. If the app cannot reach the proxy, set `FIREWALL_OUTBOUND_SUBNETS` to the Docker network's subnet so gluetun's firewall allows replies to it.

Two caveats. VPN exit IPs are datacenter IPs, which TikTok tends to score worse than residential ones, so treat this as an escape hatch for a flagged home IP rather than a default. And the proxy changes what IP TikTok sees for an existing session, so expect extra scrutiny right after toggling; pairing a proxy change with **Reset session** and a fresh QR sign-in gives the new IP a clean identity.

X/Twitter requires a `cookies.txt` from a logged-in x.com session (must include `auth_token` and `ct0`), uploaded from the **Settings > Twitter** cookies panel. Profile lookups work without it, but timelines and downloads do not.

Instagram uses a username/password login from the **Settings > Instagram** panel instead of a cookies file; only the resulting session cookie is stored, never the password.
