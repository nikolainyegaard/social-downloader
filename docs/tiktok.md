# TikTok

TikTok runs on the shared engine with its own session processor (`process_session` override) plus the sound loop and job extras registered by its adapter. Read this before touching anything under `platforms/tiktok/`.

## Database: ChannelDB + store.py

TikTok has no database module of its own. `ChannelDB("tiktok")` owns `DATA_DIR/tiktok/tiktok.db` on the shared schema; `TikTokStore` (constructed with that ChannelDB) holds what the engine has no equivalent for: sound tables, stats backfill, ban/privacy handling, refresh batches. `platforms/tiktok/migrate.py` folds a pre-engine DB into the schema at startup (see the fold-in note below). TikTok-only tables `sounds` and `sound_videos` are created by `TikTokStore.init_tables()` via the adapter's `init_db_extra` hook. The legacy `username_history` table survives the migration; new writes go to profile_history.

```
channels (engine columns + TikTok extras):
  channel_id TEXT PK, handle, display_name, description,
  subscriber_count, following_count, video_count, join_date,
  verified, avatar_url, raw_channel_data, bio_link, relation, profile_fail_count,
  sec_uid,                         TikTok's stable secondary ID
  account_status (active|banned), banned_at (COALESCE, never overwritten),
  privacy_status, viewer_relations, added_at, last_checked,
  enabled, tracking_enabled, starred, bookmarked,
  pinned_at,                       Quick Access pin; NULL = unpinned, set time orders the row
  last_video_at, next_check_at (NULL = due immediately), check_interval_secs,
  last_full_refresh_at,
  last_quick_video_ids,            dead: retired with the yt-dlp deletion redesign, accessors removed
  full_refresh_pending, refresh_batch   TikTok's daily full-refresh batch cycle

videos:
  video_id TEXT PK, channel_id FK, content_type (video|photo|audio),
  title, upload_date, download_date, file_path,
  status (up|deleted|undeleted), deleted_at, undeleted_at,
  deleted_reason (video_deleted|user_banned|NULL),
  deletion_confirmed INTEGER NOT NULL DEFAULT 0,   TikTok model: 0 = first absence, 1 = confirmed
  false_positive_count, direct_added,
  view/like/comment/share/save/repost counts, duration, width, height,
  music_title, music_artist, music_id, raw_video_data, ytdlp_data,
  stats_backfilled_at, stats_updated_at, stats_error_count, stats_last_error

sounds:        sound_id TEXT PK, label, comment, added_at, last_checked, enabled,
               tracking_enabled, starred
sound_videos:  sound_id FK, video_id FK, added_at; PK (sound_id, video_id)
```

Indexes from `store.init_tables()`: `idx_sound_videos_sound`, `idx_videos_channel_id`, `idx_videos_status`, `idx_profile_history_channel_id`, `idx_videos_stats_backfilled_at`, `idx_channels_next_check_at`.

`TikTokStore` specifics:
- Deletion model: `mark_video_possibly_deleted` / `confirm_video_deletion` / `revert_or_undelete_video` are thin delegates to the engine ChannelDB, which owns the shared two-strike model (see backend.md); TikTok pioneered it and the engine platforms adopted it
- `add_video_full(...)` sets `stats_backfilled_at` only when `view_count IS NOT NULL`, leaving NULL for backfill (`ChannelDB.add_video` is the generic insert)
- `update_video_stats` (backfill worker, always stamps) / `update_video_stats_loop` (loop byproduct, COALESCE, stamps `stats_updated_at` and `stats_backfilled_at = COALESCE(..., now)`)
- Ban lifecycle (`set_account_status`, `ban_channel_videos`, `restore_banned_videos`, `touch_last_checked`) lives on the engine ChannelDB; the TikTok tracker calls it there directly
- `get_videos_missing_stats()`: `stats_backfilled_at IS NULL AND stats_error_count < 3 AND file_path IS NOT NULL AND status NOT IN ('deleted','undeleted')`, joined to channels
- `ensure_sound_channel(channel_id, handle, sec_uid=None)` inserts with `enabled=0`
- Scheduler extras: `assign_refresh_batches(n_days)`, `activate_refresh_batch(batch_num)`, `clear_full_refresh_pending(channel_id)`
- Profile helpers: `update_channel_profile`, `update_channel_from_item_list` (10222 private accounts), `update_privacy_status`, `set_channel_relation`, `increment_profile_fail_count` / `reset_profile_fail_count`, plus sound CRUD and backfill error helpers

