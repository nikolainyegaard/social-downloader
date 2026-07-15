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

X/Twitter requires a `cookies.txt` from a logged-in x.com session (must include `auth_token` and `ct0`), uploaded from the **Settings > Twitter** cookies panel. Profile lookups work without it, but timelines and downloads do not.

Instagram uses a username/password login from the **Settings > Instagram** panel instead of a cookies file; only the resulting session cookie is stored, never the password.
