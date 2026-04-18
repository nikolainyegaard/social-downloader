# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Star button on user and sound cards: outline/grey when unset, solid yellow-orange when starred; persisted in the database
- Starred filter pill for users (All / Starred) and sounds (All / Starred)
- Starred sort option for users; sort controls for sounds (Label, Starred, Saved videos, Date added)
- Mobile smart add bar: single unified input above the stats panel that auto-detects whether the value is a TikTok username, sound ID, or sound URL, and routes to the correct tracking endpoint; includes a Paste button; replaces the separate "Track a user" and "Track a sound" forms on mobile
- User and sound modal: column headers are sticky and scroll horizontally in sync with the video rows on mobile
- User and sound modal: toolbar collapses on mobile to a single row (view toggle, post count, Profile History); filter pills expand via a "Filters" toggle button
- Sound card grid: Tracking filter pills (All / Active / Inactive) matching the Users grid; inactive cards dimmed
- Sound card grid: tracking toggle on each card, matching user cards
- Sound modal toolbar: video search (ID or description), matching the user modal
- Sound modal header: comment/notes field saved on blur, matching the user modal
- Sound modal: list/grid view toggle, matching the user modal; grid view uses the same infinite-scroll thumbnail renderer

### Changed
- Recent entries: detail text shows the full video ID instead of a truncated value
- `templates/index.html` internal consolidation (no functional changes): 18 duplicated modal functions replaced by 9 parameterised engine functions; shared CSS base classes (`.modal-base`, `.label-caps`) extracted; inline styles moved to stylesheet; JS helpers (`_cmp`, `_attachSentinel`, `_trackingBadge`, etc.) extracted to module scope; `apiJSON` adds `Content-Type` only when a body is present
- `templates/index.html` split into `static/style.css` and `static/app.js`; HTML template reduced from ~5000 to 640 lines
- User modal: opens in grid view by default on mobile; switches to list view automatically when a specific video needs to be highlighted
- User modal header: compact layout on mobile with avatar and name on one row; handle, ID, bio, and stats below
- Bio in user modal: collapsed to a single truncated line by default; tap to expand inline, tap again to collapse
- Close buttons across all modals unified to a rounded-square style with a CSS-drawn X; consistent size and shape everywhere

### Fixed
- Suppress `RuntimeError: Event loop is closed` tracebacks that appeared in the log after each loop run; Playwright subprocess transports clean up during GC after asyncio.run() closes the loop, harmless but noisy
- Sound loop: retry fetch once with a 15-second delay when the Playwright session times out, instead of skipping the sound for the entire loop run
- User loop: validate the TikTok session immediately after creation; if bot-detected at startup, trigger the existing cooldown+restart path instead of processing 3 users before the problem is detected
- User loop: when session creation fails entirely, trigger cooldown+restart on the first failure instead of hard-aborting the loop
- Private filter no longer matches banned users whose privacy_status was set before the ban
- Reset button now clears the search field in addition to filters and sort
- Modals no longer allow the underlying page to scroll while open; root cause was `overflow: hidden` being set on `<body>` when `<html>` is the actual scroll container
- Recent log modal stays open when opening a user or sound modal from a recent activity entry
- Escape key now dismisses modals in the correct order: sound detail, then user detail, then recent log
- Log clear state persists across page reloads; cleared position saved to localStorage and restored on load
- Filter pills in user/sound modal toolbar no longer stretch to fill the full row width on mobile
- Clicking a column header to sort no longer resets the horizontal scroll position in video modals
- Filter pills (All/Active/etc.) now correctly show their active state when the filter row is first expanded on mobile
- Sound catalog filter/sort controls were never visible when switching to the Sounds tab; switching tabs now also hides the user filter bar without reserving its layout space

