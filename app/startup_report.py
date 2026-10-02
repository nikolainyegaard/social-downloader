"""
Startup report: what a cold start spent its time on, kept on disk.

One JSON file per process start in data/startup/ (last 20 kept), the way a
boot log survives a reboot: the slow part of a cold container is over by
the time anyone opens the page, so the facts have to be recorded as they
happen. main.py marks the startup phases (dependency upgrade through loop
threads), the request hooks in web.py record the first request of every
API endpoint after start with its duration, size and the handler's own
step breakdown (Server-Timing), and the browser posts its load timeline
once after a fresh start. Settings > General > Diagnostics reads them.

Nothing here is sampled or aggregated; a report describes one start.
"""

from __future__ import annotations

import json
import os
import threading
import time
from contextlib import contextmanager

from config import DATA_DIR, APP_VERSION, _ts

REPORT_DIR  = os.path.join(DATA_DIR, "startup")
KEEP        = 20
WINDOW_SECS = 600     # requests are recorded this long after start
SLOW_SECS   = 1.0     # slower API requests are logged at any time

_PROCESS_T0 = time.time()
_lock  = threading.Lock()
_phase: dict | None = None
_report: dict = {
    "version":          APP_VERSION,
    "container_start":  float(os.environ.get("CONTAINER_START_TS") or 0) or None,
    "process_start":    _PROCESS_T0,
    "listening_at":     None,
    "page_served_at":   None,
    "usable_at":        None,
    "phases":           [],       # {name, secs}
    "requests":         [],       # first request per endpoint: {endpoint, path, at, secs, bytes, steps}
    "facts":            {},
    "client":           None,     # posted by the browser
}
_seen_endpoints: set = set()
_path = os.path.join(REPORT_DIR, time.strftime("%Y-%m-%d_%H-%M-%S", time.localtime(_PROCESS_T0)) + ".json")


def _save() -> None:
    try:
        os.makedirs(REPORT_DIR, exist_ok=True)
        tmp = _path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(_report, f, indent=1)
        os.replace(tmp, _path)
        names = sorted(n for n in os.listdir(REPORT_DIR) if n.endswith(".json"))
        for old in names[:-KEEP]:
            os.remove(os.path.join(REPORT_DIR, old))
    except OSError as e:
        print(f"[{_ts()}] [startup] could not write the startup report: {e}")


# ── Phases (main.py) ──────────────────────────────────────────────────────────

def begin(name: str) -> None:
    """Start a phase; the previous one ends here."""
    global _phase
    now = time.time()
    with _lock:
        if _phase:
            _report["phases"].append({"name": _phase["name"], "secs": round(now - _phase["t0"], 3)})
        _phase = {"name": name, "t0": now}


def listening(facts: dict) -> None:
    """Last phase mark: Flask is about to serve. The dependency upgrade ran
    before Python started, so its duration is the container stamp to the
    process start."""
    global _phase
    begin("")
    with _lock:
        _phase = None
        if _report["container_start"]:
            _report["phases"].insert(0, {"name": "dependency upgrade (before python)",
                                         "secs": round(_PROCESS_T0 - _report["container_start"], 3)})
        _report["listening_at"] = time.time()
        _report["facts"] = facts
    _save()


# ── Requests (web.py hooks) ───────────────────────────────────────────────────

@contextmanager
def step(name: str):
    """Time one step of a request handler; lands in the Server-Timing header
    and in the startup report. Harmless outside a request."""
    from flask import g, has_request_context
    t0 = time.perf_counter()
    try:
        yield
    finally:
        if has_request_context():
            g.setdefault("_steps", []).append((name, round((time.perf_counter() - t0) * 1000, 1)))


def request_started() -> None:
    from flask import g
    g._t0 = time.perf_counter()


