# Architecture

Self-hosted social media archiver. Monitors creators across platforms, detects new, deleted, and restored posts each loop cycle, and downloads them with embedded metadata. Flask web UI, one tab ("app") per platform. Ships as a Docker image: `ghcr.io/nikolainyegaard/social-downloader`.

## Platforms

All platforms run on the shared engine, backend and frontend.

| Platform | Scope | Data source | Auth |
|----------|-------|-------------|------|
| TikTok | users, sounds, stories | TikTokApi + yt-dlp + curl_cffi | QR login (in-app) |
| YouTube | channels | yt-dlp | none |
| Twitter | accounts | gallery-dl | cookies.txt |
| Instagram | profiles, stories | instaloader | cookies.txt |
| OnlyFans | creators, stories | UltimaScraperAPI | auth.json |

Backend `app/engine/`: one database module, one loop, one tracker, one blueprint factory, parameterized by a small per-platform adapter. TikTok's extras (sounds, backfill, jobs) are adapter hooks plus extra routes in `platforms/tiktok/`. Frontend: every platform app renders from `channels.js` via `initChannelApp(cfg)`; the per-platform JS file is a config plus platform-only extras.

## File structure

```
social-downloader/
├── app/
│   ├── main.py               entry point; Flask + all loop threads; tees stdout to the run log
│   ├── config.py             global env config + platform enable/disable store (platforms.json)
│   ├── cookies.py            shared per-platform cookies.txt storage + route registration
│   ├── scheduling.py         shared session-based scheduler for all platform loops
│   ├── auth.py               OAuth2/OIDC blueprint: /login, /auth/callback, /logout
│   ├── backup.py             daily SQLite backup, 14-day retention, daemon thread
│   ├── downloader.py         yt-dlp download + direct photo/story download (shared)
│   ├── transcoder.py         background AV1 transcode job: queue, worker, verification
│   ├── photo_converter.py    background AVIF conversion; encode_avif helper
│   ├── thumbnailer.py        thumbnails, avatar/banner caching, thumbnail repair
│   ├── web.py                Flask app; global routes; mounts platform blueprints
│   ├── engine/               the channel platform engine (one instance per platform)
│   │   ├── __init__.py       ChannelAdapter dataclass + ChannelEngine
│   │   ├── database.py       ChannelDB: per-platform SQLite file, identical schema
│   │   ├── loop.py           ChannelLoop: state, triggers, manual-run queue, worker thread
│   │   ├── tracker.py        session processing, diffing, deletion detection
│   │   └── web.py            create_channel_blueprint(engine): all /api/{platform}/* routes
│   ├── platforms/
│   │   ├── registry.py       ENGINES: one ChannelEngine per platform
│   │   ├── tiktok/           adapter + TikTok-only extras
│   │   │   ├── adapter.py    nouns, hooks, status extras, extra routes
│   │   │   ├── api.py        profile, video list, video detail fetching
│   │   │   ├── store.py      TikTokStore: sound tables + TikTok-only queries
│   │   │   ├── sounds.py     sound loop
│   │   │   ├── tracker.py    user + sound tracking logic
│   │   │   ├── config.py     TikTok env defaults + proxy settings
│   │   │   ├── login.py      QR login inside the persistent browser profile
│   │   │   ├── screen.py     in-app browser viewer: x11grab frames + xdotool input
│   │   │   ├── migrate.py    one-way in-place migration of the legacy TikTok DB
│   │   │   └── web.py        sounds, backfill, jobs, diag routes
│   │   ├── twitter/          api.py (gallery-dl) + adapter.py (cookies, diagnostics)
│   │   ├── instagram/        api.py (instaloader) + adapter.py (session, diagnostics)
│   │   ├── youtube/          api.py (yt-dlp) + adapter.py (debug route)
│   │   └── onlyfans/         api.py (UltimaScraperAPI) + adapter.py + config.py
│   ├── templates/index.html  shell; tabs, sections, platform scripts from the served platform list
│   └── static/
│       ├── common.js         shared modal engine, utilities, formatting, settings core
│       ├── channels.js       platform app engine: every platform's UI from a config
│       ├── tiktok.js         config + sounds catalog/modal, jobs, diag, backfill
│       ├── twitter.js instagram.js youtube.js onlyfans.js   thin configs
│       ├── style.css         global styles + per-platform CSS variable themes
│       ├── types.d.ts        dev-only ambient types for tsc --checkJs
│       ├── vendor/           self-hosted libs (d3 + cal-heatmap, uPlot, JetBrains Mono)
│       └── icons/
├── docs/                     this documentation
├── scripts/                  standalone maintenance scripts, run via docker exec
│   ├── redownload_stories.py      re-download afflicted TikTok video stories (live only)
│   ├── clean_false_avatar_history.py  delete spurious avatar history rows from the
│   │                              8-9 Jul 2026 re-encode-hash bug (dry run by default)
│   └── clean_onlyfans_html.py     flatten stored OnlyFans HTML to plain text
├── Dockerfile
├── docker-compose.yml        (docker-compose.override.yml is gitignored, local dev)
├── jsconfig.json             tsc --checkJs config for the frontend JS
└── requirements.txt
```

