# Changelog

All notable changes to this project will be documented in this file.

Forked from [tiktok-downloader](https://github.com/nikolainyegaard/tiktok-downloader) at v1.25.0.

## [Unreleased]

## [0.2.0] - 2026-04-28

### Added
- Card action menu (`•••` button) on TikTok user cards and YouTube channel cards: replaces the inline Remove button with a dropdown containing Remove and the new Run Profile action
- Run Profile action: fetches and updates profile info (avatar, display name, bio/description, subscriber count) without triggering a video fetch or download; available via `POST /api/tiktok/users/<id>/run-profile` and `POST /api/youtube/channels/<id>/run-profile`
- Toast notification system (`showToast` in `common.js`): reusable slide-in toasts with `success`, `warning`, `error`, and `info` types; optional action button and configurable auto-dismiss duration
- Migration warning toast: shown on page load when any TikTok video paths in the database do not match the current media directory; includes a button to open the Migration settings panel directly
- YouTube content type tracking (video/short/stream): stored in DB; shorts display with a distinct icon and badge in thumbnail cells
- YouTube channel modal: Videos grid (wide 16:9) and Shorts grid views, in addition to list view
- YouTube diagnostics panel in Settings: channel videos raw fetch and database query tool; `/api/youtube/debug/channel-videos` and `/api/youtube/db/query` endpoints
- Settings modal reorganised into platform-aware tabs: TikTok, YouTube, Jobs, Diagnostics, Database; Jobs/Diagnostics/Database tabs have TikTok/YouTube sub-tabs
- README with setup, configuration, volumes, and migration guide
- `backfill_upload_dates()` in YouTube database: runs at loop start, patches NULL `upload_date` rows; self-heals across one loop cycle
- `fmtDateOnly` date formatter and `uploadDateFmt` hook on modal config: YouTube channel modal shows date-only for the uploaded column
- Reusable DB query pane (`initDbQueryPane`, `_dbqRun`, `_dbqView`) in `common.js`: single implementation used for both platforms; DB query HTML no longer duplicated in `index.html`
- TikTok `repost_count` column: populated from item_list stats and video detail fetches each loop run

### Changed
- YouTube video storage: `ytdlp_data` and `raw_video_data` TEXT blobs replaced by 30+ dedicated columns; `automatic_captions`, `subtitles`, and `heatmap` discarded entirely (expired URL lists and per-0.1s engagement data); average per-video storage drops from ~336 KB to ~1-2 KB; existing data migrated and DB vacuumed automatically on first startup
- TikTok video storage: `ytdlp_data` and `raw_video_data` blob columns dropped; all stats were already in dedicated columns; `repost_count` backfilled before drop; session cookies that yt-dlp embedded in the info dict are no longer stored on disk
- Shared JS helpers consolidated into `common.js`: `apiJSON`, `fmt`, `fmtCount`, date formatters, `_videoStatus`, `_trackingBadge`, scroll lock, pill glider, `_makeJobWidget`, `_triggerLoop`, image modal helpers, shared icons, and the complete modal engine; `youtube.js` no longer has an implicit runtime dependency on `tiktok.js`
- Creator action helpers extracted to `common.js` (`_creatorRun`, `_creatorRunProfile`, `_creatorRemove`, `_creatorToggleStar`, `_saveCreatorComment`, `_renderStatGrid`); platform files now contain thin one-line wrappers
- `ytClearLog` now persists the clear position across page reloads via `localStorage` (matching TikTok behaviour)
- Startup migration now cleans up tiktok-downloader artifacts: `loop_state.json`, flat `run_YYYYMMDD.log` files in `data/logs/`, and `data/reports/` (if empty)
- All `alert()` error/warning dialogs replaced with `showToast` calls; inline "Saved." spans replaced with success toasts
- Dockerfile: `VIDEOS_DIR=/app/videos` replaced with `MEDIA_DIR=/app/media`; fixes TikTok video playback and thumbnail 404s
- Deletion confirmation threshold reduced from 3 to 2 for both TikTok and YouTube
- `DATA_DIR` and `MEDIA_DIR` now resolved with `os.path.abspath` at import time; fixes video playback and thumbnail 404s when the process CWD is not the app directory
- YouTube recently saved panel now groups consecutive same-channel downloads with a count badge (e.g. `@handle x605`), matching TikTok behaviour
- YouTube download format changed to `bestvideo[height<=1080]+bestaudio/best`; video serving now sets the correct MIME type per file extension
- Thumbnail generator retries with `seek=0` when ffmpeg exits 0 but produces no output file (common for Shorts)
- Migration panel new-prefix auto-fill now appends `/tiktok` subpath
- `docker-compose.yml`: loop interval env vars removed; intervals are configurable from the UI

### Fixed
- Database files automatically vacuumed after startup migration when blob columns are dropped
- YouTube channel modal load time: `get_videos_for_channel` used `SELECT *`, forcing SQLite to read ~200 MB of `ytdlp_data` blobs per open; now resolved by dropping the columns entirely
- Settings modal crashed on open after settings restructure
- YouTube video upload dates blank for Shorts: `download_video` now extracts `upload_date` from the full yt-dlp info dict; existing NULL rows backfilled on next loop run
- TikTok video playback and thumbnail 404s: `get_video()` now normalizes `file_path` to absolute via `os.path.abspath`

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
[0.2.0]: https://github.com/nikolainyegaard/social-downloader/compare/v0.1.0...v0.2.0
[Unreleased]: https://github.com/nikolainyegaard/social-downloader/compare/v0.2.0...HEAD
