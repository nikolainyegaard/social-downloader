"""
Advanced search: a Gmail/GitHub style filter grammar on top of the FTS5
trigram index in media_text, compiled to one SQL statement per platform.

Grammar (parse): free text words and "phrases" match the index; -word
excludes items that contain the word anywhere; OR between terms; key:value
filters narrow by creator, platform, text source, item type, status,
flags, dates and numeric stats; re:/pattern/i is a regex post-filter over
the text rows; near:"a b"~40 is FTS5 proximity in characters; sort: picks the order. A
token with an unknown key is plain text, so a URL or a time is never
mistaken for a filter.

Results are items (posts, stories, creators), one row each, carrying the
text rows that matched with their snippets. Across platforms the route
merges per-platform pages by the sort key.
"""

from __future__ import annotations

import json
import re
import time
from datetime import datetime

# Text sources in media_text, by item type, with the aliases the in: filter accepts
SOURCES = {
    "caption": "video", "description": "video", "sound": "video",
    "image": "both", "frame": "both",
    "comment": "comment", "comment_author": "comment", "comment_author_name": "comment",
    "handle": "channel", "display_name": "channel", "bio": "channel", "bio_link": "channel",
    "old_handle": "channel", "old_display_name": "channel", "old_bio": "channel", "old_bio_link": "channel",
}
SOURCE_ALIASES = {
    "username": ["handle"], "name": ["display_name"], "link": ["bio_link"], "text": ["caption", "description"],
    "ocr": ["image", "frame"], "media": ["image", "frame"], "author": ["comment_author", "comment_author_name"],
    "old": ["old_handle", "old_display_name", "old_bio", "old_bio_link"],
    "creator": ["handle", "display_name", "bio", "bio_link", "old_handle", "old_display_name", "old_bio", "old_bio_link"],
    "comments": ["comment", "comment_author", "comment_author_name"],
}
KEYS = {"from", "platform", "in", "type", "status", "is", "has", "before", "after", "on",
        "likes", "views", "comments", "duration", "sort", "re", "near"}
SORTS = {"rank", "date", "likes", "views", "comments"}
TYPES = {"video", "photo", "post", "story", "creator", "comment"}
STATUSES = {"live", "deleted", "banned", "missing", "restored"}
FLAGS_IS = {"starred", "pinned", "bookmarked", "banned", "tracked"}
FLAGS_HAS = {"comments", "file"}

_NUM_RX = re.compile(r"^(>=|<=|>|<|=)?\s*(\d+(?:\.\d+)?)([kKmM]?)$")


# ── Parsing ───────────────────────────────────────────────────────────────────

def _tokens(q: str) -> list[str]:
    """Whitespace split that keeps "quoted strings" and /regex/ bodies whole,
    the key: prefix and - sign attached."""
    out, i, n = [], 0, len(q)
    while i < n:
        while i < n and q[i].isspace():
            i += 1
        if i >= n:
            break
        start = i
        depth_q = depth_re = False
        while i < n and (depth_q or depth_re or not q[i].isspace()):
            ch = q[i]
            if ch == '"' and not depth_re:
                depth_q = not depth_q
            elif ch == "/" and not depth_q and (i == start or q[i - 1] == ":"):
                depth_re = True
            elif ch == "/" and depth_re and q[i - 1] != "\\":
                depth_re = False
            i += 1
        out.append(q[start:i])
    return out


def _num(v: str) -> tuple[str, float] | None:
    m = _NUM_RX.match(v.strip())
    if not m:
        return None
    op, num, suf = m.group(1) or "=", float(m.group(2)), m.group(3).lower()
    return op, num * {"k": 1_000, "m": 1_000_000}.get(suf, 1)


def _date_range(v: str) -> tuple[int, int] | None:
    """'2026', '2026-03' or '2026-03-14' to (start, end) unix seconds."""
    for fmt, step in (("%Y-%m-%d", "day"), ("%Y-%m", "month"), ("%Y", "year")):
        try:
            d = datetime.strptime(v, fmt)
        except ValueError:
            continue
        if step == "day":
            e = d.replace(day=d.day) ; end = int(e.timestamp()) + 86400
        elif step == "month":
            end = int((d.replace(year=d.year + (d.month == 12), month=1 if d.month == 12 else d.month + 1)).timestamp())
        else:
            end = int(d.replace(year=d.year + 1).timestamp())
        return int(d.timestamp()), end
    return None


