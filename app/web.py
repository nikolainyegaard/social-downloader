"""Flask application factory."""

import hashlib
import os

from flask import Flask, render_template, jsonify, request, send_from_directory, abort
from config import APP_VERSION

_STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
_HASHED_FILES = ["style.css", "common.js", "tiktok.js", "youtube.js"]

_hash_to_original: dict[str, str] = {}  # "style-ab12cd34.css" -> "style.css"
_original_to_url:  dict[str, str] = {}  # "style.css"          -> "/assets/style-ab12cd34.css"


def _build_asset_map() -> None:
    for name in _HASHED_FILES:
        path = os.path.join(_STATIC_DIR, name)
        try:
            with open(path, "rb") as f:
                digest = hashlib.md5(f.read()).hexdigest()[:8]
        except FileNotFoundError:
            digest = "00000000"
        base, ext = os.path.splitext(name)
        hashed = f"{base}-{digest}{ext}"
        _hash_to_original[hashed] = name
        _original_to_url[name]    = f"/assets/{hashed}"


def create_app() -> Flask:
    app = Flask(__name__)
    _build_asset_map()

    from platforms.tiktok.web import tiktok_bp
    app.register_blueprint(tiktok_bp)

    from platforms.youtube.web import youtube_bp
    app.register_blueprint(youtube_bp)

    @app.route("/")
    def index():
        return render_template("index.html", version=APP_VERSION)

    @app.route("/api/health")
    def health():
        from config import get_path_issues
        issues = get_path_issues()
        return jsonify({"ok": not issues, "issues": issues})

    @app.route("/api/migrate/preview")
    def migrate_preview():
        from platforms.tiktok.database import get_legacy_path_prefixes
        return jsonify(get_legacy_path_prefixes())

    @app.route("/api/migrate", methods=["POST"])
    def migrate_paths():
        from platforms.tiktok.database import rewrite_file_paths
        body = request.get_json(silent=True) or {}
        old_prefix = (body.get("old_prefix") or "").strip().rstrip("/")
        new_prefix = (body.get("new_prefix") or "").strip().rstrip("/")
        if not old_prefix or not new_prefix:
            return jsonify({"error": "old_prefix and new_prefix are required"}), 400
        if old_prefix == new_prefix:
            return jsonify({"error": "old_prefix and new_prefix must differ"}), 400
        count = rewrite_file_paths(old_prefix, new_prefix)
        return jsonify({"ok": True, "updated": count})

    @app.route("/assets/<path:filename>")
    def hashed_asset(filename):
        original = _hash_to_original.get(filename)
        if not original:
            abort(404)
        response = send_from_directory(_STATIC_DIR, original)
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response

    def _asset_url(filename: str) -> str:
        return _original_to_url.get(filename, f"/static/{filename}")

    app.jinja_env.globals["asset_url"] = _asset_url

    return app
