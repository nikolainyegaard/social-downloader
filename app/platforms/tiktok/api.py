"""TikTok data fetching."""

from __future__ import annotations

import asyncio
import copy
import json
import os
import random
import re
import sys
import threading

# One persistent Chrome profile shared by every TikTok browser session, so
# TikTok sees the same device identity across runs. A fresh Playwright context
# per launch reads as a brand-new device carrying the same account cookie,
# which is exactly the pattern bot detection scores hardest.
_PROFILE_LOCK = threading.Lock()


def _profile_dir() -> str:
    from platforms.tiktok.config import TIKTOK_DATA_DIR
    return os.path.join(TIKTOK_DATA_DIR, "browser_profile")


_RELEASE_GUARD = threading.Lock()


def _profile_context_factory():
    """Claim the persistent profile and return (browser_context_factory, release),
    or (None, None) when another browser currently holds the profile (Chrome
    cannot run two processes on one user-data-dir). release() is idempotent and
    frees the profile from whichever thread calls it: normally the context close
    event, or the caller when create_sessions fails before the context exists."""
    from platforms.tiktok.config import CHROME_EXECUTABLE

    if not _PROFILE_LOCK.acquire(blocking=False):
        return None, None

    released = [False]

    def release():
        with _RELEASE_GUARD:
            if released[0]:
                return
            released[0] = True
        _PROFILE_LOCK.release()

    async def factory(playwright):
        from platforms.tiktok.config import get_proxy
        profile = _profile_dir()
        os.makedirs(profile, exist_ok=True)
        _clear_stale_singleton(profile)
        proxy = get_proxy()
        context = await playwright.chromium.launch_persistent_context(
            profile,
            # Headed on a display, otherwise Chrome's new headless mode via
            # arg with the Playwright flag off (TikTokApi's own handling)
            headless=False,
            args=[] if _headed() else ["--headless=new"],
            executable_path=CHROME_EXECUTABLE,
            **({"proxy": {"server": proxy}} if proxy else {}),
        )
        context.on("close", lambda _ctx: release())
        return context

    return factory, release


def _clear_stale_singleton(profile: str) -> None:
    """Chrome refuses a profile whose SingletonLock names another host (exit
    21, "in use by another Google Chrome process on another computer"). The
    profile lives on the data volume, so a lock left by a container that
    stopped while Chrome was running names the previous container's hostname
    and never clears itself, not even across a compose down/up. Remove the
    singleton files when the lock is clearly stale: another hostname, or a
    dead pid on this one. _PROFILE_LOCK is already held when this runs, so no
    session of this process can legitimately own them."""
    import socket

    lock = os.path.join(profile, "SingletonLock")
    try:
        target = os.readlink(lock)  # the lock is a symlink to "hostname-pid"
    except OSError:
        return
    host, _, pid = target.rpartition("-")
    stale = host != socket.gethostname()
    if not stale:
        try:
            os.kill(int(pid), 0)
        except (OSError, ValueError):
            stale = True
    if not stale:
        return
    for name in ("SingletonLock", "SingletonSocket", "SingletonCookie"):
        try:
            os.remove(os.path.join(profile, name))
        except OSError:
            pass


def _headed() -> bool:
    """Run the browser headed when a working X display exists (in Docker that
    is the Xvfb the container starts). Headed Chrome drops the entire headless
    fingerprint class. Connects to the X socket instead of trusting DISPLAY or
    the socket file: the env var is baked into the image, and the socket file
    in /tmp survives a docker restart while the Xvfb process does not, so only
    a listening server proves the display is alive. Anything less must degrade
    to headless instead of launching Chrome at a display that is not there."""
    # ponytail: local dev on a Linux desktop gets visible Chrome windows, add
    # an env opt-out if that annoys
    import socket

    display = os.environ.get("DISPLAY", "")
    if not display.startswith(":"):
        return bool(display)  # remote display forms: trust the env var
    num = display[1:].split(".")[0]
    path = f"/tmp/.X11-unix/X{num}"
    if not os.path.exists(path):
        return False
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(1)
            s.connect(path)
        return True
    except OSError:
        return False


