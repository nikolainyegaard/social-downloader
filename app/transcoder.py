"""
Background AV1 transcode job for large videos.

Re-encodes archived H.264 mp4 files to AV1 (SVT-AV1, 10-bit, tune=VQ) with
Opus audio, cutting 50-90% of the size at visually transparent quality
(settings calibrated against VMAF on real archive samples). New downloads
over the size threshold enqueue automatically when the job is enabled; the
Backfill button (Settings > General > Jobs) enqueues every existing file
that qualifies.

Safety model: the original is never opened for writing. The encode goes to a
hidden temp file next to the original (same filesystem, so the final swap is
one atomic os.replace), and the swap happens only after four gates pass:
ffmpeg exit code, output strictly smaller, container duration within 1 s,
and a full-file VMAF check against configurable floors. A failed gate keeps
the original and records the reason; failed rows are never retried
automatically. A crash or power cut mid-encode leaves only a temp file,
which startup recovery removes while resetting the row to pending.

Playback collision: swapping a file while the viewer is streaming it would
feed the player byte ranges from a different file (each HTTP range request
reopens the path). The media routes stamp every serve via mark_served();
when a finished transcode finds its file served within the grace window the
row parks as swap_pending and the worker moves on, retrying the swap between
queue items instead of blocking on it.

Offloading: queue rows claimed for processing outside the app (by setting
status 'remote' directly in the DB) are ignored by the worker. When such a
row returns to pending and its file probes as AV1 smaller than the
orig_bytes recorded at enqueue time, the worker credits the saving as done
with reason 'transcoded externally' instead of skipping.

Uses its own ffmpeg (TRANSCODE_FFMPEG, default /opt/ffmpeg/ffmpeg from the
image's static build) because Debian bookworm's ffmpeg carries SVT-AV1 1.4
and no libvmaf. Encodes run serially under nice 19 with a thread cap, so the
job never takes the machine from other containers or the app itself.
"""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
from contextlib import contextmanager

from config import DATA_DIR, MEDIA_DIR, _ts

_DB_PATH       = os.path.join(DATA_DIR, "transcode.db")
_SETTINGS_PATH = os.path.join(DATA_DIR, "transcode.json")
_TMP_PREFIX    = ".transcode-"

_DEFAULT_SETTINGS = {
    "enabled":            False,  # auto-enqueue new downloads
    "paused":             False,  # worker halted (queue keeps accepting)
    "min_size_mb":        50,
    "min_bpp":            0.10,  # skip sources below this bits/pixel/frame: already compact, AV1 at this CRF only grows them
    "crf":                22,
    "preset":             4,
    "audio_bitrate_kbps": 96,
    "threads":            8,
    "verify_vmaf":        True,
    "vmaf_mean_floor":    96.0,
    "vmaf_min_floor":     85.0,
}

# The static build ships ffmpeg and ffprobe side by side; fall back to the
# system binaries outside the container (local dev).
_STATIC_FFMPEG = "/opt/ffmpeg/ffmpeg"
FFMPEG  = os.environ.get("TRANSCODE_FFMPEG") or (
    _STATIC_FFMPEG if os.path.exists(_STATIC_FFMPEG) else "ffmpeg")
FFPROBE = (os.path.join(os.path.dirname(FFMPEG), "ffprobe")
           if os.path.sep in FFMPEG else "ffprobe")

# Grace window: a file range-requested within this many seconds counts as
# being watched and its swap is deferred.
_SERVE_GRACE_SECS = 60

_state_lock = threading.Lock()
_state: dict = {
    "current":  None,   # {path, phase, pct, speed} while a file is processing
    "scanning": False,  # backfill walk in progress
    "message":  "",     # sticky operator-facing note (disk full, no libvmaf)
}

_wake = threading.Event()
_worker_started = False

# The in-flight ffmpeg process, so Skip current can kill it. _skip_requested
# distinguishes a user cancel from a genuine encode failure.
_proc_lock = threading.Lock()
_current_proc: subprocess.Popen | None = None
_skip_requested = False

_served_lock: threading.Lock = threading.Lock()
_served: dict[str, float] = {}   # abs path -> monotonic time of last serve


# ── Settings ──────────────────────────────────────────────────────────────────