def parse(q: str) -> dict:
    """The query as the engine and the UI see it. text: [{term, phrase, neg}]
    with 'OR' entries between alternatives; filters: {key: [values]}; plus
    regex, near, sort and notes about ignored input."""
    out = {"text": [], "filters": {}, "regex": None, "near": None, "sort": None, "notes": []}
    for tok in _tokens(q):
        if tok == "OR":
            if out["text"] and out["text"][-1] != "OR":
                out["text"].append("OR")
            continue
        neg = tok.startswith("-") and len(tok) > 1
        body = tok[1:] if neg else tok
        key, _, val = body.partition(":")
        if _ and key.lower() in KEYS and val:
            key = key.lower()
            if val.startswith('"') and val.endswith('"') and len(val) >= 2:
                val = val[1:-1]
            if key == "re":
                m = re.match(r"^/(.*)/([a-z]*)$", val, re.S)
                pat, flags = (m.group(1), m.group(2)) if m else (val, "")
                try:
                    re.compile(pat)
                except re.error as e:
                    out["notes"].append(f"regex ignored: {e}")
                    continue
                out["regex"] = {"pattern": pat, "flags": flags}
            elif key == "near":
                m = re.match(r'^"?(.+?)"?(?:~(\d+))?$', val)
                words = [w for w in m.group(1).split() if len(w) >= 3] if m else []
                if len(words) < 2:
                    out["notes"].append("near: needs two words of 3+ characters")
                    continue
                # The trigram tokenizer makes every character position a token,
                # so the NEAR distance is in characters, not words
                out["near"] = {"words": words, "distance": int(m.group(2) or 40)}
            elif key == "sort":
                if val.lower() in SORTS:
                    out["sort"] = val.lower()
                else:
                    out["notes"].append(f"sort: unknown '{val}', use {', '.join(sorted(SORTS))}")
            elif key == "in":
                srcs = []
                for v in val.lower().split(","):
                    v = v.strip()
                    srcs += SOURCE_ALIASES.get(v) or ([v] if v in SOURCES else [])
                    if v not in SOURCE_ALIASES and v not in SOURCES:
                        out["notes"].append(f"in: unknown source '{v}'")
                if srcs:
                    out["filters"].setdefault("in", []).extend(srcs)
            elif key in ("before", "after", "on"):
                rng = _date_range(val)
                if not rng:
                    out["notes"].append(f"{key}: use YYYY, YYYY-MM or YYYY-MM-DD")
                    continue
                out["filters"].setdefault(key, []).append(rng)
            elif key in ("likes", "views", "comments", "duration"):
                num = _num(val)
                if not num:
                    out["notes"].append(f"{key}: use a number, optionally with > < >= <= and k or m")
                    continue
                out["filters"].setdefault(key, []).append(num)
            else:
                v = val.lower().lstrip("@") if key == "from" else val.lower()
                checks = {"type": TYPES, "status": STATUSES, "is": FLAGS_IS, "has": FLAGS_HAS}
                if key in checks and v not in checks[key]:
                    out["notes"].append(f"{key}: unknown '{v}', use {', '.join(sorted(checks[key]))}")
                    continue
                out["filters"].setdefault(("-" if neg else "") + key, []).append(v)
            continue
        phrase = body.startswith('"') and body.endswith('"') and len(body) >= 2
        term = body[1:-1] if phrase else body
        if not term.strip():
            continue
        if len(term.replace('"', "")) < 3:
            out["notes"].append(f"'{term}' ignored: words need 3 characters")
            continue
        out["text"].append({"term": term, "phrase": phrase, "neg": neg})
    if out["text"] and out["text"][-1] == "OR":
        out["text"].pop()
    if not out["sort"]:
        out["sort"] = "rank" if any(t != "OR" and not t["neg"] for t in out["text"]) or out["near"] else "date"
    return out


# ── Compiling ─────────────────────────────────────────────────────────────────

def _fts_term(t: dict) -> str:
    return '"' + t["term"].replace('"', '""') + '"'


