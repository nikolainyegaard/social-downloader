"""
Background text index job: OCR of saved media into media_text.

Reads every post and story file the OCR model version has not seen yet
(videos.text_indexed / stories.text_indexed below VERSION), runs RapidOCR
over images and over video frames sampled every few seconds, and writes the
recognised text to media_text, where the FTS5 index makes it searchable
(engine/database.py). Captions are indexed separately on insert and are
never touched here.

Queue model: the text_indexed columns are the queue. 0 means pending, VERSION
means done at this model version, -VERSION means failed at it (parked until
Retry failed). Bumping VERSION after a model change re-indexes everything on
its own. There is no queue DB to lose or rebuild.

Video text: one frame every frame_interval_secs through ffmpeg (fps filter,
pts_time read back from showinfo). Consecutive frames with near-identical
text collapse into one row spanning start_ts to end_ts, so an overlay that
sits on screen for ten seconds is one row, not five. Videos longer than
max_video_secs are marked done with no rows: long-form content is out of
scope and would dominate the frame budget.

Hardware: onnxruntime on CPU by default. TEXT_INDEX_GPU=1 asks RapidOCR for
the CUDA provider (needs the image built with OCR_GPU=1 and the container
given a GPU); the status reports which provider actually loaded, so a GPU
build that silently fell back to CPU is visible in the panel. The worker
thread and its ffmpeg children run at nice 19.
"""

from __future__ import annotations

import difflib
import json
import os
import re
import shutil
import statistics
import subprocess
import tempfile
import threading
import time
from collections import deque

from config import DATA_DIR, _ts

VERSION = 1   # OCR model/pipeline version stamped into text_indexed

_SETTINGS_PATH = os.path.join(DATA_DIR, "text_index.json")

_DEFAULT_SETTINGS = {
    "enabled":             False,  # worker processes pending items
    "paused":              False,
    "frame_interval_secs": 2,      # video sampling period
    "max_video_secs":      180,    # longer videos are skipped (marked done, no text)
    "min_confidence":      0.7,    # OCR lines below this are dropped
    "threads":             4,      # onnxruntime intra-op threads (CPU)
}

_VIDEO_EXT = {".mp4", ".webm", ".mkv", ".mov"}
_IMAGE_EXT = {".avif", ".jpg", ".jpeg", ".png", ".webp", ".gif"}

# How alike two consecutive frames' text must be to count as the same block
_SAME_TEXT_RATIO = 0.75

# A line needs this many letters or digits to count as text. The detector
# fires on logos, stickers and UI chrome and the recogniser then returns one
# or two confident characters ("OA", "8", a CJK glyph), which would fill the
# index with noise; real overlay text is never that short
_MIN_LINE_CHARS = 3


def _keep_line(text: str, score: float, s: dict) -> str | None:
    """None when the line passes, else the reason it is dropped."""
    if score < s["min_confidence"]:
        return "confidence"
    if sum(ch.isalnum() for ch in text) < _MIN_LINE_CHARS:
        return "too short"
    return None

_state_lock = threading.Lock()
_state: dict = {
    "current":  None,   # {platform, item_type, item_id, phase}
    "message":  "",
    "provider": None,   # onnxruntime execution provider actually in use
    "recent":   deque(maxlen=10),   # {platform, item_type, item_id, blocks, secs, error}
    "items_done":   0,
    "frames_done":  0,
    "started_at":   None,
}
_wake = threading.Event()
_worker_started = False
_ocr = None
_ocr_lock = threading.Lock()


# ── Settings ──────────────────────────────────────────────────────────────────

def get_settings() -> dict:
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


# ── OCR engine ────────────────────────────────────────────────────────────────

