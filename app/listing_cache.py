"""Per-creator cache of the last complete post listing.

A full check lists a creator's whole catalog (yt-dlp plus a scrolled profile
page on TikTok, every HikerAPI page on Instagram), which for a large creator
is minutes of work and, on paid APIs, money, before the comment stage even
starts. Manual runs within LISTING_CACHE_HOURS of such a listing reuse it:
the check lists only the newest posts, takes stats and comment counts for
the rest from here, and skips deletion detection (absence from a cached list
proves nothing). Scheduled checks never read the cache, so their deletion
cadence is unchanged; the "(no cache)" run variants bypass it too.

One JSON file per creator under data/{platform}/listing_cache/, written
after every complete full listing: {"ts": unix, "posts": {video_id: post}}.
"""
import json
import os
import time

from config import DATA_DIR

TTL_HOURS = int(os.environ.get("LISTING_CACHE_HOURS", 6))


def split_mode(mode: str) -> tuple[str, bool]:
    """'full-nocache' -> ('full', False); 'quick' -> ('quick', True)."""
    base, _, flag = (mode or "full").partition("-")
    return base, flag != "nocache"


def _path(platform: str, channel_id: str) -> str:
    return os.path.join(DATA_DIR, platform, "listing_cache", f"{channel_id}.json")


def save(platform: str, channel_id: str, posts: dict) -> None:
    path = _path(platform, channel_id)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"ts": int(time.time()), "posts": posts}, f, default=str)
    os.replace(tmp, path)


def load(platform: str, channel_id: str) -> dict | None:
    """The cached listing when it is younger than TTL_HOURS, else None."""
    try:
        with open(_path(platform, channel_id), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    if time.time() - data.get("ts", 0) > TTL_HOURS * 3600 or not isinstance(data.get("posts"), dict):
        return None
    return data


def age(cached: dict) -> str:
    mins = int(time.time() - cached["ts"]) // 60
    return f"{mins // 60}h {mins % 60:02d}m" if mins >= 60 else f"{mins}m"


if __name__ == "__main__":
    import tempfile
    DATA_DIR = tempfile.mkdtemp()  # noqa: F811
    assert split_mode("full-nocache") == ("full", False) and split_mode("quick") == ("quick", True)
    save("t", "c1", {"v1": {"comment_count": 3}})
    c = load("t", "c1")
    assert c and c["posts"]["v1"]["comment_count"] == 3 and age(c) == "0m"
    c["ts"] -= (TTL_HOURS + 1) * 3600
    with open(_path("t", "c1"), "w") as f:
        json.dump(c, f)
    assert load("t", "c1") is None
    print("listing_cache ok")