def reset_browser_profile() -> tuple[bool, str]:
    """Full sign-out: delete the persistent browser profile and cookies.txt.

    The next session starts as a brand-new device, so this is also the
    recovery move when the identity is deeply flagged: reset, then mint a
    fresh session with the QR login.
    """
    import shutil
    from cookies import delete_cookies

    if not _PROFILE_LOCK.acquire(blocking=False):
        return False, "The browser is in use, likely by a running loop. Try again when it finishes."
    try:
        shutil.rmtree(_profile_dir(), ignore_errors=True)
        delete_cookies("tiktok")
        return True, "Session reset. Sign in with a new QR code."
    finally:
        _PROFILE_LOCK.release()


def _patchright_active() -> bool:
    # main.py aliases sys.modules["playwright"] to patchright at startup when
    # the package is installed
    return getattr(sys.modules.get("playwright"), "__name__", "") == "patchright"


async def _wait_for_signer(page, attempts: int = 20) -> bool:
    """Wait for TikTok's request signer (window.byted_acrawler) to appear on
    the current page. Every make_request signs through it, so after any
    navigation the signer must be back before the session's next API call."""
    for _ in range(attempts):
        try:
            if await page.evaluate(
                "() => !!(window.byted_acrawler && window.byted_acrawler.frontierSign)"
            ):
                return True
        except Exception:
            pass
        await asyncio.sleep(0.5)
    return False


async def _plain_page(context):
    """page_factory that skips TikTokApi's vendored stealth patches.

    Those JS patches (navigator overrides, toString rewrites) are themselves
    fingerprintable. Patchright hides the CDP layer natively, so a plain
    untouched page is the cleaner profile when it is active.
    """
    page = await context.new_page()

    # TikTokApi signs every request by evaluating window.byted_acrawler in the
    # page's main world. Patchright's evaluate defaults to an isolated context
    # where page globals do not exist (that is its Runtime.enable fix), so
    # this page's evaluate is rebound to the main world. Everything else keeps
    # the isolated default.
    orig_evaluate = page.evaluate

    async def _evaluate_main_world(expression, arg=None):
        return await orig_evaluate(expression, arg, isolated_context=False)

    page.evaluate = _evaluate_main_world

    await page.goto("https://www.tiktok.com")

    # TikTok's own page scripts inject the request signer. When it never
    # appears the page is a verification or consent wall, and every request in
    # this session would die on a cryptic frontierSign evaluate error. One
    # clear line instead.
    if not await _wait_for_signer(page):
        print(f"TikTok page loaded without the request signer, likely a"
              f" verification or consent wall (url: {page.url})")
    return page


async def create_tiktok_session(api, ms_token: str | None = None,
                                cookies: dict | None = None, **overrides):
    """The one create_sessions call every TikTok browser session goes through.

    Uses the persistent browser profile when it is free. Concurrent sessions
    (an add lookup or diagnostics probe while a loop runs) fall back to the old
    ephemeral context so they never fail on the profile lock.
    """
    from platforms.tiktok.config import CHROME_EXECUTABLE, get_proxy

    factory, release = _profile_context_factory()
    kwargs = dict(
        ms_tokens=[ms_token] if ms_token else [],
        num_sessions=1,
        sleep_after=3,
        cookies=[cookies] if cookies else None,
    )
    if factory:
        # The factory launches with the proxy itself (persistent context)
        kwargs["browser_context_factory"] = factory
    else:
        kwargs["executable_path"] = CHROME_EXECUTABLE
        kwargs["headless"] = not _headed()
        proxy = get_proxy()
        if proxy:
            kwargs["context_options"] = {"proxy": {"server": proxy}}
    if _patchright_active():
        kwargs["page_factory"] = _plain_page
    kwargs.update(overrides)
    try:
        await api.create_sessions(**kwargs)
    except Exception:
        # A context that launched gets released by its close event (TikTokApi
        # closes partially created contexts on failure). This covers failures
        # before the factory ever ran. release() is idempotent so both paths
        # firing is harmless.
        if release:
            release()
        raise
    await _warmup(api)