def _engine(threads: int):
    """RapidOCR, built once. Imported lazily so the app starts without the
    package (the job then reports it instead of crashing the process)."""
    global _ocr
    with _ocr_lock:
        if _ocr is not None:
            return _ocr
        import onnxruntime as ort
        from rapidocr import RapidOCR
        gpu = os.environ.get("TEXT_INDEX_GPU") == "1"
        if gpu and hasattr(ort, "preload_dlls"):
            # pip-installed CUDA/cuDNN wheels (onnxruntime-gpu build) load here
            try:
                ort.preload_dlls()
            except Exception:
                pass
        params = {
            "Global.use_cls": False,   # no text-direction classifier: overlays are upright
            "Global.log_level": "warning",
            "EngineConfig.onnxruntime.intra_op_num_threads": max(1, int(threads)),
            "EngineConfig.onnxruntime.use_cuda": bool(gpu),
            # The default EXHAUSTIVE search benchmarks every convolution
            # algorithm for each new input shape, and the recogniser meets a
            # new width per text box, so a short run is nothing but warm-up
            "EngineConfig.onnxruntime.cuda_ep_cfg.cudnn_conv_algo_search": "HEURISTIC",
        }
        _ocr = RapidOCR(params=params)
        try:
            sess = _ocr.text_det.session.session   # onnxruntime InferenceSession
            provider = sess.get_providers()[0]
        except Exception:
            provider = "CUDAExecutionProvider" if gpu and "CUDAExecutionProvider" in ort.get_available_providers() else "CPUExecutionProvider"
        with _state_lock:
            _state["provider"] = provider
        print(f"[{_ts()}] [text-index] OCR engine ready: {provider}")
        return _ocr


def _ocr_image(path: str, s: dict, trace: list | None = None,
               label: str = "") -> tuple[str, float] | None:
    """Recognise one image file. Returns (text, mean confidence) or None when
    no text above the confidence floor was found. trace, when given, gets
    one entry per call with every raw line and score (the diagnostics)."""
    t0  = time.time()
    res = _engine(s["threads"])(path)
    raw = [(str(t).strip(), float(c)) for t, c in zip(getattr(res, "txts", None) or [],
                                                      getattr(res, "scores", None) or [])]
    pairs = [(t, c) for t, c in raw if t and not _keep_line(t, c, s)]
    if trace is not None:
        trace.append({"label": label, "secs": round(time.time() - t0, 3), "lines": raw,
                      "kept": len(pairs)})
    if not pairs:
        return None
    return " ".join(t for t, _ in pairs), statistics.fmean(c for _, c in pairs)


# ── ffmpeg helpers ────────────────────────────────────────────────────────────

_FFMPEG = ["nice", "-n", "19", "ffmpeg", "-nostdin", "-hide_banner", "-y"]


def _duration(path: str) -> float | None:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", path],
            capture_output=True, text=True, timeout=60).stdout.strip()
        return float(out) if out else None
    except Exception:
        return None


def _to_png(path: str, tmpdir: str) -> str:
    """Decode any image (AVIF included, which OpenCV cannot read) to PNG."""
    out = os.path.join(tmpdir, "image.png")
    r = subprocess.run(_FFMPEG + ["-v", "error", "-i", path, "-frames:v", "1", out],
                       capture_output=True, text=True, timeout=120)
    if r.returncode != 0 or not os.path.exists(out):
        raise RuntimeError(f"ffmpeg image decode failed: {r.stderr.strip()[-200:]}")
    return out


_PTS_RX = re.compile(r"pts_time:\s*([0-9.]+)")


def _frames(path: str, interval: float, tmpdir: str) -> list[tuple[float, str]]:
    """Sample one frame per interval. Returns (seconds, frame path) pairs; the
    timestamps come from showinfo so they are the real decode times, not
    assumed multiples of the interval."""
    pattern = os.path.join(tmpdir, "f_%05d.jpg")
    r = subprocess.run(
        _FFMPEG + ["-v", "info", "-i", path,
                   "-vf", f"fps=1/{interval},scale='min(1080,iw)':-2,showinfo",
                   "-q:v", "4", pattern],
        capture_output=True, text=True, timeout=600)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg frame sampling failed: {r.stderr.strip()[-200:]}")
    times = [float(m) for m in _PTS_RX.findall(r.stderr)]
    files = sorted(f for f in os.listdir(tmpdir) if f.startswith("f_"))
    return [(times[i] if i < len(times) else i * interval, os.path.join(tmpdir, f))
            for i, f in enumerate(files)]


# ── Text block collapsing ─────────────────────────────────────────────────────

