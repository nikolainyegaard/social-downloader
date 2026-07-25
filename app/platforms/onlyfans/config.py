"""OnlyFans platform configuration and environment defaults."""

from __future__ import annotations

import os

ONLYFANS_SESSIONS_PER_DAY = int(os.environ.get("ONLYFANS_SESSIONS_PER_DAY", 4))
ONLYFANS_HIGH_PRIORITY_CHECK_HOURS = int(os.environ.get("ONLYFANS_HIGH_PRIORITY_CHECK_HOURS", 6))
ONLYFANS_ACTIVE_CHECK_HOURS = int(os.environ.get("ONLYFANS_ACTIVE_CHECK_HOURS", 24))
ONLYFANS_INACTIVE_CHECK_HOURS = int(os.environ.get("ONLYFANS_INACTIVE_CHECK_HOURS", 72))
ONLYFANS_FULL_REFRESH_DAYS = int(os.environ.get("ONLYFANS_FULL_REFRESH_DAYS", 7))
ONLYFANS_SESSION_GAP_MEAN_SECS = int(os.environ.get("ONLYFANS_SESSION_GAP_MEAN_SECS", 90))
