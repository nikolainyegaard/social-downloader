# Changelog

All notable changes to this project will be documented in this file.

Forked from [tiktok-downloader](https://github.com/nikolainyegaard/tiktok-downloader) at v1.25.0.

## [Unreleased]

### Fixed
- YouTube channel modal load time: `get_videos_for_channel` used `SELECT *`, forcing SQLite to read the full `ytdlp_data` blob (avg 336 KB/video, ~200 MB for a large channel) before Python discarded it; now uses an explicit column list that excludes both blob columns; same fix applied to `get_videos_for_user` on TikTok

### Changed
- YouTube video storage: `ytdlp_data` and `raw_video_data` TEXT blobs dropped from the videos table; replaced by 30+ dedicated columns (`description`, `tags`, `categories`, `fps`, `vcodec`, `acodec`, `filesize_approx`, `age_limit`, `channel_follower_count`, `availability`, `was_live`, `language`, `dynamic_range`, `chapters`, `timestamp`, `tbr`, `vbr`, `abr`, `asr`, `audio_channels`, `aspect_ratio`, `format`, `format_id`, `format_note`, `resolution`, `duration_string`, `channel_url`, `webpage_url`, `original_url`, `uploader_url`, `channel_name`, `uploader`, `uploader_id`, `channel_is_verified`); `automatic_captions`, `subtitles`, and `heatmap` discarded entirely (expired URL lists and analytics data with no app-level value); average per-video storage drops from ~336 KB to ~1-2 KB; existing data migrated automatically on first startup
- `get_videos_for_channel` reverted to `SELECT *` (no blob columns remain; explicit list no longer needed)
- `backfill_upload_dates` now reads from the dedicated `timestamp` column instead of parsing `ytdlp_data` JSON

### Changed
- Shared JS helpers consolidated into `common.js`: `apiJSON`, `fmt`, `fmtCount`, date formatters, `_videoStatus`, `_trackingBadge`, scroll lock, pill glider, `_makeJobWidget`, `_triggerLoop`, image modal helpers, shared icons, and the complete modal engine including `_renderModalVideoGrid` and `_appendModalGrid`; youtube.js no longer has an implicit runtime dependency on tiktok.js
- Creator action helpers extracted to `common.js` (`_creatorRun`, `_creatorRunProfile`, `_creatorRemove`, `_creatorToggleStar`, `_saveCreatorComment`, `_renderStatGrid`); platform files now contain thin one-line wrappers
- `ytClearLog` now persists the clear position across page reloads via `localStorage` (matching TikTok behaviour); previously the YouTube log would reset to showing all entries on page reload

### Added
- Card action menu (`•••` button) on TikTok user cards and YouTube channel cards: replaces the inline Remove button with a dropdown containing Remove and the new Run Profile action
- Run Profile action: fetches and updates profile info (avatar, display name, bio/description, subscriber count) without triggering a video fetch or download; available for both TikTok users and YouTube channels via `POST /api/tiktok/users/<id>/run-profile` and `POST /api/youtube/channels/<id>/run-profile`
- Toast notification system (`showToast` in `common.js`): reusable slide-in toasts with `success`, `warning`, `error`, and `info` types; optional action button and configurable auto-dismiss duration
- Migration warning toast: shown on page load when any TikTok video paths in the database do not match the current media directory; includes a button to open the Migration settings panel directly
- YouTube content type tracking (video/short/stream): stored in DB, shorts display with a distinct icon and badge in thumbnail cells
- YouTube channel modal: Videos grid (wide 16:9) and Shorts grid views, in addition to list view
- YouTube diagnostics panel in Settings: channel videos raw fetch and database query tool
- `/api/youtube/debug/channel-videos` and `/api/youtube/db/query` endpoints
- Settings modal reorganised into platform-aware tabs: TikTok, YouTube, Jobs, Diagnostics, Database; Jobs/Diagnostics/Database tabs have TikTok/YouTube sub-tabs
- README with setup, configuration, volumes, and migration guide
- `raw_channel_data TEXT` column on YouTube `channels` table: full yt-dlp channel info dict (minus thumbnails/entries/formats) stored on add and updated each loop
- `raw_video_data TEXT` column on YouTube `videos` table: full flat extraction entry stored on download
- `backfill_upload_dates()` in YouTube database: runs at loop start, patches NULL `upload_date` rows from stored `ytdlp_data`; self-heals across one loop cycle
- `fmtDateOnly` date formatter and `uploadDateFmt` hook on modal config: YouTube channel modal shows date-only for uploaded column (no time, since yt-dlp flat extraction only provides YYYYMMDD)
- `/api/youtube/reports/<filename>` endpoint: serves report files for the DB query widget
- Reusable DB query pane (`initDbQueryPane`, `_dbqRun`, `_dbqView`) in `common.js`: single implementation used for all platforms; DB query HTML no longer duplicated in `index.html`

### Changed
- Startup migration now cleans up tiktok-downloader artifacts: `loop_state.json` (root and `data/tiktok/`), flat `run_YYYYMMDD.log` files in `data/logs/`, and `data/reports/` (if empty); `loop_state.json` is deleted rather than moved since nothing in the new app reads it
- All `alert()` error/warning dialogs replaced with `showToast` calls; inline "Saved." spans in settings and comment forms replaced with success toasts
- Dockerfile: `VIDEOS_DIR=/app/videos` replaced with `MEDIA_DIR=/app/media`; fixes TikTok video playback and thumbnail 404s (same root cause as the earlier YouTube path fix; the old env var was a leftover from tiktok-downloader and left `MEDIA_DIR` unset, causing path resolution to depend on CWD)
- Deletion confirmation threshold reduced from 3 to 2 for both TikTok and YouTube: a video must be absent for 2 consecutive loop runs before being marked deleted
- `DATA_DIR` and `MEDIA_DIR` now resolved with `os.path.abspath` at import time; fixes video playback and thumbnail 404s when the process CWD is not the app directory
- YouTube recently saved panel now groups consecutive same-channel downloads and shows a count badge (e.g. `@handle x605`), matching TikTok behaviour
- YouTube download format changed to `bestvideo[height<=1080]+bestaudio/best` (no mp4 merge constraint); video serving now sets the correct MIME type per file extension
- `upload_date` in YouTube flat extraction now falls back to `timestamp` (Unix epoch) when the formatted date string is absent
- Thumbnail generator retries with `seek=0` when ffmpeg exits 0 but produces no output file (videos shorter than 1 s, common for Shorts)
- Migration panel new-prefix auto-fill now appends `/tiktok` subpath
- `docker-compose.yml`: loop interval env vars removed; intervals are configurable from the UI
- `download_video` return dict now includes `upload_date` (parsed from full yt-dlp info); YouTube tracker uses it as fallback when flat extraction returns no date (common for Shorts)
- YouTube `/db/query` response normalized to match TikTok format (`{ok, report_file, preview, total, summary}`)
- Settings sub-tab buttons restyled to match main platform tab (underline style, accent on active); CSS converted from ID-based to class-based (`.diag-output`, `.db-query-input`)
- `esc`, `_makeReportWidget`, `openReportView`, `closeReportView` moved from `tiktok.js` to `common.js`; `_makeReportWidget` now accepts `reportsApiPath` parameter and looks up DOM elements lazily; `openReportView` accepts optional `apiBase` parameter
- Interval and Database cleanup sub-sections removed from YouTube front-page loops card; both are already in Settings

### Fixed
- Settings modal crashed on open: `switchSettingsSection` was referencing old nav/section IDs (`cookies`, `loops`, etc.) that no longer exist after the settings restructure
- YouTube video upload dates blank: Shorts tab flat extraction returns no date field; `download_video` now extracts it from the full yt-dlp info dict captured during download, and existing NULL rows are backfilled from stored `ytdlp_data` on the next loop run
- TikTok video playback and thumbnail 404s: `get_video()` now normalizes `file_path` to absolute via `os.path.abspath` before returning; Flask's `send_file` resolves relative paths against `app.root_path` (`/app/app`), not CWD (`/app`), so relative paths stored in the DB by earlier downloads were resolved to the wrong directory

## [0.1.0] - 2026-04-26

### Added
- YouTube channel tracking: add channels by handle, track new/deleted videos each loop, download via yt-dlp
- YouTube channel modal: video grid/list toggle, filter by status, search, profile history panel
- YouTube loop controls: manual trigger, run now per channel, configurable interval, log panel
- YouTube database cleanup: orphaned record removal, orphaned thumbnail removal, VACUUM
- YouTube stats panel: channel count, saved/deleted video counts, latest download date
- YouTube recent activity panel: recent saves, deletions, and profile changes
- Per-platform tab navigation with hash routing (`#tiktok`, `#youtube`)
- Platform-aware CSS variable themes (dark/red for YouTube, existing grey/blue for TikTok)
- Multi-platform file layout: `platforms/tiktok/` and `platforms/youtube/` packages
- Per-platform Flask Blueprints with namespaced routes (`/api/tiktok/`, `/api/youtube/`)
- Shared frontend utilities split into `common.js` + per-platform `tiktok.js` + `youtube.js`
- Modal engine extended with optional per-platform overrides for thumbnails, actions, and profile history

### Changed
- All TikTok routes moved from `/api/` to `/api/tiktok/` prefix
- `database.py`, `loop.py`, `user_tracker.py`, `sound_tracker.py`, `tiktok_api.py` moved to `platforms/tiktok/`
- `web.py` slimmed to Flask factory + blueprint registration + global routes
- `app.js` split into `common.js` + `tiktok.js`; all TikTok API calls updated to `/api/tiktok/` prefix
- `thumbnailer.py`: platform-aware avatar caching; `cache_avatar` accepts `platform` parameter
- `downloader.py`: platform parameter added; output paths use `MEDIA_DIR/{platform}/`
- `config.py` stripped to global-only config; platform-specific config lives in each platform package
- Downloaded media directory renamed from `videos/` to `media/`; env var renamed from `VIDEOS_DIR` to `MEDIA_DIR`

[0.1.0]: https://github.com/nikolainyegaard/social-downloader/releases/tag/v0.1.0
[Unreleased]: https://github.com/nikolainyegaard/social-downloader/compare/v0.1.0...HEAD
