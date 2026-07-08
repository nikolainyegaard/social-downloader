"""Instagram API stubs - placeholder implementation."""


def fetch_profile_info(handle):
    # ponytail: stub until Instagram API is implemented
    raise NotImplementedError("Instagram API not yet implemented")


def normalize_handle(handle):
    handle = handle.strip().lstrip("@")
    if "/" in handle:
        handle = handle.rstrip("/").rsplit("/", 1)[-1].lstrip("@")
    return handle
