# Cross-cutting decisions and gotchas

Platform-specific ones live in [tiktok.md](tiktok.md) and [platforms.md](platforms.md).

## Platform enable/disable: live gates, not thread lifecycle

Disabling a platform must stop everything immediately, but no thread is killed or restarted: every long-lived worker checks `config.platform_enabled(platform)` at its next decision point. The gates: `run_session_scheduler` and the TikTok sound scheduler skip sessions AND manual triggers while disabled (slots are still consumed so re-enabling resumes the cadence), the ChannelLoop and SoundLoop manual-run workers park queued runs, the add worker parks pending lookups, and a `before_request` on each blueprint 403s every `/api/{p}/*` route. The PATCH route also fires `request_stop()` so an in-flight session ends at its next safe point. Re-enabling is just the flag flip. Frontend: index.html renders tabs, sections, and script tags only for enabled platforms, so a toggle reloads the page instead of tearing a live app down, and a disabled platform ships zero JS.

## Avatar change detection: SSIM confirm against CDN encode variance

Google's avatar CDN keeps byte-different encodes of the same picture on different edge caches: the same URL seconds apart returns identical bytes, but checks hours apart flip between variants (seen on YouTube as a false "avatar changed" every session). Source-hash comparison alone cannot decide a change, and a two-strike confirm (same new hash twice in a row) reduced but did not eliminate it, since one edge can answer twice and a session plus a manual run land close together.

`cache_avatar` now decides visually: the md5 in the `.avif.src.md5` sidecar is the fast path for the unchanged case, and a download with a different hash is decoded and compared against the cached avatar by `_ssim_same_picture` (both scaled to 64x64 grayscale, ffmpeg SSIM, same picture at >= 0.95; re-encode variants score ~0.99). Same picture: the new hash becomes the sidecar's current hash so repeats fast-path, no re-encode, no archive. Visually different, or the comparison itself fails: recorded and archived as before. Sidecars from the retired two-strike scheme may carry a pending hash on line 2; only the first token is read.

The `avatar-history/<filename>` route exists in both platforms/tiktok/web.py (numeric IDs) and engine/web.py (alphanumeric channel IDs). The engine one was missing until July 2026, which rendered blank OLD/NEW images on YouTube.

## Thumbnails: HEVC reserved colour primaries (FFmpeg 7)

Two distinct problems from TikTok's HEVC sources carrying reserved/unspecified CICP tags. Do not conflate them.

1. **Input decode error.** FFmpeg 7 `buffersrc` sometimes rejects `reserved/reserved` primaries with "Invalid color space". `generate_thumbnail()` tries once without a BSF and on that specific error retries with a metadata bitstream filter before `-i` (patching the input before the decoder reads it): `-bsf:v hevc_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1`, or `h264_metadata=...` for H.264. For this problem `-color_primaries bt709` before `-i`, `setparams`, and `zscale` did NOT work.
2. **Output AVIF unreadable by Firefox.** More common and separate: the encode succeeds (exit 0) but writes the source's reserved CICP into the output's `colr` nclx box. Firefox then refuses the AVIF and renders a 0x0 blank (`naturalWidth === 0`) while Chrome tolerates it, which is why thumbnails looked "missing" only in Firefox despite being valid to ffprobe and served 200/304. Fix: stamp BT.709 on the OUTPUT frame in the filter graph, `...,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709` in `generate_thumbnail` and the same `-vf` in `photo_converter.encode_avif`. It must be `setparams` in the chain, not the output `-color_*` flags, which only reliably set primaries. Reserved is displayed as BT.709 anyway, so this is lossless. Detect a bad file by reading its `colr` nclx CICP bytes (`thumbnailer._colr_reserved`, header read, no ffprobe): only reserved code points **0 and 3** are invalid. Do NOT flag **2 (unspecified)**: it is valid, Firefox renders it, and it is the default for untagged sources, so flagging it made the repair job regenerate the whole library.

Repair for files already on disk: the Fix broken thumbnails job (Settings > General > Jobs, `thumbnail-repair`) scans every platform's `thumbs/*.avif` and regenerates the bad ones. The backfill cannot do this (it is an existence check and these files exist).

