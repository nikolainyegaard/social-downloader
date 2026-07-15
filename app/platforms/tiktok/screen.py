"""In-app viewer for the TikTok browser display.

The browser runs headed on the container's Xvfb display (see the headed-browser
notes in api.py). This module grabs single JPEG frames of that display with
ffmpeg x11grab and injects mouse input with xdotool, so the web UI can render a
live view and let the user solve a captcha or verification wall by hand.

xdotool injects at the X server level, so Chrome receives native OS input
events, the same path a real mouse takes. That matters: how a captcha is solved
is itself scored, and replayed events that look like real input pass where
synthetic DOM events would not.

Everything rides the app's own HTTPS and auth, so no extra port is exposed.
"""

from __future__ import annotations

import os
import subprocess

# Matches the Xvfb screen the Docker CMD starts. x11grab errors if the size
# does not match the real display geometry, so this is not a free-form guess.
SCREEN_W = 1920
SCREEN_H = 1080


def _display() -> str:
    return os.environ.get("DISPLAY", ":99")


def available() -> bool:
    """True when a working X display exists to grab from."""
    from platforms.tiktok.api import _headed
    return _headed()


def grab_frame() -> bytes | None:
    """One JPEG frame of the whole display, or None if the grab failed."""
    try:
        proc = subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-f", "x11grab",
             "-video_size", f"{SCREEN_W}x{SCREEN_H}", "-i", _display(),
             "-frames:v", "1", "-q:v", "6", "-f", "mjpeg", "-"],
            capture_output=True, timeout=10,
        )
    except Exception:
        return None
    return proc.stdout or None


def _build_xdotool_args(events: list[dict]) -> list[str]:
    """Turn a list of pointer events into one xdotool argument vector.

    Each event is {type: 'down'|'move'|'up', x, y} in display pixels. Batching
    the whole burst into a single xdotool call preserves ordering and avoids a
    process spawn per mouse move. Coordinates are clamped to the screen so a
    misreported frame size cannot drive the pointer off the display.
    """
    args = ["xdotool"]
    for e in events:
        x = max(0, min(SCREEN_W - 1, int(e["x"])))
        y = max(0, min(SCREEN_H - 1, int(e["y"])))
        args += ["mousemove", str(x), str(y)]
        if e.get("type") == "down":
            args += ["mousedown", "1"]
        elif e.get("type") == "up":
            args += ["mouseup", "1"]
    return args


def send_input(events: list[dict]) -> bool:
    """Replay pointer events onto the display via xdotool. Best-effort."""
    if not events:
        return True
    try:
        subprocess.run(
            _build_xdotool_args(events),
            env={**os.environ, "DISPLAY": _display()},
            capture_output=True, timeout=5,
        )
        return True
    except Exception:
        return False


if __name__ == "__main__":
    # arg-building is the only non-trivial logic; verify ordering and clamping
    got = _build_xdotool_args([
        {"type": "down", "x": 10, "y": 20},
        {"type": "move", "x": 5000, "y": -3},
        {"type": "up", "x": 30, "y": 40},
    ])
    assert got == [
        "xdotool",
        "mousemove", "10", "20", "mousedown", "1",
        "mousemove", "1919", "0",
        "mousemove", "30", "40", "mouseup", "1",
    ], got
    print("ok")
