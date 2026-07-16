"""The channel platform engine.

One engine instance per platform, each fully isolated: its own SQLite file,
loop state, run queue, worker threads, and log buffer. Everything
platform-specific is declared in a ChannelAdapter; the engine provides the
database, scheduler loop, tracker, and Flask blueprint.

Adding a platform = one adapter (plus its api module) + a registry entry.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from engine.database import ChannelDB
from engine.loop import ChannelLoop


class ChannelGoneError(Exception):
    """The platform definitively reports the account as gone (banned, suspended,
    terminated, or deleted). Adapters raise this from fetch_profile so the
    tracker can mark the channel banned. Transient errors must NOT use it."""


@dataclass
class ChannelAdapter:
    platform: str                   # "twitter"; URL prefix, DB dir, media dir
    label: str                      # "Twitter"; log lines and UI messages
    prefix: str                     # "tw"; thread names and report slugs
    creator_noun: str               # "account"; API error messages
    item_noun: str                  # "post"; log messages
    quick_limit: int | None         # posts fetched by a quick check; None = fetch everything
    has_banner: bool                # cache and serve channel banners

    normalize_handle: Callable      # (raw: str) -> str
    lookup_profile: Callable        # (handle: str) -> info dict; the add flow
    fetch_profile: Callable         # (channel: dict) -> info dict; the loop flow
    iter_posts: Callable            # (channel_id: str) -> iterator of (post_dict, raw_post)
    download_item: Callable         # (engine, channel_id, handle, display_name, vid_id, post, raw, log) -> None

    register_extra_routes: Callable | None = None   # (bp, engine) -> None

    # Full-session override for platforms whose fetching needs session-scoped
    # resources (TikTok holds one browser session across a whole run). When set,
    # the engine's generic tracker is bypassed:
    #   process_session(engine, channels, log, set_current, stop_event) -> completed count
    #   process_single(engine, channel, log, set_current, profile_only, mode) -> None
    process_session: Callable | None = None
    process_single: Callable | None = None

    # Stories: platforms with ephemeral stories set has_stories and, when they
    # use the generic tracker, implement fetch_stories returning story dicts
    # {story_id, content_type 'video'|'photo', posted_at, expires_at, media_url,
    # headers?}. Platforms with a process_session override (TikTok) fetch
    # stories inside their own tracker and call engine.tracker.save_new_stories.
    has_stories: bool = False
    fetch_stories: Callable | None = None           # (engine, channel) -> list[dict]

    # Extra DB setup after ChannelDB.init_db (platform-only tables, e.g. TikTok sounds).
    init_db_extra: Callable | None = None           # (engine) -> None

    # Merge platform-only keys into the /status payload (e.g. TikTok sound loop state).
    extend_status: Callable | None = None           # (engine, state: dict) -> None

    # Platform-only integer settings served/accepted by /settings alongside the
    # schedule keys: {key: default}. on_settings_changed fires when one changes.
    extra_settings: dict | None = None
    on_settings_changed: Callable | None = None     # (engine, changed_keys: list[str]) -> None


class ChannelEngine:
    def __init__(self, adapter: ChannelAdapter):
        self.adapter  = adapter
        self.platform = adapter.platform
        self.label    = adapter.label
        self.db       = ChannelDB(adapter.platform)
        self.loop     = ChannelLoop(self)

    def create_blueprint(self):
        from engine.web import create_channel_blueprint
        return create_channel_blueprint(self)
