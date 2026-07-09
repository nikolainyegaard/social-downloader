"""Channel platform registry: one ChannelEngine instance per platform.

main.py starts a scheduler thread per engine and web.py registers a blueprint
per engine, both by iterating ENGINES. Adding a platform: write its api.py and
adapter.py, then add the adapter here.

TikTok is not in the registry yet; it keeps its own implementation in
platforms/tiktok until the phase-3 fold-in.
"""

from __future__ import annotations

from engine import ChannelEngine
from platforms.twitter.adapter import twitter_adapter
from platforms.instagram.adapter import instagram_adapter
from platforms.youtube.adapter import youtube_adapter

ENGINES: dict[str, ChannelEngine] = {
    adapter.platform: ChannelEngine(adapter)
    for adapter in (twitter_adapter, instagram_adapter, youtube_adapter)
}