### Performance
- Recent activity panel: `_recentDate` pre-captures the current time once per render batch instead of once per entry
- User modal: video thumbnails are now lazy-loaded, reducing the initial network burst to only visible rows
- All date formatting now uses cached `Intl.DateTimeFormat` instances instead of constructing a formatter on every call (`fmtDateShort`, `_recentDate`, modal header join date, profile history entries)
- User and sound modal: video rows batch-inserted with a single `insertAdjacentHTML` call instead of one `appendChild` per row
- User and sound modal toolbars: status/type counts computed in a single `forEach` pass instead of five separate `.filter()` calls
- User modal toolbar: `_filteredSorted` results cached to avoid computing the sorted list twice per toolbar render
- `renderStatus` (runs every 5 s): DOM element references cached at startup instead of re-queried on every tick
- Page no longer renders wider than the viewport on mobile; the Track a Sound label input and the filter tabs + search row were each wider than the viewport, forcing the CSS grid to expand and clip all content on the right
- Track a sound: label input hidden on mobile
- Filter tabs: pills and search wrap to separate rows on mobile; search goes full-width below the pills
- iOS focus zoom: all focusable inputs, selects, and textareas use 16px minimum font size on mobile to prevent Safari from zooming on tap
- Horizontal rubber-band scroll suppressed on mobile via overscroll-behavior-x:none
- Filter pill text no longer wraps inside button bounds
- Header meta row wraps to its own line on mobile instead of overflowing
- Recent entries: detail column hidden on mobile to prevent row overflow

## [1.24.0] - 2026-04-11

### Added

**Video modals**
- Video grid view: toggle in the user modal toolbar switches between list and grid; cells show a view count overlay and video/photo type badge; click to play or open the carousel; deleted/restored/missing cells are indicated by a coloured outline
- Video type badge overlaid on thumbnails: play icon for videos, photo-grid icon for photo posts
- Clicking a thumbnail now plays the video or opens the photo carousel; a separate image-preview button opens the still thumbnail
- Video search in the user modal toolbar: filters by video ID or description, shows "N of M posts" when active
- "Missing" status in user and sound modals for videos absent from the latest scrape but not yet confirmed deleted; user cards show a "Missing" counter when non-zero
- Per-user comment field; saved on blur, persisted to the database

**User cards and profile**
- Ban inactivity countdown: shows "N days until inactive" for banned users within the 14-day auto-deactivation window
- "Profile Updates" count in the user modal stats bar; clickable, opens profile change history
- Account status and privacy status changes recorded in profile history; appear in the Profile History panel (with filter pills) and the Recently changed profile feed

**Navigation and global UI**
- Search bar in the nav bar: filters users (by username, display name, or ID) and sounds (by label or ID); shows "N of M" count when active
- Untracked users in Recently Saved and Recently Deleted appear in grey and route to the relevant sound modal with the video highlighted
- Back-to-top button; appears after scrolling 200px

**Settings and tools**
- Database settings tab with a SQL query runner: SELECT results shown as a preview with a full-report viewer and download; other statements report rows affected
- "Include banned users" toggle on the Delete all avatars utility; banned users excluded by default since their avatars cannot be re-fetched

**Loop and backend**
- Video listing via TikTokApi `item_list` as the primary source; returns full stats and photo detection in one pass; yt-dlp kept as fallback
- Shared TikTokApi browser session across all users in a loop run, replacing per-user sessions (eliminated 8-20 min overhead for large libraries)
- Bot detection with automatic session reset and per-user retry; loop aborts after 3 consecutive post-reset failures
- Loop duration and new-video count saved to disk; pre-populated in the UI on restart
- Eliminated redundant avatar requests for users without a cached file; previously these were retried on every startup

### Changed

**UI**
- Loops panel redesigned as two sections with a 3-column grid: last/next run, duration and new-video count, Run Now button
- Log moved from a standalone bottom section into the nav bar as a third view pill alongside Users and Sounds
- Play button moved immediately right of the thumbnail in the video list; download button remains in the action column
- Reset button grouped with Sort controls as a single unit
- Loop panel shows a "N new" counter after each run (user and sound loop independently)
- Recently Deleted panel now only shows individually deleted videos, not those cleared by an account ban

**Backend and logging**
- Deletion confirmation threshold configurable via `DELETION_CONFIRM_THRESHOLD` env var; controls both the deletion check and the "Missing" label threshold
- Loop log messages use "post/posts" instead of "video/videos" for counts that may include photo posts
- Sound loop log messages no longer prefixed with `[sound]`; consistent with user loop format
- "Thumbnail OK" log suppressed per photo post; failures are still reported
- Delete all avatars utility resets the cached flag for removed files; skips banned users unless the toggle is enabled

### Fixed

