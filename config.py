"""
Central configuration and cookie helpers.
All modules import paths and settings from here.
"""

import os

DATA_DIR    = os.environ.get("DATA_DIR",   "./data")
VIDEOS_DIR  = os.environ.get("VIDEOS_DIR", "./videos")
COOKIES_PATH = os.path.join(DATA_DIR, "cookies.txt")

LOOP_INTERVAL_MINUTES = int(os.environ.get("LOOP_INTERVAL_MINUTES", 30))
WEB_PORT              = int(os.environ.get("WEB_PORT", 5000))


def get_ms_token() -> str | None:
    """
    Return the msToken value for TikTokApi sessions.

    Priority:
      1. Parse msToken / ms_token from ./data/cookies.txt (Netscape format).
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
    result = {}
    try:
        with open(COOKIES_PATH, encoding="utf-8", errors="ignore") as f:
            for line in f:
                stripped = line.strip()
                if not stripped:
                    continue
                if stripped.startswith("#HttpOnly_"):
                    stripped = stripped[len("#HttpOnly_"):]
                elif stripped.startswith("#"):
                    continue
                parts = stripped.split("\t")
                if len(parts) != 7:
                    continue
                _domain, _flag, _path, _secure, _expiry, name, value = parts
                result[str(name)] = str(value)
    except FileNotFoundError:
        pass
    return result


def get_cookies_for_playwright() -> list[dict]:
    """
    Parse cookies.txt and return a list of Playwright-format cookie dicts
    suitable for passing to TikTokApi's create_sessions(cookies=[...]).
    """
    result = []
    try:
        with open(COOKIES_PATH, encoding="utf-8", errors="ignore") as f:
            for line in f:
                stripped = line.strip()
                if not stripped:
                    continue
                if stripped.startswith("#HttpOnly_"):
                    stripped = stripped[len("#HttpOnly_"):]
                elif stripped.startswith("#"):
                    continue
                parts = stripped.split("\t")
                if len(parts) != 7:
                    continue
                domain, _, path, secure, expiry, name, value = parts
                try:
                    expires = float(expiry)
                except (ValueError, TypeError):
                    expires = -1.0
                result.append({
                    "name":    str(name),
                    "value":   str(value),
                    "domain":  str(domain),
                    "path":    str(path),
                    "expires": expires,
                })
    except FileNotFoundError:
        pass
    return result


def cookies_info() -> dict:
    """Return metadata about the current cookies file."""
    if not os.path.exists(COOKIES_PATH):
        return {"present": False}
    stat = os.stat(COOKIES_PATH)
    return {
        "present":      True,
        "updated_at":   int(stat.st_mtime),
        "size_bytes":   stat.st_size,
    }