def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def collapse_frames(hits: list[tuple[float, str, float]], interval: float) -> list[tuple]:
    """Merge consecutive frames carrying the same text into one block.
    hits: (ts, text, confidence) in time order, frames without text omitted.
    Returns (source, start_ts, end_ts, text, confidence) rows; the text kept
    for a block is the one with the highest confidence seen."""
    rows: list[tuple] = []
    cur = None   # [start, end, best_text, best_conf, norm]
    for ts, text, conf in hits:
        n = _norm(text)
        if cur is not None and (ts - cur[1]) <= interval * 1.5 and \
                difflib.SequenceMatcher(None, cur[4], n).ratio() >= _SAME_TEXT_RATIO:
            cur[1] = ts
            if conf > cur[3]:
                cur[2], cur[3], cur[4] = text, conf, n
            continue
        if cur is not None:
            rows.append(("frame", cur[0], cur[1] + interval, cur[2], cur[3]))
        cur = [ts, ts, text, conf, n]
    if cur is not None:
        rows.append(("frame", cur[0], cur[1] + interval, cur[2], cur[3]))
    return rows


# ── One item ──────────────────────────────────────────────────────────────────

def _set_phase(phase: str) -> None:
    with _state_lock:
        if _state["current"]:
            _state["current"]["phase"] = phase


def _index_video_file(path: str, item: dict, s: dict, tmpdir: str,
                      trace: list | None = None) -> list[tuple] | None:
    """Rows for one video file, or None when it exceeds max_video_secs."""
    dur = item.get("duration") or _duration(path)
    if trace is not None:
        trace.append({"label": "duration", "secs": 0, "lines": [], "kept": 0,
                      "note": f"{dur} s (db: {item.get('duration')}), limit {s['max_video_secs']} s"})
    if dur and dur > s["max_video_secs"]:
        return None
    t0 = time.time()
    frames = _frames(path, float(s["frame_interval_secs"]), tmpdir)
    if trace is not None:
        trace.append({"label": "sampling", "secs": round(time.time() - t0, 3), "lines": [], "kept": 0,
                      "note": f"{len(frames)} frames at {[round(t, 2) for t, _ in frames]}"})
    hits = []
    for i, (ts, fpath) in enumerate(frames):
        _set_phase(f"frame {i + 1} of {len(frames)}")
        got = _ocr_image(fpath, s, trace, f"frame {i + 1} @ {ts:.2f}s")
        if got:
            hits.append((ts, got[0], got[1]))
        os.unlink(fpath)
    with _state_lock:
        _state["frames_done"] += len(frames)
    return collapse_frames(hits, float(s["frame_interval_secs"]))


def _index_item(engine, item: dict, s: dict, dry_run: bool = False,
                trace: list | None = None) -> tuple[list[tuple], str | None]:
    """Index one post or story. Returns (rows, skip reason). dry_run skips
    the DB write (diagnostics)."""
    from engine.web import sibling_files
    files = sibling_files({"file_path": item["file_path"], "video_id": item["item_id"]}) \
        if item["item_type"] == "video" else \
        ([item["file_path"]] if os.path.exists(item["file_path"]) else [])
    if not files:
        raise FileNotFoundError(item["file_path"])
    rows: list[tuple] = []
    skipped = None
    multi = len(files) > 1
    with tempfile.TemporaryDirectory(prefix="text-index-") as tmpdir:
        for n, path in enumerate(files, 1):
            ext = os.path.splitext(path)[1].lower()
            if ext in _VIDEO_EXT:
                _set_phase("sampling frames")
                got = _index_video_file(path, item, s, tmpdir, trace)
                if got is None:
                    skipped = "longer than the video limit"
                    continue
                # A carousel video keeps the slot index in start_ts of its
                # first block so the UI can name the slide; single videos
                # already carry real seconds there
                rows.extend(got)
            elif ext in _IMAGE_EXT:
                _set_phase(f"image {n} of {len(files)}" if multi else "image")
                got = _ocr_image(_to_png(path, tmpdir), s, trace, f"image {n}: {os.path.basename(path)}")
                if got:
                    rows.append(("image", float(n) if multi else None, None, got[0], got[1]))
    if not dry_run:
        engine.db.replace_media_text(item["item_type"], item["item_id"], item["channel_id"], rows)
        engine.db.set_text_indexed(item["item_type"], item["item_id"], VERSION)
    return rows, skipped


