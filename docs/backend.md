# Backend module reference

Shared modules and the channel engine. Platform specifics live in [tiktok.md](tiktok.md) and [platforms.md](platforms.md).

## config.py

Global config; platform-specific config lives in the platform package.
- `DATA_DIR`, `MEDIA_DIR`, `WEB_PORT`, `APP_VERSION`, `THUMBNAIL_WORKERS`, `THUMBNAIL_USE_GPU`
- `platform_enabled(platform)` / `get_disabled_platforms()` / `save_disabled_platforms(set)`: the on/off store (`DATA_DIR/platforms.json`, atomic writes, read per call so toggles apply without a restart)
- `_ts() -> str`: local time as `"YYYY-MM-DD HH:MM:SS"`, the canonical timestamp helper

## cookies.py

Netscape cookies.txt storage, one file per platform at `DATA_DIR/{platform}/cookies.txt`, with an explicit timestamp file (st_mtime is unreliable on Docker volume mounts and resets to container start).
- `cookies_path` / `cookies_info` / `save_cookies` / `delete_cookies` / `get_cookies_flat`, all `(platform, ...)`
- `save_cookies_netscape(platform, cookies)`: writes Playwright `context.cookies()` dicts as cookies.txt and stamps the time; used by the TikTok QR login export
- `register_cookie_routes(bp, platform, on_change=None)`: GET/POST/DELETE `/cookies` on a platform blueprint. `on_change` runs after every upload or delete so the platform can rebuild in-memory state; returning an error string from it rejects the upload (file removed, 400)
- `platforms/tiktok/config.py` keeps thin wrappers with the old `get_cookies_flat()` / `cookies_info()` signatures

Frontend counterpart in common.js: `_cookiesRender` / `_cookiesLoad` / `_cookiesUpload` / `_cookiesDelete(platform, idPrefix)`, driving any panel whose ids follow `{idPrefix}Pill`, `{idPrefix}PillText`, `{idPrefix}Meta`, `{idPrefix}DeleteBtn`.

## downloader.py

**`download_video(*, video_id, username, platform, ...) -> dict | None`**
- One `ydl.extract_info(url, download=True)` captures the info dict and downloads
- Returns `{"file_path", "ytdlp_data", "upload_date"}` or None. `upload_date` comes from the full info dict (`upload_date` YYYYMMDD, then `timestamp`); callers use it when pre-download metadata had no date (YouTube Shorts from flat extraction)
- Embeds metadata via the FFmpegMetadata postprocessor; sets file mtime to upload_date
- Output: `MEDIA_DIR/{platform}/@{username}/{video_id}.ext`

**`download_photos(*, video_id, username, image_urls, upload_date) -> str | None`**: TikTok photo posts (yt-dlp returns audio only). Downloads via requests, converts to AVIF, keeps .jpg if the encode fails. Returns the first image path.

**`rename_creator_folder(platform, old_username, new_username) -> bool`**: renames `@old` to `@new`, merging if the target exists.

**`download_story`**: see the story gotcha in [gotchas.md](gotchas.md).

`from __future__ import annotations` is present here: it defers annotation evaluation so `str | None` works on Python < 3.10.

## transcoder.py

Background AV1 transcode job (Settings > General > Jobs). Re-encodes large mp4 files to SVT-AV1 10-bit + Opus, one file at a time under `nice 19` with an `lp` thread cap. Settings in `data/transcode.json` (read per call: `enabled`, `paused`, `min_size_mb`, `crf`, `preset`, `audio_bitrate_kbps`, `threads`, `verify_vmaf`, VMAF floors); queue and history in `data/transcode.db` (`transcodes` table, one row per path, status pending/encoding/verifying/swap_pending/done/failed/skipped). The queue DB is derived state: a lost DB is rebuilt by a Backfill scan.