A third failure class, distinct from both: a truncated thumbnail from an interrupted write. `generate_thumbnail` used to encode straight to the final path, so a crash mid-encode left a partial AVIF that exists (backfill skips it), carries no reserved tags (the old repair scan skipped it), but decodes in no browser. Fixed on both sides: it now encodes to `{path}.tmp` and renames, and the repair job flags structural truncation via `_avif_truncated` (top-level ISOBMFF box walk against file size, header-only).

## encode_avif: always pass `-f avif`

Without it ffmpeg fails on `dst + ".tmp"` because it cannot infer the container from the extension. This caused 100% failure of an initial 10,216-file conversion run.

## AVIF for images, AV1 only for large H.264 files

Blanket AV1/WebM video re-encoding was evaluated and abandoned early: TikTok delivers HEVC, nearly as efficient as AV1, and a test encode came out 3x larger. That conclusion does NOT hold for the long H.264 livestream VODs (OnlyFans and similar): those come from real-time encoders at ~6 Mbps and shrink 50-90% at visually transparent quality (VMAF-calibrated), which is what the AV1 transcode job (transcoder.py, Settings > General > Jobs) exists for. Its size threshold is what separates the two regimes; do not point it at small HEVC-sourced clips expecting wins. JPEG to AVIF remains the image-side win (50-70% smaller). Thumbnails are AVIF-first with a JPEG fallback: `_thumb_exists()` checks both extensions so the backfill does not regenerate over an existing `.jpg`, and the web endpoint tries `.avif` then `.jpg`.

## AV1 transcode: swap deferral and the second ffmpeg

Two decisions in transcoder.py that look odd without context:

- **The swap is deferred, not locked.** On Linux, replacing a file mid-playback is safe at the filesystem level, but the viewer streams via HTTP range requests and every request reopens the path, so a swap mid-stream would serve ranges from a byte-incompatible file. Instead of blocking (a 60-minute VOD opened right after download would stall the queue for an hour), the media routes stamp `mark_served` on every serve and the worker parks a finished transcode as `swap_pending` when its file was served within the last 60 s, moving on to the next file and retrying the swap between items. If a swap ever races a stream anyway, the ETag changes with the file size, `If-Range` stops validating, and the browser re-fetches instead of corrupting playback.
- **The job uses `/opt/ffmpeg/ffmpeg`, not the system ffmpeg.** Bookworm's package has SVT-AV1 1.4 (2022, far worse quality-per-bit) and no libvmaf, so the encode recipe and the verification gate both need the static BtbN build baked into the image. Do not switch the rest of the app to it: the in-app browser viewer depends on x11grab, which static builds do not reliably carry. With VMAF verification on and an ffmpeg without libvmaf (e.g. local dev), the worker deliberately refuses to process and says so in the panel rather than silently skipping the quality gate.

Encoder settings (CRF 22, preset 4, 10-bit, tune=0, Opus 96k) were calibrated against VMAF on real archive samples in July 2026: mean 97+ with per-frame minimum 94+ on both a 720p landscape VOD and a 1080x1920 portrait VOD. The per-frame minimum floor ships at 85, not 94, because hour-long files hit scene cuts and near-black frames that score low without being visible defects; the mean floor of 96 is the real gate.

## yt-dlp downloads send a Chrome user agent

On 2026-08-10 TikTok started rejecting yt-dlp's default UA on the video webpage endpoint: every download died instantly with "Unexpected response from webpage request" while listings, scrapes, and the browser session kept working (yt-dlp issue 17403; no fixed release existed at the time). `download_video` pins a current Chrome UA in `http_headers` for all platforms; it is what TikTok's heuristic checks and is harmless elsewhere. If downloads break again with that error, refresh the UA string to a current Chrome version before digging deeper.

## Story downloads: validation and quarantine