**Legacy schema fold-in, keep it:** `migrate.py::migrate_legacy_tiktok_schema(db_path)` runs at startup before init_db and folds a pre-engine TikTok DB into the shared schema in place: users to channels, plus column renames (tiktok_id to channel_id, username to handle, bio to description, follower_count to subscriber_count, raw_user_data to raw_channel_data, videos.type to content_type, videos.description to title), writing a backup copy next to the DB first. Single transaction, no-op when no `users` table exists. Keep it until no deployment can still be running a pre-engine database.

## api.py

| Task | Method | Why |
|------|--------|-----|
| Profile (primary) | profile page read in the session's browser | Reads the `__UNIVERSAL_DATA_FOR_REHYDRATION__` blob; TikTok serves the page while the signed JSON endpoint returns empty bodies |
| Profile (fallback) | TikTokApi `/api/user/detail/` | Resolves by secUid alone; kept so the code self-heals if it answers again |
| Video list for deletion | yt-dlp flat extraction (`tiktokuser:{id}`) | Reliable full current set, incl. followed-private accounts (cookies carry the follow). Runs every check, in parallel; sole authority for deletion |
| Stats enrichment (primary) | profile page sniff | Captures the `/api/post/item_list/` responses the page's own frontend requests while scrolling. Adds view/like counts, photo type, image URLs yt-dlp lacks |
| Stats enrichment (fallback) | TikTokApi item_list | The constructed endpoint, kept for self-healing |
| Video detail / stats | curl_cffi page scrape | New videos not in item_list; stats backfill |
| Live stories | TikTokApi story/item_list | Same endpoint gallery-dl uses; needs logged-in cookies |
| Story download | yt-dlp on `/@handle/video/{id}` | yt-dlp fetches the page itself so the media URL is signed for its own request. Must be `/video/`, not `/story/`. Direct CDN GETs are the fallback and the path for photo stories |
| Downloads | yt-dlp (video), requests (photos) | yt-dlp returns audio only for photo posts |

`UserBannedException`: raised on TikTok `statusCode 10202`.

**`async create_tiktok_session(api, ms_token=None, cookies=None, **overrides)`**
- The single create_sessions call every TikTok browser session goes through (tracker, sounds, add lookups, diagnostics). Session-shaping changes (stealth, warmup, headed mode) belong here, never at call sites
- One persistent Chrome profile at `data/tiktok/browser_profile` via TikTokApi's `browser_context_factory` hook (needs TikTokApi>=7.3, pinned), so TikTok sees the same device across runs
- Chrome cannot run two processes on one user-data-dir, so a non-blocking profile lock serializes access: the first session (in practice the loop) gets the profile, concurrent sessions fall back to an ephemeral context. The lock frees on the context close event, the caller frees it on a create_sessions failure before the context exists, and release is idempotent
- Under patchright it passes a `page_factory` that skips TikTokApi's vendored stealth JS patches
- Headed when a working X display exists: `_headed()` connects to `/tmp/.X11-unix/X{n}` rather than trusting DISPLAY (the env var is baked into the image, a stale socket file survives a docker restart, and a dead Xvfb must degrade to headless). Local dev on a Linux desktop shows visible Chrome windows, so unset DISPLAY there. Playwright auto-adds `--no-sandbox` as root
- Ends with `_warmup(api)`: seconds of randomized dwell, mouse drift, and scrolling before the first API call. Best-effort, never fails the session