- Photo posts discovered via sound tracking now get a thumbnail generated; previously these had no thumbnail until the next restart
- Adding a banned or removed account now shows a clear "is banned or removed on TikTok" error instead of a misleading "cookies may be stale" message
- "X videos found" no longer logged for private accounts where the video fetch is skipped
- "Profile updates" counter now uses singular "update" when the count is 1
- Video search in the user modal no longer loses focus on each keystroke
- Switching tracking views now clears the active search filter
- Sounds nav pill count now resets to the total when leaving the Sounds view
- Loop panel no longer shifts the page layout while running
- Video row horizontal padding corrected, fixing uneven spacing to the left of thumbnails

## [1.23.0] - 2026-04-08

### Added
- Utilities settings tab with one-off maintenance actions
- "Delete all avatars" action: removes cached profile pictures without affecting archived history; avatars re-downloaded on next loop run
- "Delete all thumbnails" action: removes all generated thumbnails; regenerated on next startup

### Changed
- AVIF compression tuned: photo posts CRF 30 to 28, avatars 35 to 30, thumbnails 40 to 38

## [1.22.0] - 2026-04-08

### Added
- Accounts banned for 14+ consecutive days are automatically set to inactive; profile check and ban recovery still run

### Changed
- Recently Saved panel groups consecutive downloads from the same user into a single row (e.g. "@user 12x")
- Recent panel uses fixed column widths; video IDs truncated to 10 characters in Recently Deleted
- Settings panel clears finished job widgets when the modal is closed

## [1.21.1] - 2026-04-08

### Fixed
- TikTok status 10223 (FTC/underage restriction) now treated as banned, matching status 10202
- Already-banned accounts no longer re-run ban writes on every loop; log shows "No changes (still banned)"
- Error messages for failed profile fetches now show `sec_uid=...` instead of the raw base64 value

## [1.21.0] - 2026-04-08

### Added
- Ban detection: accounts returning TikTok status 10202 marked `banned`; all active videos marked deleted with reason `user_banned`
- Ban recovery: previously banned accounts restored automatically; all `user_banned` videos returned to `undeleted` status
- `deleted_reason` column on `videos` table (`video_deleted` or `user_banned`); existing deleted rows backfilled on startup
- Profile fetches now use `secUid` directly, surviving username changes without needing the current username
- File integrity check: scheduled at 00:00 and 12:00 with Scan (dry run) and Purge buttons in Settings
- "User info by ID" lookup in the Diagnostics panel for accounts identified by `tiktok_id:sec_uid`

### Changed
- TikTokApi pinned to `==7.3.3`

### Removed
- Unused pending-ban counter

## [1.20.1] - 2026-04-07

### Fixed
- Profile fetches now use `user_id + sec_uid` together, fixing lookups for accounts with changed usernames
- Video list fetches now try `tiktokuser:{sec_uid}` first, avoiding "Unable to extract secondary user ID" after username changes
- Newly added users appear in the tracked list immediately when the background lookup completes, without waiting for the polling interval

## [1.20.0] - 2026-04-07

### Added
- Deletion tracking for sound-tracked videos: 3 consecutive missing runs required before marking deleted
- "Retry failed" button in backfill settings: clears error state on failed videos so they can be re-queued
- Backfill run log now shows per-video outcome (OK with view count, or FAIL with error category)

### Changed
- Users and sounds share a single tracking list with a toggle button, replacing two separate sections

### Fixed
- Bio changes no longer recorded when account is `private_blocked`; TikTok hides the bio and a missing value is not a real change
- TikTokApi `KeyError: 'user'` now produces a readable error message instead of a raw traceback

## [1.19.2] - 2026-04-07

### Fixed
- Startup crash on upgrade: `CREATE INDEX` for `stats_backfilled_at` was running before the column was added via migration

## [1.19.1] - 2026-04-06

### Fixed
- "Run Now" during the 5-minute loop avoidance buffer now skips the remaining wait and starts immediately, preventing a phantom second run

## [1.19.0] - 2026-04-06

### Added
- Recently Saved section in the dashboard: 9 most recent downloads with click-to-open; section header opens full paginated log
- "Reset" button in the Tracked Users filter bar resets sort, Privacy, and Tracking filters to defaults