def fts_match(parsed: dict) -> str | None:
    """The MATCH expression for the positive terms (OR groups kept), or None."""
    parts: list[str] = []
    pending_or = last_positive = False
    for t in parsed["text"]:
        if t == "OR":
            pending_or = last_positive   # OR only joins two positive terms
            continue
        if t["neg"]:
            last_positive = pending_or = False
            continue
        term = _fts_term(t)
        if pending_or and parts:
            parts[-1] = f"({parts[-1]} OR {term})"
        else:
            parts.append(term)
        pending_or, last_positive = False, True
    if parsed["near"]:
        parts.append("NEAR(" + " ".join('"' + w.replace('"', '""') + '"' for w in parsed["near"]["words"])
                     + f", {parsed['near']['distance']})")
    return " AND ".join(parts) if parts else None


_ITEM_COLS = """item_type, item_id, channel_id, handle, display_name, ts, status, deleted_reason,
                content_type, has_file, likes, views, comment_count, duration, comments_saved,
                starred, pinned, bookmarked, account_status, tracking_enabled, label,
                post_id, post_handle, post_label"""

_BRANCHES = {
    "video": """SELECT 'video' AS item_type, v.video_id AS item_id, v.channel_id, c.handle, c.display_name,
                       v.upload_date AS ts, v.status, v.deleted_reason, v.content_type,
                       v.file_path IS NOT NULL AS has_file, v.like_count AS likes, v.view_count AS views,
                       v.comment_count, v.duration,
                       (SELECT COUNT(*) FROM comments cm WHERE cm.video_id = v.video_id) AS comments_saved,
                       c.starred, c.pinned_at IS NOT NULL AS pinned, c.bookmarked, c.account_status,
                       c.tracking_enabled, v.title AS label, NULL AS post_id, NULL AS post_handle, NULL AS post_label
                FROM videos v JOIN channels c ON c.channel_id = v.channel_id""",
    "story": """SELECT 'story' AS item_type, s.story_id AS item_id, s.channel_id, c.handle, c.display_name,
                       s.posted_at AS ts, 'up' AS status, NULL AS deleted_reason, s.content_type,
                       s.file_path IS NOT NULL AS has_file, NULL AS likes, NULL AS views, NULL AS comment_count,
                       NULL AS duration, 0 AS comments_saved,
                       c.starred, c.pinned_at IS NOT NULL AS pinned, c.bookmarked, c.account_status,
                       c.tracking_enabled, NULL AS label, NULL AS post_id, NULL AS post_handle, NULL AS post_label
                FROM stories s JOIN channels c ON c.channel_id = s.channel_id""",
    "channel": """SELECT 'channel' AS item_type, c.channel_id AS item_id, c.channel_id, c.handle, c.display_name,
                       c.added_at AS ts, 'up' AS status, NULL AS deleted_reason, 'creator' AS content_type,
                       c.avatar_cached AS has_file, NULL AS likes, c.subscriber_count AS views, NULL AS comment_count,
                       NULL AS duration, 0 AS comments_saved,
                       c.starred, c.pinned_at IS NOT NULL AS pinned, c.bookmarked, c.account_status,
                       c.tracking_enabled, c.description AS label, NULL AS post_id, NULL AS post_handle, NULL AS post_label
                FROM channels c WHERE c.enabled = 1""",
    # type:comment makes the comment the result: handle and name are the
    # commenter's, ts and likes the comment's, label its text, and the post
    # it sits on rides along in post_id, post_handle and post_label
    "comment": """SELECT 'comment' AS item_type, cm.comment_id AS item_id, cm.channel_id, cm.author AS handle,
                       cm.author_name AS display_name, cm.created_at AS ts, 'up' AS status, NULL AS deleted_reason,
                       'comment' AS content_type, 0 AS has_file, cm.likes, NULL AS views, NULL AS comment_count,
                       NULL AS duration, 0 AS comments_saved,
                       c.starred, c.pinned_at IS NOT NULL AS pinned, c.bookmarked, c.account_status,
                       c.tracking_enabled, cm.text AS label, cm.video_id AS post_id, c.handle AS post_handle, v.title AS post_label
                FROM comments cm JOIN channels c ON c.channel_id = cm.channel_id
                                 LEFT JOIN videos v ON v.video_id = cm.video_id""",
}