**`async get_user_info(api, username=None, sec_uid=None) -> dict`**
- Primary: profile page read in a fresh tab (`_fetch_page_user_detail`). Fallback: `api.make_request()` on `/api/user/detail/` with `secUid` and empty `uniqueId` (survives renames, bypasses the library's username guard). Final tier: username-only `user.info()` for first-time adds
- Rename vs ban disambiguation: a not-found page for a user with a stored sec_uid is never trusted directly. The endpoint, an item_list probe (`_recover_handle_via_items`), and a yt-dlp probe (`_recover_handle_via_ytdlp`: one flat entry off `tiktokuser:{sec_uid}`, returns `(handle, listed)`) answer first. The yt-dlp tier matters because the other two are constructed requests TikTok blanks. Queried by secUid, yt-dlp often never learns the handle and builds entry URLs from the secUid, so candidates echoing it (or any prefix, the URL regex truncates at the first '-') are rejected; `listed` still reports that videos exist. When entries exist but carry no handle, the probe scrapes the first listed video's page (`get_video_details` with the "user" placeholder, curl_cffi, no browser) and takes the author's uniqueId after verifying secUid. A recovered handle gets a fresh page read. When videos are listable but no page resolves, it raises a plain RuntimeError (transient) instead of reading as a ban; the check proceeds and the tracker's listing-based restore (`_was_banned and remote_ids and (is_private or not _profile_ok)`) clears the stale ban in the same pass. The profile-success restore clears `_was_banned` after firing so the listing-based restore cannot log a second restore in the same check

**`async get_user_videos_browser(api, username, sec_uid, max_count=2000, expected_count=None, stop_event=None) -> (list[dict], bool)`**
- Drives the profile page in a fresh tab and sniffs the item_list responses (shared `_sniff_item_list` core with the sound loop's music page sniff)
- Also harvests items SSR'd into the rehydration blob (`_read_profile_blob_items`) and merges them in front: the blob carries the grid's top (pinned posts, newest rows) and the page's own requests can skip that batch
- Items pinned to sec_uid via the author field; same normalised shape as `get_user_videos_with_stats`
- `complete=False` (stall before the natural end) must not feed deletion tracking. `expected_count` (the profile's video_count) upgrades a stalled listing to complete when at least that many were captured, covering catalogs whose grid finishes without a final empty page; it never cuts the scroll short

**`async get_user_videos_with_stats(api, sec_uid, max_count=2000, stop_event=None, logd=None) -> list[dict]`**: the constructed item_list endpoint, now the fallback. Pages `/api/post/item_list/`, random 1-3 s sleep every 10 items. `sec_uid` required, else a redundant round-trip returning 0 results.

**`get_user_videos(tiktok_id, sec_uid=None, cookies_path=None) -> list[dict]`**: synchronous yt-dlp. Tries `tiktokuser:{sec_uid}` first (avoids the internal resolution step that fails after a rename), then `tiktokuser:{tiktok_id}`.

**`async fetch_sound_video_ids(sound_id) -> list[str]`**: runs on the single browser turn via `run_browser_job`; sniffs the music page for up to 3000 IDs (`_sniff_music_item_list`), constructed `sound.videos()` as fallback; raises rather than returning a truncated listing.

**`get_video_details(video_id, username, cookies) -> dict`**: synchronous, curl_cffi impersonating Chrome. `username` may be `"user"`; TikTok redirects `/@user/video/{id}` to the canonical URL.

## tracker.py

Per-user flow:
1. Random exponential gap between users (mean `TIKTOK_SESSION_GAP_MEAN_SECS`, default 90 s, floor 15 s; not for manual runs)
2. Shared TikTokApi session created once before the loop, `sleep_after=3` + full cookie jar
3. Profile via `get_user_info`. Compare handle/display_name/bio/bio_link with the DB, record changes, `cache_avatar()` (bio and bio_link comparison skipped for private_blocked and currently-private accounts, since TikTok hides the bio there; username, display name, and avatar still tracked)
4. Ban handling: `UserBannedException` bans all videos; previously banned and now accessible restores them and resets status; banned 14+ days with `tracking_enabled=1` auto-disables once
5. Deletion source, every check and both modes: `get_user_videos` via `asyncio.to_thread`, launched here so it overlaps the browser fetch. Sole authority for deletion (see below). Do NOT re-add a private-account skip: accounts we do not follow already returned earlier as inaccessible
6. Stats enrichment, parallel with step 5: `get_user_videos_browser`, then `get_user_videos_with_stats` as its fallback. Fills `item_list_map` with view/like counts and new-video details. An incomplete or failed sniff is not fatal since it does not drive deletion. Skipped without sec_uid
7. Diff: `remote_ids` = union of both sources (drives new_ids and undeletions); `present_ids` = the yt-dlp set only (drives deletion). Deletion runs only when `_should_run_deletion` passes
8. New videos: item_list details when available, else `get_video_details()`. Download, then `store.add_video_full`, then `db.update_video_downloaded`. Video thumbnails are generated inside `downloader.download_video`; the tracker calls `generate_thumbnail` itself only for photo posts. Audio-only posts are recorded with content_type 'audio' and no file so they are never retried
9. Deleted: `mark_video_possibly_deleted`, then `confirm_video_deletion` on a second consecutive absence
10. Undeleted: `revert_or_undelete_video` immediately, no threshold
11. Stats upsert: `update_video_stats_loop()` for known videos in item_list (quick covers the page it fetched, full covers all)

**DB ordering:** `add_video_full()` is called AFTER a successful download, so failed downloads leave no orphaned rows.

**Single-post saves:** `save_video_by_id(vid_id, cookies, log, prefix="")` returns 'saved' | 'audio' | None. It fetches details, ensures the author's channel row (enabled=0 when new), downloads, and records one post; shared by the sound loop and by `run_direct_video(engine, vid_id, log)` behind `POST /api/tiktok/videos/direct`. Direct-added posts get `videos.direct_added = 1`, excluded from active/pending sets and sound deletion queries so diffs never flag them; ban handling still covers them since bans mark per channel.

## sounds.py

`SoundLoop`, singleton via `get_sound_loop(engine)`: own state dict at `data/tiktok/sound_loop_state.json` (legacy `sound_*` keys in loop_state.json as fallback), own `trigger_event`, `reschedule()` / `check_and_clear_reschedule()`, manual-run queue + worker, a fixed-interval `scheduler_thread()` with smart avoidance of the user loop, and pause via `sound_loop_paused`. `get_state()` merges `sound_loop_*` keys into the TikTok /status payload.

Sound tracking details:
- `get_video_details` is called with `username="user"`: TikTok redirects `/@user/video/{id}` to the canonical URL and curl_cffi follows it
- `ensure_sound_channel()` inserts sound-discovered users with `enabled=0`, and the channel queries filter `WHERE enabled = 1`. To fully track one: remove the row, then add via the UI. Their videos stay on disk

---

# TikTok decisions and gotchas

## Page-initiated requests vs constructed requests

TikTok answers requests its own page JS initiates while returning empty bodies to constructed calls signed through the same session (`make_request` and the generators on it). Every listing surface is therefore tiered: browser read or sniff primary, constructed endpoint as a self-healing fallback. Profile = page read (`_fetch_page_user_detail`), user videos = profile page sniff (`get_user_videos_browser`), sounds = music page sniff (`_sniff_music_item_list`). All three share the rules: a dedicated tab (never the session's signer page, navigating it mid-evaluate kills the session) and an incomplete listing never feeds deletion tracking.

Sniff semantics (shared `_sniff_item_list`): the end signal is an item_list response with zero items, because TikTok's hasMore stays true on the final page; a stall (about 8 quiet seconds) reads as incomplete. Small-account caveat: the profile page renders its first grid from the rehydration blob, so an account whose whole catalog fits in the initial render may never fire a sniffable request. `expected_count` upgrades a stalled-but-complete capture, and anything short falls back to the constructed endpoint, so behaviour never drops below the pre-sniff status quo.

The blob is not only a small-account concern: the page SSRs the grid's top (pinned posts, newest rows) into it and the page's own requests can continue after that batch, so a pure response sniff misses exactly the top. `get_user_videos_browser` harvests the blob items (`_read_profile_blob_items`, scanning every `__DEFAULT_SCOPE__` value for itemList arrays since the scope name moves across layouts) and merges them in front. Found in production as pinned posts flagged possibly deleted by every quick check and reverted by the next full run; deletion now runs off yt-dlp so that failure mode is gone, but the merge still matters for complete stats enrichment.

## Deletion detection is yt-dlp, always, both modes

Every check launches a parallel yt-dlp pass (`get_user_videos` via `asyncio.to_thread`) that lists the account's full current video set; the diff is `active_ids - present_ids` with `present_ids` from yt-dlp only. The browser sniff and item_list never feed the diff, they only enrich stats and new-video details. Why: the browser paths are the ones that stall, truncate, or empty under bot detection, which produced false mass deletions (e.g. a sniff stalling at 167 of a larger catalog while item_list returned an empty bot-detected body, flagging everything). yt-dlp with logged-in cookies lists the whole catalog reliably, public or followed-private.

This replaced the design where the browser listing drove deletion and Quick mode could see only the newest 30, so there is no quick-mode blind spot and no position-diff baseline (`last_quick_video_ids` is unused; the column is left in place, harmless).

`mode` still controls the browser side: quick fetches the first page (30) and upserts stats for those, full fetches all pages. Mode is chosen in `process_user_session` from `last_full_refresh_at`; manual runs pass `?mode=quick|full`.

Guard: `_should_run_deletion(ydlp_ok, fetch_interrupted, present_count, profile_video_count, has_saved)` runs the diff only when yt-dlp succeeded, the run was not interrupted, and the listing is trustworthy (`_listing_untrustworthy`: not empty while the profile reports videos, and not under 50% of `video_count`). A failed or too-incomplete listing skips deletion for that run rather than false-flagging; the next check verifies. A genuinely emptied account reports `video_count == 0`, which stays trustworthy, so its saved videos are still flagged. The 0.5 floor is a heuristic and the guard errs toward skipping, which is non-destructive.

## Bot detection

Mitigations: persistent browser profile (one stable device identity), patchright driver (CDP leaks closed), headed browser under Xvfb, session warmup (dwell + scroll before the first API call), Google Chrome preferred on amd64, curl_cffi impersonating Chrome, randomized exponential inter-user gaps (mean 90 s, floor 15 s), random sleep every 10 items, shared session with reset on detection, full cookie jar. **Cookies are the single biggest factor:** prefer the QR login, which mints them with the browser's own fingerprint.

Detection and recovery: `_is_bot_error()` matches "bot", "captcha", "no sessions created", "no valid sessions", and explicitly excludes `EmptyResponseException` (an empty body is the constructed endpoints' resting state, not a session verdict). On detection the full `async with TikTokApi()` context exits (browser teardown), then sleep, then a new browser process; session-context resets without a new browser were tried first and are insufficient, TikTok fingerprints at the browser level. Per-user counts in `bot_retry_counts`: first detection sleeps `_BOT_SLEEP_1 = 300s`, second `_BOT_SLEEP_2 = 600s`. A third failure (or an unrecoverable session creation) cancels the loop and stamps `bot_cooldown_until` via `_start_bot_cooldown()`, so the scheduler skips sessions for `bot_cooldown_hours` instead of retrying a flagged identity; manual triggers still run and a clean run clears the stamp. A dead session (`_SessionLostError`) relaunches immediately, up to 2 times per user, without the cooldown sleep.

`_make_session` validates right after `create_sessions`: TikTok sometimes completes the Playwright handshake and returns empty sessions, and without the check the first user triggers bot detection and wastes the restart.

## Persistent browser profile: one device identity

Every session goes through `create_tiktok_session`, which launches Chrome with a persistent user-data-dir (`data/tiktok/browser_profile`) via `browser_context_factory` (needs TikTokApi>=7.3). A fresh Playwright context per launch presented TikTok with a brand-new device carrying the same account cookie every run, the classic stolen-session pattern. The persistent profile keeps localStorage, ttwid, and fingerprint continuity.

Concurrency: Chrome refuses two processes on one user-data-dir, so a non-blocking module lock guards it. The holder is whichever session launches first (in practice the loop); overlapping ad-hoc sessions fall back to an ephemeral context rather than fail. The lock releases on the context close event from whichever thread fires it (a plain threading.Lock allows cross-thread release), the caller also releases on a create_sessions failure, and release is idempotent.

Stale lock after a container stop: Chrome writes a SingletonLock symlink ("hostname-pid") inside the user-data-dir, which sits on the data volume. A container that stops while Chrome runs leaves it, and since the next container has a new hostname Chrome refuses the profile with exit 21 ("in use by another Google Chrome process on another computer"), surviving a compose down/up. `_clear_stale_singleton` runs in the profile factory (under `_PROFILE_LOCK`, so nothing in-process owns the files) and removes the Singleton files when the lock names another host or a dead pid on this one; a live same-host lock is left alone.

**Never add a second `create_sessions` call site;** route everything through `create_tiktok_session`.

## Single browser turn: one live browser, ever

`browser_gate` serializes browser ownership across every thread. Whoever runs a browser holds `browser_gate.turn` for its lifetime: the session loop and dedicated manual runs (acquired in the adapter's `_process_session` / `_process_single`), ad-hoc jobs, and the QR login. Because the turn holder is the only browser, the persistent profile is always free for it, so the ephemeral fallback in `_profile_context_factory` (a fresh device identity carrying account cookies, the stolen-cookie shape) is dead code in practice and stays only as a safety net.

Ad-hoc browser work (add lookups, diagnostics probes, sound fetches) goes through `run_browser_job(coro_fn)`: while a session is live it queues the job and the session runs it on the warm browser between users and during gap sleeps (`browser_gate.open_jobs` / `drain_jobs` / `close_jobs`; `_service_sleep` polls once per second mid-sleep for jobs and manual runs, services them, and resumes the remaining sleep); otherwise it takes the turn and runs a dedicated session. `close_jobs` orphans anything still queued and `run_browser_job` resubmits, so a session restart or crash never strands a caller; a job queued behind a very long single-user check can hit the 30 min wait timeout, surfacing as a retryable error.

**Never call `asyncio.run` inside a job and never add a new `TikTokApi()` call site outside the turn:** new ad-hoc needs are a `run_browser_job` job (wrap in `asyncio.to_thread` from async code, as `fetch_sound_video_ids` does).

The engine side of the same guarantee: each ChannelLoop's `_work_lock` keeps manual runs and sessions from overlapping on every platform, which also keeps each platform's log strictly sequential.

## QR login: session minted inside the persistent profile

`login.py` runs the flow behind `/api/tiktok/login/qr`. A background thread claims the persistent profile via `_profile_context_factory` (409-style error state when a loop holds it), opens tiktok.com/login/qrcode, and every 2 s screenshots the QR element into the state dict as a data URL while polling context cookies for a `sessionid`. The whole page is a fallback only after the element has been missing for `FULL_PAGE_AFTER` (3) consecutive polls, so a wall or a post-scan confirmation still appears within seconds but the half-loaded page never flashes before the code (the UI shows a spinner until then, and the QR img uses `image-rendering: pixelated` so the upscaled element screenshot stays crisp). On success it exports the profile's tiktok.com cookies via `save_cookies_netscape`, so curl_cffi scrapes and yt-dlp downloads share the session just minted with the browser's own fingerprint. No credentials are handled; the phone app authenticates. Frontend: `ttQrStart` / `ttQrPoll` in tiktok.js, 2 s poll suppressed in `_POLLING_ENDPOINTS`.

The QR login is the only sign-in in the TikTok UI. The cookie upload UI was removed once QR landed (desktop-browser cookies reintroduce the fingerprint mismatch), but `POST /api/tiktok/cookies` stays registered: Twitter uses the same code and it doubles as an emergency hatch if TikTok changes the login page.

Sign-out is Reset session (`reset_browser_profile()` behind `DELETE /login/session`): it deletes the browser profile AND cookies.txt, because after a QR login the session lives in the profile and deleting only the cookies would leave the browser signed in. Since deleting the profile is a new device, this is also the recovery move for a deeply flagged identity: reset, then QR sign-in fresh. Refused with 409 while the browser holds the profile lock.

## Patchright: leak-patched Playwright driver

TikTok's client JS probes for the DevTools artifacts Playwright leaves behind (`Runtime.enable` side effects, automation flags). Patchright is a drop-in playwright-python fork that closes those leaks. main.py aliases `sys.modules["playwright"]` (and `playwright.async_api`) to patchright at the very top, before anything imports the real package, so TikTokApi and the QR login use the patched driver unchanged. Without patchright installed the alias is a no-op and vanilla Playwright is used; the app must keep working either way.

Three consequences to preserve:
- TikTokApi's vendored stealth JS patches are themselves fingerprintable, so `create_tiktok_session` passes a plain `page_factory` when patchright is active. Under vanilla Playwright the stealth patches stay on
- The alias must run before ANY playwright import. All TikTokApi imports are lazy (inside functions), which is what makes the top-of-main shim sufficient. Never add a module-level `from TikTokApi import ...` or `from playwright... import ...`
- **Main-world evaluate:** patchright's Runtime.enable fix runs `page.evaluate` in an isolated JS world, where the page's own globals do not exist. TikTokApi signs every request by evaluating `window.byted_acrawler.frontierSign` (a main-world global), so unmodified patchright dies on "Cannot read properties of undefined (reading 'frontierSign')" even though the page loaded. `_plain_page` rebinds that page's `evaluate` to pass patchright's `isolated_context=False`. This single line is what makes patchright and TikTokApi work together. Vanilla Playwright has no such kwarg, so the rebind only happens on the patchright page factory

Browser install: `patchright install chromium` (Dockerfile arm64 branch and local dev), because the patched driver looks in its own registry when `executable_path` is None. amd64 keeps Google Chrome via `CHROME_EXECUTABLE` detection.

Wall detection: after load `_plain_page` polls up to 10 s for the request signer via the main-world evaluate. When it never appears the page is a verification or consent wall rather than the homepage, so one clear log line with the URL is printed instead of leaving every request to fail cryptically. The QR login's streamed screenshots are the way to see what the profile is being served.

## xvfb-run hangs as PID 1: start Xvfb directly

The original headed CMD wrapped the app in xvfb-run. In production the container came up with Xvfb running, the app never launched, and there was no output anywhere: xvfb-run waits for Xvfb's SIGUSR1 readiness signal to interrupt its `wait`, and PID 1 signal semantics break that handshake. The same command works via `docker exec` (not PID 1), which made it confusing. Fix: CMD starts `Xvfb :99 ... &` in a shell and `exec`s python, with DISPLAY in ENV.

Related restart gotcha: /tmp survives a `docker restart` (only recreating the container resets it), so the previous run's `/tmp/.X99-lock` and `/tmp/.X11-unix/X99` linger. Xvfb refuses to start when the stale lock's pid matches a live process (pids restart from 1 after a container restart, so collisions are common), and the stale socket file made the old existence-based `_headed()` launch Chrome headed at a dead display, breaking every browser use until the container was recreated. Two-sided fix: the CMD removes both files before starting Xvfb, and `_headed()` proves the display is alive by connecting to the socket.

## In-app browser viewer: captcha solving over the app's own HTTPS

`screen.py` streams the headed display into the web UI and forwards mouse input, so the user solves a rotate captcha or verification wall by hand. `GET /api/tiktok/screen` returns one JPEG grabbed with ffmpeg x11grab (503 when headless); `POST /api/tiktok/screen/input` takes `{events: [{type: down|move|up, x, y}]}` in display pixels and replays them with xdotool. Frontend (`ttViewerOpen` / `_viewerNextFrame` / `_viewerSend`) polls roughly 3x a second by preloading the next Image and swapping on load, maps pointer coordinates from the rendered image rect onto the fixed 1920x1080 space, and batches moves (60 ms) while flushing down/up immediately so a drag stays ordered. Both routes are in `_POLLING_ENDPOINTS`.

Why this shape:
- VNC/noVNC (the first build) needs a raw WebSocket on its own port. The target server is HTTPS-only with no other ports and no SSH, and Flask is WSGI so it cannot proxy a WebSocket. Frame polling over plain HTTP was the only transport that fit. If the deployment constraints change, VNC is the nicer UX
- xdotool injects at the X server level, so Chrome sees native OS input, the same path a real mouse takes. How a captcha is solved is itself scored, and synthetic DOM events would look robotic. The web-poll cadence still makes input burstier than a local mouse, so a correct solve could in theory be rejected on timing
- NOT Chrome's DevTools screencast: attaching DevTools enables `Runtime.enable`, exactly the leak patchright exists to hide. x11grab and xdotool are invisible to the page

Frame grabbing captures the whole display, not one Playwright page, so it also shows captcha popups and iframes regardless of which thread owns the session. The display is black when no session runs (the browser only exists during checks, lookups, and logins); the viewer shows a hint rather than an error.

## Proxy routing

`get_proxy()` in `platforms/tiktok/config.py` returns the proxy URL or None, resolved per call via `get_proxy_settings()` (DB settings `proxy_mode` / `proxy_url` / `proxy_enabled`, `TIKTOK_PROXY` seeding a custom url), so the UI toggle applies from the next session or request without a restart. Two modes: `gluetun` resolves to the fixed `GLUETUN_PROXY_URL` (http://gluetun:8888, requires the sidecar to be named gluetun) and shows the WireGuard panel with the url input locked; `custom` uses `proxy_url` and hides the panel. The mode default keeps pre-mode installs working: custom when a url exists, gluetun otherwise. `POST /proxy/test` verifies the path before the toggle is flipped: it fetches https://api.ipify.org through the proxy and directly, and flags `same_ip` when the exits match.

Every TikTok network surface consults it: the persistent browser context (`launch_persistent_context` proxy kwarg, which covers the QR login), the ephemeral TikTokApi fallback (`context_options`), the curl_cffi detail scrape, the yt-dlp listing fallback, and the yt-dlp/photo/story downloads (optional `proxy` kwarg threaded through downloader.py and `save_new_stories`; other platforms pass nothing). Avatar caching in thumbnailer.py is the one TikTok fetch that stays on the server IP: it is CDN traffic shared across platforms and not risk-scored. UI in Settings > TikTok > Network (an Enable VPN master switch driving proxy_enabled, mode pills and the address below it).

The same panel manages gluetun's WireGuard config as four fields (private_key, address, public_key, endpoint). `POST /proxy/wireguard` composes a canonical wg0.conf at `DATA_DIR/gluetun/wireguard/wg0.conf` (mode 600, AllowedIPs and PersistentKeepalive are constants, IPv6 address entries stripped since gluetun refuses them on hosts without IPv6), which gluetun sees because its volume points at `./data/gluetun`. GET returns the fields including the private key for the UI's eye reveal; the key already sits in plaintext in that file for gluetun, so the authenticated echo adds no exposure. The Paste full config modal parses a provider file client-side (comment stripping, IPv4-only) and only fills the fields; saving still goes through the POST. Gluetun reads the file at startup only, so the UI tells the user to restart that container.

The one place the app touches Docker: with the host socket mounted (optional, off by default, a commented volume line documented with its tradeoff in the README), the WireGuard save and remove toasts carry a Restart gluetun now action backed by `POST /proxy/gluetun/restart`. The route talks to the Docker API over `/var/run/docker.sock` with stdlib http.client (no docker package). The API addresses containers by name or id, never by the network alias the proxy URL uses, and the name is deployment-specific, so the route resolves the `gluetun` DNS name on the shared network and restarts the container holding that IP. DNS fails exactly when the restart is most needed (a gluetun crash-looping on a bad config has no network presence), so the fallback searches all containers in any state for the literal name `gluetun` or the `com.docker.compose.service=gluetun` label, keeps only those sharing a Docker network with the app's own container (self-inspected via hostname, which defaults to the container id), and tie-breaks by compose project label. A candidate on foreign networks only (another stack's gluetun) is never restarted, and remaining ambiguity refuses with the candidate names rather than guessing. GET `/proxy/wireguard` reports `restart_available` (socket present) so the UI only offers the action when it can work. Gluetun's own control server was rejected: it cannot re-read wg0.conf without a container restart.

## Recovering afflicted stories

The stories table stores no media URL (TikTok signs them with a short expiry). It stores story_id, and a video story's page is `https://www.tiktok.com/@{handle}/video/{id}` (story ids share the video id space), which yt-dlp fetches and downloads self-consistently with no cookies. It must be `/video/`, not `/story/`: yt-dlp's TikTok extractor only matches `/video/{id}`, and `/story/{id}` falls through to the generic extractor, which TikTok 302s to the feed ("Unsupported URL: .../foryou"). This was the bug behind story corruption: `parse_story_item` built the URL as `/story/`, so yt-dlp never engaged and the dead CDN candidates were left to carry it.

The Corrupted story recovery job (Settings > TikTok > Jobs) and `scripts/redownload_stories.py` both use the `/video/` URL to repair afflicted rows (file missing or ffprobe-invalid). Shared logic: `engine.tracker.scan_afflicted_stories(db)` classifies rows (ailment missing/corrupt, live flag), `engine.tracker.purge_afflicted_stories(db, rows)` deletes rows + files, `platforms.tiktok.tracker.redownload_story_row(db, row)` re-fetches one live video via yt-dlp with no browser session. The script defaults to a dry run (`--run` to act, `--purge-expired` to drop unrecoverable rows). The in-app Re-download purges expired afflicted stories automatically: they are unrecoverable, and leaving the row made the viewer warn "failed to play" on every playback. Limits: video only (photo stories have no such page; the next check re-fetches them) and live only. The corrupt-but-present class is why the tool exists: the loop will not retry it (the id is known) and DB cleanup will not remove it (the file is present).

See [gotchas.md](gotchas.md) for the shared story download validation and quarantine.
