# YouTube, Twitter, Instagram, OnlyFans

Each platform is an `api.py` (fetch + download) plus a `ChannelAdapter`. TikTok has its own file: [tiktok.md](tiktok.md).

## YouTube

`platforms/youtube/api.py`, yt-dlp only. Profile: processed flat extraction with `playlist_items: "1"` + `lazy_playlist`. Video list: flat extraction on the channel URL. Detail: `extract_info` without download.

Channel identified by the stable `channel_id` from the yt-dlp info dict, equivalent to TikTok's sec_uid, so a handle change never breaks tracking.

**Profile fetch gotchas.** A tabless or @handle URL resolves to a metadata-less husk (title = channel ID, everything else null) when the channel has no videos tab (shorts-only channels), so `fetch_channel_info` tries `/featured` first and falls back to the given URL. It uses a processed flat extraction limited to one item (`process=False` can return an unresolved url reference). `_parse_channel` never returns an empty-string handle (None when unknown) and never lets display_name fall back to the channel ID. Trackers treat falsy profile values as missing from a sparse fetch, not a change, and `update_channel_info` COALESCEs display_name and description.

**upload_date for Shorts.** Flat extraction of the Shorts tab returns no `upload_date` or `timestamp`, but the full download does. `download_video` parses and returns it, and the adapter uses `post.get("upload_date") or result.get("upload_date")`. `ChannelDB.backfill_upload_dates()` patches existing NULL rows from the stored `timestamp` column at the start of each run.

**raw_video_data** is the full flat extraction entry minus formats/thumbnails/postprocessors, stored when the video is first seen and downloaded; `ytdlp_data` comes from `extract_info` during download. See the blob-size note in [gotchas.md](gotchas.md).

## Twitter

`platforms/twitter/api.py`, gallery-dl's Python API in-process (no subprocess). Authenticated with the cookies.txt from Settings > Twitter > Account; timelines require a login (gallery-dl raises AuthRequired), profile lookup works unauthenticated.

- Profile: `https://x.com/{handle}/info`. Media tweets: `https://x.com/id:{user_id}/media`. Download: requests on the CDN URLs gallery-dl returns, photos converted to AVIF
- Accounts identified by numeric user ID via the `id:` URL syntax, which survives handle changes
- The media timeline covers original posts only; `retweets` and `quoted` are disabled in `_configure()`
- `iter_profile_posts(user_id)` groups gallery-dl's per-file `Message.Url` stream into one post per tweet; multi-media tweets save as `{tweet_id}_{num:02d}.ext`, single-media as `{tweet_id}.ext`
- NSFW media needs "Display media that may contain sensitive content" enabled on the cookie account

## Instagram

`platforms/instagram/api.py`, instaloader with a browser-exported session. Stories: `api.fetch_stories(user_id)` maps `_L.get_stories` items to the engine story contract and returns [] without a session login (instaloader refuses anonymous story access). Instagram story CDN URLs download without cookies; `download_story` sends its Referer header only for TikTok.

The endpoint workarounds below are load-bearing. Do not "simplify" them back to the library defaults.