- **`start()`**: init + crash recovery (mid-flight rows back to pending, their temp files removed) + the worker thread. Called from main.py before the loop threads so downloads can enqueue
- **`maybe_enqueue(path)`**: post-download hook, called from downloader.py (videos, video stories) and the Twitter/Instagram/OnlyFans `download_post_media`. Filters on `enabled`, `.mp4`, and `min_size_mb`; never raises. Re-enqueues done/skipped rows (a re-downloaded file is H.264 again); failed rows stay failed until Retry failed
- **`start_backfill()`**: walks MEDIA_DIR in a thread and INSERT OR IGNOREs every qualifying mp4; largest files dequeue first
- **Per-file gates**, all of which must pass before the original is touched: ffmpeg exit 0, output strictly smaller, container duration within 1 s, full-file VMAF above the mean and per-frame-minimum floors. Failures keep the original and record the reason
- **Swap**: encode goes to `.transcode-{name}` next to the original (same filesystem), mtime copied over (it carries the upload date), then one atomic `os.replace`. The `videos` schema stores only path/duration/width/height, all unchanged by a swap, so no DB follow-up is needed
- **Playback deferral**: the engine's file/story routes call `mark_served(path)` on every range request; a finished transcode whose file was served within the last 60 s parks as `swap_pending` and the worker moves on, retrying between queue items. Without this, a swap mid-playback would feed the player ranges from a different file (each range request reopens the path)
- **`FFMPEG`/`FFPROBE`**: `TRANSCODE_FFMPEG` env, else the image's static build at `/opt/ffmpeg/ffmpeg` (Bookworm's ffmpeg has SVT-AV1 1.4 and no libvmaf), else system ffmpeg. `vmaf_available()` is checked once; with verification on and no libvmaf the worker refuses to run and says so in the panel
- **`get_status()`**: settings, current file (phase/pct/speed from `-progress`), counts per status, bytes saved, last 10 finished rows; polled by the General Jobs pane via `/api/transcode/status`

## photo_converter.py

**`encode_avif(src, dst, crf) -> bool`**: FFmpeg `libaom-av1 -still-picture 1 -crf {crf} -b:v 0 -cpu-used 6`, writes `dst + ".tmp"` then renames. Always pass `-f avif` explicitly (see [gotchas.md](gotchas.md)). CRF: `CRF_PHOTO = 28`, `CRF_THUMB = 38`, `CRF_AVATAR = 30`. Startup thread has an 8 s delay so `init_db()` finishes first.

## thumbnailer.py

**`generate_thumbnail(video_id, file_path) -> str | None`**: 360px-wide AVIF via `libaom-av1 -still-picture 1`; thumbs dir derived from file_path. Seeks to 1 s for video, scales directly for images. `-hwaccel cuda` on decode when `THUMBNAIL_USE_GPU`. Skips silently if any thumbnail exists. Encodes to `{path}.tmp` and renames, so an interrupted encode leaves no partial file at the final path.

**`cache_avatar(creator_id, avatar_url, platform="tiktok", db_obj=None) -> "changed" | "unchanged" | False`**: downloads the source, compares md5 via the `.avif.src.md5` sidecar, then SSIM (see the avatar gotcha), converts to AVIF only on a real change. Archives the old file as `{creator_id}_{timestamp}.avif` and records profile_history. Re-downloads every run (CDN URLs expire). Every caller must pass the platform's ChannelDB as `db_obj` (returns False otherwise).

**`cache_banner(channel_id, banner_url, platform, db_obj=None) -> bool`**: same path into `DATA_DIR/{platform}/banners/`; sets `banner_cached`.

**`avatar_thumb(platform, creator_id) -> str | None`**: 96px variant for the 20-48px UI avatars, generated lazily on first `?size=thumb` and regenerated when the full avatar is newer. Encodes capped by a semaphore (4) since a page load can request dozens. No backfill: thumbs exist only for requested avatars.

**`repair_broken_thumbnails() -> dict`** / **`get_repair_state()`**: back the Fix broken thumbnails job. Scans every platform's `thumbs/*.avif` and regenerates undecodable ones. Two header-only detectors (no ffprobe): `_colr_reserved(path)` reads the `colr` nclx box for reserved CICP (0 and 3 only), `_avif_truncated(path)` walks top-level ISOBMFF boxes and flags files whose boxes do not cover the file size.

The thumbnail backfill scan covers every engine DB in the registry.

## engine/

One `ChannelEngine` per platform, built from a `ChannelAdapter`, held in `platforms/registry.py` `ENGINES`. Engines are fully isolated: separate SQLite files, loop state, run queues, worker threads, log buffers. main.py starts one scheduler thread per engine; web.py registers one blueprint per engine.

