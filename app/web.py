"""Flask application factory."""

from flask import Flask, render_template
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

    return app
