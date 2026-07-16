"""TikTok-specific configuration and cookie helpers."""

from __future__ import annotations

import os
from config import DATA_DIR, MEDIA_DIR, CHROME_EXECUTABLE  # noqa: F401

TIKTOK_DATA_DIR        = os.path.join(DATA_DIR, "tiktok")
AVATARS_DIR            = os.path.join(TIKTOK_DATA_DIR, "avatars")
COOKIES_PATH           = os.path.join(TIKTOK_DATA_DIR, "cookies.txt")
COOKIES_TIMESTAMP_PATH = os.path.join(TIKTOK_DATA_DIR, "cookies.timestamp")
TIKTOK_MEDIA_DIR       = os.path.join(MEDIA_DIR, "tiktok")

# Env var precedence: TIKTOK_* > legacy USER_LOOP_INTERVAL_MINUTES > LOOP_INTERVAL_MINUTES
_LOOP_LEGACY                = int(os.environ.get("LOOP_INTERVAL_MINUTES", 180))
_USER_LOOP_LEGACY           = int(os.environ.get("USER_LOOP_INTERVAL_MINUTES", _LOOP_LEGACY))
USER_LOOP_INTERVAL_MINUTES  = int(os.environ.get("TIKTOK_USER_LOOP_INTERVAL_MINUTES", _USER_LOOP_LEGACY))
SOUND_LOOP_INTERVAL_MINUTES = int(os.environ.get("TIKTOK_SOUND_LOOP_INTERVAL_MINUTES",
                                  int(os.environ.get("SOUND_LOOP_INTERVAL_MINUTES", 60))))

DELETION_CONFIRM_THRESHOLD = int(os.environ.get("DELETION_CONFIRM_THRESHOLD", 2))

SESSIONS_PER_DAY          = int(os.environ.get("TIKTOK_SESSIONS_PER_DAY", 4))
HIGH_PRIORITY_CHECK_HOURS = int(os.environ.get("TIKTOK_HIGH_PRIORITY_CHECK_HOURS", 6))
ACTIVE_CHECK_HOURS        = int(os.environ.get("TIKTOK_ACTIVE_CHECK_HOURS", 24))
INACTIVE_CHECK_HOURS      = int(os.environ.get("TIKTOK_INACTIVE_CHECK_HOURS", 72))
STATS_REFRESH_DAYS        = int(os.environ.get("TIKTOK_STATS_REFRESH_DAYS", 7))
SESSION_GAP_MEAN_SECS     = int(os.environ.get("TIKTOK_SESSION_GAP_MEAN_SECS", 90))


# The fixed address of a gluetun sidecar's HTTP proxy in gluetun mode. Assumes
# the container is reachable as "gluetun" on the Docker network, which the
# README compose example provides; other setups use custom mode instead.
GLUETUN_PROXY_URL = "http://gluetun:8888"


def get_proxy_settings() -> dict:
    """The proxy settings with all defaults applied: {mode, url, enabled}.

    mode is "gluetun" (fixed GLUETUN_PROXY_URL, WireGuard config managed in
    the UI) or "custom" (user-entered url). Settings live in the TikTok DB
    (Settings > Network > TikTok); the TIKTOK_PROXY env var seeds a custom
    url and enables routing until the UI writes its own values. Installs that
    saved a url before modes existed keep it via the custom default.
    """
    env_url = os.environ.get("TIKTOK_PROXY", "")
    try:
        # Lazy import: the registry imports this module while building engines
        from platforms.registry import ENGINES
        db = ENGINES["tiktok"].db
        url     = (db.get_setting("proxy_url", env_url) or "").strip()
        mode    = db.get_setting("proxy_mode", "custom" if url else "gluetun")
        enabled = db.get_setting("proxy_enabled", "1" if env_url else "0") == "1"
    except Exception:
        url     = env_url.strip()
        mode    = "custom" if url else "gluetun"
        enabled = bool(env_url)
    return {"mode": mode, "url": url, "enabled": enabled}


def get_proxy() -> str | None:
    """URL all TikTok traffic routes through, or None when routing is off.

    Read per use, so a settings change applies from the next browser session
    or request without a restart.
    """
    s = get_proxy_settings()
    if not s["enabled"]:
        return None
    if s["mode"] == "gluetun":
        return GLUETUN_PROXY_URL
    return s["url"] or None


def get_ms_token() -> str | None:
    """
    Return the msToken value for TikTokApi sessions.

    Priority:
      1. Parse msToken / ms_token from cookies.txt (Netscape format).
      2. Fall back to the ms_token environment variable.
    """
    try:
        with open(COOKIES_PATH, encoding="utf-8", errors="ignore") as f:
            for line in f:
                if line.startswith("#") or not line.strip():
                    continue
                parts = line.strip().split("\t")
                # Netscape cookie format: domain flag path secure expiry name value
                if len(parts) == 7 and parts[5].lower() in ("mstoken", "ms_token"):
                    return parts[6]
    except FileNotFoundError:
        pass
    return os.environ.get("ms_token")


def get_cookies_flat() -> dict:
    """Return cookies.txt as a flat {name: value} dict."""
    from cookies import get_cookies_flat as _shared
    return _shared("tiktok")


def cookies_info() -> dict:
    """Return metadata about the current cookies file."""
    from cookies import cookies_info as _shared
    return _shared("tiktok")