**Username lookup bypasses instaloader's search resolution.** instaloader 4.15 resolves usernames through Instagram's logged-out search endpoint (fbsearch non_profiled_serp), which omits many smaller accounts, so an existing public profile raises `ProfileNotExistsException` with no HTTP error in the chain (upstream PR instaloader#2715, unmerged as of July 2026). 4.15.1 also sent malformed GraphQL profile queries, hence the `instaloader>=4.15.2` pin.

`_profile_from_username` replicates the request the web frontend makes: GET `www.instagram.com/api/v1/users/web_profile_info/?username=X` on the instaloader session (`_L.context._session`, a private attr, acceptable with the pin) with `X-IG-App-ID: 936619743392459`, `X-Requested-With: XMLHttpRequest`, Referer, and the session csrftoken. This is also how gallery-dl resolves usernames (`_user_by_name_impl`, the reference for future breakage). The response's `data.user` is a legacy-format node passed to `Profile(_L.context, node)`; a `status: ok` with a null user is authoritative nonexistence, raised with the library's exact message so `_GONE_MARKERS` still match; any other error falls back to `Profile.from_username`, except a 429: the fallback hits the same endpoint on the same session, so it cannot succeed, and instaloader's rate controller sleeps 20+ minutes before raising; a 429 raises `ConnectionException` immediately instead. Post iteration resolves by stored numeric id and never hits this. instaloader's `get_json` cannot carry the needed headers, which is why the request goes through the raw session.

**Two dead ends, do not revisit:** `context.get_iphone_json` on the same endpoint (upstream's approach) hits i.instagram.com, which 429s sessions like ours on the first request, after which instaloader's rate controller sleeps 30 minutes per retry and blocks the add worker. `TopSearchResults` (`web/search/topsearch/`) returns 401; Instagram retired it.

`_L` is constructed with `iphone_support=False` for the same 429 reason (otherwise `profile_pic_url` fetches the HD avatar via the iphone API and every check risks a 30 minute stall). With it off, everything comes from the web endpoints the session belongs to, at web quality. It also sets `post_metadata_txt_pattern=""`, since the default writes a stray `{shortcode}.txt` next to every post.

**Post listing** is in the same boat: `Profile.get_posts()` uses a retired GraphQL doc_id and 401s persistently with a "Please wait a few minutes" message that reads as a rate limit but never clears (instaloader #2689); `Profile.from_id` uses an old query_hash and is equally suspect. `iter_profile_posts` therefore paginates `www.instagram.com/api/v1/feed/user/{user_id}/` via `_web_api_get` (count=12, `max_id` / `next_max_id` / `more_available`, 2 s between pages, same recipe as gallery-dl's `user_feed`) and wraps items with `Post.from_iphone_struct`, which despite the name makes no iphone API call: it builds the node from the feed item, including display_url/video_url/sidecar children, so `_L.download_post` works unchanged. Never let Post attribute reads fall through to `Post._obtain_metadata` (its doc_id is also retired, instaloader #2716); guard optional fields like `video_view_count` with try/except.

**Session trust** is the deeper layer: a session minted by instaloader's password `login()` is flagged from birth, and Instagram then 429s the web profile endpoints and returns empty search results even for large accounts while a real browser works. Instagram auth is therefore a cookies.txt upload like Twitter's: `reload_session_from_cookies` rebuilds the session via `_L.load_session` (requires sessionid and csrftoken, it KeyErrors without csrftoken) at import and through the cookie routes' `on_change`, using ds_user_id as the context username stand-in. After `load_session` the cookie jar is rebuilt with domain `.instagram.com`: `cookiejar_from_dict` leaves domains empty, so Set-Cookie responses add duplicates instead of overwriting and a later `cookies.get("csrftoken")` raises CookieConflictError ("There are multiple cookies with name, 'csrftoken'"); `_web_api_get` also reads the csrf via `dict_from_cookiejar`, which tolerates duplicates. There is no logout call anywhere: `_L.logout()` POSTs to Instagram and fails on flagged sessions, so Remove just deletes the file and clears the in-memory session. Lookup errors name both paths (web endpoint and search) so a flagged session is diagnosable, and a web failure plus a search miss raises without the words "does not exist" so it can never trip `_GONE_MARKERS`.

**Watch item, untested as of July 2026:** `_L.get_stories` still uses old query_hash GraphQL. If story fetching breaks, the web equivalent is `/api/v1/feed/reels_media/?reel_ids={id}` with the same `_web_api_get` headers.

## OnlyFans

`platforms/onlyfans/api.py`, UltimaScraperAPI. OnlyFans signs its API with an `x-bc` token from browser localStorage, so cookies alone cannot authenticate: the credential is an auth.json (cookie string with auth_id and sess, plus x_bc and user_agent), uploaded through the shared cookies file store and read back via `cookies_path("onlyfans")`. The upload is filtered to the keys `AuthDetails(**auth_json)` accepts, since anything else makes `create_auth_details` raise. `validate_auth_file` is the cookie routes' `on_change` hook.

Bios and post text arrive as HTML; `clean_html` flattens them to plain text on write, and `clean_stored_html` (behind `POST /api/onlyfans/jobs/clean-html` and `scripts/clean_onlyfans_html.py`) rewrites existing rows.

`iter_profile_posts(user_id, limit=None)` filters out text-only and fully locked posts, so a diagnostics call asking for 5 posts requests 20 to leave headroom.

Adapter: `quick_limit=30`, `has_banner=True`, `has_stories=True`, prefix `of`, creator noun "creator", item noun "post". The frontend config maps the Views column to likes, since OnlyFans exposes no view counts.