### Changed
- Dashboard layout: Stats (1/3) + wide Recent panel (2/3) on top row; Track forms (2/3) + Loops panel (1/3) below
- Profile history avatar diff: two 100px circles side-by-side with Old/New labels, replacing small inline thumbnails

### Fixed
- `mark_video_deleted` now correctly handles `undeleted` videos that disappear again
- `delete_orphaned_records()` now also clears profile history rows for removed users

## [1.18.1] - 2026-04-06

### Changed
- Database cleanup moved into the Jobs settings tab; reusable progress widget now shared across all jobs

## [1.18.0] - 2026-04-06

### Added
- Log rotation at midnight in addition to on startup; archives named `run_YYYYMMDD.log` vs `run_YYYYMMDD_HHMMSS.log`

### Fixed
- Photo post thumbnails were never generated for new downloads; now called after each successful photo download
- `stats_backfilled_at` no longer set at insert time when `view_count` is NULL; those videos now correctly enter the backfill queue

## [1.17.0] - 2026-04-06

### Added
- Tracking toggle on user and sound cards: pausing stops video downloads while profile, ban, and deletion tracking continues
- "Inactive" pill in the user list filter bar; "Banned" pill added to Privacy filter
- "Remove audio-only files" job in Settings to clean up `.m4a` files from before format enforcement
- Diagnostics tab in Settings with a raw API call runner (yt-dlp, TikTokApi, video details)
- Per-run log files: `run_current.log` rotated to a dated archive on startup; last 10 runs kept

### Changed
- yt-dlp format string hardened; audio-only downloads are now rejected and removed automatically
- `APP_VERSION` injected at Docker build time via `BUILD_VERSION` ARG instead of hardcoded in `config.py`

### Fixed
- Thumbnail generation failure on HEVC/H.264 videos with `reserved/reserved` colour primaries

## [1.16.4] - 2026-04-06

### Changed
- "Track a sound" is always visible, matching the "Track a user" layout; no longer hidden behind a toggle

### Fixed
- Log separator colouring for both loops (regex was matching wrong case)
- Sound loop log lines now use consistent colouring

## [1.16.3] - 2026-04-06

### Fixed
- Saving loop interval settings now reschedules the sleeping thread immediately instead of waiting for the old interval to expire
- User and sound card hover highlight no longer flickers during status polls

## [1.16.2] - 2026-04-06

### Fixed
- Profile history "New" avatar now shows the correct image after a change (browser cache busted per change event)
- Browser spinner arrows removed from loop interval number inputs

## [1.16.1] - 2026-04-05

### Changed
- Loops panel moved into the top-panels row alongside Statistics and Recent (layout only)

## [1.16.0] - 2026-04-05

### Added
- User loop and sound loop are now fully independent with separate intervals, state, and trigger events
- `POST /api/trigger/sounds` endpoint for triggering the sound loop manually
- Loop intervals configurable from the Settings panel and persisted in the database
- `SOUND_LOOP_INTERVAL_MINUTES` environment variable (default 60); `USER_LOOP_INTERVAL_MINUTES` replaces `LOOP_INTERVAL_MINUTES`

### Changed
- If both loops are due at the same time, the second waits for the first to finish plus a 5-minute buffer

## [1.15.1] - 2026-04-05

### Fixed
- Filter pill groups in user and sound modals now appear side by side on the same line

## [1.15.0] - 2026-04-05

### Added
- Sound tracking: track TikTok sounds by URL or numeric ID; downloads all matching videos
- Sound cards with label, video count, Run/Remove buttons; sound detail modal with sortable, filterable video list and author column
- `music_id` column on `videos` table
- Backfill reset button in Settings

## [1.14.1] - 2026-04-05

### Fixed
- Jobs panel no longer shows "All images already in AVIF." for ~8 seconds after restart before showing real progress

## [1.14.0] - 2026-04-05

### Added
- Photo carousel viewer in user modal for photo posts; keyboard navigation (`←`/`→`/`Escape`)
- Video/photo type filter pills in user modal (All types / Videos / Photos)

### Fixed
- AVIF encoding failed for all files due to missing `-f avif` flag when output used a `.tmp` extension

## [1.13.0] - 2026-04-05

### Added
- All photos, thumbnails, and avatars stored as AVIF (50-70% smaller than JPEG at equivalent quality)
- Background JPEG-to-AVIF conversion runs on startup; manual trigger in Settings

