# Developer documentation

Reference docs for the codebase. Read the file that covers what you are changing; none of this needs to be read up front.

| File | Covers |
|------|--------|
| [architecture.md](architecture.md) | What the app is, platform list, file tree, tech stack, runtime threads, adding a platform |
| [scheduling.md](scheduling.md) | The session-based loop scheduler: sessions, due times, triggers, pause, quick/full, stop semantics |
| [api-routes.md](api-routes.md) | Every HTTP route, global and per platform |
| [config.md](config.md) | Environment variables, data and media layout, Docker build, reverse proxy |
| [backend.md](backend.md) | Module reference for the shared modules and the channel engine, incl. the DB schema |
| [frontend.md](frontend.md) | `static/` reference: common.js, channels.js, the platform configs, style.css, overlays |
| [tiktok.md](tiktok.md) | TikTok: api, tracker, sounds, DB extras, and every TikTok-specific decision (browser, patchright, proxy, QR login, bot detection) |
| [platforms.md](platforms.md) | YouTube, Twitter, Instagram, OnlyFans: data sources and their platform-specific quirks |
| [gotchas.md](gotchas.md) | Cross-cutting decisions: media encoding, avatar detection, OAuth, stories, DB migrations, layout traps |
