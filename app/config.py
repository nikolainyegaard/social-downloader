"""
Central configuration.
Global paths and settings live here; platform-specific config lives in platforms/<platform>/config.py.
"""

import os
import shutil
from datetime import datetime

APP_VERSION = os.environ.get("APP_VERSION", "dev")  # v1.19.0

# OAuth / OIDC authentication (disabled by default)
OAUTH_ENABLED       = os.environ.get("OAUTH_ENABLED", "").lower() in ("1", "true", "yes")
SECRET_KEY          = os.environ.get("SECRET_KEY", "")
OAUTH_CLIENT_ID     = os.environ.get("OAUTH_CLIENT_ID", "")
OAUTH_CLIENT_SECRET = os.environ.get("OAUTH_CLIENT_SECRET", "")
OAUTH_DISCOVERY_URL = os.environ.get("OAUTH_DISCOVERY_URL", "")
SESSION_LIFETIME_DAYS = int(os.environ.get("SESSION_LIFETIME_DAYS", "7"))

if OAUTH_ENABLED:
    _missing = [k for k, v in {
        "SECRET_KEY":          SECRET_KEY,
        "OAUTH_CLIENT_ID":     OAUTH_CLIENT_ID,
        "OAUTH_CLIENT_SECRET": OAUTH_CLIENT_SECRET,
        "OAUTH_DISCOVERY_URL": OAUTH_DISCOVERY_URL,
    }.items() if not v]
    if _missing:
        raise RuntimeError(
            f"OAUTH_ENABLED=true but these env vars are not set: {', '.join(_missing)}"
        )

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