### Changed
- `transcoder.py` and video transcoding functionality removed

## [1.12.1] - 2026-04-05

### Fixed
- "Last run" time now persists across container restarts; no longer shows "Never run" after a restart

## [1.12.0] - 2026-04-05

### Added
- Clicking "Recently deleted", "Recently changed profile", or "Recently banned" headers opens a full paginated log
- Profile history diff view: old and new values shown side by side
- Browser extension badge links in the Cookies settings panel

### Changed
- Video list date columns in the user modal now include time of day

### Fixed
- Profile history toolbar no longer overwritten by the video list toolbar when opening a modal from a Recent entry
- Video row highlight from the Recent panel now stays until first hover instead of auto-fading

## [1.11.0] - 2026-04-05

### Added
- Profile history: tracks username, display name, bio, and avatar changes with timestamps; viewable in user modal
- Recent panel on the main page: recently deleted videos, profile changes, and bans; clicking entries opens the relevant user or video

### Changed
- Cookie status and backfill controls moved to page header pills and the Settings modal
- User card stat labels now appear above values instead of inline

## [1.10.0] - 2026-04-05

### Added
- Privacy filter pills (All / Public / Private) and Status filter pills (All / Active / Banned) in the user list
- Backfill error tracking: videos with 3+ consecutive failures listed separately with last error message
- "Nothing to backfill" feedback when the queue is empty

### Fixed
- Backfill skips videos with pending deletion, avoiding spurious error accumulation on disappearing videos
- Cookie "Updated" timestamp no longer shows wrong time after container restart
- Modal avatar is now clickable (opens full-size image preview)

## [1.9.0] - 2026-04-05

### Added
- Statistics panel: tracked users, saved/deleted videos, photo posts, total views/likes, latest saved
- User card and modal avatars are now clickable (opens full-size image preview)

### Removed
- `del_` file prefix system for deleted videos; startup migration renames any existing `del_*` files

## [1.8.0] - 2026-04-04

### Added
- Settings modal (gear icon in header) with Cookies and Database sections
- Cookie status indicator in the page header; red warning banner when cookies are absent
- Database cleanup tool: orphaned DB records, orphaned thumbnails/avatars, SQLite VACUUM

## [1.7.0] - 2026-04-04

### Added
- `stats_backfilled_at` column as the backfill eligibility signal, replacing `view_count IS NULL`
- Backfill now covers all metadata fields: duration, dimensions, music info, raw video data
- Missing stats count shown in the header; decrements live during a backfill run

## [1.6.1] - 2026-04-04

### Added
- User sort control: sort by username, display name, followers, saved/deleted count, or date added

### Fixed
- Cookie "Updated" timestamp now written at upload time; no longer reset by container restarts
- Backfill progress text no longer blank on page reload while a backfill is already running

## [1.6.0] - 2026-04-04

### Added
- Thumbnail click opens full-size image preview
- Play button on video rows opens in-browser video player
- Stats backfill: background job fetches missing engagement stats for videos downloaded before v1.5.0

### Fixed
- Clicking Run or Remove on a user card no longer also opens the card modal

## [1.5.0] - 2026-04-04

### Added
- Thumbnail generation for all videos and photo posts; background backfill on startup
- Avatar caching: profile pictures downloaded and stored locally
- Full metadata storage: engagement stats, dimensions, music info, and raw API/yt-dlp data in DB and embedded in video files
- User detail modal: full profile info, video list with thumbnails, filter/sort, infinite scroll

## [1.4.1] - 2026-04-04

### Changed
- User card layout: display name and handle on separate lines; bio reserves fixed height; old usernames formatted consistently

## [1.4.0] - 2026-04-04

### Added
- Per-user manual "Run" button on each card; multiple runs can be queued

## [1.3.11] - 2026-04-02

### Fixed
- Re-adding a tracked user (e.g. after a username change) now updates their profile and backfills missing fields

## [1.3.9] - 2026-04-02

### Fixed
- Profile fetches no longer fail with "You must provide the username" when `sec_uid` is available

## [1.3.8] - 2026-04-02

### Added
- Privacy status badge on user cards: Public, Private (accessible), Private (no access)

### Changed
- `secret` flag from TikTokApi now correctly mapped to private account status instead of banned

