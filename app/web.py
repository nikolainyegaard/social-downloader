"""Flask application factory."""

import hashlib
import os
import secrets
from datetime import timedelta

from flask import Flask, jsonify, redirect, render_template, request, send_from_directory, abort, session, url_for
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

    from config import (
        OAUTH_ENABLED, SECRET_KEY, DATA_DIR, SESSION_LIFETIME_DAYS,
    )

    # Session configuration. When OAuth is disabled the secret key is unused
    # (no session data is written), so a random per-startup value is fine.
    app.secret_key = SECRET_KEY if SECRET_KEY else secrets.token_hex(32)
    app.config.update(
        SESSION_COOKIE_NAME="sd_session",
        SESSION_COOKIE_HTTPONLY=True,   # deny JS access to the session cookie
        SESSION_COOKIE_SAMESITE="Lax",  # blocks cross-site request forgery for nav requests
        SESSION_COOKIE_SECURE=OAUTH_ENABLED,  # HTTPS-only when auth is active
        PERMANENT_SESSION_LIFETIME=timedelta(days=SESSION_LIFETIME_DAYS),
    )

    if OAUTH_ENABLED:
        # Server-side filesystem sessions so the session can be truly invalidated
        # on logout (client-side-only sessions cannot be revoked).
        sessions_dir = os.path.join(DATA_DIR, "sessions")
        os.makedirs(sessions_dir, exist_ok=True)
        app.config.update(
            SESSION_TYPE="filesystem",
            SESSION_FILE_DIR=sessions_dir,
            SESSION_FILE_THRESHOLD=500,
            SESSION_PERMANENT=True,
        )
        from flask_session import Session
        Session(app)

        # Trust one level of reverse proxy (Caddy) so that url_for(_external=True)
        # and redirect URIs use https:// instead of http://.
        from werkzeug.middleware.proxy_fix import ProxyFix
        app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)

    # Auth blueprint: /login, /auth/callback, /logout
    from auth import bp as auth_bp, init_oauth
    app.register_blueprint(auth_bp)
    init_oauth(app)

    # Central auth enforcement. Checked on every request before any view runs.
    _PUBLIC_ENDPOINTS = {"auth.login", "auth.callback", "auth.logout"}

    @app.before_request
    def _require_auth():
        if not OAUTH_ENABLED:
            return
        if request.endpoint in _PUBLIC_ENDPOINTS:
            return
        # Static assets are intentionally public: they contain no sensitive data
        # and requiring auth for CSS/JS would break the login page itself.
        if request.path.startswith(("/assets/", "/static/")):
            return
        # Health endpoint is public so monitoring tools can check it without auth.
        if request.path == "/api/health":
            return
        if not session.get("user"):
            if request.path.startswith("/api/"):
                return jsonify({"error": "unauthorized", "login_url": url_for("auth.login")}), 401
            next_url = request.full_path.rstrip("?")
            return redirect(url_for("auth.login", next=next_url))

    # Security response headers applied to every response.
    # CSP allows unsafe-inline for scripts/styles because the current templates
    # use inline event handlers and style attributes extensively; tightening this
    # requires a separate refactor. The remaining directives still provide
    # meaningful protection: frame-ancestors blocks clickjacking, object-src
    # blocks Flash/plugin injection, base-uri prevents base-tag hijacking.
    _CSP = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; "
        "media-src 'self' blob:; "
        "connect-src 'self'; "
        "font-src 'self'; "
        "object-src 'none'; "
        "base-uri 'self'; "
        "frame-ancestors 'none';"
    )

    @app.after_request
    def _security_headers(response):
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Content-Security-Policy"] = _CSP
        if OAUTH_ENABLED:
            # Preload-safe: 2 years. Only sent over HTTPS (enforced by Caddy + ProxyFix).
            response.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
        return response

    # Expose auth state to all Jinja2 templates.
    @app.context_processor
    def _auth_context():
        return {"oauth_user": session.get("user") if OAUTH_ENABLED else None}

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