async def _warmup(api):
    """A few seconds of human-shaped activity on the loaded TikTok page before
    the first API call of the session: dwell, mouse drift, scrolling.

    A human loads the page, looks at it, and scrolls. A cold start straight
    into the item_list API is a behavioral tell no fingerprint work covers.
    Best-effort by design: a warmup failure never fails the session.
    """
    try:
        page = api.sessions[0].page
        await asyncio.sleep(random.uniform(1.0, 2.5))
        for _ in range(random.randint(2, 4)):
            await page.mouse.move(random.randint(60, 1200), random.randint(60, 660),
                                  steps=random.randint(5, 15))
            await asyncio.sleep(random.uniform(0.2, 0.6))
            await page.mouse.wheel(0, random.randint(250, 900))
            await asyncio.sleep(random.uniform(0.4, 1.2))
    except Exception:
        pass


class UserBannedException(Exception):
    """Raised when TikTok returns a ban/removal/restriction status code.

    Codes handled:
      10202 USER_NOT_EXIST      -- account permanently deleted or removed
      10221 USER_BAN            -- account banned by TikTok
      10223 USER_FTC            -- account restricted under COPPA/FTC rules
      10225 USER_UNIQUE_SENSITIVITY -- account restricted for content sensitivity
    """


class UserPrivateException(Exception):
    """Raised when TikTok returns statusCode 10222 (USER_PRIVATE).

    The account exists but has restricted its profile. No public data is accessible.
    Distinct from a ban: the account may go public again, so tracking is preserved
    but the video fetch is skipped.
    """


class UserBlockedException(Exception):
    """Raised when TikTok returns statusCode 10222 and relation is 4 or 5.

    relation=4 means the account has blocked the cookies account (no follow).
    relation=5 means the account has blocked the cookies account (cookies was following them).
    """


def _raise_for_user_status(data: dict, ident: str) -> None:
    """Shared TikTok profile status handling. Both profile sources carry the
    same statusCode/userInfo shape: the /api/user/detail/ JSON response and
    the profile page blob's webapp.user-detail scope."""
    _sc = data.get("statusCode")
    if _sc in (10202, 10221, 10223, 10225):
        raise UserBannedException(
            f"TikTok returned statusCode {_sc} for {ident} "
            f"-- account is banned, removed, restricted, or FTC-restricted"
        )
    if _sc == 10222:
        _rel = int(data.get("userInfo", {}).get("user", {}).get("relation") or 0)
        if _rel in (4, 5):
            raise UserBlockedException(
                f"TikTok returned statusCode 10222 for {ident} "
                f"-- cookies account is blocked by this user (relation={_rel})"
            )
        # TikTok returns 10222 for private accounts but still provides full
        # profile data when a relationship exists (e.g. mutual follow). If the
        # user object is populated, callers fall through and return it normally;
        # is_private will be set from secret=True in the response.
        if not data.get("userInfo", {}).get("user", {}).get("id"):
            raise UserPrivateException(
                f"TikTok returned statusCode 10222 for {ident} "
                f"-- account is private"
            )
    if _sc == 10102:
        raise ValueError(
            f"TikTok returned statusCode 10102 for {ident} "
            f"-- session is not authenticated; cookies may be stale or expired"
        )


def _normalise_user_info(data: dict, username: str | None = None) -> dict:
    """Map a statusCode/userInfo payload (JSON endpoint response or the page
    blob's webapp.user-detail scope) to the normalised profile dict."""
    u = data.get("userInfo", {}).get("user", {})
    s = data.get("userInfo", {}).get("stats", {})

    if not u.get("id"):
        status_code = data.get("statusCode")
        status_info = f" (statusCode={status_code})" if status_code else ""
        raise ValueError(f"No user data returned{status_info}")

    return {
        "tiktok_id":       u.get("id"),
        "sec_uid":         u.get("secUid"),
        "username":        u.get("uniqueId", username),
        "display_name":    u.get("nickname"),
        "bio":             u.get("signature"),
        "bio_link":        (u.get("bioLink") or {}).get("link") or None,
        "join_date":       u.get("createTime"),
        "follower_count":  s.get("followerCount", 0),
        "following_count": s.get("followingCount", 0),
        "video_count":     s.get("videoCount", 0),
        # 'secret' flag means the account is private (not necessarily banned)
        "is_private":      bool(u.get("secret")),
        # relation encodes the relationship between the cookies account and this account:
        # 0=none, 1=cookies follows them, 2=mutual/friends, 4=cookies blocked them,
        # 5=they blocked cookies (cookies was following), 6=they follow cookies only.
        "relation":        int(u.get("relation") or 0),
        "verified":        bool(u.get("verified")),
        "avatar_url":      u.get("avatarLarger") or u.get("avatarMedium") or u.get("avatarThumb"),
        "_raw_user_data":  json.dumps(data),
    }


