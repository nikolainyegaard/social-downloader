"""Flask application factory."""

from flask import Flask, render_template, jsonify, request
from config import APP_VERSION


def create_app() -> Flask:
    app = Flask(__name__)

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

    return app
