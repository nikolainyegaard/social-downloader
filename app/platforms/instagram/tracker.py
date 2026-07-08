"""Instagram channel tracking."""

from __future__ import annotations

import threading
from typing import Callable

from platforms.instagram import database as db
from platforms.instagram.api import fetch_profile_info


def process_all_channels(
    channels: list[dict],
    log: Callable[[str], None],
    set_current: Callable[[str | None], None] | None = None,
    stop_event: threading.Event | None = None,
) -> int:
    """Process all tracked Instagram channels. Returns the count of successful channel runs."""
    completed = 0
    for channel in channels:
        if stop_event and stop_event.is_set():
            log("=== Instagram loop stopped by request ===")
            break
        try:
            process_single_channel(channel, log, set_current)
            completed += 1
        except Exception as e:
            log(f"Unhandled error for @{channel.get('handle', '?')}: {e}")
    return completed


def process_single_channel(
    channel: dict,
    log: Callable[[str], None],
    set_current: Callable[[str | None], None] | None = None,
    profile_only: bool = False,
) -> None:
    """Placeholder: Instagram API not yet implemented."""
    handle = channel.get("handle", "?")
    if set_current:
        set_current(handle)
    try:
        log(f"[Instagram] Loop: placeholder - not yet implemented (@{handle})")
    finally:
        if set_current:
            set_current(None)


def run_full_loop():
    print("[Instagram] Loop: placeholder - not yet implemented")
