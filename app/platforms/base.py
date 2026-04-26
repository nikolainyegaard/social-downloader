"""Abstract base class for platform adapters."""


class PlatformAdapter:
    platform: str  # "tiktok", "youtube"

    def fetch_profile(self, creator: dict) -> dict:
        raise NotImplementedError

    def fetch_videos(self, creator: dict) -> list[dict]:
        raise NotImplementedError

    def fetch_video_detail(self, video_id: str, creator: dict) -> dict:
        raise NotImplementedError

    def build_download_url(self, video: dict, creator: dict) -> str:
        raise NotImplementedError

    def normalize_username(self, raw: str) -> str:
        raise NotImplementedError
