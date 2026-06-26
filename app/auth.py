"""OAuth2/OIDC authentication blueprint (Authlib + Authentik)."""

from functools import wraps
from urllib.parse import urlencode, urlparse

from authlib.integrations.flask_client import OAuth
from flask import Blueprint, jsonify, redirect, request, session, url_for

bp = Blueprint("auth", __name__)
_oauth = OAuth()


def init_oauth(app):
    """Bind the OAuth client to the app and register the OIDC provider if enabled."""
    _oauth.init_app(app)
    from config import OAUTH_ENABLED
    if not OAUTH_ENABLED:
        return
    from config import OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_DISCOVERY_URL
    _oauth.register(
        name="oidc",
        client_id=OAUTH_CLIENT_ID,
        client_secret=OAUTH_CLIENT_SECRET,
        server_metadata_url=OAUTH_DISCOVERY_URL,
        client_kwargs={
            "scope": "openid profile email",
            "code_challenge_method": "S256",  # PKCE
        },
    )


def _safe_next(url):
    """Return url only if it is a safe internal relative path; otherwise return '/'."""
    if not url:
        return "/"
    parsed = urlparse(url)
    # Reject absolute URLs and protocol-relative paths
    if parsed.scheme or parsed.netloc:
        return "/"
    path = parsed.path
    if not path.startswith("/") or path.startswith("//"):
        return "/"
    # Avoid redirect loops into auth routes
    if path.startswith("/login") or path.startswith("/auth/") or path.startswith("/logout"):
        return "/"
    return url


@bp.route("/login")
def login():
    from config import OAUTH_ENABLED
    if not OAUTH_ENABLED:
        return redirect("/")
    if session.get("user"):
        return redirect(_safe_next(request.args.get("next", "/")))
    next_url = _safe_next(request.args.get("next", "/"))
    # Persist the intended destination across the provider redirect
    session["_oauth_next"] = next_url
    redirect_uri = url_for("auth.callback", _external=True)
    return _oauth.oidc.authorize_redirect(redirect_uri)


@bp.route("/auth/callback")
def callback():
    from config import OAUTH_ENABLED
    if not OAUTH_ENABLED:
        return redirect("/")

    token = _oauth.oidc.authorize_access_token()
    userinfo = token.get("userinfo") or {}
    next_url = session.get("_oauth_next", "/")

    # Session fixation prevention: discard all pre-login session data before
    # writing the authenticated identity, so the pre-auth session ID cannot be
    # reused by an attacker who obtained it.
    session.clear()

    session["user"] = {
        "sub":   userinfo.get("sub", ""),
        "email": userinfo.get("email", ""),
        "name":  userinfo.get("name") or userinfo.get("preferred_username", ""),
    }
    # Raw ID token kept server-side (in the server-side session file, not the cookie)
    # so it can be passed as id_token_hint on OIDC front-channel logout.
    session["_id_token"] = token.get("id_token", "")
    session.permanent = True

    return redirect(_safe_next(next_url))


@bp.route("/logout")
def logout():
    from config import OAUTH_ENABLED
    if not OAUTH_ENABLED:
        return redirect("/")

    id_token = session.get("_id_token", "")
    session.clear()

    # OIDC front-channel logout: tell the IdP the session has ended so it can
    # invalidate its own session and enforce single-sign-out.
    try:
        metadata = _oauth.oidc.load_server_metadata()
        end_session = metadata.get("end_session_endpoint")
        if end_session and id_token:
            post_logout_uri = url_for("auth.login", _external=True)
            return redirect(
                end_session + "?" + urlencode({
                    "id_token_hint":            id_token,
                    "post_logout_redirect_uri": post_logout_uri,
                })
            )
    except Exception:
        pass

    return redirect(url_for("auth.login"))