async def _fetch_page_user_detail(api, username: str) -> dict | None:
    """Load @{username}'s profile page in the open session's browser and read
    the embedded __UNIVERSAL_DATA_FOR_REHYDRATION__ script tag (the same blob
    get_video_details parses off video pages with curl_cffi). Returns the
    webapp.user-detail scope, which carries the same statusCode/userInfo shape
    as the /api/user/detail/ JSON endpoint, or None when no blob is readable
    (consent or verification wall, timeout, page layout change) so the caller
    falls back to the endpoint. Misses are printed (terminal only): they are
    expected to be rare, and a silent miss would make every fallback failure
    look like an endpoint problem."""
    try:
        page = api.sessions[0].page
        await page.goto(f"https://www.tiktok.com/@{username}",
                        wait_until="domcontentloaded")
        blob = await page.evaluate(
            """() => {
                const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
                return el ? el.textContent : null;
            }"""
        )
        if not blob:
            print(f"Profile page read for @{username}: no rehydration blob, "
                  f"likely a verification or consent wall (url: {page.url})")
            return None
        detail = json.loads(blob).get("__DEFAULT_SCOPE__", {}).get("webapp.user-detail")
    except Exception as exc:
        print(f"Profile page read for @{username} failed: {exc}")
        return None
    if not isinstance(detail, dict):
        print(f"Profile page read for @{username}: blob has no webapp.user-detail scope")
        return None
    # The navigation replaced the page that carried the request signer; wait
    # for it to come back so the session's next signed call (item_list) works.
    await _wait_for_signer(page, attempts=10)
    return detail


async def _endpoint_user_info(api, username: str | None, sec_uid: str) -> dict:
    """Resolve a profile through the signed /api/user/detail/ JSON endpoint.

    The fallback behind the page read: it resolves by secUid alone (no
    username needed) and self-heals the moment TikTok starts answering it
    again. Passing username alongside when available does no harm and may
    help TikTok disambiguate, but is not required.
    """
    data = None
    for _attempt in range(2):
        data = await api.make_request(
            url="https://www.tiktok.com/api/user/detail/",
            params={"secUid": sec_uid, "uniqueId": username or ""},
        )
        if data is None:
            raise RuntimeError(
                f"TikTokApi returned None for sec_uid={sec_uid} "
                f"-- TikTok may have blocked the request or cookies are stale"
            )
        _raise_for_user_status(data, f"sec_uid={sec_uid}")
        if data.get("userInfo", {}).get("user", {}).get("id"):
            break  # got valid data
        # statusCode 0 with empty user object is a transient session artifact.
        # The session is degraded but not blocked -- a short wait and one retry
        # consistently resolves it (confirmed via diagnostics on affected accounts).
        if _attempt == 0:
            await asyncio.sleep(3)
        # second attempt falls through to the empty-check in _normalise_user_info
    return _normalise_user_info(data, username)


async def _recover_handle_via_items(api, sec_uid: str) -> str | None:
    """Read the current handle for a secUid off one item_list page.

    Disambiguates a rename from a ban when the profile page under the stored
    handle shows no account and the JSON endpoint is not answering: a renamed
    account still lists items under its secUid, a banned or removed one does
    not. Returns None when nothing is listable.
    """
    try:
        async for video in api.user(sec_uid=sec_uid).videos(count=1):
            author = video.as_dict.get("author") or {}
            if author.get("secUid") == sec_uid and author.get("uniqueId"):
                return str(author["uniqueId"])
            return None
    except Exception:
        pass
    return None