### Removed
- Auto-ban detection via `secret` flag

## [1.3.7] - 2026-04-02

### Changed
- Username change now renames the video folder on disk and updates all file paths in the database

## [1.3.6] - 2026-04-02

### Added
- All loop lookups now use TikTok ID instead of username, surviving username changes
- Deletion/ban confirmation threshold: 3 consecutive missing loop runs required before marking deleted or banned

## [1.3.4] - 2026-04-02

### Added
- App version displayed in the page header

### Fixed
- Username input replaced with `contenteditable` div to suppress Safari/iCloud Passwords autofill

## [1.3.3] - 2026-04-01

### Fixed
- Partial improvement to Safari autofill suppression on username input

## [1.3.2] - 2026-03-30

### Fixed
- DB record now written after a successful download, so failed downloads are retried on the next loop run

## [1.3.1] - 2026-03-30

### Changed
- Docker image installs Google Chrome on amd64; arm64 falls back to Playwright Chromium
- Fresh TikTokApi session created per user, fixing "No sessions created" errors on later users in the list

## [1.3.0] - 2026-03-30

### Added
- Deletion tracking with a 3-run confirmation threshold before a video is marked deleted

## [1.2.3] - 2026-03-30

### Fixed
- Log panel stall: server now returns the full log buffer
- Queue error dismissal now persists across page reloads and other devices
- Cookie upload cleanly overwrites the existing file

## [1.2.2] - 2026-03-30

### Added
- Caddy Docker integration example in the documentation

## [1.2.1] - 2026-03-29

### Changed
- Minor copy and code cleanup (no functional changes)

## [1.2.0] - 2026-03-29

### Added
- `get_video_details()` via `curl_cffi` with Chrome impersonation for video type and image URLs
- Cookie helpers for both yt-dlp and Playwright
- Random 2-5s inter-user delay in the loop

### Changed
- Video listing switched from TikTokApi (bot-detected) to yt-dlp flat playlist extraction

## [1.1.0] - 2026-03-29

### Added
- Photo post support: individual images downloaded per post
- Queue-based user add: input clears immediately; background worker resolves lookups with pending/error feedback
- Client-side log clear button

### Fixed
- "Last: 2h ago" shown on fresh start; now correctly shows "Never run"

## [1.0.0] - 2026-03-29

### Added
- Initial release: Flask web UI, SQLite database, yt-dlp downloads, TikTokApi for profile info
- Tracked users, video downloads, deletion detection, username change tracking
- Docker and Docker Compose support

[Unreleased]: https://github.com/nikolainyegaard/tiktok-downloader/compare/v1.24.0...HEAD
[1.24.0]: https://github.com/nikolainyegaard/tiktok-downloader/compare/v1.23.0...v1.24.0
[1.23.0]: https://github.com/nikolainyegaard/tiktok-downloader/compare/v1.22.0...v1.23.0
[1.22.0]: https://github.com/nikolainyegaard/tiktok-downloader/compare/v1.21.1...v1.22.0
[1.21.1]: https://github.com/nikolainyegaard/tiktok-downloader/compare/v1.21.0...v1.21.1
[1.21.0]: https://github.com/nikolainyegaard/tiktok-downloader/compare/v1.20.1...v1.21.0
[1.20.1]: https://github.com/nikolainyegaard/tiktok-downloader/compare/v1.20.0...v1.20.1
[1.20.0]: https://github.com/nikolainyegaard/tiktok-downloader/compare/v1.19.2...v1.20.0
[1.19.2]: https://github.com/nikolainyegaard/tiktok-downloader/compare/v1.19.1...v1.19.2
[1.19.1]: https://github.com/nikolainyegaard/tiktok-downloader/compare/v1.19.0...v1.19.1
[1.19.0]: https://github.com/nikolainyegaard/tiktok-downloader/compare/v1.18.1...v1.19.0
[1.18.1]: https://github.com/nikolainyegaard/tiktok-downloader/compare/v1.18.0...v1.18.1
[1.18.0]: https://github.com/nikolainyegaard/tiktok-downloader/compare/v1.17.0...v1.18.0
[1.17.0]: https://github.com/nikolainyegaard/tiktok-downloader/compare/v1.16.4...v1.17.0