**`ChannelGoneError`**: adapters raise it from `fetch_profile` when the platform definitively reports the account gone (banned, suspended, terminated, deleted), matched against a narrow per-adapter `_GONE_MARKERS`. Transient errors must never map to it. YouTube fetches by stable channel ID so a rename never matches; Twitter, Instagram, and OnlyFans look up by handle, so a rename reads as gone until corrected or the account returns (the ban then clears itself).

### ChannelAdapter (dataclass)

The whole per-platform surface:
- Identity: `platform`, `label`, `prefix`, `creator_noun`, `item_noun`
- Flags: `quick_limit` (posts a quick check fetches; None = everything, e.g. YouTube flat extraction), `has_banner`, `has_stories`
- Hooks: `normalize_handle(raw)`, `lookup_profile(handle)` (add flow), `fetch_profile(channel)` (loop flow), `iter_posts(channel_id)` yielding `(post_dict, raw_post)`, `download_item(engine, channel_id, handle, display_name, vid_id, post, raw, log)` (the full download-and-record sequence, including thumbnail generation; DB ordering is per platform: Twitter/Instagram/OnlyFans record the row before downloading, YouTube only after a successful download)
- `register_extra_routes(bp, engine)`: platform-only routes
- Overrides: `process_session` / `process_single` (TikTok routes its own tracker through these), `init_db_extra` (extra tables/indexes), `extend_status`, `extra_settings` / `on_settings_changed`, `on_large_deletion`
- `fetch_stories(engine, channel)` returns story dicts `{story_id, content_type, posted_at, expires_at, media_url, headers?}`; the generic tracker fetches per check and `engine.tracker.save_new_stories` downloads new ones into `media/{platform}/@handle/stories/` and records them in the shared `stories` table (expires_at drives the live state; expired stories keep files and rows; viewed_at comes from the story viewer). Platforms with a session override (TikTok) call save_new_stories from their own tracker (`_check_user_stories`, which never raises so a story failure cannot fail a user check or trip bot recovery)

### engine/database.py

