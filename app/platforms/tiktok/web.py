"""TikTok-only routes registered on the engine channel blueprint.

The engine blueprint (engine/web.py) serves every standard creator route for
/api/tiktok/*. register_tiktok_routes(bp, engine) is invoked by the adapter's
register_extra_routes hook and adds only what has no engine equivalent:
sound tracking, the stats backfill, photo-post serving, ban history,
maintenance jobs, utilities, and the raw-fetch diagnostics.
"""

from __future__ import annotations

import asyncio
import glob as _glob
import io
import json
import os
import re
import threading
import time
import traceback
import zipfile
from flask import jsonify, request, send_file, Response

from config import DATA_DIR, MEDIA_DIR
from platforms.tiktok.config import get_ms_token, get_cookies_flat, COOKIES_PATH
from platforms.tiktok.api import create_tiktok_session, get_video_details
from platforms.tiktok.store import TikTokStore
from platforms.tiktok.sounds import get_sound_loop
from thumbnailer import AVATARS_DIR

# Imported for its side effect: starts the AVIF conversion thread on import.
import photo_converter as _photo_converter

REPORTS_DIR = os.path.join(DATA_DIR, "reports")
os.makedirs(REPORTS_DIR, exist_ok=True)

_AUDIO_EXTENSIONS = frozenset([".mp3", ".m4a", ".m4b", ".aac", ".ogg", ".wav", ".flac", ".opus"])


def _write_report(slug: str, header: str, lines: list[str]) -> str:
    ts       = time.strftime("%Y%m%d-%H%M%S")
    filename = f"{slug}-{ts}.txt"
    path     = os.path.join(REPORTS_DIR, filename)
    with open(path, "w", encoding="utf-8") as f:
        f.write(header + "\n\n")
        for line in lines:
            f.write(line + "\n")
    return filename


def _annotate_photo_multi(videos: list[dict]) -> list[dict]:
    """Mark photo posts holding more than one image ({id}_02.* exists on disk),
    so the UI can show a carousel glyph vs a single-image glyph."""
    for v in videos:
        if v.get("content_type") == "photo" and v.get("file_path"):
            folder = os.path.dirname(v["file_path"])
            v["multi"] = any(
                os.path.exists(os.path.join(folder, f"{v['video_id']}_02.{ext}"))
                for ext in ("avif", "jpg", "jpeg")
            )
    return videos