async def get_user_info(api, username: str | None = None,
                        sec_uid: str | None = None) -> dict:
    """Fetch user profile data. Returns a normalised dict.

    Primary path: navigate the session's own browser page to the profile and
    read the embedded rehydration blob. TikTok serves full profile data to
    the real browser even while the signed /api/user/detail/ JSON endpoint
    returns empty bodies for the same session.

    Fallback path: the JSON endpoint (resolves by secUid alone, so it
    survives username changes), kept so the code self-heals if the endpoint
    starts answering again. A final username-only user.info() fallback covers
    lookups that reach the endpoint tier without a sec_uid.

    Renames vs bans: a renamed handle's profile page is indistinguishable
    from a removed account's, so a not-found page for a user with a stored
    sec_uid is never trusted directly; the endpoint and an item_list probe
    get to answer first.
    """
    if not sec_uid and not username:
        raise ValueError("Must provide username or sec_uid")

    page_detail = None
    if username:
        page_detail = await _fetch_page_user_detail(api, username)
    if page_detail:
        u = page_detail.get("userInfo", {}).get("user", {})
        if u.get("id") and (not sec_uid or u.get("secUid") == sec_uid):
            _raise_for_user_status(page_detail, f"@{username}")
            return _normalise_user_info(page_detail, username)
        if not sec_uid:
            # No stored sec_uid means the handle is the identity, so the
            # page's status (banned, private, stale login) is authoritative.
            # When nothing raises the blob was some wall shape; fall through
            # to the endpoint tiers.
            _raise_for_user_status(page_detail, f"@{username}")
        # With a stored sec_uid, a page without that user under this handle
        # is a rename as often as a ban; resolve by secUid below before
        # trusting the page's not-found status.

    if sec_uid:
        try:
            return await _endpoint_user_info(api, username, sec_uid)
        except (UserBannedException, UserPrivateException, UserBlockedException):
            raise  # the endpoint answered; its verdict is authoritative
        except Exception as endpoint_exc:
            # Endpoint dead or empty (TikTok's current behaviour for this
            # session). Probe item_list to tell a rename from a ban.
            handle = await _recover_handle_via_items(api, sec_uid)
            if handle and handle != username:
                renamed_detail = await _fetch_page_user_detail(api, handle)
                if renamed_detail:
                    u = renamed_detail.get("userInfo", {}).get("user", {})
                    if u.get("id") and u.get("secUid") == sec_uid:
                        _raise_for_user_status(renamed_detail, f"@{handle}")
                        return _normalise_user_info(renamed_detail, handle)
            if page_detail is not None:
                # Nothing listable and no endpoint: the page's ban/private
                # status is the best signal left. A renamed account with
                # nothing listable (zero videos, or private and not followed)
                # lands here as a ban; the ban restore machinery self-heals
                # if it ever answers again.
                _raise_for_user_status(page_detail, f"@{username} (sec_uid={sec_uid})")
            raise endpoint_exc

    # Final fallback: username-only lookup via user.info() (first-time adds).
    user = api.user(username=username)
    try:
        data = await user.info()
    except KeyError as exc:
        if exc.args[0] == 'user':
            # TikTok returned userInfo without a 'user' sub-key -- the
            # canonical shape for banned / removed / FTC-restricted accounts.
            raise UserBannedException(
                f"@{username} is banned or removed on TikTok"
            ) from exc
        raise RuntimeError(
            f"TikTokApi returned incomplete data for @{username} "
            f"(missing key {exc}) -- cookies may be stale"
        ) from exc
    _raise_for_user_status(data, f"@{username}")
    return _normalise_user_info(data, username)


