"""TikTok QR login: mint the session inside the app's own persistent browser.

The phone app does the authenticating, so no credentials touch this service,
and the session cookie is created with the exact browser fingerprint that will
use it. After login the profile's cookies are exported to cookies.txt so
curl_cffi scrapes and yt-dlp downloads share the same session.
"""

from __future__ import annotations

import asyncio
import base64
import threading
import time

QR_URL       = "https://www.tiktok.com/login/qrcode"
TIMEOUT_SECS = 240
POLL_SECS    = 2
# Consecutive polls the QR element must be missing before the whole page is
# shown instead. The element is legitimately absent on a verification wall or
# a post-scan confirmation, but also briefly while the page loads, and a
# flash of the half-loaded page before the code appears looks broken.
FULL_PAGE_AFTER = 3

_lock  = threading.Lock()
_state = {"status": "idle", "qr": None, "message": None}
_thread: threading.Thread | None = None


def _set(**kw):
    with _lock:
        _state.update(kw)


def get_state() -> dict:
    with _lock:
        return dict(_state)


def start_qr_login() -> tuple[bool, str]:
    """Kick off the QR login flow in a background thread. Returns (ok, message)."""
    global _thread
    if _thread and _thread.is_alive():
        return False, "A QR login is already in progress"
    _set(status="starting", qr=None, message=None)
    _thread = threading.Thread(target=_run, name="tiktok-qr-login", daemon=True)
    _thread.start()
    return True, "started"


def _run():
    try:
        asyncio.run(_flow())
    except Exception as e:
        _set(status="error", qr=None, message=str(e))


async def _flow():
    from playwright.async_api import async_playwright
    from platforms.tiktok.api import _profile_context_factory, browser_gate

    # Hold the browser turn for the whole login so a session starting mid-login
    # waits instead of falling back to an ephemeral context next to us.
    if not browser_gate.turn.acquire(blocking=False):
        _set(status="error", qr=None,
             message="The browser is in use, likely by a running loop. Try again when it finishes.")
        return
    try:
        await _flow_with_turn(async_playwright, _profile_context_factory)
    finally:
        browser_gate.turn.release()


async def _flow_with_turn(async_playwright, _profile_context_factory):
    factory, release = _profile_context_factory()
    if factory is None:
        _set(status="error", qr=None,
             message="The browser is in use, likely by a running loop. Try again when it finishes.")
        return
    try:
        async with async_playwright() as pw:
            context = await factory(pw)
            try:
                page = await context.new_page()
                await page.goto(QR_URL, wait_until="domcontentloaded")
                deadline = time.time() + TIMEOUT_SECS
                misses = 0  # consecutive polls without the QR element
                while time.time() < deadline:
                    if await _logged_in(context):
                        n = _export_cookies(await context.cookies())
                        _set(status="success", qr=None,
                             message=f"Signed in. {n} cookies saved to cookies.txt")
                        return
                    shot, cropped = await _screenshot(page, full_page=misses >= FULL_PAGE_AFTER)
                    if cropped:
                        misses = 0
                        _set(status="waiting", qr=shot, message=None)
                    elif shot:
                        misses += 1
                        _set(status="waiting", qr=shot, message=None)
                    else:
                        misses += 1
                        # keep the last frame on a transient miss; only report
                        # loading while nothing has been shown yet
                        if get_state()["qr"] is None:
                            _set(status="waiting", qr=None,
                                 message="Loading the login page")
                    await asyncio.sleep(POLL_SECS)
                _set(status="expired", qr=None, message="Login window timed out")
            finally:
                await context.close()
    finally:
        release()  # idempotent, the context close event also fires it


async def _logged_in(context) -> bool:
    for c in await context.cookies("https://www.tiktok.com"):
        if c.get("name") == "sessionid" and c.get("value"):
            return True
    return False


async def _screenshot(page, full_page: bool) -> tuple[str | None, bool]:
    """Return (data URL, cropped) for the QR element, re-captured every poll so
    refresh prompts and scan confirmations show up in the UI as the page changes.

    The whole page is captured instead only when full_page is set (the element
    has been missing for a few polls, so this is a wall or a changed page, not
    a load in progress).
    """
    # ponytail: selector-based capture of the QR canvas, whole page when TikTok
    # changes markup. The user still sees whatever the login page shows
    for selector in ("canvas", 'img[src^="data:image"]'):
        try:
            loc = page.locator(selector)
            if await loc.count():
                png = await loc.first.screenshot(timeout=3000)
                return "data:image/png;base64," + base64.b64encode(png).decode(), True
        except Exception:
            continue
    if not full_page:
        return None, False
    try:
        png = await page.screenshot(timeout=3000)
        return "data:image/png;base64," + base64.b64encode(png).decode(), False
    except Exception:
        return None, False


def _export_cookies(cookies: list[dict]) -> int:
    """Write the profile's TikTok cookies to cookies.txt. Returns the count."""
    from cookies import save_cookies_netscape

    tiktok = [c for c in cookies if "tiktok" in (c.get("domain") or "")]
    save_cookies_netscape("tiktok", tiktok)
    return len(tiktok)
