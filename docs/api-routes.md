# API routes

Routes are namespaced per platform via Flask Blueprints.

```
GET  /                            index.html
GET  /login                       redirect to OIDC provider; sets state + PKCE verifier
GET  /auth/callback               validates state, exchanges code, stores session
GET  /logout                      clears session; redirects to end_session_endpoint
GET/PATCH /api/auth/config        read (public) / write (protected when OAuth active) OAuth config

TikTok extras on its engine blueprint:
/api/tiktok/sounds                sound tracking
/api/tiktok/trigger/sounds        fire the sound loop
/api/tiktok/channels/<id>/track   track a sound-discovered user (enabled=1)
/api/tiktok/videos/direct         POST a post URL; saves one post, exempt from deletion checks
/api/tiktok/login/qr              POST starts the QR flow, GET polls (status, QR data URL, message)
/api/tiktok/login/session         DELETE resets: removes browser profile + cookies.txt (409 while in use)
/api/tiktok/screen                GET one JPEG frame of the headed display (503 when headless)
/api/tiktok/screen/input          POST {events:[{type,x,y}]}, replayed via xdotool
/api/tiktok/proxy                 GET/PATCH {url, enabled}: the proxy all TikTok traffic uses
/api/tiktok/proxy/wireguard       GET/POST private_key, address, public_key, endpoint (composes wg0.conf), DELETE
/api/tiktok/proxy/gluetun/restart POST: restart the gluetun container via the Docker socket (503 without it)
/api/tiktok/proxy/test            POST: IP echo through proxy and direct; latency, same_ip flag
/api/tiktok/jobs/story-recovery/status|scan|redownload
/api/tiktok/jobs/thumbnail-repair/status|start   undecodable thumbnails, all platforms
/api/tiktok/jobs/photo-converter/status|start, audio-cleanup/status|start, file-check/status|scan|purge
/api/tiktok/pause/sounds          pause the sound loop
/api/tiktok/videos/<id>/...       TikTok video/photo serving

Engine blueprint, shared by every platform ({p} = tiktok|youtube|twitter|instagram|onlyfans):
/api/{p}/channels                      list (GET), add (POST)
/api/{p}/queue                         add-queue state: newest row per handle, pending + recently resolved
/api/{p}/add-history                   persistent add attempts, newest first; ?before=<id>&limit= keyset
/api/{p}/add-history/<id>              DELETE discards a resolved entry (409 while pending)
/api/{p}/channels/<id>                 DELETE removes the creator
/api/{p}/channels/<id>/videos          list for the detail modal
/api/{p}/channels/<id>/run             manual run; ?mode=quick|full (default full)
/api/{p}/channels/<id>/run-profile     profile-only run
/api/{p}/channels/<id>/tracking|star|bookmark|pin|comment   PATCH toggles and notes
/api/{p}/channels/<id>/profile-history change history
/api/{p}/channels/<id>/stats-history   daily snapshots (followers, following, posts, saved), oldest first
/api/{p}/channels/<id>/connections     GET list, POST {handle} links, DELETE /<other_id> unlinks
/api/{p}/channels/<id>/avatar|banner   cached images; avatar takes ?size=thumb
/api/{p}/channels/<id>/avatar-history/<filename>   an archived previous avatar
/api/{p}/channels/<id>/storage         media folder size for the Storage chip
/api/{p}/channels/<id>/stories         saved stories (live flag from expires_at)
/api/{p}/channels/<id>/stories/calendar  {YYYY-MM-DD: count}
/api/{p}/videos/<id>/thumbnail|file    media serving (mimetype from extension)
/api/{p}/videos/<id>/files             multi-media post file list ({name, type, url})
/api/{p}/videos/<id>/files/<n>         serve the nth sibling file
/api/{p}/stories/<id>/file             serve a saved story
/api/{p}/stories/<id>/viewed           POST stamps stories.viewed_at; unviewed live counts drive the
                                       colored vs grey avatar story ring (payload field unviewed_stories)
/api/{p}/status                        loop state snapshot incl. logs
/api/{p}/events                        SSE: status and queue snapshots on change (1 s check, 15 s keepalive)
/api/{p}/trigger                       primes + runs starred creators
/api/{p}/trigger/next|half|all         other trigger scopes
/api/{p}/stop                          stop ASAP: wakes any sleep, ends a bulk download after the in-flight item
/api/{p}/pause                         POST {paused}: skip scheduled sessions; persisted in settings
/api/{p}/settings                      Loop Schedule settings (GET/PATCH)
/api/{p}/stats /recent /recent/*       aggregate stats and activity feeds
/api/{p}/recent/feed                   unified dashboard feed: saved/deleted groups, profile changes, bans
                                       newest first; ?before=<ts>&limit=&kind=&starred=1&bookmarked=1
/api/{p}/db/query /db/cleanup          DB query pane and cleanup job
/api/{p}/reports/<filename>            report downloads

Adapter extras:
/api/twitter|instagram|onlyfans/cookies   GET/POST/DELETE the credential file (Instagram upload rebuilds
                                          the instaloader session and rejects invalid files; OnlyFans
                                          takes auth.json)
/api/twitter|instagram|onlyfans/diagnostics   raw profile or first posts
/api/onlyfans/jobs/clean-html             flatten stored HTML in existing rows
/api/youtube/debug/channel-videos         raw profile + flat extraction entries

Global:
/api/health                       unauthenticated health check
/api/transcode/status             AV1 transcode job: settings, current file, counts, recent results
/api/transcode/settings           PATCH any transcode.json key (enabled, paused, min_size_mb, ...)
/api/transcode/backfill           POST: scan the library and queue qualifying files (409 while scanning)
/api/transcode/retry-failed       POST: requeue every failed row
/api/platforms                    GET the platform list ({id, label, enabled})
/api/platforms/<id>               PATCH {enabled}: toggle live; disabling stops the loop immediately and
                                  403s every /api/{p}/* route on that blueprint
/api/migrate/preview /api/migrate legacy tiktok-downloader path migration scan and rewrite
/assets/<name>-<hash>.<ext>       content-hashed static assets (immutable cache header)
```

**PATCH flag semantics on `channels/<id>`:** bookmark is a pure filter flag, no loop logic reads it. Starring also bookmarks; unstarring leaves it; un-bookmarking a starred channel returns 409. Pin backs the Quick Access panel via `channels.pinned_at`, pin time orders the row.

**`_SuppressPolling`** (Werkzeug log filter in main.py, with `_POLLING_ENDPOINTS`) keeps high-frequency poll routes out of the access log. Update it whenever a new poll route is added.