def get_user_videos(tiktok_id: str, sec_uid: str | None = None,
                    cookies_path: str | None = None) -> list[dict]:
    """List all videos from a user's profile using yt-dlp flat extraction.

    Prefers tiktokuser:{sec_uid} when sec_uid is available: yt-dlp can use it
    directly without needing to resolve the "secondary user ID" internally, so it
    survives username changes without an extra lookup. Falls back to
    tiktokuser:{tiktok_id} when sec_uid is absent (e.g. newly added users).
    Returns [{video_id, description, upload_date}].
    """
    import yt_dlp
    from platforms.tiktok.config import get_proxy

    ydl_opts = {
        "quiet":        True,
        "no_warnings":  True,
        "extract_flat": True,
    }
    if cookies_path:
        ydl_opts["cookiefile"] = cookies_path
    proxy = get_proxy()
    if proxy:
        ydl_opts["proxy"] = proxy

    # sec_uid is the "channel_id" in yt-dlp terms. Using it directly avoids the
    # "Unable to extract secondary user ID" error yt-dlp raises when it can't
    # resolve a sec_uid from a numeric-only lookup (common after username changes).
    urls_to_try = []
    if sec_uid:
        urls_to_try.append(f"tiktokuser:{sec_uid}")
    urls_to_try.append(f"tiktokuser:{tiktok_id}")

    last_exc: Exception | None = None
    for url in urls_to_try:
        try:
            videos = []
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
                for entry in (info or {}).get("entries") or []:
                    if not entry or not entry.get("id"):
                        continue
                    videos.append({
                        "video_id":    entry["id"],
                        "description": entry.get("title") or "",
                        "upload_date": entry.get("timestamp"),
                    })
            return videos
        except Exception as exc:
            last_exc = exc
            continue

    raise last_exc  # type: ignore[misc]


async def get_user_videos_with_stats(api, sec_uid: str,
                                     max_count: int = 2000,
                                     stop_event=None,
                                     logd=None) -> list[dict]:
    """Page through /api/post/item_list/ and return all reachable videos with stats.

    Uses the already-open TikTokApi session (no new browser launch).
    Stops when hasMore=False, max_count reached, or stop_event is set.
    Returns a list of normalised dicts in the same shape as get_video_details().

    A randomised delay is inserted after every 10 items (~every 3 items within a
    30-item page) to avoid triggering TikTok rate-limiting on the shared session.
    The sleep lands before the generator issues its next request.
    """
    import asyncio
    import random

    results = []
    async for video in api.user(sec_uid=sec_uid).videos(count=max_count):
        if stop_event and stop_event.is_set():
            break
        results.append(_normalise_item_list_entry(video.as_dict))
        n = len(results)
        if n % 30 == 0 and logd:
            logd(f"  Page {n // 30}: {n} items")
        if n % 10 == 0:
            await asyncio.sleep(round(random.uniform(0.5, 1.5), 2))
    return results


def _normalise_item_list_entry(item: dict) -> dict:
    """Map a raw /api/post/item_list/ item to the same shape as get_video_details().

    Handles both statsV2 (nested string values) and stats (direct integers).
    """
    def _stat(v):
        if v is None:
            return None
        if isinstance(v, dict):
            return int(v.get("count", 0) or 0)
        return int(v)

    raw_stats  = item.get("statsV2") or item.get("stats") or {}
    image_post = item.get("imagePost")
    video_meta = item.get("video") or {}
    music      = item.get("music") or {}
    author     = item.get("author") or {}

    image_urls = []
    if image_post:
        image_urls = [
            img["imageURL"]["urlList"][0]
            for img in image_post.get("images", [])
            if img.get("imageURL", {}).get("urlList")
        ]

    try:
        upload_date = int(item["createTime"]) if item.get("createTime") else None
    except (ValueError, TypeError):
        upload_date = None

    return {
        "video_id":            str(item["id"]),
        "description":         item.get("desc", ""),
        "upload_date":         upload_date,
        "type":                "photo" if image_post else "video",
        "image_urls":          image_urls,
        "view_count":          _stat(raw_stats.get("playCount")),
        "like_count":          _stat(raw_stats.get("diggCount")),
        "comment_count":       _stat(raw_stats.get("commentCount")),
        "share_count":         _stat(raw_stats.get("shareCount")),
        "save_count":          _stat(raw_stats.get("collectCount")),
        "repost_count":        _stat(raw_stats.get("repostCount")),
        "duration":            video_meta.get("duration"),
        "width":               video_meta.get("width"),
        "height":              video_meta.get("height"),
        "music_title":         music.get("title"),
        "music_artist":        music.get("authorName"),
        "music_id":            str(music["id"]) if music.get("id") else None,
        "author_id":           author.get("id"),
        "author_username":     author.get("uniqueId"),
        "author_sec_uid":      author.get("secUid"),
        "author_display_name": author.get("nickname"),
        "author_bio":          author.get("signature"),
        "author_avatar":       (author.get("avatarLarger")
                                or author.get("avatarMedium")
                                or author.get("avatarThumb")),
        "_raw_video_data":     None,
    }