def _branches(parsed: dict) -> set[str]:
    """Every hit is reported as the thing that matched: a comment hit is a
    comment result (with its post), a caption or OCR hit a post, a bio hit a
    creator. Comments only join a search that has text to match, or that
    asks for them with type:comment, so a bare filter query lists posts."""
    types = set(parsed["filters"].get("type", []))
    if not types:
        return {"video", "story", "channel", "comment"}
    out = set()
    if types & {"video", "photo", "post"}:
        out.add("video")
    if "story" in types:
        out.add("story")
    if "creator" in types:
        out.add("channel")
    if "comment" in types:
        out.add("comment")
    return out


def _where(parsed: dict, branch: str, params: list) -> list[str]:
    """Filter clauses for one branch over the aliased item columns."""
    f = parsed["filters"]
    w: list[str] = []
    types = set(f.get("type", []))
    if branch == "video" and types and not ({"video", "post"} & types):
        w.append("i.content_type IN ('photo', 'image')")
    elif branch == "video" and types == {"video"}:
        w.append("i.content_type NOT IN ('photo', 'image')")
    for h in f.get("from", []):
        if branch == "comment":
            w.append("i.handle = ? COLLATE NOCASE"); params.append(h)   # the commenter
            continue
        w.append("""(i.handle = ? COLLATE NOCASE OR i.channel_id IN (
                        SELECT channel_id FROM profile_history WHERE field = 'handle' AND old_value = ? COLLATE NOCASE))""")
        params += [h, h]
    for h in f.get("-from", []):
        w.append("NOT (i.handle = ? COLLATE NOCASE)")
        params.append(h)
    for st in f.get("status", []):
        if branch != "video":
            w.append("1 = 0" if st != "live" else "1 = 1")
            continue
        w.append({"live":     "i.status = 'up'",
                  "deleted":  "(i.status = 'deleted' AND COALESCE(i.deleted_reason, '') != 'user_banned')",
                  "banned":   "i.deleted_reason = 'user_banned'",
                  "missing":  "(i.status = 'deleted' AND i.deleted_reason IS NULL)",
                  "restored": "i.status = 'undeleted'"}[st])
    for fl in f.get("is", []):
        w.append({"starred": "i.starred = 1", "pinned": "i.pinned = 1", "bookmarked": "i.bookmarked = 1",
                  "banned": "i.account_status = 'banned'", "tracked": "i.tracking_enabled != 0"}[fl])
    for fl in f.get("-is", []):
        w.append("NOT (" + {"starred": "i.starred = 1", "pinned": "i.pinned = 1", "bookmarked": "i.bookmarked = 1",
                            "banned": "i.account_status = 'banned'", "tracked": "i.tracking_enabled != 0"}[fl] + ")")
    for fl in f.get("has", []):
        w.append({"comments": "i.comments_saved > 0", "file": "i.has_file = 1"}[fl])
    for fl in f.get("-has", []):
        w.append("NOT (" + {"comments": "i.comments_saved > 0", "file": "i.has_file = 1"}[fl] + ")")
    for start, _end in f.get("before", []):
        w.append("i.ts < ?"); params.append(start)
    for _start, end in f.get("after", []):
        w.append("i.ts >= ?"); params.append(end)
    for start, end in f.get("on", []):
        w.append("i.ts >= ? AND i.ts < ?"); params += [start, end]
    for key, col in (("likes", "i.likes"), ("views", "i.views"), ("comments", "i.comment_count"), ("duration", "i.duration")):
        for op, num in f.get(key, []):
            if branch != "video" and not (branch == "comment" and key == "likes"):
                w.append("1 = 0")
            else:
                w.append(f"{col} {op} ?"); params.append(num)
    return w


_ORDER = {
    "rank":     "rank ASC, ts DESC",
    "date":     "ts DESC, rank ASC",
    "likes":    "likes DESC, ts DESC",
    "views":    "views DESC, ts DESC",
    "comments": "comment_count DESC, ts DESC",
}