Story CDN URLs are pre-signed and reused outside the browser, so downloads fail in varied ways (403, truncated transfer, garbage body). `downloader.download_story` tries yt-dlp on the story page first for videos (self-consistent client), then each direct CDN URL candidate; every video is ffprobe-gated (`_probe_media_file`, requires a decodable video stream) on BOTH paths, since unchecked yt-dlp output was the source of corrupt files slipping through. A rejected download is not just deleted: `_quarantine_story` writes the bytes plus a JSON trace (url/host, status, Content-Length vs bytes received, content-type, magic bytes, ffprobe reason) to `data/story_debug`, bounded to the most recent failures.

To diagnose a corruption report, read those traces: `transfer: short read` or an IncompleteRead means the transfer was cut off (network, proxy, timeout); `size ok` with a `<!DOC` or `{"` head means the CDN served an error page; a truncated ftyp magic means a genuinely bad video body. TikTok story recovery is in [tiktok.md](tiktok.md).

## OAuth / OIDC

- **Config storage:** `DATA_DIR/oauth.json` (client id, secret, discovery URL, enabled flag, session lifetime), written by Settings > General > Access. The Flask secret key is generated on first startup into `DATA_DIR/.secret_key`. Neither needs user management beyond the UI
- **Restart on change:** `create_app()` reads oauth.json once and captures the values in closure scope, so UI changes take effect after a container restart. The UI shows a persistent restart-required banner and detects saved-vs-running drift (`enabled` vs `enabled_runtime` from `GET /api/auth/config`)
- **Escape hatch:** `OAUTH_FORCE_DISABLE=true` bypasses `_require_auth` without touching oauth.json, for when the provider is down and you are locked out. The UI surfaces a prominent banner
- **Library:** Authlib `flask_client` handles state, nonce, PKCE verifier, and ID token signature/issuer/audience/expiry validation. Do not bypass or hand-verify tokens
- **PKCE:** `code_challenge_method='S256'`, so an intercepted authorization code is useless
- **Server-side sessions:** flask-session filesystem backend in `DATA_DIR/sessions/`, always initialized whether or not OAuth is on, so enabling it needs no code-path change. Only a session ID is in the cookie, so logout is a true invalidation (client-side Flask sessions cannot be revoked)
- **Session fixation:** `session.clear()` in `/auth/callback` before writing the identity discards the pre-login session ID
- **Open redirect:** `_safe_next()` rejects any `next` with a scheme or netloc (`https://evil.com`, `//evil.com`, `javascript:`)
- **Front-channel logout:** `/logout` calls the provider `end_session_endpoint` with the raw `id_token_hint` from the server-side session, so the provider invalidates its own session. If unavailable the local session is still cleared
- **Security headers** via `after_request`: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Content-Security-Policy` (includes `form-action 'self'`, which does not fall back to `default-src`), `Cache-Control: no-store` (skipped on hashed assets with their own immutable header), and `X-Powered-By` removal. `Strict-Transport-Security` only when OAuth is enabled, so HSTS never pins a non-TLS dev setup
- **ProxyFix** `x_proto=1, x_host=1` trusts exactly one upstream (Caddy) so `url_for(_external=True)` builds https redirect URIs; trusting more would allow header spoofing
- **Unauthenticated by design:** static assets (no sensitive data, must load before the login redirect), `/api/health` (uptime monitors), and `GET /api/auth/config` (the Settings form must populate before or without a session; PATCH is protected)
- **Polling 401:** `apiJSON` redirects to `/login` on any 401, otherwise an expired session just spams error toasts. `_loginRedirectPending` ensures only the first concurrent 401 redirects, so OAuth state is not overwritten

## raw_video_data vs ytdlp_data

- TikTok: `raw_video_data` from the `get_video_details()` page scrape, stored at first-seen, includes stats, music, hashtags, CDN URLs stripped. `ytdlp_data` from `extract_info`, stored on download completion, NULL for photo posts
- YouTube: `raw_video_data` is the full flat extraction entry minus formats/thumbnails/postprocessors, stored when first seen and downloaded. `ytdlp_data` from `extract_info` during download

Both are excluded from the video list API responses: `get_videos_for_channel` and `get_videos_for_user` use explicit column lists, not `SELECT *`. `ytdlp_data` averages 336 KB per YouTube video, so a 600-video channel would force SQLite to read ~200 MB off disk just for Python to discard it.

## send_file and relative paths: app.root_path vs CWD

Flask's `send_file` resolves relative paths against `app.root_path` (`/app/app`), not `os.getcwd()` (`/app`). TikTok downloads made before the `os.path.abspath` fix in config.py stored paths like `./media/tiktok/@user/video.mp4`: `os.path.exists()` passed (CWD) but `send_file` 404'd. Fix: `get_video()` normalizes `file_path` to absolute before returning, so every caller gets a correct path.

## Event loop closure noise

After `asyncio.run()` returns, Playwright's `BaseSubprocessTransport` objects call `loop.call_soon()` in `__del__` and raise `RuntimeError: Event loop is closed`. main.py suppresses that specific error via `sys.unraisablehook`; everything else passes through.

## Page grids and min-content: cap the tracks with min-width

`.app` and `.platform-section` are single-column CSS grids. An auto track is sized by the widest child's min-content and every child then stretches to it, so one non-wrapping element (a toolbar row, a long add-bar input) silently widens the page past the viewport. `.app > *, .platform-section > * { min-width: 0 }` caps the tracks; inner flex rows then handle their own shrinking. Both layers need the rule: fixing only `.app` still lets the platform-section track grow.

Related: mobile CSS must target classes the engine generator emits (`.tracking-tab-row`, `.tracking-search`, `.modal-header`, `.modal-video-list`), never static per-platform ids. The engine fold-in left `#trackingSearch` and `#modalHeader` rules matching nothing, breaking the mobile layout with no error.