async def get_user_stories(api, author_id: str) -> list[dict]:
    """Fetch a user's currently live stories via the story/item_list web endpoint.

    Same endpoint gallery-dl's TikTok extractor uses; requires logged-in
    cookies (the session carries them). authorId is the numeric user ID we
    store as channel_id. Returns raw item dicts in the post/item_list shape.
    Users without live stories return an empty list.
    """
    items: list[dict] = []
    cursor = "0"
    for _page in range(5):  # stories cap out well below 5 pages of 30
        data = await api.make_request(
            url="https://www.tiktok.com/api/story/item_list/",
            params={
                "authorId":     str(author_id),
                "count":        "30",
                "cursor":       cursor,
                "loadBackward": "false",
            },
        )
        if not data or not isinstance(data.get("itemList"), list):
            break
        items.extend(data["itemList"])
        if not data.get("hasMore"):
            break
        cursor = str(data.get("cursor") or "")
        if not cursor or cursor == "0":
            break
    return items


def parse_story_item(item: dict) -> dict | None:
    """Map a raw story item to the engine's story dict contract.

    {story_id, content_type, posted_at, expires_at, media_url}; returns None
    when the item carries no downloadable media URL. Expiry uses the item's
    expiry field when present, otherwise post time + 24h.
    """
    sid = item.get("id")
    if not sid:
        return None
    try:
        posted_at = int(item.get("createTime") or 0) or None
    except (ValueError, TypeError):
        posted_at = None

    expires_at = None
    story_meta = item.get("story") or {}
    for candidate in (story_meta.get("ExpiredAt"), story_meta.get("expiredAt"),
                      item.get("expiredAt"), item.get("storyExpiredAt")):
        try:
            value = int(candidate) if candidate else 0
        except (ValueError, TypeError):
            continue
        if value > 10**12:  # story.ExpiredAt is in milliseconds
            value //= 1000
        if value > 0:
            expires_at = value
            break
    if expires_at is None and posted_at:
        expires_at = posted_at + 24 * 3600

    image_post = item.get("imagePost")
    if image_post:
        urls = [
            img["imageURL"]["urlList"][0]
            for img in image_post.get("images", [])
            if img.get("imageURL", {}).get("urlList")
        ]
        if not urls:
            return None
        return {
            "story_id":     str(sid),
            "content_type": "photo",
            "posted_at":    posted_at,
            "expires_at":   expires_at,
            "media_url":    urls[0],
        }

    video_meta = item.get("video") or {}
    play_addr  = video_meta.get("playAddr") or video_meta.get("downloadAddr")
    if not play_addr:
        bitrates = video_meta.get("bitrateInfo") or []
        for b in bitrates:
            url_list = (b.get("PlayAddr") or {}).get("UrlList") or []
            if url_list:
                play_addr = url_list[0]
                break
    if not play_addr:
        return None
    return {
        "story_id":     str(sid),
        "content_type": "video",
        "posted_at":    posted_at,
        "expires_at":   expires_at,
        "media_url":    play_addr,
    }


async def fetch_sound_video_ids(sound_id: str, ms_token: str | None,
                                cookies_flat: dict | None = None) -> list[str]:
    """Fetch all video IDs that use a given TikTok sound.
    Returns a list of video ID strings (up to ~3000).
    Opens its own TikTokApi session.
    """
    from TikTokApi import TikTokApi

    video_ids: list[str] = []
    async with TikTokApi() as api:
        await create_tiktok_session(api, ms_token, cookies_flat)
        async for video in api.sound(id=sound_id).videos(count=3000):
            video_ids.append(str(video.id))
    return video_ids