def run(db, parsed: dict, limit: int = 50, offset: int = 0) -> list[dict]:
    """Execute the parsed query against one platform database."""
    match   = fts_match(parsed)
    regex   = parsed["regex"]
    sources = parsed["filters"].get("in")
    neg     = [t for t in parsed["text"] if t != "OR" and t["neg"]]
    params: list = []
    ctes = []
    if match or regex:
        # The FTS query stands alone (rank and snippet are only valid with
        # the FTS table as the sole source); the join to media_text for
        # source, ref and the regex happens one level up
        if match:
            ctes.append("""hits AS MATERIALIZED (
                SELECT rowid AS id, rank, snippet(media_text_fts, 0, '<b>', '</b>', '…', 60) AS snippet
                FROM media_text_fts WHERE media_text_fts MATCH ?)""")
            params.append(match)
        else:
            ctes.append("hits AS MATERIALIZED (SELECT id, 0 AS rank, substr(text, 1, 160) AS snippet FROM media_text)")
        agg_where: list[str] = []
        agg_params: list = []
        if regex:
            agg_where.append("m.text REGEXP ?"); agg_params.append(regex["pattern"] + "\x00" + regex["flags"])
        if sources:
            agg_where.append("m.source IN (" + ",".join("?" * len(sources)) + ")"); agg_params += sources
        params += agg_params
        # Each match carries the whole text so the dialog can highlight
        # every occurrence (the FTS snippet shows one). Comment rows are
        # left to cagg: a comment hit is its own result, not the post's
        ctes.append(f"""agg AS (
            SELECT m.item_type, m.item_id, MIN(h.rank) AS rank, COUNT(*) AS n,
                   json_group_array(json_object('source', m.source, 'ref', m.ref, 'snippet', h.snippet, 'text', m.text)) AS matches
            FROM hits h JOIN media_text m ON m.id = h.id
            WHERE m.source NOT IN ('comment', 'comment_author', 'comment_author_name')
            {'AND ' + ' AND '.join(agg_where) if agg_where else ''}
            GROUP BY m.item_type, m.item_id)""")
        if "comment" in _branches(parsed):
            # The same hits grouped per comment for the comment branch
            ctes.append(f"""cagg AS (
                SELECT m.ref AS comment_id, MIN(h.rank) AS rank, COUNT(*) AS n,
                       json_group_array(json_object('source', m.source, 'ref', m.ref, 'snippet', h.snippet, 'text', m.text)) AS matches
                FROM hits h JOIN media_text m ON m.id = h.id
                WHERE m.source IN ('comment', 'comment_author', 'comment_author_name')
                {'AND ' + ' AND '.join(agg_where) if agg_where else ''}
                GROUP BY m.ref)""")
            params += agg_params
    if neg:
        neg_match = " OR ".join(_fts_term(t) for t in neg)
        ctes.append("""excl AS MATERIALIZED (
            SELECT DISTINCT m.item_type, m.item_id FROM media_text m
            WHERE m.id IN (SELECT rowid FROM media_text_fts WHERE media_text_fts MATCH ?))""")
        params.append(neg_match)
    parts = []
    for branch in ("video", "story", "channel", "comment"):
        if branch not in _branches(parsed):
            continue
        if sources and not any(SOURCES.get(s) in ("both", branch) for s in sources):
            continue   # the requested sources never belong to this item type
        if branch == "comment" and not (match or regex) and "comment" not in parsed["filters"].get("type", []):
            continue   # comments only come with text to match, or on request
        bp: list = []
        w = _where(parsed, branch, bp)
        if not (match or regex):
            join = ""
        elif branch == "comment":
            join = "JOIN cagg a ON a.comment_id = i.item_id"
        else:
            join = "JOIN agg a ON a.item_type = i.item_type AND a.item_id = i.item_id"
        sel_rank = "a.rank, a.n, a.matches" if join else "0 AS rank, 0 AS n, NULL AS matches"
        if neg and branch == "comment":
            w.append("""NOT EXISTS (SELECT 1 FROM media_text m WHERE m.source = 'comment' AND m.ref = i.item_id
                                    AND m.id IN (SELECT rowid FROM media_text_fts WHERE media_text_fts MATCH ?))""")
            bp.append(neg_match)
        elif neg:
            w.append("NOT EXISTS (SELECT 1 FROM excl e WHERE e.item_type = i.item_type AND e.item_id = i.item_id)")
        parts.append(f"""SELECT i.*, {sel_rank} FROM ({_BRANCHES[branch]}) i {join}
                         {'WHERE ' + ' AND '.join(w) if w else ''}""")
        params += bp
    if not parts:
        return []
    sql = ("WITH " + ",\n".join(ctes) + "\n" if ctes else "") + "\nUNION ALL\n".join(parts) \
        + f"\nORDER BY {_ORDER[parsed['sort']]} LIMIT ? OFFSET ?"
    params += [limit, offset]
    with db.get_db() as conn:
        if regex:
            cache: dict = {}
            def _regexp(pat, text):
                key = pat
                if key not in cache:
                    p, _, fl = pat.partition("\x00")
                    cache[key] = re.compile(p, (re.I if "i" in fl else 0) | re.S)
                return 1 if text is not None and cache[key].search(text) else 0
            conn.create_function("REGEXP", 2, _regexp)
        rows = [dict(r) for r in conn.execute(sql, params).fetchall()]
    for r in rows:
        r["matches"] = json.loads(r["matches"]) if r.get("matches") else []
    return rows