`ChannelDB(platform)`, method names matching the old per-platform modules. Tables: `channels`, `videos`, `profile_history`, `stories`, `settings`, `add_queue`, `channel_stats_history`, `channel_connections`. Full column list in [tiktok.md](tiktok.md) (the shared schema plus TikTok's extras).

- `add_queue`: one row per attempt keyed by handle, status pending/ok/error, error_kind shorthand plus error_detail; a retry via `add_queue_set_pending` flips the newest unresolved row back to pending instead of inserting; seeded from existing channels by added_at when empty
- `_migrate_db` adds the domain model columns `account_status` (default 'active'), `banned_at`, `privacy_status`, `viewer_relations`, `channels.bookmarked`, `videos.direct_added`. init_db repairs the starred-implies-bookmarked invariant on every launch and backfills a synthetic to-banned profile_history row at banned_at for channels whose ban predates the July 2026 transition-recording fix (idempotent via NOT EXISTS)
- Ban helpers mirror the TikTok store: `set_account_status` (banned stamps `banned_at` via COALESCE and records every transition in profile_history; `get_activity_feed` hides to-banned rows, `field = 'account_status' AND old_value != 'banned'`, since its own banned event covers them), `ban_channel_videos`, `restore_banned_videos`, `touch_last_checked`
- `get_video_id_sets(channel_id) -> (known_ids, active_ids, pending_ids)`; direct_added videos stay in known_ids but out of active/pending, so listing diffs never flag them
- `record_stats_snapshot(channel_id, subscriber_count, following_count, video_count)`: appends to channel_stats_history after every successful profile fetch. One row per creator per local day, same-day upsert with COALESCE so a sparse fetch never wipes earlier values; saved_count derived from videos at write time; a fetch with no stats records nothing. `get_stats_history` reads oldest first. The numeric columns on `channels` stay latest-only; this table is the only time series
- `channel_connections`: two-way links (a person's second account), one row per pair stored `channel_a < channel_b`; accessors take either side; `remove_channel` drops the links
- Also `record_profile_change`, `get_recent_activity`, `get_saved_history`, `backfill_upload_dates()`, `vacuum()` (raw connect, outside any transaction), `mark_video_deleted` (pending_deletion_since counter model, engine platforms only)
- `get_db()` commits on exit, rolls back on exception, and tracks written tables via a sqlite authorizer feeding the SSE stream's per-table versions (`tables_version()`)

### engine/loop.py

`ChannelLoop(engine)`. Loop state dict + logs deque (maxlen 1000), trigger event and scope, reschedule flag, manual-run queue with its own worker, `run_loop(channels_due, manual)` dispatching to the adapter's `process_session` or the generic tracker. The `_work_lock` makes sessions and manual runs mutually exclusive: `run_loop` holds it for the session, the worker holds it per run and stands down while a session runs. The queue is exposed through `pop_manual_run()` and `finish_manual_run(channel, profile_only, mode, error)`, used by the worker and by the trackers' between-creator drains (`engine.tracker.drain_manual_runs`, TikTok `_drain_manual_runs_inline`). Also owns `schedule_midpoint_run`.

State keys: running, manual_run, sleep_until, sleep_next, last_run_start, current_run_start, last_run_end, last_run_duration_secs, last_new_videos, last_session_completed, last_session_total, next_run, current_channel, current_stage, sessions_today, logs. `current_stage` is what the check is doing right now ("fetching videos", "downloading video 2 of 5"), set by the trackers via `_set_stage` and shown in the now strip; a new current_channel resets it. The SoundLoop has an equivalent `stage` (`sound_loop_stage`).

Persisted to `data/{platform}/loop_state.json` with crash recovery: a lingering current_run_start is promoted on load, an atexit save writes the in-progress duration, and `recover_state_from_db` infers last_run_end from `MAX(last_checked)`. A legacy TikTok state file with `user_`-prefixed keys is still read.

Reschedule pattern: `reschedule_loop()` sets a flag and fires the trigger event; the scheduler calls `check_and_clear_reschedule()` after waking and `continue`s to re-read the interval, which must happen before the manual-trigger path.

### engine/tracker.py

`process_all_channels(engine, ...)` / `process_single_channel(engine, ...)`. Quick/full cadence, deletion spike guard, `_CONFIRM_THRESHOLD = 2`, 3-failure session abort, profile change detection (falsy fetched fields count as missing, not changes), avatar/banner caching with the engine db as `db_obj`. Ban lifecycle: a `ChannelGoneError` marks the channel banned and its active videos deleted with reason user_banned; a later successful fetch restores them, re-enables tracking, and sets status active; 14+ consecutive banned days disable tracking once. Transient fetch errors only log. Also `scan_afflicted_stories` / `purge_afflicted_stories` (story recovery).

### engine/web.py

`create_channel_blueprint(engine)`: every `/api/{platform}/*` route plus the adapter's extras. See [api-routes.md](api-routes.md).

## web.py

Global Flask app. Registers one blueprint per platform from `ENGINES` via `engine.create_blueprint()`; TikTok's extras land on its engine blueprint through the adapter.

Global routes: `GET /`, `GET /api/health`, `GET /api/platforms`, `PATCH /api/platforms/<id>`, `GET /api/migrate/preview`, `POST /api/migrate`, `/api/transcode/*`, `/api/jobs/*` (the app-wide maintenance jobs behind Settings > General > Jobs: photo converter, thumbnail repair, audio cleanup with its state and worker defined here, clear-thumbnails; they live on the app rather than a blueprint because a disabled platform's blueprint 403s), `GET/PATCH /api/auth/config`, `GET /assets/<path>`. `GET /` renders index.html with the platform list (tabs, sections, and script tags for enabled platforms; the full list injected as `window.__PLATFORMS__`). `after_request` sets the security headers and the vendored font cache header (the hashed-asset map cannot rewrite URLs inside CSS).

## auth.py

Blueprint for OAuth2/OIDC via Authlib `flask_client`, registered at `/` in `create_app()`. Design decisions in [gotchas.md](gotchas.md).
- `init_oauth(app)` registers the OIDC client from `oauth.json`'s `discovery_url`; no-op when disabled
- `_safe_next(next_url)` rejects any value with a scheme or netloc; only `/`-paths that are not auth routes pass
- `GET /login`: generates PKCE verifier and state, stores them in session, redirects to the provider
- `GET /auth/callback`: validates state, exchanges the code, validates the ID token, `session.clear()` (fixation), stores identity and raw ID token, redirects to `next` or `/`
- `GET /logout`: clears the session, redirects to the provider `end_session_endpoint` with `id_token_hint`, falls back to `/`