def register_tiktok_routes(bp, engine) -> None:
    db          = engine.db
    store       = TikTokStore(engine.db)
    sounds_loop = get_sound_loop(engine)

    # Cookie API (shared per-platform cookies.txt storage)
    from cookies import register_cookie_routes
    register_cookie_routes(bp, "tiktok")

    # QR login: signs in inside the persistent browser profile
    from platforms.tiktok import login as qr_login

    @bp.route("/login/qr", methods=["POST"])
    def tiktok_qr_start():
        ok, msg = qr_login.start_qr_login()
        if not ok:
            return jsonify({"error": msg}), 409
        return jsonify({"ok": True})

    @bp.route("/login/qr", methods=["GET"])
    def tiktok_qr_status():
        return jsonify(qr_login.get_state())

    @bp.route("/login/session", methods=["DELETE"])
    def tiktok_session_reset():
        from platforms.tiktok.api import reset_browser_profile
        ok, msg = reset_browser_profile()
        if not ok:
            return jsonify({"error": msg}), 409
        return jsonify({"ok": True, "message": msg})

    # Proxy routing: all TikTok traffic (browser, page fetches, downloads) can
    # go through an HTTP proxy. Two modes: "gluetun" uses the fixed sidecar
    # address and manages its WireGuard config below; "custom" takes any URL.
    from platforms.tiktok.config import get_proxy_settings, GLUETUN_PROXY_URL

    @bp.route("/proxy", methods=["GET"])
    def tiktok_proxy_get():
        return jsonify({**get_proxy_settings(), "gluetun_url": GLUETUN_PROXY_URL})

    @bp.route("/proxy", methods=["PATCH"])
    def tiktok_proxy_set():
        body = request.get_json(silent=True) or {}
        if "mode" in body:
            if body["mode"] not in ("gluetun", "custom"):
                return jsonify({"error": "mode must be gluetun or custom"}), 400
            db.set_setting("proxy_mode", body["mode"])
        if "url" in body:
            url = str(body["url"]).strip()
            if url and not url.startswith(("http://", "https://", "socks5://")):
                return jsonify({"error": "The proxy URL must start with http://, https://, or socks5://"}), 400
            db.set_setting("proxy_url", url)
        if "enabled" in body:
            s = get_proxy_settings()
            if body["enabled"] and s["mode"] == "custom" and not s["url"]:
                return jsonify({"error": "Set a proxy URL before enabling routing"}), 400
            db.set_setting("proxy_enabled", "1" if body["enabled"] else "0")
        return jsonify({"ok": True})

    @bp.route("/proxy/test", methods=["POST"])
    def tiktok_proxy_test():
        """Fetch an IP echo through the configured proxy, whether or not
        routing is enabled, so the path can be verified before flipping the
        toggle. Compares against the server's direct IP: the same address on
        both sides means the proxy is not actually changing the exit."""
        import requests as _requests
        s = get_proxy_settings()
        proxy = GLUETUN_PROXY_URL if s["mode"] == "gluetun" else s["url"]
        if not proxy:
            return jsonify({"ok": False, "error": "No proxy address configured"})
        echo = "https://api.ipify.org"
        try:
            t0 = time.time()
            resp = _requests.get(echo, proxies={"http": proxy, "https": proxy}, timeout=15)
            resp.raise_for_status()
            proxy_ip   = resp.text.strip()
            latency_ms = int((time.time() - t0) * 1000)
        except Exception as e:
            return jsonify({"ok": False, "error": f"{type(e).__name__}: {e}"})
        try:
            direct_ip = _requests.get(echo, timeout=10).text.strip()
        except Exception:
            direct_ip = None
        return jsonify({"ok": True, "proxy_ip": proxy_ip, "direct_ip": direct_ip,
                        "latency_ms": latency_ms,
                        "same_ip": bool(direct_ip) and direct_ip == proxy_ip})

    # WireGuard config for the gluetun VPN container, managed as four values
    # (private key, address, server public key, endpoint) instead of a raw
    # file: the app composes a canonical wg0.conf itself, so AllowedIPs and
    # keepalive are constants and IPv6 entries (which gluetun rejects when the
    # host has no IPv6) can never reach the file. Written under the app's data
    # volume; gluetun mounts that folder (./data/gluetun) as /gluetun and
    # reads it at startup. The private key is returned by GET for the UI's
    # reveal toggle; it already sits in plaintext on disk for gluetun.
    _WG_PATH = os.path.join(DATA_DIR, "gluetun", "wireguard", "wg0.conf")
    _WG_FIELDS = ("private_key", "address", "public_key", "endpoint")
    _DOCKER_SOCK = "/var/run/docker.sock"

    @bp.route("/proxy/wireguard", methods=["GET"])
    def tiktok_wireguard_get():
        restart_available = os.path.exists(_DOCKER_SOCK)
        if not os.path.exists(_WG_PATH):
            return jsonify({"present": False, "restart_available": restart_available})
        fields = {f: None for f in _WG_FIELDS}
        keymap = {"privatekey": "private_key", "address": "address",
                  "publickey": "public_key", "endpoint": "endpoint"}
        try:
            with open(_WG_PATH, encoding="utf-8", errors="ignore") as f:
                for line in f:
                    key, _, val = line.partition("=")
                    name = keymap.get(key.strip().lower())
                    if name:
                        fields[name] = val.strip()
            updated = int(os.path.getmtime(_WG_PATH))
        except OSError:
            updated = None
        return jsonify({"present": True, "updated_at": updated,
                        "restart_available": restart_available, **fields})

    @bp.route("/proxy/wireguard", methods=["POST"])
    def tiktok_wireguard_set():
        body = request.get_json(silent=True) or {}
        vals = {}
        for f in _WG_FIELDS:
            v = str(body.get(f, "")).strip()
            if not v or "\n" in v or "\r" in v:
                return jsonify({"error": f"{f.replace('_', ' ')} is required"}), 400
            vals[f] = v
        # Keep only the IPv4 entries of a comma-separated address list
        v4 = [a.strip() for a in vals["address"].split(",")
              if a.strip() and ":" not in a]
        if not v4:
            return jsonify({"error": "The address needs an IPv4 entry like 10.2.0.2/32 "
                            "(gluetun does not support IPv6)"}), 400
        if ":" not in vals["endpoint"] or vals["endpoint"].startswith("["):
            return jsonify({"error": "The endpoint must be an IPv4 host:port pair"}), 400
        conf = ("[Interface]\n"
                f"PrivateKey = {vals['private_key']}\n"
                f"Address = {', '.join(v4)}\n"
                "\n"
                "[Peer]\n"
                f"PublicKey = {vals['public_key']}\n"
                "AllowedIPs = 0.0.0.0/0\n"
                f"Endpoint = {vals['endpoint']}\n"
                "PersistentKeepalive = 25\n")
        os.makedirs(os.path.dirname(_WG_PATH), exist_ok=True)
        with open(_WG_PATH, "w", encoding="utf-8") as f:
            f.write(conf)
        try:
            os.chmod(_WG_PATH, 0o600)
        except OSError:
            pass
        return jsonify({"ok": True})

    @bp.route("/proxy/wireguard", methods=["DELETE"])
    def tiktok_wireguard_delete():
        try:
            os.remove(_WG_PATH)
        except FileNotFoundError:
            pass
        return jsonify({"ok": True})

    @bp.route("/proxy/gluetun/restart", methods=["POST"])
    def tiktok_gluetun_restart():
        """Restart the gluetun sidecar through the Docker socket so a saved
        WireGuard config takes effect without shell access. Requires the host
        socket mounted into this container (optional; documented in the
        README); the UI only offers the action when restart_available from
        the GET above is true. Stdlib HTTP over the unix socket, since
        requests cannot speak to one and the docker package would be a heavy
        dependency for one route.

        The Docker API only addresses containers by name or id, not by the
        network alias the proxy URL uses, and the container name is
        deployment-specific (compose defaults to project-gluetun-1, setups
        with several gluetun stacks name them apart). So the right container
        is found by resolving the gluetun DNS name on the shared network and
        matching that IP against the running containers. DNS fails exactly
        when the restart is most needed, though: a gluetun crash-looping on a
        bad config has no network presence. The fallback therefore searches
        all containers (any state) for the compose service label or literal
        name gluetun, narrowed to this container's own networks and compose
        project so another stack's gluetun is never the one restarted."""
        import http.client
        import socket as _socket

        if not os.path.exists(_DOCKER_SOCK):
            return jsonify({"error": "The Docker socket is not mounted into this "
                            "container; see the README for the volume line that "
                            "enables restarting gluetun from here"}), 503

        class _DockerSockConnection(http.client.HTTPConnection):
            def connect(self):
                self.sock = _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM)
                self.sock.settimeout(self.timeout)
                self.sock.connect(_DOCKER_SOCK)

        def docker_request(method, path):
            conn = _DockerSockConnection("localhost", timeout=30)
            try:
                conn.request(method, path)
                resp = conn.getresponse()
                return resp.status, resp.read().decode("utf-8", errors="ignore")
            finally:
                conn.close()

        def networks_of(c):
            return set(((c.get("NetworkSettings") or {}).get("Networks") or {}).keys())

        try:
            try:
                gluetun_ip = _socket.gethostbyname("gluetun")
            except OSError:
                gluetun_ip = None
            status, body = docker_request("GET", "/containers/json?all=true")
            if status != 200:
                return jsonify({"error": f"Docker returned {status}: {body.strip()}"}), 502
            containers = json.loads(body)

            # The container the app actually talks to: the one holding the IP
            # the gluetun DNS name resolves to on the shared network
            target = None
            if gluetun_ip:
                for c in containers:
                    nets = (c.get("NetworkSettings") or {}).get("Networks") or {}
                    if any(n.get("IPAddress") == gluetun_ip for n in nets.values()):
                        target = c["Id"]
                        break

            if not target:
                cands = [c for c in containers
                         if "/gluetun" in (c.get("Names") or [])
                         or (c.get("Labels") or {}).get("com.docker.compose.service") == "gluetun"]
                # Narrow multiple matches using this container's own networks
                # and compose project (best effort: the default hostname is
                # the container id, so Docker can tell us who we are)
                self_networks, self_project = set(), None
                try:
                    status, body = docker_request("GET", f"/containers/{_socket.gethostname()}/json")
                    if status == 200:
                        me = json.loads(body)
                        self_networks = networks_of(me)
                        self_project = ((me.get("Config") or {}).get("Labels") or {}).get(
                            "com.docker.compose.project")
                except Exception:
                    pass
                if self_networks:
                    # Ours has to share a network with us, whatever its state;
                    # a candidate that does not belongs to some other stack
                    cands = [c for c in cands if networks_of(c) & self_networks]
                if len(cands) > 1 and self_project:
                    scoped = [c for c in cands
                              if (c.get("Labels") or {}).get("com.docker.compose.project") == self_project]
                    cands = scoped or cands
                if len(cands) == 1:
                    target = cands[0]["Id"]
                elif len(cands) > 1:
                    names = ", ".join((c.get("Names") or ["?"])[0].lstrip("/") for c in cands)
                    return jsonify({"error": f"Several gluetun containers match ({names}) and "
                                    "none could be tied to this app; restart yours by hand"}), 409
            if not target:
                return jsonify({"error": "No gluetun container found on this app's Docker "
                                "networks; check that the gluetun service is defined next to "
                                "the app and see its state with docker ps -a"}), 404

            # t=5: Docker sends SIGTERM, waits up to 5 s, then kills. The
            # request blocks until the container is up again, hence the
            # generous connection timeout.
            status, body = docker_request("POST", f"/containers/{target}/restart?t=5")
            if status >= 300:
                return jsonify({"error": f"Docker returned {status}: {body.strip()}"}), 502
        except Exception as e:
            return jsonify({"error": f"Docker API request failed: {type(e).__name__}: {e}"}), 502
        return jsonify({"ok": True})

    # Live view of the headed browser display: grab frames and inject mouse
    # input so the user can solve a captcha or verification wall in the UI
    from platforms.tiktok import screen as browser_screen

    @bp.route("/screen", methods=["GET"])
    def tiktok_screen_frame():
        if not browser_screen.available():
            return jsonify({"error": "No display: the browser runs headless here"}), 503
        frame = browser_screen.grab_frame()
        if not frame:
            return jsonify({"error": "Could not capture the display"}), 503
        return Response(frame, mimetype="image/jpeg",
                        headers={"Cache-Control": "no-store"})

    @bp.route("/screen/input", methods=["POST"])
    def tiktok_screen_input():
        events = (request.get_json(silent=True) or {}).get("events", [])
        if not isinstance(events, list):
            return jsonify({"error": "events must be a list"}), 400
        browser_screen.send_input(events)
        return jsonify({"ok": True})

    # Stats backfill state
    _backfill_lock  = threading.Lock()
    _backfill_state: dict = {"running": False, "done": 0, "total": 0, "errors": 0}

    # Missing file check state
    _file_check_lock  = threading.Lock()
    _file_check_state: dict = {
        "running":     False,
        "mode":        None,   # "scan" | "purge"
        "found":       0,
        "removed":     0,
        "preview":     [],     # first 10 file paths
        "report_file": None,   # filename in REPORTS_DIR
        "last_run":    None,
    }

    # Corrupted story recovery state
    _story_repair_lock  = threading.Lock()
    _story_repair_state: dict = {
        "running":       False,
        "mode":          None,   # "scan" | "redownload"
        "corrupt":       0,
        "missing":       0,
        "live_video":    0,
        "live_photo":    0,
        "expired":       0,
        "recovered":     0,
        "still_failing": 0,
        "last_run":      None,
    }

    # Audio file cleanup state
    _audio_cleanup_lock  = threading.Lock()
    _audio_cleanup_state: dict = {
        "running":    False,
        "found":      0,
        "deleted":    0,
        "db_removed": 0,
        "errors":     0,
        "last_run":   None,
    }

    # ── Workers ───────────────────────────────────────────────────────────────

    def _run_backfill() -> None:
        videos  = store.get_videos_missing_stats()
        cookies = get_cookies_flat()
        total   = len(videos)

        with _backfill_lock:
            _backfill_state.update({"running": True, "done": 0, "total": total, "errors": 0})

        print(f"[backfill] Starting: {total} video(s) to process")

        for v in videos:
            vid_id = v["video_id"]
            handle = v["handle"]
            success_details = None
            try:
                details = get_video_details(vid_id, handle, cookies)
                store.update_video_stats(
                    vid_id,
                    view_count=details.get("view_count"),
                    like_count=details.get("like_count"),
                    comment_count=details.get("comment_count"),
                    share_count=details.get("share_count"),
                    save_count=details.get("save_count"),
                    duration=details.get("duration"),
                    width=details.get("width"),
                    height=details.get("height"),
                    music_title=details.get("music_title"),
                    music_artist=details.get("music_artist"),
                )
                success_details = details
            except Exception as e:
                error_str = str(e)
                error_count = store.increment_stats_error(vid_id, error_str)
                with _backfill_lock:
                    _backfill_state["errors"] += 1
                if "HTTP 404" in error_str or "No item data" in error_str or "Could not find page data" in error_str:
                    category = "not found (video may be deleted on TikTok)"
                elif "HTTP " in error_str:
                    category = "HTTP error"
                elif "timeout" in error_str.lower():
                    category = "timeout"
                else:
                    category = "fetch error"
                print(f"[backfill] FAIL ({error_count}/3) {vid_id} (@{handle}): {category}: {e}")
            with _backfill_lock:
                _backfill_state["done"] += 1
                done = _backfill_state["done"]
            if success_details is not None:
                print(f"[backfill] {done}/{total} OK: {vid_id} (@{handle})"
                      f" views={success_details.get('view_count')}")
            time.sleep(1.5)

        with _backfill_lock:
            errors = _backfill_state["errors"]
        print(f"[backfill] Done: {total} processed, {errors} error(s)")

        with _backfill_lock:
            _backfill_state["running"] = False

    def _run_file_scan() -> None:
        with _file_check_lock:
            if _file_check_state["running"]:
                return
            _file_check_state.update({"running": True, "mode": "scan",
                                       "found": 0, "removed": 0,
                                       "preview": [], "report_file": None})

        print("[file-check] Scanning for missing video files...")
        try:
            missing  = db.find_missing_video_files()
            paths    = [e["file_path"] for e in missing]
            count    = len(missing)
            header   = f"Missing file check - scan - {time.strftime('%Y-%m-%d %H:%M:%S')}\n{count} missing file(s) found"
            filename = _write_report("file-check-scan", header, paths)
            with _file_check_lock:
                _file_check_state.update({"found": count, "preview": paths[:10],
                                           "report_file": filename})
            print(f"[file-check] Scan done: {count} missing.")
        except Exception as e:
            print(f"[file-check] Scan error: {e}")
        finally:
            with _file_check_lock:
                _file_check_state["running"]  = False
                _file_check_state["last_run"] = time.strftime("%Y-%m-%d %H:%M:%S")

    def _run_file_purge() -> None:
        with _file_check_lock:
            if _file_check_state["running"]:
                return
            _file_check_state.update({"running": True, "mode": "purge",
                                       "found": 0, "removed": 0,
                                       "preview": [], "report_file": None})

        print("[file-check] Purging missing video file records...")
        try:
            missing  = db.find_missing_video_files()
            paths    = [e["file_path"] for e in missing]
            count    = len(missing)
            for entry in missing:
                db.delete_video(entry["video_id"])
            header   = f"Missing file check - purge - {time.strftime('%Y-%m-%d %H:%M:%S')}\n{count} record(s) removed from database"
            filename = _write_report("file-check-purge", header, paths)
            with _file_check_lock:
                _file_check_state.update({"found": count, "removed": count,
                                           "preview": paths[:10],
                                           "report_file": filename})
            print(f"[file-check] Purge done: {count} record(s) removed.")
        except Exception as e:
            print(f"[file-check] Purge error: {e}")
        finally:
            with _file_check_lock:
                _file_check_state["running"]  = False
                _file_check_state["last_run"] = time.strftime("%Y-%m-%d %H:%M:%S")

    def _run_audio_cleanup() -> None:
        with _audio_cleanup_lock:
            if _audio_cleanup_state["running"]:
                return
            _audio_cleanup_state.update({"running": True, "found": 0, "deleted": 0, "db_removed": 0, "errors": 0})

        print(f"[audio-cleanup] Scanning {MEDIA_DIR} for audio-only files...")
        try:
            audio_files = [
                p for p in _glob.glob(os.path.join(MEDIA_DIR, "*", "@*", "*"))
                if os.path.isfile(p) and os.path.splitext(p)[1].lower() in _AUDIO_EXTENSIONS
            ]

            with _audio_cleanup_lock:
                _audio_cleanup_state["found"] = len(audio_files)

            print(f"[audio-cleanup] Found {len(audio_files)} audio file(s)")

            for path in audio_files:
                video_id = os.path.splitext(os.path.basename(path))[0]
                try:
                    os.remove(path)
                    with _audio_cleanup_lock:
                        _audio_cleanup_state["deleted"] += 1
                    print(f"[audio-cleanup] Deleted {path}")
                except OSError as e:
                    print(f"[audio-cleanup] Failed to delete {path}: {e}")
                    with _audio_cleanup_lock:
                        _audio_cleanup_state["errors"] += 1
                    continue

                if db.delete_video(video_id):
                    with _audio_cleanup_lock:
                        _audio_cleanup_state["db_removed"] += 1
                    print(f"[audio-cleanup] Removed {video_id} from database")

        except Exception as e:
            print(f"[audio-cleanup] Unexpected error: {e}")
        finally:
            with _audio_cleanup_lock:
                _audio_cleanup_state["running"]  = False
                _audio_cleanup_state["last_run"] = time.strftime("%Y-%m-%d %H:%M:%S")

    def _story_repair_scan() -> None:
        from engine.tracker import scan_afflicted_stories
        with _story_repair_lock:
            if _story_repair_state["running"]:
                return
            _story_repair_state.update({"running": True, "mode": "scan", "recovered": 0,
                                        "still_failing": 0})
        print("[story-recovery] Scanning saved stories for missing or corrupt files...")
        try:
            afflicted = scan_afflicted_stories(db)
            counts = {
                "corrupt":    sum(1 for r in afflicted if r["ailment"] == "corrupt"),
                "missing":    sum(1 for r in afflicted if r["ailment"] == "missing"),
                "live_video": sum(1 for r in afflicted if r["live"] and r["content_type"] != "photo"),
                "live_photo": sum(1 for r in afflicted if r["live"] and r["content_type"] == "photo"),
                "expired":    sum(1 for r in afflicted if not r["live"]),
            }
            with _story_repair_lock:
                _story_repair_state.update(counts)
            print(f"[story-recovery] Scan done: {len(afflicted)} afflicted "
                  f"({counts['live_video']} live video, {counts['live_photo']} live photo, "
                  f"{counts['expired']} expired).")
        except Exception as e:
            print(f"[story-recovery] Scan error: {e}")
        finally:
            with _story_repair_lock:
                _story_repair_state["running"]  = False
                _story_repair_state["last_run"] = time.strftime("%Y-%m-%d %H:%M:%S")

    def _story_repair_redownload() -> None:
        from engine.tracker import scan_afflicted_stories
        from platforms.tiktok.tracker import redownload_story_row
        with _story_repair_lock:
            if _story_repair_state["running"]:
                return
            _story_repair_state.update({"running": True, "mode": "redownload",
                                        "recovered": 0, "still_failing": 0})
        print("[story-recovery] Re-downloading afflicted live video stories...")
        try:
            afflicted  = scan_afflicted_stories(db)
            live_video = [r for r in afflicted if r["live"] and r["content_type"] != "photo"]
            live_photo = sum(1 for r in afflicted if r["live"] and r["content_type"] == "photo")
            expired    = sum(1 for r in afflicted if not r["live"])
            with _story_repair_lock:
                _story_repair_state.update({
                    "corrupt":    sum(1 for r in afflicted if r["ailment"] == "corrupt"),
                    "missing":    sum(1 for r in afflicted if r["ailment"] == "missing"),
                    "live_video": len(live_video), "live_photo": live_photo, "expired": expired,
                })
            recovered = failing = 0
            for r in live_video:
                if redownload_story_row(db, r, log=lambda m: print(f"[story-recovery]{m}")):
                    recovered += 1
                else:
                    failing += 1
                with _story_repair_lock:
                    _story_repair_state.update({"recovered": recovered, "still_failing": failing})
                time.sleep(2)
            print(f"[story-recovery] Re-download done: {recovered} recovered, {failing} failed, "
                  f"{expired} expired.")
        except Exception as e:
            print(f"[story-recovery] Re-download error: {e}")
        finally:
            with _story_repair_lock:
                _story_repair_state["running"]  = False
                _story_repair_state["last_run"] = time.strftime("%Y-%m-%d %H:%M:%S")

    # ── Channel extras ────────────────────────────────────────────────────────

    @bp.route("/channels/<channel_id>/storage", methods=["GET"])
    def channel_storage(channel_id: str):
        """Total on-disk size of this user's media folder, computed on demand
        (only when the modal Info panel opens, so no cost on the channel list)."""
        row = db.get_channel(channel_id)
        if not row:
            return jsonify({"error": "User not found"}), 404
        folder = os.path.join(MEDIA_DIR, "tiktok", f"@{row['handle']}")
        total  = 0
        for dirpath, _dirs, files in os.walk(folder):
            for name in files:
                try:
                    total += os.path.getsize(os.path.join(dirpath, name))
                except OSError:
                    pass
        return jsonify({"bytes": total})

    @bp.route("/channels/<channel_id>/track", methods=["POST"])
    def track_discovered_channel(channel_id: str):
        """Promote a sound-discovered (enabled=0) stub to fully tracked.
        Feeds the engine's add queue, whose worker resolves the profile by
        sec_uid via the adapter and re-enables soft-disabled stubs."""
        row = db.get_channel(channel_id)
        if not row:
            return jsonify({"error": "User not found"}), 404
        if row.get("enabled", 0) == 1:
            return jsonify({"error": "Already tracked"}), 409
        engine.enqueue_add(row["handle"])
        return jsonify({"queued": True, "handle": row["handle"]}), 202

    # Post IDs currently being fetched by a direct-add thread; a re-paste while
    # the first attempt is still retrying must not spawn a second thread
    _direct_inflight: set = set()
    _direct_lock = threading.Lock()

    @bp.route("/videos/direct", methods=["POST"])
    def add_direct_video():
        """Save a single post from a direct URL (e.g. subscriber-only videos,
        which never appear in profile listings). Runs the download in a
        background thread; progress shows in the loop log console."""
        body = request.get_json(silent=True) or {}
        url  = (body.get("url") or "").strip()
        m    = re.search(r"tiktok\.com/(?:@[^/]+/)?(?:video|photo)/(\d+)", url)
        if not m:
            return jsonify({"error": "Not a TikTok post URL"}), 400
        vid_id = m.group(1)

        existing = db.get_video(vid_id)
        if existing:
            # Already known: just flag it as direct so listing diffs leave it alone
            store.set_video_direct_added(vid_id)
            return jsonify({"ok": True, "video_id": vid_id, "already_saved": True})

        with _direct_lock:
            if vid_id in _direct_inflight:
                return jsonify({"ok": True, "video_id": vid_id, "in_progress": True})
            _direct_inflight.add(vid_id)

        from platforms.tiktok.tracker import run_direct_video
        log = engine.loop._log
        log(f"=== Direct URL add: {vid_id} ===")

        def _worker():
            try:
                run_direct_video(engine, vid_id, log)
            finally:
                with _direct_lock:
                    _direct_inflight.discard(vid_id)

        threading.Thread(target=_worker, daemon=True).start()
        return jsonify({"ok": True, "video_id": vid_id, "queued": True}), 202

    @bp.route("/resolve-url", methods=["POST"])
    def resolve_url():
        """Expand a TikTok share/short link to its canonical URL so the add bar
        can route it (profile vs post). The browser cannot follow a cross-origin
        redirect itself."""
        body = request.get_json(silent=True) or {}
        url  = (body.get("url") or "").strip()
        if not re.match(r"https?://(?:vm|vt)\.tiktok\.com/|https?://(?:www\.)?tiktok\.com/t/", url):
            return jsonify({"error": "Not a TikTok share link"}), 400
        from platforms.tiktok.api import resolve_share_url
        return jsonify({"ok": True, "url": resolve_share_url(url)})

    @bp.route("/channels/<channel_id>/avatar-history/<filename>", methods=["GET"])
    def channel_avatar_history(channel_id: str, filename: str):
        if not re.fullmatch(r"[0-9]+_[0-9]+\.(jpg|avif)", filename):
            return ("", 400)
        path = os.path.join(AVATARS_DIR, filename)
        if not os.path.exists(path):
            return ("", 404)
        mime = "image/avif" if filename.endswith(".avif") else "image/jpeg"
        return send_file(path, mimetype=mime)

    # ── Photo post API ────────────────────────────────────────────────────────

    @bp.route("/videos/<video_id>/photos", methods=["GET"])
    def video_photos(video_id: str):
        video = db.get_video(video_id)
        if not video or video.get("content_type") != "photo" or not video.get("file_path"):
            return ("", 404)
        folder = os.path.dirname(video["file_path"])
        urls: list[str] = []
        for i in range(1, 51):  # TikTok caps photo posts well below 50
            found = False
            for ext in ("avif", "jpg", "jpeg"):
                path = os.path.join(folder, f"{video_id}_{i:02d}.{ext}")
                if os.path.exists(path):
                    urls.append(f"/api/tiktok/videos/{video_id}/photo/{i}")
                    found = True
                    break
            if not found:
                break
        if not urls:
            return ("", 404)
        return jsonify({"urls": urls, "count": len(urls)})

    @bp.route("/videos/<video_id>/photos/zip", methods=["GET"])
    def video_photos_zip(video_id: str):
        video = db.get_video(video_id)
        if not video or video.get("content_type") != "photo" or not video.get("file_path"):
            return ("", 404)
        folder = os.path.dirname(video["file_path"])
        buf = io.BytesIO()
        added = 0
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
            for i in range(1, 51):
                for ext in ("avif", "jpg", "jpeg"):
                    path = os.path.join(folder, f"{video_id}_{i:02d}.{ext}")
                    if os.path.exists(path):
                        zf.write(path, f"{video_id}_{i:02d}.{ext}")
                        added += 1
                        break
                else:
                    break
        if not added:
            return ("", 404)
        buf.seek(0)
        return send_file(
            buf,
            mimetype="application/zip",
            as_attachment=True,
            download_name=f"{video_id}_photos.zip",
        )

    @bp.route("/videos/<video_id>/photo/<int:n>", methods=["GET"])
    def video_photo(video_id: str, n: int):
        if n < 1 or n > 50:
            return ("", 400)
        video = db.get_video(video_id)
        if not video or not video.get("file_path"):
            return ("", 404)
        folder = os.path.dirname(video["file_path"])
        for ext in ("avif", "jpg", "jpeg"):
            path = os.path.join(folder, f"{video_id}_{n:02d}.{ext}")
            if os.path.exists(path):
                mime = "image/avif" if ext == "avif" else "image/jpeg"
                return send_file(path, mimetype=mime)
        return ("", 404)

    # ── Stats backfill API ────────────────────────────────────────────────────

    @bp.route("/backfill", methods=["GET"])
    def get_backfill_status():
        with _backfill_lock:
            return jsonify(dict(_backfill_state))

    @bp.route("/backfill", methods=["POST"])
    def start_backfill():
        with _backfill_lock:
            if _backfill_state["running"]:
                return jsonify({"error": "Already running"}), 409
        threading.Thread(target=_run_backfill, daemon=True, name="stats-backfill").start()
        return jsonify({"ok": True})

    @bp.route("/backfill/failed", methods=["GET"])
    def get_backfill_failed():
        return jsonify(store.get_videos_stats_failed())

    @bp.route("/backfill/reset", methods=["POST"])
    def reset_backfill():
        with _backfill_lock:
            if _backfill_state["running"]:
                return jsonify({"error": "Backfill is currently running"}), 409
        count = store.reset_backfill_status()
        return jsonify({"ok": True, "reset": count})

    @bp.route("/backfill/reset-errors", methods=["POST"])
    def reset_backfill_errors():
        with _backfill_lock:
            if _backfill_state["running"]:
                return jsonify({"error": "Backfill is currently running"}), 409
        count = store.reset_backfill_errors()
        return jsonify({"ok": True, "reset": count})

    # ── Ban history ───────────────────────────────────────────────────────────

    @bp.route("/recent/bans", methods=["GET"])
    def get_recent_bans():
        offset = int(request.args.get("offset", 0))
        limit  = int(request.args.get("limit",  50))
        return jsonify(store.get_ban_history(offset=offset, limit=limit))

    # ── Sound API ─────────────────────────────────────────────────────────────

    @bp.route("/sounds", methods=["GET"])
    def list_sounds():
        return jsonify(store.get_all_sounds())

    @bp.route("/sounds", methods=["POST"])
    def add_sound():
        body  = request.get_json(silent=True) or {}
        raw   = str(body.get("sound_id", "")).strip()
        label = str(body.get("label", "")).strip() or None

        # Accept full TikTok sound URLs; extract the trailing numeric ID
        m = re.search(r'(\d{10,25})(?:[^0-9]|$)', raw)
        sound_id = m.group(1) if m else raw

        if not sound_id.isdigit():
            return jsonify({"error": "sound_id must be numeric (or a TikTok sound URL)"}), 400

        added = store.add_sound(sound_id, label)
        if not added:
            return jsonify({"error": "Sound is already being tracked"}), 409
        return jsonify({"ok": True, "sound_id": sound_id}), 201

    @bp.route("/sounds/<sound_id>", methods=["PATCH"])
    def update_sound(sound_id: str):
        if not store.get_sound(sound_id):
            return jsonify({"error": "Sound not found"}), 404
        body  = request.get_json(silent=True) or {}
        label = body.get("label")
        if label is not None:
            label = str(label).strip() or None
        store.update_sound_label(sound_id, label)
        return jsonify({"ok": True})

    @bp.route("/sounds/<sound_id>", methods=["DELETE"])
    def remove_sound(sound_id: str):
        if not store.get_sound(sound_id):
            return jsonify({"error": "Sound not found"}), 404
        store.remove_sound(sound_id)
        return jsonify({"ok": True})

    @bp.route("/sounds/<sound_id>/star", methods=["PATCH"])
    def set_sound_star(sound_id: str):
        if not store.get_sound(sound_id):
            return jsonify({"error": "Sound not found"}), 404
        body    = request.get_json(silent=True) or {}
        starred = body.get("starred")
        if not isinstance(starred, bool):
            return jsonify({"error": "starred must be a boolean"}), 400
        store.set_sound_starred(sound_id, starred)
        return jsonify({"ok": True})

    @bp.route("/sounds/<sound_id>/tracking", methods=["PATCH"])
    def set_sound_tracking(sound_id: str):
        if not store.get_sound(sound_id):
            return jsonify({"error": "Sound not found"}), 404
        body    = request.get_json(silent=True) or {}
        enabled = body.get("enabled")
        if not isinstance(enabled, bool):
            return jsonify({"error": "enabled must be a boolean"}), 400
        store.set_sound_tracking_enabled(sound_id, enabled)
        return jsonify({"ok": True})

    @bp.route("/sounds/<sound_id>/comment", methods=["PATCH"])
    def set_sound_comment(sound_id: str):
        if not store.get_sound(sound_id):
            return jsonify({"error": "Sound not found"}), 404
        body    = request.get_json(silent=True) or {}
        comment = body.get("comment", "")
        if not isinstance(comment, str):
            return jsonify({"error": "comment must be a string"}), 400
        store.set_sound_comment(sound_id, comment.strip())
        return jsonify({"ok": True})

    @bp.route("/sounds/<sound_id>/videos", methods=["GET"])
    def sound_videos(sound_id: str):
        if not store.get_sound(sound_id):
            return jsonify({"error": "Sound not found"}), 404
        return jsonify(_annotate_photo_multi(store.get_sound_videos(sound_id)))

    @bp.route("/sounds/<sound_id>/run", methods=["POST"])
    def run_sound(sound_id: str):
        if not store.get_sound(sound_id):
            return jsonify({"error": "Sound not found"}), 404
        if not sounds_loop.enqueue_sound_run(sound_id):
            return jsonify({"error": "Already queued or running"}), 409
        return jsonify({"ok": True})

    # ── Sound loop control ────────────────────────────────────────────────────

    @bp.route("/trigger/sounds", methods=["POST"])
    def trigger_sounds_now():
        from config import get_path_issues
        issues = get_path_issues()
        if issues:
            return jsonify({"error": issues[0]["message"]}), 503
        if sounds_loop.is_running():
            return jsonify({"error": "Sound loop is already running"}), 409
        sounds_loop.trigger_event.set()
        return jsonify({"ok": True})

    @bp.route("/stop/sounds", methods=["POST"])
    def stop_sound_loop():
        if not sounds_loop.is_running():
            return jsonify({"error": "Sound loop is not running"}), 409
        sounds_loop.request_stop()
        return jsonify({"ok": True})

    @bp.route("/pause/sounds", methods=["POST"])
    def set_sound_pause():
        # Paused skips scheduled sound runs; manual triggers still work.
        body   = request.get_json(silent=True) or {}
        paused = bool(body.get("paused"))
        db.set_setting("sound_loop_paused", "1" if paused else "0")
        return jsonify({"paused": paused})

    # ── Jobs API ──────────────────────────────────────────────────────────────

    @bp.route("/jobs/photo-converter/status", methods=["GET"])
    def get_photo_converter_status():
        return jsonify(_photo_converter.get_state())

    @bp.route("/jobs/photo-converter/start", methods=["POST"])
    def start_photo_converter():
        if not _photo_converter.start():
            return jsonify({"error": "Already running"}), 409
        return jsonify({"ok": True})

    @bp.route("/jobs/thumbnail-repair/status", methods=["GET"])
    def thumbnail_repair_status():
        from thumbnailer import get_repair_state
        return jsonify(get_repair_state())

    @bp.route("/jobs/thumbnail-repair/start", methods=["POST"])
    def thumbnail_repair_start():
        # Regenerates thumbnails (all platforms) whose AVIF colour tags are
        # reserved/unspecified, which Firefox renders blank. Covers every
        # platform since thumbnail generation is shared.
        from thumbnailer import get_repair_state, repair_broken_thumbnails
        if get_repair_state()["running"]:
            return jsonify({"error": "Already running"}), 409
        threading.Thread(target=repair_broken_thumbnails, daemon=True,
                         name="thumbnail-repair").start()
        return jsonify({"ok": True})

    @bp.route("/jobs/audio-cleanup/status", methods=["GET"])
    def get_audio_cleanup_status():
        with _audio_cleanup_lock:
            return jsonify(dict(_audio_cleanup_state))

    @bp.route("/jobs/audio-cleanup/start", methods=["POST"])
    def start_audio_cleanup():
        with _audio_cleanup_lock:
            if _audio_cleanup_state["running"]:
                return jsonify({"error": "Already running"}), 409
        threading.Thread(target=_run_audio_cleanup, daemon=True, name="audio-cleanup").start()
        return jsonify({"ok": True})

    @bp.route("/jobs/file-check/status", methods=["GET"])
    def get_file_check_status():
        with _file_check_lock:
            return jsonify(dict(_file_check_state))

    @bp.route("/jobs/file-check/scan", methods=["POST"])
    def start_file_scan():
        with _file_check_lock:
            if _file_check_state["running"]:
                return jsonify({"error": "Already running"}), 409
        threading.Thread(target=_run_file_scan, daemon=True, name="file-check").start()
        return jsonify({"ok": True})

    @bp.route("/jobs/file-check/purge", methods=["POST"])
    def start_file_purge():
        with _file_check_lock:
            if _file_check_state["running"]:
                return jsonify({"error": "Already running"}), 409
        threading.Thread(target=_run_file_purge, daemon=True, name="file-check").start()
        return jsonify({"ok": True})

    @bp.route("/jobs/story-recovery/status", methods=["GET"])
    def get_story_recovery_status():
        with _story_repair_lock:
            return jsonify(dict(_story_repair_state))

    @bp.route("/jobs/story-recovery/scan", methods=["POST"])
    def start_story_scan():
        with _story_repair_lock:
            if _story_repair_state["running"]:
                return jsonify({"error": "Already running"}), 409
        threading.Thread(target=_story_repair_scan, daemon=True, name="story-recovery").start()
        return jsonify({"ok": True})

    @bp.route("/jobs/story-recovery/redownload", methods=["POST"])
    def start_story_redownload():
        with _story_repair_lock:
            if _story_repair_state["running"]:
                return jsonify({"error": "Already running"}), 409
        threading.Thread(target=_story_repair_redownload, daemon=True, name="story-recovery").start()
        return jsonify({"ok": True})

    # ── Utilities ─────────────────────────────────────────────────────────────

    @bp.route("/utils/clear-avatars", methods=["POST"])
    def clear_avatars():
        body = request.get_json(silent=True) or {}
        include_banned = bool(body.get("include_banned", False))

        banned_ids = set()
        if not include_banned:
            with db.get_db() as conn:
                rows = conn.execute(
                    "SELECT channel_id FROM channels WHERE account_status = 'banned'"
                ).fetchall()
                banned_ids = {r["channel_id"] for r in rows}

        deleted = 0
        deleted_ids = []
        if os.path.isdir(AVATARS_DIR):
            for fname in os.listdir(AVATARS_DIR):
                # Current avatars: {channel_id}.avif or {channel_id}.jpg; no underscore before extension
                stem, ext = os.path.splitext(fname)
                if ext.lower() in (".avif", ".jpg", ".jpeg") and "_" not in stem:
                    if stem in banned_ids:
                        continue
                    try:
                        os.remove(os.path.join(AVATARS_DIR, fname))
                        deleted += 1
                        deleted_ids.append(stem)
                    except OSError:
                        pass

        if deleted_ids:
            with db.get_db() as conn:
                conn.executemany(
                    "UPDATE channels SET avatar_cached = 0 WHERE channel_id = ?",
                    [(cid,) for cid in deleted_ids]
                )

        return jsonify({"deleted": deleted})

    @bp.route("/utils/clear-thumbnails", methods=["POST"])
    def clear_thumbnails():
        deleted = 0
        for thumbs_dir in _glob.glob(os.path.join(MEDIA_DIR, "*", "*", "thumbs")):
            if not os.path.isdir(thumbs_dir):
                continue
            for fname in os.listdir(thumbs_dir):
                if os.path.splitext(fname)[1].lower() in (".avif", ".jpg", ".jpeg"):
                    try:
                        os.remove(os.path.join(thumbs_dir, fname))
                        deleted += 1
                    except OSError:
                        pass
        return jsonify({"deleted": deleted})

    # ── Diagnostics API ───────────────────────────────────────────────────────

    @bp.route("/debug/fetch", methods=["POST"])
    def debug_fetch():
        body   = request.get_json(silent=True) or {}
        source = body.get("source", "")
        action = body.get("action", "")
        inp    = (body.get("input") or "").strip()

        if not inp:
            return jsonify({"ok": False, "output": "Error: no input provided"})

        try:
            if source == "get_video_details":
                m_vid  = re.search(r'/(?:video|photo)/(\d+)', inp)
                m_user = re.search(r'@([\w.]+)/', inp)
                video_id = m_vid.group(1)  if m_vid  else inp
                handle   = m_user.group(1) if m_user else "user"
                cookies  = get_cookies_flat()
                result   = get_video_details(video_id, handle, cookies)
                return jsonify({"ok": True, "output": json.dumps(result, indent=2, default=str)})

            elif source == "ytdlp" and action == "user_videos":
                from platforms.tiktok.api import get_user_videos
                result = get_user_videos(inp, cookies_path=COOKIES_PATH if os.path.exists(COOKIES_PATH) else None)
                return jsonify({"ok": True, "output": json.dumps(result, indent=2, default=str)})

            elif source == "ytdlp" and action == "video_info":
                import yt_dlp
                opts = {"quiet": True, "no_warnings": True,
                        **({"cookiefile": COOKIES_PATH} if os.path.exists(COOKIES_PATH) else {})}
                with yt_dlp.YoutubeDL(opts) as ydl:
                    info = ydl.sanitize_info(ydl.extract_info(inp, download=False))
                return jsonify({"ok": True, "output": json.dumps(info, indent=2, default=str)})

            elif source == "tiktokapi" and action == "user_info":
                from TikTokApi import TikTokApi as _TikTokApi
                handle   = inp.lstrip("@").strip()
                ms_token = get_ms_token()

                async def _fetch_user_info_adhoc():
                    cookies_flat = get_cookies_flat()
                    async with _TikTokApi() as _api:
                        await create_tiktok_session(_api, ms_token, cookies_flat)
                        return await _api.make_request(
                            url="https://www.tiktok.com/api/user/detail/",
                            params={"uniqueId": handle, "secUid": ""},
                        )

                data = asyncio.run(_fetch_user_info_adhoc())
                if data is None:
                    data = {"error": "TikTok returned no data (None)"}
                return jsonify({"ok": True, "output": json.dumps(data, indent=2, default=str)})

            # Probes the story/item_list endpoint for a user. Input: @handle or
            # numeric user id of a tracked user. Validates story fetching against
            # the live cookies before trusting the loop wiring.
            elif source == "tiktokapi" and action == "user_stories":
                from TikTokApi import TikTokApi as _TikTokApi
                from platforms.tiktok.api import get_user_stories, parse_story_item
                _needle = inp.lstrip("@").strip().lower()
                _match  = next((c for c in db.get_all_channels()
                                if c["handle"].lower() == _needle or c["channel_id"] == _needle), None)
                if not _match:
                    return jsonify({"ok": False, "output": f"Error: no tracked user matches {inp}"})
                ms_token = get_ms_token()

                async def _fetch_stories_adhoc():
                    cookies_flat = get_cookies_flat()
                    async with _TikTokApi() as _api:
                        await create_tiktok_session(_api, ms_token, cookies_flat)
                        return await get_user_stories(_api, _match["channel_id"])

                items  = asyncio.run(_fetch_stories_adhoc())
                parsed = [s for s in (parse_story_item(i) for i in items) if s]
                out = {
                    "user":        f"@{_match['handle']} ({_match['channel_id']})",
                    "item_count":  len(items),
                    "parsed":      parsed,
                    "raw_sample":  items[:1],
                }
                return jsonify({"ok": True, "output": json.dumps(out, indent=2, default=str)})

            # Uses TikTokApi's make_request() (Playwright + X-Bogus signing) but
            # bypasses the username guard in user.info(). Tests whether TikTok
            # resolves a user by secUid alone when uniqueId is empty.
            elif source == "tiktokapi" and action == "user_info_by_id":
                from TikTokApi import TikTokApi as _TikTokApi
                if ":" not in inp:
                    return jsonify({"ok": False, "output": "Error: input must be channel_id:sec_uid"})
                channel_id, sec_uid = inp.split(":", 1)
                channel_id = channel_id.strip()
                sec_uid    = sec_uid.strip()
                ms_token   = get_ms_token()

                async def _fetch_by_sec_uid():
                    cookies_flat = get_cookies_flat()
                    async with _TikTokApi() as _api:
                        await create_tiktok_session(_api, ms_token, cookies_flat)
                        return await _api.make_request(
                            url="https://www.tiktok.com/api/user/detail/",
                            params={"secUid": sec_uid, "uniqueId": ""},
                        )

                data = asyncio.run(_fetch_by_sec_uid())
                if data is None:
                    data = {"error": "TikTok returned no data (None)"}
                return jsonify({"ok": True, "output": json.dumps(data, indent=2, default=str)})

            elif source == "tiktokapi" and action == "resolve_username":
                handle  = inp.lstrip("@").strip()
                db_chan = db.get_channel_by_handle(handle)
                if db_chan:
                    data = {"source": "database", "channel_id": db_chan["channel_id"], "sec_uid": db_chan["sec_uid"]}
                    return jsonify({"ok": True, "output": json.dumps(data, indent=2, default=str)})

                from TikTokApi import TikTokApi as _TikTokApi
                ms_token = get_ms_token()

                async def _resolve_handle():
                    cookies_flat = get_cookies_flat()
                    async with _TikTokApi() as _api:
                        await create_tiktok_session(_api, ms_token, cookies_flat)
                        return await _api.make_request(
                            url="https://www.tiktok.com/api/user/detail/",
                            params={"uniqueId": handle, "secUid": ""},
                        )

                data = asyncio.run(_resolve_handle())
                if data is None:
                    data = {"error": "TikTok returned no data (None)"}
                return jsonify({"ok": True, "output": json.dumps(data, indent=2, default=str)})

            elif source == "tiktokapi" and action == "item_list_username":
                from TikTokApi import TikTokApi as _TikTokApi
                from platforms.tiktok.api import get_user_videos_with_stats as _get_vws
                handle = inp.lstrip("@").strip()

                async def _item_list_by_handle():
                    ms_token     = get_ms_token()
                    cookies_flat = get_cookies_flat()
                    async with _TikTokApi() as _api:
                        await create_tiktok_session(_api, ms_token, cookies_flat)
                        await asyncio.sleep(3)
                        user_obj = _api.user(username=handle)
                        await user_obj.info()  # resolve sec_uid
                        sec_uid = getattr(user_obj, "sec_uid", None)
                        results = await _get_vws(_api, sec_uid=sec_uid)
                        return {"sec_uid_resolved": sec_uid, "count": len(results), "videos": results}

                result = asyncio.run(_item_list_by_handle())
                return jsonify({"ok": True, "output": json.dumps(result, indent=2, default=str)})

            elif source == "tiktokapi" and action == "item_list_by_id":
                from TikTokApi import TikTokApi as _TikTokApi
                from platforms.tiktok.api import get_user_videos_with_stats as _get_vws
                if ":" not in inp:
                    return jsonify({"ok": False, "output": "Error: input must be channel_id:sec_uid"})
                channel_id, sec_uid = inp.split(":", 1)
                channel_id = channel_id.strip()
                sec_uid    = sec_uid.strip()

                async def _item_list_by_id():
                    ms_token     = get_ms_token()
                    cookies_flat = get_cookies_flat()
                    async with _TikTokApi() as _api:
                        await create_tiktok_session(_api, ms_token, cookies_flat)
                        await asyncio.sleep(3)
                        results = await _get_vws(_api, sec_uid=sec_uid)
                        return {"channel_id": channel_id, "sec_uid": sec_uid,
                                "count": len(results), "videos": results}

                result = asyncio.run(_item_list_by_id())
                return jsonify({"ok": True, "output": json.dumps(result, indent=2, default=str)})

            elif source == "tiktokapi" and action == "item_list_from_db":
                from TikTokApi import TikTokApi as _TikTokApi
                from platforms.tiktok.api import get_user_videos_with_stats as _get_vws
                handle  = inp.lstrip("@").strip()
                channel = db.get_channel_by_handle(handle)
                if not channel:
                    return jsonify({"ok": False,
                                    "output": f"Error: @{handle} not found in database"})
                sec_uid    = channel.get("sec_uid")
                channel_id = channel.get("channel_id")
                if not sec_uid:
                    return jsonify({"ok": False,
                                    "output": f"Error: @{handle} has no sec_uid stored;"
                                              f" loop would skip item_list for this user"})

                async def _item_list_from_db():
                    ms_token     = get_ms_token()
                    cookies_flat = get_cookies_flat()
                    async with _TikTokApi() as _api:
                        await create_tiktok_session(_api, ms_token, cookies_flat)
                        await asyncio.sleep(3)
                        results = await _get_vws(_api, sec_uid=sec_uid)
                        return {"channel_id": channel_id, "handle": handle,
                                "sec_uid": sec_uid, "count": len(results), "videos": results}

                result = asyncio.run(_item_list_from_db())
                return jsonify({"ok": True, "output": json.dumps(result, indent=2, default=str)})

            elif source == "tiktokapi" and action == "sound_raw":
                from TikTokApi import TikTokApi as _TikTokApi
                sound_id = re.sub(r'[^0-9]', '', inp)
                if not sound_id:
                    return jsonify({"ok": False, "output": "Error: could not extract a numeric sound_id from input"})

                async def _fetch_sound_raw():
                    ms_token     = get_ms_token()
                    cookies_flat = get_cookies_flat()
                    async with _TikTokApi() as _api:
                        await create_tiktok_session(_api, ms_token, cookies_flat)
                        raw_items = []
                        total = 0
                        async for video in _api.sound(id=sound_id).videos(count=3000):
                            total += 1
                            if total <= 3:
                                raw_items.append(video.as_dict)
                        return {"sound_id": sound_id, "total_fetched": total,
                                "note": "first 3 raw items shown below",
                                "items": raw_items}

                result = asyncio.run(_fetch_sound_raw())
                return jsonify({"ok": True, "output": json.dumps(result, indent=2, default=str)})

            else:
                return jsonify({"ok": False, "output": f"Unknown source/action: {source}/{action}"})

        except Exception as e:
            return jsonify({"ok": False, "output": f"Error: {e}\n\n{traceback.format_exc()}"})