def get_settings() -> dict:
    """Read per call, like platforms.json, so changes apply without restart."""
    try:
        with open(_SETTINGS_PATH, encoding="utf-8") as f:
            stored = json.load(f)
    except (OSError, ValueError):
        stored = {}
    return {**_DEFAULT_SETTINGS, **{k: stored[k] for k in _DEFAULT_SETTINGS if k in stored}}


def save_settings(changes: dict) -> dict:
    merged = {**get_settings(), **{k: changes[k] for k in _DEFAULT_SETTINGS if k in changes}}
    tmp = _SETTINGS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(merged, f, indent=2)
    os.replace(tmp, _SETTINGS_PATH)
    _wake.set()
    return merged


# ── Queue DB ──────────────────────────────────────────────────────────────────

@contextmanager
def _db():
    """One connection per operation, committed and closed on exit. A bare
    `with sqlite3.connect(...)` commits but never closes, and the status
    endpoint is polled every 2 s."""
    conn = sqlite3.connect(_DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    try:
        with conn:
            yield conn
    finally:
        conn.close()


def _init_db() -> None:
    with _db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS transcodes (
                path        TEXT PRIMARY KEY,
                status      TEXT NOT NULL DEFAULT 'pending',
                reason      TEXT,
                orig_bytes  INTEGER,
                new_bytes   INTEGER,
                vmaf_mean   REAL,
                vmaf_min    REAL,
                queued_at   INTEGER,
                finished_at INTEGER,
                elapsed     INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_transcodes_status ON transcodes(status);
        """)
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(transcodes)")}
        if "elapsed" not in cols:
            conn.execute("ALTER TABLE transcodes ADD COLUMN elapsed INTEGER")


def _tmp_path(path: str) -> str:
    return os.path.join(os.path.dirname(path), _TMP_PREFIX + os.path.basename(path))


def _set_row(path: str, **cols) -> None:
    keys = ", ".join(f"{k} = ?" for k in cols)
    with _db() as conn:
        conn.execute(f"UPDATE transcodes SET {keys} WHERE path = ?", (*cols.values(), path))


def _finish(path: str, status: str, **cols) -> None:
    _set_row(path, status=status, finished_at=int(time.time()), **cols)


# ── Enqueue ───────────────────────────────────────────────────────────────────

def maybe_enqueue(path: str) -> None:
    """Post-download hook: queue a fresh file if auto-transcode is on and it
    meets the criteria. Never raises; a queueing failure must not fail a
    download. A row already done or skipped is reset to pending because the
    file was just written anew (a re-download is H.264 again); failed rows
    stay failed until an explicit retry."""
    try:
        s = get_settings()
        if not s["enabled"] or not path.lower().endswith(".mp4"):
            return
        path = os.path.abspath(path)
        if os.path.getsize(path) < s["min_size_mb"] * 1024 * 1024:
            return
        with _db() as conn:
            conn.execute("""
                INSERT INTO transcodes (path, status, orig_bytes, queued_at)
                VALUES (?, 'pending', ?, ?)
                ON CONFLICT(path) DO UPDATE SET
                    status = 'pending', reason = NULL, queued_at = excluded.queued_at
                    WHERE transcodes.status IN ('done', 'skipped')
            """, (path, os.path.getsize(path), int(time.time())))
        _wake.set()
    except Exception as e:
        print(f"[{_ts()}] [transcode] enqueue failed for {path}: {e}")


def start_backfill() -> bool:
    """Walk the media library and enqueue every qualifying mp4 not already
    tracked. Runs in its own thread (the walk visits ~100k+ files). Returns
    False when a scan is already running."""
    with _state_lock:
        if _state["scanning"]:
            return False
        _state["scanning"] = True

    def _scan():
        added = 0
        try:
            min_bytes = get_settings()["min_size_mb"] * 1024 * 1024
            now = int(time.time())
            with _db() as conn:
                # Rows parked because their file was gone: if the file is back
                # (moved away for external transcoding, restored from backup),
                # requeue them. orig_bytes is kept, so a file that returned
                # already transcoded still credits its saving.
                gone = [r["path"] for r in conn.execute(
                    "SELECT path FROM transcodes WHERE status = 'skipped' "
                    "AND reason IN ('file missing', 'file removed before swap')")]
                for p in gone:
                    if os.path.exists(p):
                        conn.execute(
                            "UPDATE transcodes SET status = 'pending', reason = NULL, "
                            "queued_at = ? WHERE path = ?", (now, p))
                        added += 1
                for dirpath, _dirs, files in os.walk(MEDIA_DIR):
                    for name in files:
                        if not name.lower().endswith(".mp4") or name.startswith(_TMP_PREFIX):
                            continue
                        full = os.path.join(dirpath, name)
                        try:
                            if os.path.getsize(full) < min_bytes:
                                continue
                        except OSError:
                            continue
                        cur = conn.execute("""
                            INSERT OR IGNORE INTO transcodes (path, status, orig_bytes, queued_at)
                            VALUES (?, 'pending', ?, ?)
                        """, (os.path.abspath(full), os.path.getsize(full), now))
                        added += cur.rowcount
            print(f"[{_ts()}] [transcode] backfill scan queued {added} file(s)")
        except Exception as e:
            print(f"[{_ts()}] [transcode] backfill scan failed: {e}")
        finally:
            with _state_lock:
                _state["scanning"] = False
            _wake.set()

    threading.Thread(target=_scan, daemon=True, name="transcode-backfill").start()
    return True


def retry_failed() -> int:
    with _db() as conn:
        cur = conn.execute(
            "UPDATE transcodes SET status = 'pending', reason = NULL WHERE status = 'failed'")
    _wake.set()
    return cur.rowcount


def skip_current() -> bool:
    """Kill the in-flight ffmpeg. The file is marked failed with reason
    'cancelled', so it stays parked until Retry failed; the original is
    untouched. Returns False when nothing is running."""
    global _skip_requested
    with _proc_lock:
        if _current_proc is None:
            return False
        _skip_requested = True
        try:
            _current_proc.terminate()
        except OSError:
            pass
    return True


def _consume_skip() -> bool:
    global _skip_requested
    with _proc_lock:
        was = _skip_requested
        _skip_requested = False
    return was


# ── Playback tracking ─────────────────────────────────────────────────────────

def mark_served(path: str) -> None:
    """Called by the media routes on every file/range request. The worker
    defers a swap while the file was served within the grace window."""
    with _served_lock:
        _served[os.path.abspath(path)] = time.monotonic()
        if len(_served) > 512:
            cutoff = time.monotonic() - _SERVE_GRACE_SECS
            for k in [k for k, v in _served.items() if v < cutoff]:
                del _served[k]


def _recently_served(path: str) -> bool:
    with _served_lock:
        ts = _served.get(os.path.abspath(path))
    return ts is not None and (time.monotonic() - ts) < _SERVE_GRACE_SECS


# ── ffmpeg helpers ────────────────────────────────────────────────────────────

def _probe(path: str, entries: str) -> str | None:
    try:
        r = subprocess.run(
            [FFPROBE, "-v", "error", "-show_entries", entries, "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=60)
        return r.stdout.strip() if r.returncode == 0 else None
    except Exception:
        return None


def _video_codec(path: str) -> str | None:
    try:
        r = subprocess.run(
            [FFPROBE, "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=codec_name", "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=60)
        return r.stdout.strip() or None if r.returncode == 0 else None
    except Exception:
        return None


def _duration(path: str) -> float | None:
    out = _probe(path, "format=duration")
    try:
        return float(out) if out else None
    except ValueError:
        return None


def _bits_per_pixel(path: str, size: int, duration: float) -> float | None:
    """Bits per pixel per frame of the video stream, the compactness measure
    behind the min_bpp gate. None when the probe fails."""
    try:
        r = subprocess.run(
            [FFPROBE, "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height,r_frame_rate", "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=60)
        w, h, rate = r.stdout.strip().split(",")
        num, _, den = rate.partition("/")
        fps = float(num) / float(den or 1)
        return (size * 8 / duration) / (int(w) * int(h) * fps)
    except Exception:
        return None


_vmaf_checked: bool | None = None


def vmaf_available() -> bool:
    """Whether the transcode ffmpeg was built with libvmaf. Checked once."""
    global _vmaf_checked
    if _vmaf_checked is None:
        try:
            r = subprocess.run([FFMPEG, "-hide_banner", "-filters"],
                               capture_output=True, text=True, timeout=30)
            _vmaf_checked = "libvmaf" in (r.stdout or "")
        except Exception:
            _vmaf_checked = False
    return _vmaf_checked


def _run_ffmpeg(cmd: list[str], duration: float | None, path: str, phase: str) -> tuple[int, str]:
    """Run ffmpeg with -progress on stdout, feeding the live panel. Returns
    (returncode, error tail). stderr is merged in; SVT's banner lines are
    filtered out of the tail so a real error is what remains."""
    global _current_proc
    errors: list[str] = []
    with _state_lock:
        _state["current"] = {"path": path, "phase": phase, "pct": 0, "speed": ""}
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, errors="replace")
    with _proc_lock:
        _current_proc = proc
    assert proc.stdout is not None
    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        key, sep, val = line.partition("=")
        if sep and key in ("out_time_us", "out_time_ms"):
            # Both keys are microseconds (out_time_ms is a historical misnomer).
            if duration:
                try:
                    pct = min(int(int(val) / 10_000 / duration), 100)
                    with _state_lock:
                        if _state["current"]:
                            _state["current"]["pct"] = pct
                except ValueError:
                    pass
        elif sep and key == "speed":
            with _state_lock:
                if _state["current"]:
                    _state["current"]["speed"] = val.strip()
        elif not sep or " " in key:
            # Not a progress pair: ffmpeg or encoder output. Keep a short tail.
            if not line.startswith(("Svt", "SvtMalloc")):
                errors.append(line)
                del errors[:-5]
    proc.wait()
    with _proc_lock:
        _current_proc = None
    return proc.returncode, " | ".join(errors)[-300:]


def _measure_vmaf(new: str, orig: str, threads: int, duration: float | None) -> tuple[float, float] | None:
    """Full-file VMAF of the transcode against its source. Returns
    (mean, min) or None when the measurement itself failed."""
    log = tempfile.NamedTemporaryFile(suffix=".json", delete=False)
    log.close()
    try:
        rc, _err = _run_ffmpeg(
            ["nice", "-n", "19", FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "error",
             "-progress", "pipe:1",
             "-i", new, "-i", orig,
             "-lavfi", f"libvmaf=n_threads={threads}:log_path={log.name}:log_fmt=json",
             "-f", "null", "-"],
            duration, orig, "verifying")
        if rc != 0:
            return None
        with open(log.name, encoding="utf-8") as f:
            frames = json.load(f).get("frames") or []
        scores = [f["metrics"]["vmaf"] for f in frames if "vmaf" in f.get("metrics", {})]
        if not scores:
            return None
        return (sum(scores) / len(scores), min(scores))
    except Exception:
        return None
    finally:
        try:
            os.remove(log.name)
        except OSError:
            pass


# ── Worker ────────────────────────────────────────────────────────────────────

def _process(path: str, s: dict) -> None:
    tmp = _tmp_path(path)
    try:
        if not os.path.exists(path):
            _finish(path, "skipped", reason="file missing")
            return
        if _video_codec(path) == "av1":
            # Smaller than the size recorded at enqueue time means the file
            # was transcoded outside the app (offloaded to another machine):
            # credit the saving instead of skipping.
            size = os.path.getsize(path)
            with _db() as conn:
                row = conn.execute("SELECT orig_bytes FROM transcodes WHERE path = ?",
                                   (path,)).fetchone()
            orig = row["orig_bytes"] if row else None
            if orig and size < orig:
                _finish(path, "done", new_bytes=size, reason="transcoded externally")
                print(f"[{_ts()}] [transcode] credited external transcode for {path}: "
                      f"{orig:,} -> {size:,} bytes")
            else:
                _finish(path, "skipped", reason="already AV1")
            return

        orig_bytes = os.path.getsize(path)
        duration   = _duration(path)
        if duration and s["min_bpp"] > 0:
            bpp = _bits_per_pixel(path, orig_bytes, duration)
            if bpp is not None and bpp < s["min_bpp"]:
                _finish(path, "skipped", reason=f"source already compact ({bpp:.3f} bpp)")
                return
        free       = shutil.disk_usage(os.path.dirname(path)).free
        if free < orig_bytes:
            # Not a per-file failure: the disk needs space. Park and wait.
            with _state_lock:
                _state["message"] = "Low disk space, transcoding waits until space frees up."
            _wake.wait(300)
            _wake.clear()
            return
        with _state_lock:
            _state["message"] = ""

        t0 = time.monotonic()
        def _secs() -> int:
            return int(time.monotonic() - t0)

        _set_row(path, status="encoding", orig_bytes=orig_bytes)
        print(f"[{_ts()}] [transcode] encoding {path} ({orig_bytes:,} bytes)")
        rc, err = _run_ffmpeg(
            ["nice", "-n", "19", FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "error",
             "-progress", "pipe:1", "-y",
             "-i", path,
             "-map", "0:v:0", "-map", "0:a:0?", "-map_metadata", "0",
             "-c:v", "libsvtav1", "-preset", str(s["preset"]), "-crf", str(s["crf"]),
             "-pix_fmt", "yuv420p10le", "-g", "120",
             "-svtav1-params", f"tune=0:lp={s['threads']}",
             "-c:a", "libopus", "-b:a", f"{s['audio_bitrate_kbps']}k",
             "-movflags", "+faststart",
             "-f", "mp4", tmp],
            duration, path, "encoding")
        if rc != 0:
            _finish(path, "failed", elapsed=_secs(), reason="cancelled" if _consume_skip()
                    else f"encode failed: {err or f'exit {rc}'}")
            return

        new_bytes = os.path.getsize(tmp)
        if new_bytes >= orig_bytes:
            _finish(path, "skipped", reason="no size win", new_bytes=new_bytes, elapsed=_secs())
            return
        new_duration = _duration(tmp)
        if duration is None or new_duration is None or abs(duration - new_duration) > 1.0:
            _finish(path, "failed", new_bytes=new_bytes, elapsed=_secs(),
                    reason=f"duration mismatch ({duration} vs {new_duration})")
            return

        vmaf_mean = vmaf_min = None
        if s["verify_vmaf"]:
            _set_row(path, status="verifying")
            scores = _measure_vmaf(tmp, path, s["threads"], duration)
            if scores is None:
                _finish(path, "failed", new_bytes=new_bytes, elapsed=_secs(),
                        reason="cancelled" if _consume_skip() else "VMAF measurement failed")
                return
            vmaf_mean, vmaf_min = scores
            if vmaf_mean < s["vmaf_mean_floor"] or vmaf_min < s["vmaf_min_floor"]:
                _finish(path, "failed", new_bytes=new_bytes, elapsed=_secs(),
                        vmaf_mean=round(vmaf_mean, 2), vmaf_min=round(vmaf_min, 2),
                        reason=f"below VMAF floor (mean {vmaf_mean:.2f}, min {vmaf_min:.2f})")
                return

        # mtime carries the upload date (set at download time); keep it.
        st = os.stat(path)
        os.utime(tmp, (st.st_atime, st.st_mtime))
        cols = dict(new_bytes=new_bytes, elapsed=_secs(),
                    vmaf_mean=round(vmaf_mean, 2) if vmaf_mean is not None else None,
                    vmaf_min=round(vmaf_min, 2) if vmaf_min is not None else None)
        if _recently_served(path):
            _set_row(path, status="swap_pending", **cols)
            print(f"[{_ts()}] [transcode] {os.path.basename(path)} is being watched, swap deferred")
        else:
            os.replace(tmp, path)
            _finish(path, "done", **cols)
            print(f"[{_ts()}] [transcode] done {path}: {orig_bytes:,} -> {new_bytes:,} bytes"
                  + (f", vmaf {vmaf_mean:.2f}/{vmaf_min:.2f}" if vmaf_mean is not None else ""))
    except Exception as e:
        print(f"[{_ts()}] [transcode] error on {path}: {type(e).__name__}: {e}")
        _finish(path, "failed", reason=f"{type(e).__name__}: {e}"[:300])
    finally:
        # A skip that raced a natural exit could leave the flag set; never
        # let it leak into the next file.
        _consume_skip()
        with _state_lock:
            _state["current"] = None
        with _db() as conn:
            row = conn.execute("SELECT status FROM transcodes WHERE path = ?", (path,)).fetchone()
        if row and row["status"] not in ("swap_pending",):
            try:
                if os.path.exists(tmp):
                    os.remove(tmp)
            except OSError:
                pass


def _retry_pending_swaps() -> None:
    with _db() as conn:
        rows = [r["path"] for r in conn.execute(
            "SELECT path FROM transcodes WHERE status = 'swap_pending'")]
    for path in rows:
        tmp = _tmp_path(path)
        if not os.path.exists(tmp):
            _finish(path, "failed", reason="temp file lost before swap")
            continue
        if not os.path.exists(path):
            # Original removed meanwhile (deleted creator, file check purge).
            try:
                os.remove(tmp)
            except OSError:
                pass
            _finish(path, "skipped", reason="file removed before swap")
            continue
        if _recently_served(path):
            continue
        os.replace(tmp, path)
        _finish(path, "done")
        print(f"[{_ts()}] [transcode] deferred swap completed for {path}")


def _recover() -> None:
    """Startup: a row caught mid-flight by a crash or power cut goes back to
    pending and its half-written temp file is removed. swap_pending rows keep
    their verified temp and are retried by the worker."""
    with _db() as conn:
        rows = [r["path"] for r in conn.execute(
            "SELECT path FROM transcodes WHERE status IN ('encoding', 'verifying')")]
        conn.execute(
            "UPDATE transcodes SET status = 'pending' WHERE status IN ('encoding', 'verifying')")
    for path in rows:
        try:
            tmp = _tmp_path(path)
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass
    if rows:
        print(f"[{_ts()}] [transcode] recovered {len(rows)} interrupted row(s) to pending")


def _worker() -> None:
    while True:
        try:
            _retry_pending_swaps()
            s = get_settings()
            if s["paused"]:
                _wake.wait(15)
                _wake.clear()
                continue
            if s["verify_vmaf"] and not vmaf_available():
                with _state_lock:
                    _state["message"] = ("VMAF verification is on but this ffmpeg lacks libvmaf. "
                                         "Set TRANSCODE_FFMPEG or turn verification off.")
                _wake.wait(60)
                _wake.clear()
                continue
            with _db() as conn:
                row = conn.execute(
                    "SELECT path FROM transcodes WHERE status = 'pending' "
                    "ORDER BY orig_bytes DESC LIMIT 1").fetchone()
            if not row:
                with _state_lock:
                    _state["message"] = ""
                _wake.wait(30)
                _wake.clear()
                continue
            _process(row["path"], s)
        except Exception as e:
            print(f"[{_ts()}] [transcode] worker error: {type(e).__name__}: {e}")
            time.sleep(30)


def start() -> None:
    """Called once from main.py after init_db. Idempotent."""
    global _worker_started
    if _worker_started:
        return
    _worker_started = True
    _init_db()
    _recover()
    threading.Thread(target=_worker, daemon=True, name="transcode-worker").start()


# ── Status for the Jobs panel ─────────────────────────────────────────────────

def get_status() -> dict:
    with _db() as conn:
        counts = {r["status"]: r["n"] for r in conn.execute(
            "SELECT status, COUNT(*) AS n FROM transcodes GROUP BY status")}
        saved = conn.execute(
            "SELECT COALESCE(SUM(orig_bytes - new_bytes), 0) AS saved FROM transcodes "
            "WHERE status = 'done' AND new_bytes IS NOT NULL").fetchone()["saved"]
        recent = [dict(r) for r in conn.execute(
            "SELECT path, status, reason, orig_bytes, new_bytes, vmaf_mean, vmaf_min, "
            "elapsed, finished_at "
            "FROM transcodes WHERE finished_at IS NOT NULL "
            "ORDER BY finished_at DESC LIMIT 10")]
    with _state_lock:
        current  = dict(_state["current"]) if _state["current"] else None
        scanning = _state["scanning"]
        message  = _state["message"]
    s = get_settings()
    return {
        "settings":       s,
        "vmaf_available": vmaf_available(),
        "current":        current,
        "scanning":       scanning,
        "message":        message,
        "counts": {k: counts.get(k, 0) for k in
                   ("pending", "remote", "encoding", "verifying", "swap_pending",
                    "done", "failed", "skipped")},
        "saved_bytes":    saved,
        "recent":         recent,
    }
