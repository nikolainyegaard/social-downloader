"""Daily database backup: SQLite backup API, 14-day retention."""

import os
import sqlite3
import threading
import time
from datetime import datetime, timedelta

from config import DATA_DIR
from platforms.tiktok.database import DB_PATH as _TIKTOK_DB
from platforms.youtube.database import DB_PATH as _YOUTUBE_DB

BACKUP_DIR     = os.path.join(DATA_DIR, "backups")
RETENTION_DAYS = 14

_DB_SOURCES = [
    ("tiktok",  _TIKTOK_DB),
    ("youtube", _YOUTUBE_DB),
]


def _ts() -> str:
    return f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}]"


def _next_midnight() -> float:
    now      = datetime.now()
    midnight = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return midnight.timestamp()


def _backup_db(name: str, src_path: str) -> bool:
    """Copy src_path to BACKUP_DIR/{name}_YYYYMMDD.db via the SQLite backup API.

    Returns True if the backup exists after the call (created or already present),
    False if the source DB does not exist or the backup failed.
    """
    if not os.path.exists(src_path):
        return False
    os.makedirs(BACKUP_DIR, exist_ok=True)
    date_str = datetime.now().strftime("%Y%m%d")
    dst_path = os.path.join(BACKUP_DIR, f"{name}_{date_str}.db")
    if os.path.exists(dst_path):
        return True
    tmp_path = dst_path + ".tmp"
    try:
        src = sqlite3.connect(src_path)
        dst = sqlite3.connect(tmp_path)
        src.backup(dst)
        dst.close()
        src.close()
        os.replace(tmp_path, dst_path)
        return True
    except Exception as exc:
        print(f"{_ts()} [backup] {name}: backup failed: {exc}")
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        return False


def _prune(name: str) -> None:
    cutoff = datetime.now() - timedelta(days=RETENTION_DAYS)
    try:
        for fname in os.listdir(BACKUP_DIR):
            if not (fname.startswith(f"{name}_") and fname.endswith(".db")):
                continue
            date_part = fname[len(name) + 1:-3]
            try:
                if datetime.strptime(date_part, "%Y%m%d") < cutoff:
                    os.remove(os.path.join(BACKUP_DIR, fname))
            except ValueError:
                pass
    except OSError:
        pass


def _run_backup_once() -> None:
    backed_up = []
    for name, src_path in _DB_SOURCES:
        if _backup_db(name, src_path):
            backed_up.append(name)
            _prune(name)
    if backed_up:
        print(f"{_ts()} [backup] Daily backup complete: {', '.join(backed_up)}")


def _backup_loop() -> None:
    _run_backup_once()
    while True:
        wait = _next_midnight() - time.time()
        time.sleep(max(wait, 0))
        _run_backup_once()


def start_backup_thread() -> None:
    threading.Thread(target=_backup_loop, daemon=True, name="db-backup").start()