## Tech stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Web server | Flask | Minimal; Blueprints namespace per-platform routes |
| Database | SQLite3 WAL, one file per platform | No cross-platform queries; WAL for concurrent readers |
| TikTok | TikTokApi (Playwright via patchright) | Only reliable source for profile info and item_list; patchright closes CDP detection leaks |
| YouTube | yt-dlp | Channel metadata, video lists, downloading in one tool |
| Instagram | instaloader | Web endpoints; session from browser cookies (tool logins get rate limited) |
| Twitter | gallery-dl | Drives internal web endpoints with cookies; official API bills per post read |
| OnlyFans | UltimaScraperAPI | Signs requests with the x-bc token from browser localStorage, hence auth.json |
| Video download | yt-dlp | Best quality, metadata embedding |
| Photo download | requests | yt-dlp returns audio only for TikTok photo posts |
| Page scraping | curl_cffi (Chrome impersonation) | TikTok video detail + stats without a browser |
| Image encoding | FFmpeg libaom-av1 | AVIF, still-picture mode |
| Frontend | Vanilla JS, no build step | No npm, no bundler; type-checked with tsc --checkJs (dev only) |

## Runtime threads

- **Main:** Flask (`app.run`)
- **Per-platform loop threads:** one scheduler per loop (one per engine, plus TikTok sounds); sleeps first, runs on schedule or manual trigger
- **Per-engine run workers:** each ChannelLoop drains its manual single-creator queue, but only while no session runs. A per-loop `_work_lock` serializes sessions and manual runs; a live session drains the queue itself between creators (inserted runs). The TikTok SoundLoop works the same way
- **File check:** twice daily (00:00, 12:00), removes TikTok DB records for missing files (engines cover this via DB cleanup)
- **Backup:** midnight daily plus once at startup; copies every platform DB to `data/backups/` via the SQLite backup API, prunes past 14 days
- **Add workers:** one per platform, processes the add-creator queue one entry at a time
- **Stats backfill (TikTok, on demand):** fetches video details for videos missing stats
- **Thumbnail backfill:** generates missing thumbnails, started from main.py
- **Photo converter:** JPEG to AVIF, 8 s startup delay so `init_db()` finishes first
- **Transcode worker:** one serial AV1 re-encode at a time from a persistent queue (`data/transcode.db`), nice 19, started from main.py before the loop threads

All threads are `daemon=True`. `asyncio.run()` inside a thread is safe (fresh event loop per call); never share an event loop across threads. All loop_state writes are guarded by a per-platform `_state_lock`.

## Adding a platform

Write `platforms/<name>/api.py` (fetch + download) and a `ChannelAdapter` in `adapter.py`, add it to `ENGINES` in `platforms/registry.py`, add a frontend config over channels.js, and add `<name>.js` to `_HASHED_FILES` in web.py. Nothing else: tab bar, page section, script tag, settings pane, and the General on/off toggle all render from the registry.

See [backend.md](backend.md) for the adapter contract and [frontend.md](frontend.md) for the cfg contract.