## A modal `<dialog>` makes the whole page inert, top layer included

Painting above an open modal dialog and being clickable over it are two different problems, and the top layer only solves the first. `showModal()` marks every element that is not a descendant of the dialog as inert, and an inert element is not hit-tested: the click passes through to whatever is behind it. Promoting an element into the top layer changes paint order, not inertness.

That is why the toast container is a popover **and** reparented onto the innermost open dialog (`_hostToasts`, plus the `_dlgOpenStack` maintained by `_dlgOpen` / `_dlgDrop`). As a body child it painted above the modal but swallowed no clicks, so clicking a toast's X hit the dialog element behind it, and since the dialog is its own backdrop the modal closed instead. Being a DOM descendant of the dialog takes it out of the inert subtree; staying a popover keeps it in the top layer, so it still paints above that dialog's content and escapes the overlay fade-in and any clipping. Popover type (`auto` vs `manual`) makes no difference here; only the DOM parent does.

Anything else that must be clickable over a modal needs the same treatment. The `.dd` / `.m-dd` menus are already fine because their markup sits inside the modal; `_openCardMenu` builds its menu and appends it to `document.body`, so it is subject to this.

Reparenting reinserts the moved subtree, which replays any CSS animation declared on it. That is why `toast-in` lives on a one-shot `.toast.entering` class instead of on `.toast`: otherwise every dialog open slid the visible toasts in again.

## DB indexes on migrated columns go in `_migrate_db`

A `CREATE INDEX` in `executescript` that references a migration-added column fails with "no such column". Create it inside `_migrate_db()` after the relevant `ALTER TABLE`.

## Database cleanup step ordering

1. Orphaned DB records first, so subsequent file scans are accurate
2. Thumbnail scan
3. Avatar scan (TikTok cleanup only; engine cleanup has no avatar step)
4. VACUUM last, to maximise reclaimed space

Video files on disk are never touched: this is an archiving tool.

## Consecutive-creator grouping: raw-row pagination

"Recently Saved" groups consecutive same-creator rows server-side by scanning `_GROUP_SCAN = 2500` raw rows. `offset` is a raw-row offset, not a group offset; the frontend advances by `rows_consumed` and stitches boundary groups client-side. A group breaks when the gap between two adjacent rows exceeds 5 minutes, even for the same creator. Each row is compared to its immediate predecessor, not the group anchor, so a chain of sub-5-minute gaps stays in one group even if the first and last rows are far apart.
