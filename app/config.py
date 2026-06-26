"""
Central configuration.
Global paths and settings live here; platform-specific config lives in platforms/<platform>/config.py.
"""

import json
import os
import secrets
import shutil
from datetime import datetime

APP_VERSION = os.environ.get("APP_VERSION", "dev")  # v1.19.0

DATA_DIR  = os.path.abspath(os.environ.get("DATA_DIR",  "./data"))
MEDIA_DIR = os.path.abspath(os.environ.get("MEDIA_DIR", "./media"))

WEB_PORT = int(os.environ.get("WEB_PORT", 5000))

THUMBNAIL_WORKERS = int(os.environ.get("THUMBNAIL_WORKERS", min((os.cpu_count() or 4) // 4, 4) or 1))
THUMBNAIL_USE_GPU = os.environ.get("THUMBNAIL_USE_GPU", "").lower() in ("1", "true", "yes")

# Use Google Chrome if available (better bot detection resistance than Playwright Chromium).
# Falls back to None, which tells TikTokApi to use its bundled Chromium.
CHROME_EXECUTABLE: str | None = (
    shutil.which("google-chrome") or shutil.which("google-chrome-stable") or None
)

_IN_DOCKER = os.path.exists("/.dockerenv")

# Secret key for Flask session signing. Auto-generated on first startup and
# persisted to DATA_DIR/.secret_key so it survives container restarts without
# any user configuration.
_SECRET_KEY_PATH = os.path.join(DATA_DIR, ".secret_key")


def _load_secret_key() -> str:
    try:
        with open(_SECRET_KEY_PATH) as f:
            key = f.read().strip()
            if len(key) >= 32:
                return key
    except FileNotFoundError:
        pass
    key = secrets.token_hex(32)
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(_SECRET_KEY_PATH, "w") as f:
            f.write(key)
    except OSError:
        pass
    return key


SECRET_KEY = _load_secret_key()

# Emergency escape hatch: set OAUTH_FORCE_DISABLE=true in docker-compose.yml to
# bypass auth enforcement without modifying oauth.json. Use this if the OIDC
# provider goes down and you are locked out of the Settings UI.
OAUTH_FORCE_DISABLE = os.environ.get("OAUTH_FORCE_DISABLE", "").lower() in ("1", "true", "yes")

# OAuth / OIDC configuration -- managed via Settings > Authentication in the UI.
# Persisted to DATA_DIR/oauth.json; not set via env vars.
_OAUTH_CONFIG_PATH = os.path.join(DATA_DIR, "oauth.json")

_OAUTH_DEFAULTS: dict = {
    "enabled":               False,
    "client_id":             "",
    "client_secret":         "",
    "discovery_url":         "",
    "session_lifetime_days": 7,
}


def get_oauth_config() -> dict:
    """Read oauth.json and merge with defaults. Safe to call frequently."""
    try:
        with open(_OAUTH_CONFIG_PATH) as f:
            data = json.load(f)
        return {**_OAUTH_DEFAULTS, **data}
    except (FileNotFoundError, json.JSONDecodeError):
        return dict(_OAUTH_DEFAULTS)


def save_oauth_config(config: dict) -> None:
    """Persist oauth.json atomically."""
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = _OAUTH_CONFIG_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(config, f, indent=2)
    os.replace(tmp, _OAUTH_CONFIG_PATH)


def get_path_issues() -> list[dict]:
    """Return a list of path issues that should block downloads/loops. Empty = all clear."""
    issues = []
    for name, path in [("DATA_DIR", DATA_DIR), ("MEDIA_DIR", MEDIA_DIR)]:
        try:
            os.makedirs(path, exist_ok=True)
        except OSError:
            pass
        if not os.path.isdir(path) or not os.access(path, os.W_OK):
            issues.append({
                "level": "error", "name": name, "path": path,
                "message": f"{name} ({path}) is not writable -- check directory permissions",
            })
        elif _IN_DOCKER and not os.path.ismount(path):
            issues.append({
                "level": "error", "name": name, "path": path,
                "message": (
                    f"{name} ({path}) is not mounted as a Docker volume. "
                    "Data written here will be lost when the container restarts. "
                    "Add the volume to your docker-compose.yml."
                ),
            })
    return issues


def _ts() -> str:
    """Current local time as a formatted string, used in log lines across modules."""
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")