def diagnose(platform: str, item_id: str) -> dict:
    """Run the full pipeline on one post or story without writing anything,
    and return a verbose report: the item, its files, the settings and
    provider in use, every frame's raw OCR lines and timing, and the rows
    the index would store."""
    from platforms.registry import ENGINES
    from engine.web import sibling_files
    eng = ENGINES.get(platform)
    if not eng:
        raise ValueError(f"unknown platform {platform}")
    v = eng.db.get_video(item_id)
    st = None if v else eng.db.get_story(item_id)
    if not v and not st:
        raise LookupError(f"no post or story with id {item_id} on {platform}")
    row = v or st
    item = {"item_type": "video" if v else "story", "item_id": item_id,
            "channel_id": row["channel_id"], "file_path": row.get("file_path"),
            "content_type": row.get("content_type"), "duration": row.get("duration")}
    s = get_settings()
    lines = [f"{item['item_type']} {item_id} on {platform} (channel {row['channel_id']})",
             f"content_type: {row.get('content_type')}   duration (db): {row.get('duration')}",
             f"status: {row.get('status')}   text_indexed: {row.get('text_indexed')} (current version {VERSION})",
             f"file_path: {row.get('file_path')}"]
    files = []
    if item["file_path"]:
        files = sibling_files({"file_path": item["file_path"], "video_id": item_id}) if v else             ([item["file_path"]] if os.path.exists(item["file_path"]) else [])
    for f in files:
        try:
            size = os.path.getsize(f)
        except OSError:
            size = None
        lines.append(f"  file: {f}  ({size} bytes)")
    if not files:
        lines.append("  no files on disk")
    lines.append("")
    lines.append("settings: " + json.dumps(s))
    lines.append(f"gpu requested: {os.environ.get('TEXT_INDEX_GPU') == '1'}")
    trace: list = []
    rows: list = []
    skipped = error = None
    t0 = time.time()
    try:
        rows, skipped = _index_item(eng, item, s, dry_run=True, trace=trace)
    except Exception as e:
        error = f"{type(e).__name__}: {e}"
    total = round(time.time() - t0, 2)
    with _state_lock:
        provider = _state["provider"]
    lines.append(f"provider: {provider}")
    lines.append("")
    lines.append("steps:")
    for t in trace:
        head = f"  [{t['secs']:.3f}s] {t['label']}"
        if t.get("note"):
            head += f": {t['note']}"
        lines.append(head)
        for text, score in t["lines"]:
            why = _keep_line(text, score, s)
            lines.append(f"      {'x' if why else ' '} {score:.3f}  {text}{f'   (dropped: {why})' if why else ''}")
        if t["lines"]:
            lines.append(f"      kept {t['kept']} of {len(t['lines'])} line(s)")
    lines.append("")
    if error:
        lines.append(f"FAILED: {error}")
    elif skipped:
        lines.append(f"skipped: {skipped}")
    lines.append(f"rows the index would store ({len(rows)}):")
    for src, a, b, text, conf in rows:
        span = f"{a:.1f}s to {b:.1f}s" if src == "frame" else (f"slot {int(a)}" if a else "")
        lines.append(f"  {src:5} {span:>16}  conf {conf:.3f}  {text}")
    lines.append("")
    lines.append(f"total {total}s, dry run: nothing was written")
    return {"ok": not error, "text": "\n".join(lines), "rows": len(rows), "error": error}


# ── Worker ────────────────────────────────────────────────────────────────────

def _lower_priority() -> None:
    try:
        os.setpriority(os.PRIO_PROCESS, threading.get_native_id(), 19)
    except Exception:
        pass


