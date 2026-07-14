# Changelog

All notable changes to this project will be documented in this file.

Forked from [tiktok-downloader](https://github.com/nikolainyegaard/tiktok-downloader) at v1.25.0.

## [Unreleased]

### Changed
- UI avatars (activity feed rows, creator cards) are served as small cached thumbnails generated on first request instead of the full-size originals, cutting avatar transfer size by orders of magnitude. Clicking an avatar still opens the full image
- Google Chrome is back in the amd64 image for TikTok bot detection resistance (its removal in the image slimming caused noticeably more aggressive bot detection); amd64 now ships Chrome instead of Playwright Chromium, arm64 keeps Playwright Chromium since Google publishes no arm64 Chrome build
- Front-end polish pass: keyboard focus rings on all buttons, links, and creator cards (cards now open with Enter or Space), a slash shortcut that jumps to the search box, slim dark scrollbars everywhere, subtle press feedback on buttons, and slightly brighter muted text for readability
- Dashboard rework: the Statistics panel is gone in favor of a full-width strip of stat tiles, the Recent panel is now a single chronological activity feed mixing saves, deletions, profile changes, and bans with type icons, creator avatars, and filter pills in the header (a Log button opens the expanded per-type history), and the loop and Add history panels stack in a column beside the feed. Panel headers are half as tall and the Statistics overflow scrollbar is gone
- Front-end redesign: a deeper blue-tinted dark palette with an ambient glow at the top of the page in the active platform's color, a sticky frosted-glass tab bar, elevated creator cards that lift on hover with accent-ringed avatars and a staggered entrance on first load, shimmer skeleton placeholders while the creator list loads (replaces the "No creators tracked yet" flash), stat tiles in the Statistics panel, accent dots on panel titles, softer rounded corners throughout, animated modal and tab transitions, frosted toasts, gradient primary buttons, a larger add bar with a focus glow, and fixed-width digits so countdowns and stats stop jittering
- The creator grid no longer rebuilds on every 15 second poll when nothing changed, which removes avatar and hover flicker; typing in the search box is debounced so fast typing filters once instead of per keystroke

### Added
- Bookmark flag on creators: toggled with a bookmark button next to the star button on cards and in the creator modal, shown as a small bookmark badge, and filterable via a new Bookmarked pill next to Starred. Unlike starring it has no effect on loops or check scheduling. Starring a creator also bookmarks it (existing starred creators are backfilled on launch), unstarring leaves the bookmark in place, and a starred creator cannot be un-bookmarked
- The Activity panel placeholder is now an Add history panel: every add attempt is stored permanently per platform and listed newest first with its status (looking up, added, or a failure shorthand like rate limit, bot detection, or not found; hover shows the full error), the list loads more entries on demand as you scroll, and existing tracked creators are backfilled into the history by their added date
- Failed adds persist across restarts and can be retried (re-runs the normal add flow, reusing the same history entry) or discarded via the retry and discard buttons on the row; lookups interrupted by a restart resume automatically on startup
- A pause toggle in every Loops panel header next to the next-session time: paused loops skip their scheduled sessions (the schedule keeps ticking, so resuming falls back into the normal cadence) while manual triggers and per-creator runs still work; the state survives restarts and the TikTok sound loop has its own toggle
- Story saving: the engine gains a stories pipeline every platform can hook into; TikTok fetches each user's live stories during regular checks (via the same web endpoint gallery-dl uses, logged-in cookies required) and saves new ones permanently under the user's stories folder, named by post timestamp; saved stories and a per-day calendar count are served by new API routes, and the channel list reports each user's live story count; a Diagnostics probe (TikTokApi > Live stories) tests story fetching against your cookies without waiting for a loop
- Channel databases gain account availability, privacy status, and viewer relations columns: groundwork for tracking bans, private accounts, and follow relations on every cookie-authenticated platform
- Twitter and Instagram creator modals get the Videos/Photos type filter and per-type thumbnail markers (photo grid glyph vs play glyph) in both list and grid view, matching TikTok
- Twitter account tracking backend: profile info, media timeline fetching, and media downloads via gallery-dl; accounts tracked by stable numeric user ID so handle changes are survived; retweets and quoted tweets are excluded
- Twitter cookies management in Settings > Twitter: upload a cookies.txt from a logged-in x.com session; required for timeline access and sensitive media
- Twitter pane in Settings > Diagnostics: fetch raw profile info or the first 5 media posts for any handle
- Deletion tracking, undeletion, profile change history, and avatar archiving for Twitter accounts, matching the TikTok behaviour
- Multi-media tweets are now fully viewable: a TikTok-style carousel steps through every photo and video of a post, backed by a new sibling-file listing endpoint on all channel platforms; the carousel now supports video slides
- Photo posts show distinct glyphs by image count on every platform: a picture-frame glyph for single photos and the grid-squares glyph for carousels, in both the list thumbnail badge and the grid view corner icon
- The Statistics panel on every platform shows the media storage size of that app's library in MB or GB (replaces Total likes on TikTok); the size is computed from the platform's media folder and cached for 15 minutes
- One unified add field per app, identical on desktop and mobile: a single smart bar (input, Paste button, Add) at the top of every platform tab; on TikTok it accepts usernames, profile URLs, sound IDs, and sound URLs and routes each to the right tracker, and on the other platforms it accepts handles and profile URLs; this also fixes mobile, where the non-TikTok apps previously had no add field at all
- Add feedback now lives in toast notifications: each lookup shows a spinner toast from "Looking up @name" until it lands as added or failed, lookups still running after a page reload get their toast back, sound adds show the same loading-to-result toast, and a failed lookup clears itself from the add queue once its error toast is shown; the status line and pending list under the add field are gone, closing the layout gap they left above the panels
- TikTok user modals show the next scheduled check time; starred user cards get a Priority badge
- TikTok sound cards show a "Last saved" timestamp next to "Last checked"
- TikTok detects accounts that have blocked the cookies account without revealing it in the profile relation: a profile reporting videos while both video sources return none is flagged Blocked, surfaced in the UI, and skipped until it recovers; a profile confirming zero videos is treated as a genuinely empty account and deletion tracking still runs
- TikTok posts can be saved from a direct URL pasted into the add bar, covering subscriber-only videos and anything else invisible in profile listings; the post downloads through the normal pipeline, associates with its author (added as an untracked stub when new), shows a Direct pill in the creator modal, and is exempt from listing-based deletion detection while still following ban handling
- The TikTok Loops panel now toggles between the User and Sound loops with pills in the panel header, so the panel is the same height as on the other apps instead of stacking both loops

### Changed
- Loop panels show at most the next 4 upcoming session times instead of every session in the 24 hour window, so a platform set to 12 sessions per day no longer fills the panel with pills; already-run sessions drop off instead of showing dimmed
- Dashboard panels have uniform heights on every app: Statistics and Recent share one fixed height, Activity and Loops another, with content scrolling inside the panel when it outgrows the card; stacked mobile panels keep their natural height
- The expanded Recent modals (Recently saved, deleted, changed, banned) open instantly: the first page of each list is prefetched in the background whenever the Recent panel data changes
- The modal close button is smaller and sits centered in short modal headers instead of touching the header divider
- The TikTok frontend now renders from the shared platform engine: the standalone TikTok implementation collapsed into a config over the engine plus TikTok-only extras (sounds catalog and sound modal, sound loop panel, stats backfill, jobs, diagnostics, migration); UI fixes now land once for all four apps
- TikTok-only UI features became engine features that appear on any platform whose data supplies them: relation and privacy pills, banned and blocked card styling, private-account lock icon, Priority badge on starred creators, pending re-scan notice on cards, session completed/total counts in the loop meta line, verified badge, join date, ban countdown, bio link, follower/following counts, old handles in search and display, and a next-check line in the detail modal
- Every platform's log console now appends new lines incrementally using the server's log sequence counter instead of rebuilding the console on each update; the log clear position survives reloads on all platforms the same way
- The profile history panel on every platform now shows old to new value diffs (the newest entry diffs against the current profile) with readable labels for status changes, and toggles closed when the profile updates counter is clicked again
- Recent panel entries open smarter on all platforms: a single-item saved or deleted group jumps straight to that item highlighted in the creator modal, grouped deletions show a count, and the catalog sort menu gained Last checked and Last saved
- Single-photo posts show the picture-frame glyph and open the image viewer directly on every platform; only true carousels get the grid glyph and the carousel
- Header cookies pill is now platform-aware: it reflects the authentication state of the active platform tab (TikTok cookies, Instagram session, Twitter cookies), hides on YouTube, and opens the matching Settings section when clicked
- Instagram and Twitter loops now use the TikTok-style session scheduler: check sessions are spread randomly across each 24-hour window, and each session only processes creators whose per-creator interval has come due (starred 6h, active 24h, inactive 72h by default; configurable per platform in Settings)
- Instagram and Twitter sessions shuffle the due list and add random gaps between creators instead of hammering profiles back to back
- Settings > Instagram and Settings > Twitter: the single loop interval field is replaced by the Loop Schedule panel (sessions per day plus starred/active/inactive check intervals); the `INSTAGRAM_LOOP_INTERVAL_MINUTES` and `TWITTER_LOOP_INTERVAL_MINUTES` env vars are replaced by `*_SESSIONS_PER_DAY` and `*_CHECK_HOURS` variables
- Instagram and Twitter loop panels now match TikTok's: Next, Starred, Half, and All trigger buttons with the same semantics (Starred primes and runs only starred creators; Half primes the 50% longest since last check; All primes everyone), plus the last-run meta line and session time pills
- Top platform tabs reordered to TikTok, Twitter, Instagram, YouTube; the Settings navigation matches
- Twitter, Instagram, and YouTube now render from a single shared frontend engine: identical creator cards, detail modals, filter bars, add forms, recent panels, and loop panels generated per platform from a config; changing the engine changes all three apps at once
- YouTube moved to the session scheduler: sessions spread across each 24 hour window, per-channel starred/active/inactive intervals, Next/Starred/Half/All trigger buttons, and the Loop Schedule settings panel; the `YOUTUBE_LOOP_INTERVAL_MINUTES` env var is replaced by `YOUTUBE_SESSIONS_PER_DAY` and `YOUTUBE_*_CHECK_HOURS` variables
- YouTube sessions shuffle the due list and add random gaps between channels, matching the other platforms
- Channel platform cards now match TikTok's users exactly: creator ID line, Quick and Full refresh buttons, and the Added / Last checked / Last saved meta footer; the detail modal gains the star, Quick, Full, and overflow menu buttons with the note field hidden behind "Add note"
- Quick and Full run modes for Twitter, Instagram, and YouTube: Quick fetches only the newest posts and skips deletion detection; Full fetches the whole list and runs the complete diff
- Scheduled sessions on the channel platforms now use the TikTok quick/full cadence: quick checks by default, with a full deletion-detecting check per creator every N days (new "Full check interval" setting, default 7 days, env `*_FULL_REFRESH_DAYS`)
- Full runs that find unconfirmed deletion candidates schedule an ASAP re-check; a deletion spike (25% or more of a creator's videos suddenly missing) skips deletion marks for that run to guard against truncated listings
- Channel sessions abort after 3 consecutive creator failures instead of hammering a rate limit or auth wall; failed creators stay due and retry next session
- Channel list APIs now return `last_saved` (most recent download) per creator
- One backend engine now runs all channel platforms: the twelve per-platform database, loop, tracker, and web clone files collapsed into shared engine modules plus one small adapter per platform; behaviour is unchanged and every future fix lands once for all platforms
- Each platform's loops, run queues, and log consoles are isolated engine instances; nothing is shared between platforms at runtime
- TikTok now runs on the same engine as every other platform: its database is migrated in place to the shared schema (users table renamed to channels, tiktok_id/username/bio/follower_count renamed to channel_id/handle/description/subscriber_count, videos type/description renamed to content_type/title) with an automatic backup written next to it before the first start; its API moves to the standard /api/tiktok/channels/... route shape; its user loop is the shared session scheduler and ChannelLoop; sounds, the stats backfill, photo serving, and the maintenance jobs remain TikTok-only extras on top of the engine
- The engine loop gained TikTok's full session feature set for every platform: run-start persistence with crash recovery, the inter-creator sleep indicator, session completed/total counts, and isolated midpoint re-scans on large deletion spikes
- The Recent panel and deletion history are TikTok-grade on all platforms: deletions grouped by creator, ban feed, and starred/banned name colouring
- The engine add flow now re-enables soft-disabled creator stubs (e.g. TikTok authors discovered via sound tracking) instead of rejecting them as duplicates
- Ancient tiktok-downloader one-time migrations (flat data/videos layout, del_ file prefixes, username_history backfill, ytdlp blob cleanup) were removed; upgrade to this version from v1.25.0 or later so those migrations have already run
- All filters across the app are now on/off toggles instead of single-choice selectors: the user and sound catalog filter groups, the status and type filters in every detail modal, and the profile history field pills; each pill toggles independently, several pills in a group combine (e.g. Public and Banned show both), turning everything off shows all, and the All pills are gone; toggle groups render as segmented bars where active segments tint with an accent underline, while view switchers keep the sliding pill; the catalogs default to Public, Private, and Active on (Banned, Blocked, Inactive, and Starred off) on page load and Reset, and users whose privacy is not yet known count as Public so new adds stay visible
- An Activity panel placeholder sits left of the Loops panel on every platform, reserved for a downloads-per-day line chart
- The desktop Track a user and Track a sound panels are gone on every platform, replaced by the unified add bar at the top of the tab; the Loops panel takes the full row; TikTok sound labels are now set after adding via the sound card's Edit label action

### Fixed
- The User/Sound loop switcher in the TikTok Loops panel highlights the selected pill again; it switched the view but left the slider on the previous pill
- TikTok story expiry now reads the millisecond ExpiredAt field TikTok actually sends instead of relying on the post-time-plus-24h fallback
- The Uploaded column in the creator modal shows the time of day again on TikTok, Twitter, and Instagram; the engine fold-in had switched every platform to YouTube's date-only format, even though those three APIs provide full timestamps
- The mobile page no longer overflows the screen edge: the engine fold-in left several mobile style rules pointing at the old static TikTok element names (toolbar wrapping, full-width search, compact modal header), and the page grids now cap their tracks so no single wide element can stretch every panel past the viewport
- Very long text in the add field no longer stretches the input and the page with it; the field keeps its size and clips the text like a browser URL bar, showing the end of the text when unfocused
- The All Deleted history modal on Twitter, Instagram, and YouTube crashed on open; the endpoint returns grouped entries but the shared modal had no grouped renderer
- The shared frontend engine script is now served with a content-hashed URL like the other assets, so browsers pick up engine changes after a deploy instead of running stale cached code
- Pressing Escape with the settings modal or a history modal open above a creator detail modal no longer closes both at once; overlay keyboard handling now lives in one global handler
- Sorting TikTok users by follower count works again; the sort dropdown still submitted the pre-migration field name, so every user compared equal and the order never changed
- Instagram and Twitter databases are now included in the nightly backup rotation; previously only TikTok and YouTube were backed up
- Twitter and Instagram avatars are now cached and shown on creator cards; the avatar cache only supported TikTok and YouTube, so Twitter profile fetches silently dropped the profile picture
- YouTube no longer reports a false handle change to an empty value on every loop: the channel profile fetch could return an unresolved result with no metadata, and an empty field is now treated as missing instead of a change
- YouTube channel display names no longer fall back to the channel ID; a sparse profile fetch also no longer wipes a stored display name or description on any channel platform
- YouTube profile fetches now work for channels without a videos tab (e.g. shorts-only channels): those returned no metadata at all from the plain channel URL, which was the source of the empty handle and channel-ID display name bugs; the fetch now uses the /featured tab with a fallback
- Twitter, Instagram, and YouTube log consoles now colorize lines (session separators, processing, errors, warnings, downloads, profile changes) like the TikTok log console
- YouTube Diagnostics now also returns the parsed channel profile and its raw metadata alongside the video entries
- Twitter photo posts are no longer treated as videos in the web UI: photo thumbnails open the image viewer instead of the video player, the Download button saves the file under its real extension instead of a broken .mp4, and photos are served with an image mimetype
- Pressing Escape with a media overlay open (carousel, image viewer, video player) on a channel platform no longer also closes the creator modal underneath it
- Video list responses no longer include the large raw metadata blobs (ytdlp_data, raw_video_data, chapters); on YouTube channels with many videos these forced SQLite to read megabytes per request just to discard them
- The TikTok log console no longer goes blank after an app restart when logs had been cleared earlier: the persisted clear position pointed past the restarted log counter and silently hid every new line until the counter caught up

## [0.4.0] - 2026-06-29

### Added
- OAuth2/OIDC authentication: configure and enable via Settings > Authentication; works with Authentik and any standard OIDC provider; disabled by default so existing deployments are unaffected
- Security response headers on all responses: `Content-Security-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`; `Strict-Transport-Security` added when OAuth is enabled
- `form-action 'self'` directive added to the CSP: restricts form submissions to the same origin; `form-action` does not fall back to `default-src` so it must be declared explicitly
- `Cache-Control: no-store` on all HTML and API responses that do not already set a cache header; hashed static assets keep their existing `public, max-age=31536000, immutable` header
- `X-Powered-By` header stripped from all responses in `_security_headers`
- `bio_link` storage and change tracking: new `bio_link` column on `users` table; extracted from `bioLink.link` in the TikTok API response; tracked as a profile change field alongside username, display name, and bio; displayed as a clickable link in the user modal below the bio
- `relation` column on `users` table: stored from the profile fetch; drives relationship pills on user cards and modals ("Friends" for mutual follow, "Following", "Follows you")
- `UserBlockedException`: raised when TikTok returns `statusCode 10222` with `relation` 4 or 5 (this user has blocked the cookies account); sets `privacy_status='blocked'`, shows an orange "Blocked" pill, dims and red-borders the card; filterable via a new "Blocked" filter pill on the Users view
- Padlock icon next to display name on user cards and in the user modal for all private account states (`private_accessible`, `private_blocked`, `blocked`)
- `resolve_username` diagnostics action (TikTok API source): resolves a TikTok username to `tiktok_id` and `sec_uid` via raw API; result includes a quick-link to chain directly into "User profile by ID"
- Audio-only post handling: TikTok posts with no video or photo stream are detected when yt-dlp resolves to an audio file extension; recorded in the database with `type='audio'` and no file path so the loop does not retry them; applies to both the user tracker and the sound tracker

### Changed
- Docker image: `playwright install --with-deps` now cleans apt package lists within the same layer, reducing committed layer size; Google Chrome amd64 installation also removed (was a separate step)
- User card and modal account badge replaced by `_relationPill()`: banned and blocked show coloured pills; `private_blocked` shows a grey "Private" pill; mutual/following/follows-you show a grey relationship pill; `relation=0` shows "No relation"; accounts with no relation value in the DB show "-"
- Tracking enabled/disabled badge labels changed from "Active"/"Inactive" to "Tracked"/"Untracked"
- User modal: "Run Profile" and "Add note" moved into a `•••` overflow menu alongside "Remove"; note textarea is hidden by default and toggled via "Add note"
- Diagnostics panel output area uses flex layout to fill available panel height instead of a fixed `max-height: 420px`
- Diagnostics "User profile by username" action now returns raw API JSON via `make_request` instead of calling `get_user_info`; matches the behaviour of "User profile by ID" and never throws on private accounts
- `private_blocked` user cards now show a muted yellow border; `blocked` cards share the red border treatment with `banned`
- yt-dlp format string for TikTok downloads: added `/best` as a final fallback so audio-only posts resolve to an audio file instead of erroring with "Requested format is not available"
- item_list page progress log simplified to `Page N: M items` (was `[item_list] page N fetched (M videos)`) and now appears in the UI console (was log-file only)
- `statusCode 10222` handling in `get_user_info`: falls through and returns profile data normally when `userInfo.user.id` is populated; TikTok provides full profile data for private accounts when a follow relationship exists; raises `UserPrivateException` only when no user data is present
- Private account accessibility check changed from `relation & 1` bitmask to `relation not in (1, 2)` enum; `relation=2` (mutual follow) previously evaluated to `2 & 1 = 0`, incorrectly treating mutual-follow private accounts as inaccessible

### Fixed
- OAuth login redirect race: multiple concurrent API polling calls all receiving 401 on page load each triggered `window.location.href = '/login'`, overwriting the OAuth state in the session each time; `_loginRedirectPending` flag in `apiJSON` ensures only the first 401 triggers the redirect
- Private accounts where the cookies account follows them (relation=1) or has mutual follow (relation=2) were not having profile data fetched or stored; both the sec_uid path and the username fallback path in `get_user_info` unconditionally raised `UserPrivateException` on `statusCode 10222` regardless of whether `userInfo` was populated; affected accounts showed no relationship pill and profile data was never updated despite the cookies account having follow access
- Bio and bio_link overwritten to empty on every run for private accounts; TikTok returns `signature=""` in `statusCode 10222` responses regardless of follow relationship; tracker now preserves the stored DB value when the API returns empty for a private account, and skips recording a profile change for those fields
- Audio-only posts were retried on every loop run; `download_video` returned `None` for audio files so the tracker never called `db.add_video`; the post never entered `known_ids` and appeared as new on each cycle; fixed by returning `{"audio_only": True}` from `download_video` and recording the post in the database with `type='audio'`
- `relation` column migration used `NOT NULL DEFAULT 0`, causing all pre-existing users to show "No relation" instead of "-" until the loop checked them; default is now `NULL`

## [0.3.0] - 2026-06-22

### Added
- Session-based TikTok user loop: replaces the fixed-interval loop with N sessions per 24-hour window (default 4), each firing at a random time within its equal segment; sessions only process users whose `next_check_at` has elapsed, so the workload scales naturally with the number of tracked users
- Activity scoring for check intervals: starred users checked every 6h, active users (posted within 30 days) every 24h, inactive users every 72h; intervals recomputed after each session; configurable via settings UI or env vars
- Quick vs full refresh split: normal session checks use quick mode (first ~30 videos, no stats upsert); full item_list stats refresh runs on a weekly cycle per user; mode determined by `full_refresh_pending` flag set by the batch scheduler
- Weekly full-refresh batch cycle: users are divided into 7 equal batches sorted by `last_full_refresh_at`; one batch is activated per day so item_list calls are spread evenly across the week instead of hitting all users at once
- Five new DB columns on `users`: `next_check_at`, `check_interval_secs`, `last_video_at`, `last_full_refresh_at`, `last_quick_video_ids`; two batch columns: `full_refresh_pending`, `refresh_batch`
- New settings: `sessions_per_day`, `high_priority_check_hours`, `active_check_hours`, `inactive_check_hours`, `stats_refresh_days` (UI + env vars)
- Session timeline pills on both the user loop card and the sound loop card: shows today's scheduled session times with done/running/next visual states
- Live sleep countdown bar pinned to the top of the TikTok log panel: counts down the current inter-user or cooldown sleep in place (no new log lines), shows an "up next" label with the next user and check mode; when idle, counts down to the nearest scheduled user or sound loop session
- Next, Starred, Half, and All trigger buttons replace the single "Run Now" button on the TikTok user loop card; Next runs whoever is due without forcing a full refresh; Starred triggers a full refresh for starred users only; Half triggers a quick check for the 50% of users longest since their last check; All triggers a quick check for all enabled users without setting full_refresh_pending to avoid rate limit overload
- Content-hash asset URLs: `style.css`, `common.js`, `tiktok.js`, and `youtube.js` are served at `/assets/<name>-<8-char-hash>.<ext>` with `Cache-Control: immutable`; hashes computed at startup so Cloudflare and browser caches are busted automatically on each new deploy without a build step
- "Last saved" timestamp on TikTok user cards, showing when the most recent video from that user was downloaded (derived from `MAX(download_date)` in `get_all_video_stats`); displayed below "Last checked" in the card footer
- "Last checked" and "Last saved" sort options for the TikTok user view, both defaulting to newest first
- Star, Quick, Full, Run Profile, and Remove action buttons in the TikTok user detail modal header, alongside the existing tracking toggle; Quick and Full match the per-user card buttons; the star button re-renders the modal header to reflect the updated state; Remove closes the modal before reloading
- Scheduled daily database backup: both `tiktok.db` and `youtube.db` are copied to `data/backups/` at midnight each day using the SQLite backup API; a backup also runs immediately on startup; backups older than 14 days are pruned automatically
- Position-aware deletion detection in quick mode: stores the ordered video ID list from each quick fetch in `users.last_quick_video_ids`; on subsequent quick checks, videos missing from the window that cannot be explained by new posts scrolling older ones off the bottom are flagged as deletion candidates
- Fast follow-up full re-check: after a full-mode run that finds any non-large deletion candidates (fewer than 10), `next_check_at` is reset to NULL so the user is processed again in the next session to confirm or clear the pending deletions; runs with 10 or more deletions use the midpoint re-scan path instead
- item_list page-progress log line emitted after every 30 videos fetched during a full run: `[item_list] page N fetched (M videos)`; visible in the log panel during full runs and useful for diagnosing session degradation on large accounts
- Large deletion spike isolation: when 10 or more deletions are detected in a single full run, a dedicated full re-scan is automatically scheduled to fire at the midpoint between the current run and the next scheduled session (minimum 60 seconds, default 30 minutes if no next session is known); the re-scan uses a fresh dedicated session via the same path as the "Run Full" button, avoiding shared-session degradation that can cause false confirmations on large accounts
- Pending re-scan badge on user cards: a yellow countdown pill showing when the isolated midpoint re-scan will fire; cleared automatically if a manual run is triggered for the same user before it fires
- `UserPrivateException`: TikTok error 10222 (USER_PRIVATE) is now a distinct exception from `UserBannedException`; the private path still attempts the item_list fetch instead of treating the account as banned, enabling recovery when access is restored
- `UserBannedException` extended to cover status codes 10202, 10221, 10223, and 10225 (was 10202 and 10223 only); status code 10102 (stale session) now raises `ValueError` instead of a ban exception
- Track-user flow for sound-discovered users: `POST /api/tiktok/users/<tiktok_id>/track` endpoint and `openUntrackedUserModal` frontend modal for adding a user discovered via the sound tracker without leaving the sounds view
- Lazy-batch rendering for user cards: cards render in batches of 9 as the user scrolls via IntersectionObserver, replacing the previous all-at-once render; reduces jank on large libraries
- Starred usernames highlighted in yellow in the Recents panel and recent-log modals
- Banned usernames highlighted in red in the Recents panel and recent-log modals; `account_status` added to all Recents queries so ban status is available in every section, not just the Recently Banned block
- `recover_loop_state_from_db()`: on startup, if the state file has no run history, infers `last_run_end` from `MAX(last_checked)` so the loop panel shows a meaningful "Last" time after an upgrade
- Loop state persisted on clean shutdown via `atexit`: `_shutdown_save()` writes the in-progress run duration so the "Took" display is accurate after `docker compose down`
- New trigger API endpoints: `POST /api/tiktok/trigger/next`, `/trigger/half`, `/trigger/all` (matching the four new loop card buttons)

### Changed
- TikTok deletion tracking schema: `pending_deletion_count` and `pending_deletion_since` columns replaced by `deletion_confirmed INTEGER` and `false_positive_count INTEGER`; first absence now sets `status='deleted', deletion_confirmed=0, deleted_at=now`; second consecutive absence sets `deletion_confirmed=1`; a video that returns before confirmation is silently reverted to `status='up'` and `false_positive_count` is incremented; `deleted_at` now reflects when the video was first noticed missing (was: when it was confirmed); ban deletions set `deletion_confirmed=1` immediately; existing rows migrated automatically on first startup
- Loops panel trigger buttons: removed "Run" prefix, added refresh icon to match the user card Quick/Full button style; labels are now "Next", "Starred", "Half", "All"
- Unconfirmed deleted videos (`status='deleted', deletion_confirmed=0`) now display identically to confirmed deleted videos in the frontend: same "Deleted" label, same red colour, counted together in user card and modal stats, included in the "Deleted" filter pill; the "Missing" filter pill is removed entirely
- Per-user run buttons on user cards and the user modal split into Quick and Full; Quick fetches the first 30 videos only and skips the stats upsert (matching the session loop's quick-check mode); Full is the previous behavior and does not advance the weekly full-refresh cycle any sooner
- TikTok user cards: "Last checked" and "Last saved" moved from the button row into a slim meta footer below a faint divider, alongside a new "Added" date field; the three items are shown as uppercase label / value column pairs
- Relative timestamps (Last checked, Last saved, loop run times, etc.) now show two components instead of collapsing to hours: `Xmo Yd`, `Xd Yh`, `Xh Ym`, `Xm`, `Xs`
- Inter-user gap within a session changed from uniform 2-5s to exponential distribution (mean 90s, min 15s) to better mimic organic browsing behavior and reduce bot detection
- Log panel scrolls to the bottom automatically when the Log tab is opened
- Manual trigger (Starred / Half / All) no longer lights up the next scheduled session pill as running; that pill represents the scheduled session time, not the manual trigger
- Recently deleted Recents panel and modal now groups consecutive same-user deletions with a count badge (e.g. `@handle 3x`), matching the Recently Saved grouping logic; single-entry rows highlight the video directly, multi-entry rows open the user deletion modal
- Recents panel grouped-response detection in common.js is now dynamic: dispatches on `{items, rows_consumed}` response shape rather than checking the endpoint type, so any future grouped endpoint works without frontend changes
- Usernames in the Recents panel and modals are now left-aligned within their column (was centered)
- Recents panel grid changed to 2fr 3fr 1fr: date gets 2/6, username gets 3/6 (left-aligned text centered between the outer columns), detail gets 1/6
- Profile change field labels shortened: "Username" to "Handle", "Display name" to "Name", "Account status" to "Status", "Privacy status" to "Privacy"
- Sounds catalog grid pads to a minimum of 9 ghost cards, matching the Users tab; prevents the page from jumping upward when switching tabs with few sounds tracked
- `get_recent_activity()` deletion query now scans up to 300 rows (was LIMIT 3) to feed server-side grouping before the panel renders

### Fixed
- Loops panel "Last:" showed the time the loop completed, not when it started; loop start time is now written to `loop_state.json` at session start and used for the display; a service killed mid-run still shows the start time of the interrupted run on next startup
- Stop button did not interrupt a user mid-download; the stop event is now checked between individual video downloads inside `process_single_user`, so pressing Stop takes effect after the current download finishes rather than after all downloads for the current user finish
- Recently deleted panel showed nothing after the frontend collapse of "possibly deleted" into "deleted" display; root cause was the pending-deletion schema refactor below
- Startup crash (`sqlite3.OperationalError: near ")": syntax error`) caused by a trailing comma left in the `CREATE TABLE users` statement after removing the `pending_ban_count` and `pending_ban_since` columns
- YouTube loop state file corrupted on crash: `_save_state()` opened the file with `"w"` before writing, truncating it immediately; a crash mid-write left an empty or partial JSON file and lost all loop state on next startup; now writes to a `.tmp` file and atomically renames it (matching the TikTok loop)
- Banned 10222 private accounts not recovering when videos become accessible: `UserPrivateException` bypasses the profile-level recovery block; account stayed `banned` in the DB even after item_list returned videos and undeleted them; recovery now runs at the post-fetch point when `_was_banned` and `is_private` and `remote_ids` are all true
- `tracking_enabled` not restored when a banned account recovers: the ban recovery block called `restore_banned_videos` and `set_user_account_status("active")` but not `set_user_tracking_enabled(True)`; accounts auto-disabled after 14 days stayed in no-track state permanently after recovery
- "Last checked" not updating for banned accounts: the `UserBannedException` path returned before `update_user_info` was called; now stamps `last_checked` unconditionally before returning
- "Last checked" not updating for inaccessible 10222 private accounts: `update_user_info_from_item_list` was gated on item_list returning data; when item_list returns nothing (access lost), `last_checked` was never written; now stamped via `touch_user_last_checked` in that path
- Banned users sorted to the front of every session: `get_users_due_for_check` sorted by `last_checked ASC` but `last_checked` is never written on the ban path, so banned users had a permanent sort advantage; now sorts by `next_check_at ASC` which is always written after every processed user
- Quick-mode false "Possibly deleted" log spam: deletion diff ran in quick mode against all known videos, but quick mode only fetches the first ~30; all other known videos were flagged missing; deletion diff is now skipped entirely in quick mode
- Log viewer stopping after 1000 lines: the client used `lines.length` as the slice index; once the server buffer filled to 1000 the slice was always empty; fixed with a monotonic `_log_seq` counter that increments on every log call and is returned in the status response so the client tracks position independently of buffer size
- Manual trigger consuming a scheduled session slot: session slot was always popped on wake regardless of whether the wake was manual or scheduled; now only popped on scheduled wakes
- Session timeline pills showing 12h AM/PM time; now 24h
- Profile change log lines not colored pink in the log panel; coloring regex was expanded to match "Profile change:" lines

### Removed
- `get_cookies_for_playwright()` from `platforms/tiktok/config.py`: defined but never called anywhere
- `pending_ban_count` and `pending_ban_since` columns from the TikTok `users` table schema and migration list: columns were never read or written by any database function
- `PlatformAdapter` base class (`platforms/base.py`): never subclassed; both trackers call platform API functions directly
- YouTube one-time migration block and `_one_time_backfill_ytdlp_columns()` from `platforms/youtube/database.py`: YouTube has never shipped so no database in the wild needed this migration; it was a permanent no-op
- `mark_video_deleted()` and `mark_video_undeleted()` from `database.py`: replaced by `mark_video_possibly_deleted()`, `confirm_video_deletion()`, and `revert_or_undelete_video()` to match the new two-step deletion schema
- `deletion_confirm_threshold` field removed from the `/api/tiktok/status` response: threshold is now an internal constant, not exposed to the frontend

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
[0.3.0]: https://github.com/nikolainyegaard/social-downloader/compare/v0.2.1...v0.3.0
[0.4.0]: https://github.com/nikolainyegaard/social-downloader/compare/v0.3.0...v0.4.0
[Unreleased]: https://github.com/nikolainyegaard/social-downloader/compare/v0.4.0...HEAD
