# Changelog

All notable changes to this project will be documented in this file.

Forked from [tiktok-downloader](https://github.com/nikolainyegaard/tiktok-downloader) at v1.25.0.

## [Unreleased]

### Fixed
- Loops panel "Last:" showed the time the loop completed, not when it started; loop start time is now written to `loop_state.json` at session start and used for the display; a service killed mid-run still shows the start time of the interrupted run on next startup
- Stop button did not interrupt a user mid-download; the stop event is now checked between individual video downloads inside `process_single_user`, so pressing Stop takes effect after the current download finishes rather than after all downloads for the current user finish
- Recently deleted panel showed nothing after the frontend collapse of "possibly deleted" into "deleted" display; root cause was the pending-deletion schema refactor below

### Changed
- TikTok deletion tracking schema: `pending_deletion_count` and `pending_deletion_since` columns replaced by `deletion_confirmed INTEGER` and `false_positive_count INTEGER`; first absence now sets `status='deleted', deletion_confirmed=0, deleted_at=now`; second consecutive absence sets `deletion_confirmed=1`; a video that returns before confirmation is silently reverted to `status='up'` and `false_positive_count` is incremented; `deleted_at` now reflects when the video was first noticed missing (was: when it was confirmed); ban deletions set `deletion_confirmed=1` immediately; existing rows migrated automatically on first startup

### Added
- Scheduled daily database backup: both `tiktok.db` and `youtube.db` are copied to `data/backups/` at midnight each day using the SQLite backup API; a backup also runs immediately on startup; backups older than 14 days are pruned automatically
- Position-aware deletion detection in quick mode: stores the ordered video ID list from each quick fetch in `users.last_quick_video_ids`; on subsequent quick checks, videos missing from the window that cannot be explained by new posts scrolling older ones off the bottom are flagged as deletion candidates
- Fast follow-up full re-check: after a full-mode run that finds any deletion candidates, `next_check_at` is reset to NULL so the user is processed again in the next session to confirm or clear the pending deletions

### Changed
- Loops panel trigger buttons: removed "Run" prefix, added refresh icon to match the user card Quick/Full button style; labels are now "Next", "Starred", "Half", "All"
- "Possibly deleted" videos (pending deletion count > 0) now display identically to confirmed deleted videos in the frontend: same "Deleted" label, same red colour, counted together with deleted in user card and modal stats, included in the "Deleted" filter pill in the video modal; the internal `pending_deletion_count` state is unchanged
- Per-user run buttons on user cards and the user modal split into Quick and Full; Quick fetches the first 30 videos only and skips the stats upsert (matching the session loop's quick-check mode); Full is the previous behavior and does not advance the weekly full-refresh cycle any sooner
- TikTok user cards: "Last checked" and "Last saved" moved from the button row into a slim meta footer below a faint divider, alongside a new "Added" date field; the three items are shown as uppercase label / value column pairs

### Fixed
- Startup crash (`sqlite3.OperationalError: near ")": syntax error`) caused by a trailing comma left in the `CREATE TABLE users` statement after removing the `pending_ban_count` and `pending_ban_since` columns
- YouTube loop state file corrupted on crash: `_save_state()` opened the file with `"w"` before writing, truncating it immediately; a crash mid-write left an empty or partial JSON file and lost all loop state on next startup; now writes to a `.tmp` file and atomically renames it (matching the TikTok loop)

### Removed
- `get_cookies_for_playwright()` from `platforms/tiktok/config.py`: defined but never called anywhere
- `pending_ban_count` and `pending_ban_since` columns from the TikTok `users` table schema and migration list: columns were never read or written by any database function
- `PlatformAdapter` base class (`platforms/base.py`): never subclassed; both trackers call platform API functions directly
- YouTube one-time migration block and `_one_time_backfill_ytdlp_columns()` from `platforms/youtube/database.py`: YouTube has never shipped so no database in the wild needed this migration; it was a permanent no-op

### Added
- Session-based TikTok user loop: replaces the fixed-interval loop with N sessions per 24-hour window (default 4), each firing at a random time within its equal segment; sessions only process users whose `next_check_at` has elapsed, so the workload scales naturally with the number of tracked users
- Activity scoring for check intervals: starred users checked every 6h, active users (posted within 30 days) every 24h, inactive users every 72h; intervals recomputed after each session; configurable via settings UI or env vars
- Quick vs full refresh split: normal session checks use quick mode (first ~30 videos, no stats upsert); full item_list stats refresh runs on a weekly cycle per user; mode determined by `full_refresh_pending` flag set by the batch scheduler
- Weekly full-refresh batch cycle: users are divided into 7 equal batches sorted by `last_full_refresh_at`; one batch is activated per day so item_list calls are spread evenly across the week instead of hitting all users at once
- Four new DB columns on `users`: `next_check_at`, `check_interval_secs`, `last_video_at`, `last_full_refresh_at`; two batch columns: `full_refresh_pending`, `refresh_batch`
- New settings: `sessions_per_day`, `high_priority_check_hours`, `active_check_hours`, `inactive_check_hours`, `stats_refresh_days` (UI + env vars)
- Session timeline pills on the loop card: shows today's scheduled session times with done/running/next visual states
- Live sleep countdown bar pinned to the top of the TikTok log panel: counts down the current inter-user or cooldown sleep in place (no new log lines), shows an "up next" label with the next user and check mode; when idle, counts down to the nearest scheduled user or sound loop session
- Run Starred, Run Half, and Run All buttons replace the single "Run Now" button on the TikTok user loop card; Run Starred triggers a full refresh for starred users only; Run Half triggers a quick check for the 50% of users longest since their last check; Run All triggers a quick check for all enabled users without setting full_refresh_pending to avoid rate limit overload
- Content-hash asset URLs: `style.css`, `common.js`, `tiktok.js`, and `youtube.js` are served at `/assets/<name>-<8-char-hash>.<ext>` with `Cache-Control: immutable`; hashes computed at startup so Cloudflare and browser caches are busted automatically on each new deploy without a build step
- "Last saved" timestamp on TikTok user cards, showing when the most recent video from that user was downloaded (derived from `MAX(download_date)` in `get_all_video_stats`); displayed below "Last checked" in the card footer
- "Last checked" and "Last saved" sort options for the TikTok user view, both defaulting to newest first
- Star, Run Now, Run Profile, and Remove action buttons in the TikTok user detail modal header, alongside the existing tracking toggle; the star button re-renders the modal header to reflect the updated state; Remove closes the modal before reloading

### Fixed
- Banned 10222 private accounts not recovering when videos become accessible: `UserPrivateException` bypasses the profile-level recovery block; account stayed `banned` in the DB even after item_list returned videos and undeleted them; recovery now runs at the post-fetch point when `_was_banned` and `is_private` and `remote_ids` are all true
- `tracking_enabled` not restored when a banned account recovers: the ban recovery block called `restore_banned_videos` and `set_user_account_status("active")` but not `set_user_tracking_enabled(True)`; accounts auto-disabled after 14 days stayed in no-track state permanently after recovery
- "Last checked" not updating for banned accounts: the `UserBannedException` path returned before `update_user_info` was called; now stamps `last_checked` unconditionally before returning
- "Last checked" not updating for inaccessible 10222 private accounts: `update_user_info_from_item_list` was gated on item_list returning data; when item_list returns nothing (access lost), `last_checked` was never written; now stamped via `touch_user_last_checked` in that path
- Banned users sorted to the front of every session: `get_users_due_for_check` sorted by `last_checked ASC` but `last_checked` is never written on the ban path, so banned users had a permanent sort advantage; now sorts by `next_check_at ASC` which is always written after every processed user
- Quick-mode false "Possibly deleted" log spam: deletion diff ran in quick mode against all known videos, but quick mode only fetches the first ~30; all other known videos were flagged missing; deletion diff is now skipped entirely in quick mode
- Log viewer stopping after 1000 lines: the client used `lines.length` as the slice index; once the server buffer filled to 1000 the slice was always empty; fixed with a monotonic `_log_seq` counter that increments on every log call and is returned in the status response so the client tracks position independently of buffer size
- Manual trigger consuming a scheduled session slot: session slot was always popped on wake regardless of whether the wake was manual or scheduled; now only popped on scheduled wakes
- Session timeline pills showing 12h AM/PM time; now 24h

### Changed
- Relative timestamps (Last checked, Last saved, loop run times, etc.) now show two components instead of collapsing to hours: `Xmo Yd`, `Xd Yh`, `Xh Ym`, `Xm`, `Xs`
- Inter-user gap within a session changed from uniform 2-5s to exponential distribution (mean 90s, min 15s) to better mimic organic browsing behavior and reduce bot detection
- Log panel scrolls to the bottom automatically when the Log tab is opened
- Manual trigger (Run Starred / Run Half / Run All) no longer lights up the next scheduled session pill as running; that pill represents the scheduled session time, not the manual trigger
- Recently deleted Recents panel and modal now groups consecutive same-user deletions with a count badge (e.g. `@handle 3x`), matching the Recently Saved grouping logic; single-entry rows highlight the video directly, multi-entry rows open the user deletion modal
- Recents panel grouped-response detection in common.js is now dynamic: dispatches on `{items, rows_consumed}` response shape rather than checking the endpoint type, so any future grouped endpoint works without frontend changes
- Usernames in the Recents panel and modals are now left-aligned within their column (was centered)
- Recents panel grid changed to 2fr 3fr 1fr: date gets 2/6, username gets 3/6 (left-aligned text centered between the outer columns), detail gets 1/6
- Profile change field labels shortened: "Username" to "Handle", "Display name" to "Name", "Account status" to "Status", "Privacy status" to "Privacy"

### Added
- item_list page-progress log line emitted after every 30 videos fetched during a full run: `[item_list] page N fetched (M videos)`; visible in the log panel during full runs and useful for diagnosing session degradation on large accounts
- Large deletion spike isolation: when 10 or more deletions are detected in a single full run, a dedicated full re-scan is automatically scheduled to fire at the midpoint between the current run and the next scheduled session (minimum 60 seconds, default 30 minutes if no next session is known); the re-scan uses a fresh dedicated session via the same path as the "Run Full" button, avoiding shared-session degradation that can cause false confirmations on large accounts
- Pending re-scan badge on user cards: a yellow countdown pill showing when the isolated midpoint re-scan will fire; cleared automatically if a manual run is triggered for the same user before it fires

## [0.2.1] - 2026-05-18

### Added
- TikTok Diagnostics: sound raw API output tool; fetches all videos for a sound via TikTokApi and returns the total count and first 3 raw items for inspection

### Fixed
- TikTok sound loop crash on new video downloads: tracker passed `raw_video_data` to `add_video()` but the column was already dropped by the one-time migration; removed the argument from the call site
- TikTok loop crash on new downloads: `add_video`, `update_video_downloaded`, and `update_video_stats` still referenced `raw_video_data` and `ytdlp_data` after those columns were dropped by the one-time migration; removed from all INSERT/UPDATE statements and call sites in tracker.py and web.py
- Migration warning toast showed raw number and said "videos" instead of "posts"; now formats count with locale separators and uses "posts" to correctly cover both video and photo posts
- Starred sort option still appeared in the TikTok Users, TikTok Sounds, and YouTube Channels sort dropdowns after it was removed from the JS sort label maps; removed the option elements from the HTML
- YouTube Recent panel headers (Recently deleted, Recently changed profile, Recently saved) did not open the log modal; added paginated history endpoints and wired up the headers

### Changed
- Loop run duration now shows hours when the run exceeds 60 minutes (e.g. "took 5h 32m")
- TikTok bot detection: a third consecutive detection for the same user (after 5+10 min of sleep) now cancels the loop entirely and restarts the full cooldown interval, instead of skipping the user and continuing
- Starred removed from the sort dropdown in TikTok Users, TikTok Sounds, and YouTube Channels; the "All / Starred" filter pill is unchanged
- Recently Saved grouping now breaks on gaps larger than 5 minutes between adjacent downloads of the same creator, instead of collapsing all consecutive same-creator rows into one entry regardless of time

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
[0.2.1]: https://github.com/nikolainyegaard/social-downloader/compare/v0.2.0...v0.2.1
[Unreleased]: https://github.com/nikolainyegaard/social-downloader/compare/v0.2.1...HEAD
