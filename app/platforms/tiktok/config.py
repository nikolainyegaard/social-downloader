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


def get_proxy() -> str | None:
    """URL of the proxy all TikTok traffic routes through, or None when off.

    Toggle and URL live in the TikTok DB settings (Settings > Accounts >
    TikTok); the TIKTOK_PROXY env var seeds the URL and enables routing until
    the UI writes its own values. Read per use, so a toggle applies from the
    next browser session or request without a restart.
    """
    env_url = os.environ.get("TIKTOK_PROXY", "")
    try:
        # Lazy import: the registry imports this module while building engines
        from platforms.registry import ENGINES
        db = ENGINES["tiktok"].db
        enabled = db.get_setting("proxy_enabled", "1" if env_url else "0")
        url = db.get_setting("proxy_url", env_url) or ""
    except Exception:
        enabled, url = ("1" if env_url else "0"), env_url
    return (url.strip() or None) if enabled == "1" else None


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
