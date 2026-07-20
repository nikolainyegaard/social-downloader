"""Shared Netscape cookies.txt storage, one file per platform.

Each platform stores its cookies at DATA_DIR/{platform}/cookies.txt with an
explicit upload timestamp at DATA_DIR/{platform}/cookies.timestamp (st_mtime
is unreliable on Docker volume mounts and resets on container restart).
"""

from __future__ import annotations

import os
import time

from config import DATA_DIR


def cookies_path(platform: str) -> str:
    return os.path.join(DATA_DIR, platform, "cookies.txt")


def _timestamp_path(platform: str) -> str:
    return os.path.join(DATA_DIR, platform, "cookies.timestamp")


def cookies_info(platform: str) -> dict:
    """Return metadata about the platform's current cookies file."""
    path = cookies_path(platform)
    if not os.path.exists(path):
        return {"present": False}
    try:
        with open(_timestamp_path(platform), encoding="utf-8") as f:
            uploaded_at = int(f.read().strip())
    except (FileNotFoundError, ValueError):
        uploaded_at = None
    return {
        "present":    True,
        "updated_at": uploaded_at,
        "size_bytes": os.stat(path).st_size,
    }


def save_cookies(platform: str, file_storage) -> None:
    """Persist an uploaded cookies.txt (werkzeug FileStorage) and stamp the upload time."""
    path = cookies_path(platform)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):
        os.remove(path)
    file_storage.save(path)
    with open(_timestamp_path(platform), "w", encoding="utf-8") as f:
        f.write(str(int(time.time())))


def save_cookies_netscape(platform: str, cookies: list[dict]) -> None:
    """Write browser cookie dicts (Playwright context.cookies() shape) as a
    Netscape cookies.txt and stamp the update time."""
    path = cookies_path(platform)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    lines = ["# Netscape HTTP Cookie File"]
    for c in cookies:
        domain = c.get("domain") or ""
        expires = c.get("expires") or 0
        lines.append("\t".join([
            domain,
            "TRUE" if domain.startswith(".") else "FALSE",
            c.get("path") or "/",
            "TRUE" if c.get("secure") else "FALSE",
            str(int(expires) if expires > 0 else 0),
            c.get("name") or "",
            c.get("value") or "",
        ]))
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    with open(_timestamp_path(platform), "w", encoding="utf-8") as f:
        f.write(str(int(time.time())))


def delete_cookies(platform: str) -> None:
    for path in (cookies_path(platform), _timestamp_path(platform)):
        if os.path.exists(path):
            os.remove(path)


def get_cookies_flat(platform: str) -> dict:
    """Return the platform's cookies.txt as a flat {name: value} dict."""
    result: dict = {}
    try:
        with open(cookies_path(platform), encoding="utf-8", errors="ignore") as f:
            for line in f:
                stripped = line.strip()
                if not stripped:
                    continue
                if stripped.startswith("#HttpOnly_"):
                    stripped = stripped[len("#HttpOnly_"):]
                elif stripped.startswith("#"):
                    continue
                parts = stripped.split("\t")
                if len(parts) != 7:
                    continue
                _domain, _flag, _path, _secure, _expiry, name, value = parts
                result[str(name)] = str(value)
    except FileNotFoundError:
        pass
    return result


def register_cookie_routes(bp, platform: str, on_change=None) -> None:
    """Register GET/POST/DELETE /cookies on a platform Blueprint.

    on_change, if given, runs after every upload or delete so the platform can
    rebuild in-memory state from the file (e.g. Instagram's instaloader
    session). If it returns an error string on upload, the file is rejected:
    removed again and reported as a 400."""
    from flask import jsonify, request

    @bp.route("/cookies", methods=["GET"])
    def get_cookies():
        return jsonify(cookies_info(platform))

    @bp.route("/cookies", methods=["POST"])
    def upload_cookies():
        if "file" not in request.files:
            return jsonify({"error": "No file provided"}), 400
        f = request.files["file"]
        if not f.filename:
            return jsonify({"error": "Empty filename"}), 400
        save_cookies(platform, f)
        if on_change:
            err = on_change()
            if err:
                delete_cookies(platform)
                on_change()
                return jsonify({"error": err}), 400
        return jsonify({"ok": True, **cookies_info(platform)})

    @bp.route("/cookies", methods=["DELETE"])
    def remove_cookies():
        delete_cookies(platform)
        if on_change:
            on_change()
        return jsonify({"ok": True})