def _worker() -> None:
    from platforms.registry import ENGINES
    from config import platform_enabled
    _lower_priority()
    print(f"[{_ts()}] [text-index] worker started, model version {VERSION}")
    was_active = None
    while True:
        try:
            s = get_settings()
            active = s["enabled"] and not s["paused"]
            if active != was_active:
                print(f"[{_ts()}] [text-index] " + ("running" if active else
                      ("paused" if s["enabled"] else "disabled, waiting")))
                was_active = active
            if not active:
                _wake.wait(15)
                _wake.clear()
                continue
            try:
                _engine(s["threads"])
            except Exception as e:
                with _state_lock:
                    _state["message"] = f"OCR engine unavailable: {type(e).__name__}: {e}"
                _wake.wait(60)
                _wake.clear()
                continue
            with _state_lock:
                _state["message"] = ""
                if _state["started_at"] is None:
                    _state["started_at"] = time.time()
            did_any = False
            for eng in ENGINES.values():
                if not platform_enabled(eng.platform):
                    continue
                for item in eng.db.get_text_index_pending(VERSION, limit=25):
                    did_any = True
                    t0 = time.time()
                    with _state_lock:
                        _state["current"] = {"platform": eng.platform, "item_type": item["item_type"],
                                             "item_id": item["item_id"], "phase": "starting"}
                    rec = {"platform": eng.platform, "item_type": item["item_type"],
                           "item_id": item["item_id"], "blocks": 0, "secs": 0, "error": None}
                    try:
                        rows, skipped = _index_item(eng, item, s)
                        rec["blocks"] = len(rows)
                        if skipped:
                            rec["error"] = skipped
                    except Exception as e:
                        eng.db.set_text_indexed(item["item_type"], item["item_id"], -VERSION)
                        rec["error"] = f"{type(e).__name__}: {str(e)[:160]}"
                        print(f"[{_ts()}] [text-index] {eng.platform} {item['item_type']} "
                              f"{item['item_id']} failed: {rec['error']}")
                    rec["secs"] = round(time.time() - t0, 1)
                    if not rec["error"]:
                        print(f"[{_ts()}] [text-index] {eng.platform} {item['item_type']} "
                              f"{item['item_id']}: {rec['blocks']} block(s) in {rec['secs']}s")
                    elif rec["blocks"] == 0 and not rec["error"][0].isupper():
                        print(f"[{_ts()}] [text-index] {eng.platform} {item['item_type']} "
                              f"{item['item_id']}: skipped, {rec['error']}")
                    with _state_lock:
                        _state["recent"].appendleft(rec)
                        _state["items_done"] += 1
                        _state["current"] = None
                    s = get_settings()
                    if not s["enabled"] or s["paused"]:
                        break
            if not did_any:
                print(f"[{_ts()}] [text-index] nothing pending, checking again in 60 s")
                _wake.wait(60)
                _wake.clear()
        except Exception as e:
            print(f"[{_ts()}] [text-index] worker error: {type(e).__name__}: {e}")
            with _state_lock:
                _state["current"] = None
            time.sleep(30)


def start() -> None:
    """Called once from main.py after init_db. Idempotent."""
    global _worker_started
    if _worker_started:
        return
    _worker_started = True
    threading.Thread(target=_worker, daemon=True, name="text-index-worker").start()


def reset(failed_only: bool) -> int:
    from platforms.registry import ENGINES
    n = sum(e.db.reset_text_index(VERSION, failed_only) for e in ENGINES.values())
    _wake.set()
    return n


# ── Status for the Jobs panel ─────────────────────────────────────────────────

def get_status() -> dict:
    from platforms.registry import ENGINES
    from config import platform_enabled
    counts = {"pending": 0, "done": 0, "failed": 0}
    for e in ENGINES.values():
        if not platform_enabled(e.platform):
            continue
        for k, v in e.db.text_index_counts(VERSION).items():
            counts[k] += v
    with _state_lock:
        current = dict(_state["current"]) if _state["current"] else None
        elapsed = (time.time() - _state["started_at"]) if _state["started_at"] else 0
        out = {
            "settings":    get_settings(),
            "version":     VERSION,
            "gpu_requested": os.environ.get("TEXT_INDEX_GPU") == "1",
            "provider":    _state["provider"],
            "current":     current,
            "message":     _state["message"],
            "counts":      counts,
            "items_done":  _state["items_done"],
            "frames_done": _state["frames_done"],
            "items_per_min": round(_state["items_done"] / (elapsed / 60), 1) if elapsed > 30 else None,
            "recent":      list(_state["recent"]),
        }
    out["ffmpeg"] = shutil.which("ffmpeg") is not None
    return out
