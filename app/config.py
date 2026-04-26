"""
Central configuration.
Global paths and settings live here; platform-specific config lives in platforms/<platform>/config.py.
"""

import os
import shutil
from datetime import datetime

APP_VERSION = os.environ.get("APP_VERSION", "dev")  # v1.19.0

DATA_DIR  = os.environ.get("DATA_DIR",  "./data")
MEDIA_DIR = os.environ.get("MEDIA_DIR", "./media")

WEB_PORT = int(os.environ.get("WEB_PORT", 5000))

THUMBNAIL_WORKERS = int(os.environ.get("THUMBNAIL_WORKERS", min((os.cpu_count() or 4) // 4, 4) or 1))
THUMBNAIL_USE_GPU = os.environ.get("THUMBNAIL_USE_GPU", "").lower() in ("1", "true", "yes")

# Use Google Chrome if available (better bot detection resistance than Playwright Chromium).
# Falls back to None, which tells TikTokApi to use its bundled Chromium.
CHROME_EXECUTABLE: str | None = (
    shutil.which("google-chrome") or shutil.which("google-chrome-stable") or None
)


def _ts() -> str:
    """Current local time as a formatted string, used in log lines across modules."""
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")
