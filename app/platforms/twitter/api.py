"""Twitter API stubs - placeholder implementation."""


def fetch_account_info(handle):
    # ponytail: stub until Twitter API is implemented
    raise NotImplementedError("Twitter API not yet implemented")


def normalize_handle(handle):
    handle = handle.strip().lstrip("@")
    if "/" in handle:
        handle = handle.rstrip("/").rsplit("/", 1)[-1].lstrip("@")
    return handle