def sort_key(parsed: dict):
    """Python-side merge order across platforms, matching _ORDER."""
    s = parsed["sort"]
    if s == "rank":
        return lambda r: (r["rank"] or 0, -(r["ts"] or 0))
    if s == "date":
        return lambda r: (-(r["ts"] or 0), r["rank"] or 0)
    col = {"likes": "likes", "views": "views", "comments": "comment_count"}[s]
    return lambda r: (-(r[col] or 0), -(r["ts"] or 0))


HELP = [
    ("words, \"a phrase\"", "match the text index; typos tolerated through trigrams; 3 characters minimum"),
    ("-word", "exclude items that contain the word anywhere"),
    ("a OR b", "either term"),
    ("from:handle", "one creator, current or previous handle"),
    ("platform:tiktok", "one platform"),
    ("in:caption,comment", "text source: caption, description, sound, image, frame, comment, author, handle, name, bio, link, old, creator, comments, ocr, text"),
    ("type:video|photo|story|creator|comment", "item kind; a comment hit is always its own result with its post, type:comment keeps only those, from: is then the commenter"),
    ("status:live|deleted|banned|missing|restored", "post state"),
    ("is:starred|pinned|bookmarked|banned|tracked", "creator flags"),
    ("has:comments|file", "saved comments, a saved file"),
    ("before:2026-01-01  after:2025-06  on:2026-03-14", "post date, day, month or year"),
    ("likes:>1000  views:<5k  comments:>=10  duration:<60", "numbers with > < >= <=, k and m"),
    ("re:/pattern/i", "regex over the matched text rows"),
    ("near:\"word1 word2\"~40", "words within 40 characters of each other (default 40)"),
    ("sort:rank|date|likes|views|comments", "order; rank when there is text, date otherwise"),
]


if __name__ == "__main__":
    p = parse('cat "red sunset" -dog OR bird from:@Alice in:caption,author type:photo before:2026-03 likes:>1k re:/s[ou]n/i near:"beach sand"~3 sort:likes http://x.y 12')
    assert [t if t == "OR" else (t["term"], t["phrase"], t["neg"]) for t in p["text"]] == \
        [("cat", False, False), ("red sunset", True, False), ("dog", False, True), "OR", ("bird", False, False), ("http://x.y", False, False)], p["text"]
    assert p["filters"]["from"] == ["alice"] and p["filters"]["in"] == ["caption", "comment_author", "comment_author_name"]
    assert p["filters"]["type"] == ["photo"] and p["filters"]["likes"] == [(">", 1000.0)] and p["sort"] == "likes"
    assert p["regex"] == {"pattern": "s[ou]n", "flags": "i"} and p["near"] == {"words": ["beach", "sand"], "distance": 3}
    assert p["filters"]["before"][0][0] == int(datetime(2026, 3, 1).timestamp())
    assert any("12" in n for n in p["notes"])
    assert fts_match(p) == '"cat" AND "red sunset" AND "bird" AND "http://x.y" AND NEAR("beach" "sand", 3)', fts_match(p)
    assert fts_match(parse("cat OR dog bird")) == '("cat" OR "dog") AND "bird"'
    assert parse("hello")["sort"] == "rank" and parse("from:x")["sort"] == "date"
    print("parse ok")
