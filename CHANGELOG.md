# Changelog

All notable changes to this project will be documented in this file.

Forked from [tiktok-downloader](https://github.com/nikolainyegaard/tiktok-downloader) at v1.25.0.

## [Unreleased]

### Added
- YouTube content type tracking (video/short/stream): stored in DB, shorts display with a distinct icon and badge in thumbnail cells
- YouTube channel modal: Videos grid (wide 16:9) and Shorts grid views, in addition to list view
- YouTube diagnostics panel in Settings: channel videos raw fetch and database query tool
- `/api/youtube/debug/channel-videos` and `/api/youtube/db/query` endpoints
- Settings modal reorganised into platform-aware tabs: TikTok, YouTube, Jobs, Diagnostics, Database; Jobs/Diagnostics/Database tabs have TikTok/YouTube sub-tabs
- README with setup, configuration, volumes, and migration guide

### Changed
- `DATA_DIR` and `MEDIA_DIR` now resolved with `os.path.abspath` at import time; fixes video playback and thumbnail 404s when the process CWD is not the app directory
- YouTube recently saved panel now groups consecutive same-channel downloads and shows a count badge (e.g. `@handle x605`), matching TikTok behaviour
- YouTube download format changed to `bestvideo[height<=1080]+bestaudio/best` (no mp4 merge constraint); video serving now sets the correct MIME type per file extension
- `upload_date` in YouTube flat extraction now falls back to `timestamp` (Unix epoch) when the formatted date string is absent
- `ytdlp_data` and `raw_video_data` stripped from video list API responses to reduce payload size
- Thumbnail generator retries with `seek=0` when ffmpeg exits 0 but produces no output file (videos shorter than 1 s, common for Shorts)
- Migration panel new-prefix auto-fill now appends `/tiktok` subpath
- `docker-compose.yml`: loop interval env vars removed; intervals are configurable from the UI

### Fixed
- Settings modal crashed on open: `switchSettingsSection` was referencing old nav/section IDs (`cookies`, `loops`, etc.) that no longer exist after the settings restructure

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