def get_video_details(video_id: str, username: str, cookies: dict) -> dict:
    """Fetch type and image URLs for a single video by parsing the TikTok page HTML.
    Returns {type, description, upload_date, image_urls}.
    """
    from curl_cffi import requests as curl_requests
    from platforms.tiktok.config import get_proxy

    url = f"https://www.tiktok.com/@{username}/video/{video_id}"
    proxy = get_proxy()
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        ),
        "Referer":         "https://www.tiktok.com/",
        "Accept-Language": "en-US,en;q=0.9",
    }

    resp = curl_requests.get(
        url, headers=headers, cookies=cookies,
        impersonate="chrome120", timeout=30,
        **({"proxies": {"http": proxy, "https": proxy}} if proxy else {}),
    )

    if resp.status_code != 200:
        raise RuntimeError(
            f"HTTP {resp.status_code} fetching video {video_id} details"
        )

    match = re.search(
        r'<script[^>]+\bid=["\']__UNIVERSAL_DATA_FOR_REHYDRATION__["\'][^>]*>'
        r'([^<]+)</script>',
        resp.text,
    )
    if not match:
        raise RuntimeError("Could not find page data in TikTok response")

    data = json.loads(match.group(1))
    item = (
        data
        .get("__DEFAULT_SCOPE__", {})
        .get("webapp.video-detail", {})
        .get("itemInfo", {})
        .get("itemStruct", {})
    )
    if not item:
        raise RuntimeError("No item data in TikTok page response")

    stats  = item.get("stats", {}) or {}
    video_meta = item.get("video", {}) or {}
    music  = item.get("music", {}) or {}
    author = item.get("author", {}) or {}

    # Build a cleaned raw blob: strip large/expiring fields
    raw = copy.deepcopy(item)
    _vid = raw.get("video", {})
    for _k in ("bitrateInfo", "playAddr", "downloadAddr", "cover", "dynamicCover",
               "originCover", "shareCover", "reflowCover", "codecType",
               "videoQuality", "encodeUserTag", "encodedType"):
        _vid.pop(_k, None)
    for _k in ("avatarLarger", "avatarMedium", "avatarThumb",
               "avatarLargerUrl", "avatarMediumUrl", "avatarThumbUrl"):
        raw.get("author", {}).pop(_k, None)
    _raw_video_data = json.dumps(raw)

    try:
        upload_date = int(item.get("createTime") or 0) or None
    except (ValueError, TypeError):
        upload_date = None

    image_post = item.get("imagePost")
    _author_info = {
        "author_id":           author.get("id"),
        "author_username":     author.get("uniqueId"),
        "author_sec_uid":      author.get("secUid"),
        "author_display_name": author.get("nickname"),
    }

    if image_post:
        image_urls = [
            img["imageURL"]["urlList"][0]
            for img in image_post.get("images", [])
            if img.get("imageURL", {}).get("urlList")
        ]
        return {
            "type":          "photo",
            "description":   item.get("desc", ""),
            "upload_date":   upload_date,
            "image_urls":    image_urls,
            "view_count":    stats.get("playCount"),
            "like_count":    stats.get("diggCount"),
            "comment_count": stats.get("commentCount"),
            "share_count":   stats.get("shareCount"),
            "save_count":    stats.get("collectCount"),
            "repost_count":  stats.get("repostCount"),
            "duration":      None,
            "width":         None,
            "height":        None,
            "music_title":   music.get("title"),
            "music_artist":  music.get("authorName"),
            "music_id":      str(music["id"]) if music.get("id") else None,
            "_raw_video_data": _raw_video_data,
            **_author_info,
        }

    return {
        "type":          "video",
        "description":   item.get("desc", ""),
        "upload_date":   upload_date,
        "image_urls":    [],
        "view_count":    stats.get("playCount"),
        "like_count":    stats.get("diggCount"),
        "comment_count": stats.get("commentCount"),
        "share_count":   stats.get("shareCount"),
        "save_count":    stats.get("collectCount"),
        "repost_count":  stats.get("repostCount"),
        "duration":      video_meta.get("duration"),
        "width":         video_meta.get("width"),
        "height":        video_meta.get("height"),
        "music_title":   music.get("title"),
        "music_artist":  music.get("authorName"),
        "music_id":      str(music["id"]) if music.get("id") else None,
        "_raw_video_data": _raw_video_data,
        **_author_info,
    }
