"""Self-check for ChannelDB._scan_groups: a run longer than one scan chunk
must report its true count, groups older than the run must still come back,
and a `before` page must drop the tail of a group the previous page showed.

Run: python scripts/test_scan_groups.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

from engine.database import ChannelDB


class FakeConn:
    """Serves newest-first rows honoring the trailing LIMIT ? OFFSET ? the
    scan appends; any leading WHERE args are ignored (rows are pre-filtered
    by the test)."""
    def __init__(self, rows):
        self.rows = rows

    def execute(self, sql, params):
        limit, offset = params[-2], params[-1]
        page = self.rows[offset:offset + limit]

        class R:
            def fetchall(self):
                return page
        return R()


def row(ch, ts):
    return {"channel_id": ch, "handle": ch, "download_date": ts}


def db():
    d = ChannelDB.__new__(ChannelDB)
    d._GROUP_SCAN = 10  # small chunks so the test data overflows them
    return d


def demo():
    # 25-row run for A (10s apart) newer than 5 lone posts by other channels
    # (2000s apart, too far to glue). Chunk size 10: the run spans 3 chunks.
    run = [row("A", 100000 - i * 10) for i in range(25)]
    olds = [row(f"B{i}", 90000 - i * 2000) for i in range(5)]
    rows = run + olds

    groups, more = db()._scan_groups(FakeConn(rows), "", (), "download_date", 3)
    assert [g["count"] for g in groups] == [25, 1, 1], groups
    assert groups[0]["channel_id"] == "A"
    assert more, "rows remain beyond cap=3, has_more must hold"
    assert "_last_ts" not in groups[0]

    # Scanning to the end with room to spare: everything comes back, no more.
    groups, more = db()._scan_groups(FakeConn(rows), "", (), "download_date", 50)
    assert [g["count"] for g in groups] == [25, 1, 1, 1, 1, 1]
    assert not more

    # Cursor page: before = 99900 (run rows 0-9 already shown). The feed
    # queries with a 300s lookback, so rows < before+300 reach the scan; the
    # glued group's newest row is >= before and must be dropped whole.
    visible = [r for r in rows if r["download_date"] < 99900 + 300]
    groups, more = db()._scan_groups(
        FakeConn(visible), "", (), "download_date", 3, drop_at_or_above=99900)
    assert groups[0]["channel_id"].startswith("B"), \
        f"continuation of A must be dropped, got {groups[0]}"
    assert all(g["channel_id"] != "A" for g in groups)

    # A separate older group of A (gap > 300 below the cursor) is NOT a
    # continuation and must survive the drop.
    rows2 = [row("A", 100000), row("A", 99000), row("A", 98995)]
    groups, _ = db()._scan_groups(
        FakeConn(rows2[1:]), "", (), "download_date", 3, drop_at_or_above=99900)
    assert [g["count"] for g in groups] == [2], groups

    print("ok")


if __name__ == "__main__":
    demo()