def request_finished(response):
    """after_request hook: Server-Timing header, slow-request log line, and
    the first request of each endpoint inside the startup window."""
    from flask import g, request
    t0 = getattr(g, "_t0", None)
    if t0 is None:
        return response
    secs  = time.perf_counter() - t0
    steps = getattr(g, "_steps", [])
    if steps:
        response.headers["Server-Timing"] = ", ".join(
            f'{n.replace(" ", "_")};dur={ms}' for n, ms in steps)
    size = response.calculate_content_length() or 0
    if not request.path.startswith("/api/") and request.path != "/":
        return response
    if secs >= SLOW_SECS:
        print(f"[{_ts()}] [slow] {request.method} {request.path} {secs:.2f}s {size / 1024:.0f} KB"
              + (f" ({', '.join(f'{n} {ms:.0f}ms' for n, ms in steps)})" if steps else ""))
    now = time.time()
    if now - _PROCESS_T0 > WINDOW_SECS or request.method != "GET":
        return response
    key = request.endpoint or request.path
    with _lock:
        if request.path == "/":
            if _report["page_served_at"] is not None:
                return response
            _report["page_served_at"] = now
            _save()
            return response
        if key in _seen_endpoints:
            return response
        _seen_endpoints.add(key)
        _report["requests"].append({"endpoint": key, "path": request.path, "at": now,
                                    "secs": round(secs, 3), "bytes": size,
                                    "steps": [{"name": n, "ms": ms} for n, ms in steps]})
    _save()
    return response


def set_client(payload: dict) -> bool:
    """The browser's load timeline after a fresh start; the first one wins."""
    with _lock:
        if _report["client"] is not None:
            return False
        _report["client"]    = {k: payload[k] for k in ("first_render_ms", "usable_ms", "text") if k in payload}
        _report["usable_at"] = time.time()
    _save()
    return True


# ── Reading ───────────────────────────────────────────────────────────────────

def list_reports() -> list[dict]:
    out = []
    try:
        names = sorted((n for n in os.listdir(REPORT_DIR) if n.endswith(".json")), reverse=True)
    except OSError:
        return out
    for n in names:
        try:
            with open(os.path.join(REPORT_DIR, n), encoding="utf-8") as f:
                r = json.load(f)
        except (OSError, ValueError):
            continue
        usable = r.get("usable_at")
        start  = r.get("container_start") or r.get("process_start")
        out.append({"name": n[:-5], "version": r.get("version"), "started": start,
                    "usable_secs": round(usable - start, 1) if usable and start else None,
                    "current": n == os.path.basename(_path)})
    return out


def render(name: str) -> str | None:
    if "/" in name or ".." in name:
        return None
    try:
        with open(os.path.join(REPORT_DIR, name + ".json"), encoding="utf-8") as f:
            r = json.load(f)
    except (OSError, ValueError):
        return None
    start = r.get("container_start") or r.get("process_start")
    rel   = lambda t: f"+{t - start:6.1f}s" if t and start else "   n/a"
    lines = [f"Startup report {name}   version {r.get('version')}",
             f"container start {_fmt(r.get('container_start'))}   python {_fmt(r.get('process_start'))}",
             f"listening {rel(r.get('listening_at'))}   page served {rel(r.get('page_served_at'))}   "
             f"usable {rel(r.get('usable_at'))}" + ("" if r.get("client") else " (no browser report)"),
             ""]
    if r.get("facts"):
        lines.append("facts: " + ", ".join(f"{k} {v}" for k, v in r["facts"].items()))
        lines.append("")
    lines.append("phases:")
    for p in r.get("phases", []):
        lines.append(f"  {p['secs']:8.3f}s  {p['name']}")
    lines.append("")
    lines.append("first request of each endpoint after start (slowest first):")
    reqs = sorted(r.get("requests", []), key=lambda q: -q["secs"])
    for q in reqs:
        steps = "  (" + ", ".join(f"{s['name']} {s['ms']:.0f}ms" for s in q["steps"]) + ")" if q["steps"] else ""
        lines.append(f"  {rel(q['at'])}  {q['secs']:7.3f}s  {q['bytes'] / 1024:8.0f} KB  {q['path']}{steps}")
    if not reqs:
        lines.append("  none recorded")
    if r.get("client"):
        c = r["client"]
        lines += ["", f"browser: first render {c.get('first_render_ms')} ms, usable {c.get('usable_ms')} ms after navigation",
                  "", c.get("text", "")]
    return "\n".join(lines)


def _fmt(t) -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(t)) if t else "n/a"
