#!/usr/bin/env python3
"""Tests for the cross-platform Tkinter vitals bar and its instance lock."""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESULTS = []


def display_available() -> bool:
    # Linux needs DISPLAY or WAYLAND_DISPLAY; macOS and Windows always have one.
    if sys.platform.startswith("linux"):
        return bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))
    return True


if sys.platform.startswith("linux") and not display_available():
    # A headless Linux box has no window system to test against; say so instead
    # of reporting a red suite for an environment the bar cannot use.
    print("skipped: no DISPLAY on Linux, the bar needs a window system")
    raise SystemExit(0)


def check(name, condition, detail=""):
    RESULTS.append((name, bool(condition), detail))
    if not condition:
        print(f"FAIL {name} {detail}")


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Event:
    def __init__(self, x=0, y=0, x_root=0, y_root=0):
        self.x = x
        self.y = y
        self.x_root = x_root
        self.y_root = y_root


def texts_of(bar_ui):
    return [bar_ui.canvas.itemcget(item, "text") for item in bar_ui.canvas.find_all() if bar_ui.canvas.type(item) == "text"]


bar = load_module("bar_test", ROOT / "bar.py")

work = Path(tempfile.mkdtemp(prefix="vitals-bar-test-", dir="/tmp/opencode"))
try:
    # --- pure helpers ---------------------------------------------------------
    check("format_tps integer", bar.format_tps(274.3) == "274", bar.format_tps(274.3))
    check("format_tps decimal", bar.format_tps(12.5) == "12.5", bar.format_tps(12.5))
    check("format_tps none", bar.format_tps(None) == "–", bar.format_tps(None))
    check("format_count negative", bar.format_count(-4) == 0, bar.format_count(-4))
    totals = {}
    bar.merge_totals(totals, {"ses_a": {"turns": 3, "steps": 9, "generatedTokens": 100, "activeStreamMs": 1000}})
    bar.merge_totals(totals, {"ses_a": {"turns": 1, "steps": 2, "generatedTokens": 50, "activeStreamMs": 2000}})
    check("merge keeps max turns", totals["ses_a"]["turns"] == 3, totals["ses_a"])
    check("merge keeps max stream", totals["ses_a"]["activeStreamMs"] == 2000, totals["ses_a"])
    check("rate recomputed", abs((bar.totals_rate(totals["ses_a"]) or 0) - 50) < 0.001, bar.totals_rate(totals["ses_a"]))

    # stale current session is ignored
    current_file = work / "current.json"
    current_file.write_text(json.dumps({"available": True, "sessionID": "ses_x", "observedAt": 1}), encoding="utf-8")
    check("stale session ignored", bar.load_current_session(current_file) is None)
    current_file.write_text(json.dumps({"available": True, "sessionID": "ses_x", "observedAt": int(time.time() * 1000)}), encoding="utf-8")
    check("fresh session accepted", bar.load_current_session(current_file) == {"sessionID": "ses_x"})

    # --- instance lock --------------------------------------------------------
    lock = work / "bar.lock"
    bar.LOCK_ATTEMPTS, bar.LOCK_DELAY_SECONDS = 20, 0.05
    holder = subprocess.Popen(["sleep", "30"])
    lock.write_text(json.dumps({"pid": holder.pid, "build": 1.0}), encoding="utf-8")
    check("older live revision replaced", bar.acquire_instance(lock, bar.build_token()) is True)
    deadline = time.time() + 5
    while time.time() < deadline and holder.poll() is None:
        time.sleep(0.05)
    check("older revision terminated", holder.poll() is not None)
    bar.release_instance(lock)
    check("lock released", not lock.exists())

    same = subprocess.Popen(["sleep", "30"])
    try:
        lock.write_text(json.dumps({"pid": same.pid, "build": bar.build_token()}), encoding="utf-8")
        bar.LOCK_ATTEMPTS, bar.LOCK_DELAY_SECONDS = 2, 0.01
        check("same revision not stolen", bar.acquire_instance(lock, bar.build_token()) is False)
        check("same revision still alive", same.poll() is None)
    finally:
        same.terminate()
        same.wait(timeout=5)

    dead = subprocess.Popen(["true"])
    dead.wait()
    lock.write_text(json.dumps({"pid": dead.pid, "build": 1.0}), encoding="utf-8")
    bar.LOCK_ATTEMPTS, bar.LOCK_DELAY_SECONDS = 20, 0.02
    check("stale lock recovered", bar.acquire_instance(lock, bar.build_token()) is True)
    bar.release_instance(lock)

    # --- rendering ------------------------------------------------------------
    status = work / "latest.json"
    totals_file = work / "session-totals.json"
    best_file = work / "bar-session-totals.json"
    position = work / "position.json"
    session_id = "ses_bar000000000000000001"
    status.write_text(json.dumps({
        "id": "r1",
        "sessionID": session_id,
        "sessionTotals": {"turns": 10, "steps": 245, "generatedTokens": 137000, "activeStreamMs": 500000, "tokensPerSecond": 274},
    }), encoding="utf-8")
    current_file.write_text(json.dumps({"available": True, "sessionID": session_id, "observedAt": int(time.time() * 1000)}), encoding="utf-8")
    totals_file.write_text(json.dumps({"version": 1, "sessions": {session_id: {"turns": 12, "steps": 260, "generatedTokens": 200000, "activeStreamMs": 500000}}}), encoding="utf-8")

    ui = bar.Bar(status, current_file, totals_file, best_file, position, 0, work / "absent-drafts.sqlite")
    ui.poll()
    ui.root.update()

    def texts():
        return texts_of(ui)

    joined = " | ".join(texts())
    check("bar shows turns", "12 turns" in joined, joined)
    check("bar shows steps", "260 steps" in joined, joined)
    check("bar shows tps", "400 tok/s" in joined, joined)
    check("bar normal size", ui.root.winfo_width() == bar.NORMAL_WIDTH and ui.root.winfo_height() == bar.NORMAL_HEIGHT, (ui.root.winfo_width(), ui.root.winfo_height()))
    check("bar has close glyph", "×" in joined, joined)

    # A viewed session with no totals yet must not crash the bar: it shows the
    # last measured session, and zeros only when nothing is known at all.
    empty_totals = work / "empty-totals.json"
    empty_totals.write_text(json.dumps({"version": 1, "sessions": {}}), encoding="utf-8")
    fallback_ui = bar.Bar(status, current_file, empty_totals, best_file, position, 0, work / "absent-drafts.sqlite")
    fallback_ui.poll()
    fallback_ui.root.update()
    check("unknown session keeps last measured totals", "12 turns" in " | ".join(texts_of(fallback_ui)), " | ".join(texts_of(fallback_ui)))
    fallback_ui.shutdown()
    blank_best = work / "blank-best.json"
    blank_ui = bar.Bar(status, current_file, empty_totals, blank_best, position, 0, work / "absent-drafts.sqlite")
    blank_ui.poll()
    blank_ui.root.update()
    check("nothing known renders zeros", "0 turns" in " | ".join(texts_of(blank_ui)), " | ".join(texts_of(blank_ui)))
    blank_ui.shutdown()

    # click on the × minimizes, click on the mini square restores
    ui.on_press(Event(x=ui.width - 10, y=ui.height / 2))
    ui.root.update()
    check("close click minimizes", ui.minimized is True)
    check("mini size", ui.root.winfo_width() == bar.MINI_WIDTH and ui.root.winfo_height() == bar.MINI_HEIGHT, (ui.root.winfo_width(), ui.root.winfo_height()))
    check("mini shows tps", "400" in " | ".join(texts()), " | ".join(texts()))
    ui.on_press(Event(x=10, y=10, x_root=100, y_root=100))
    ui.on_release(Event(x=10, y=10, x_root=100, y_root=100))
    ui.root.update()
    check("mini click restores", ui.minimized is False)

    # dragging moves the window and persists the position
    before = (ui.root.winfo_x(), ui.root.winfo_y())
    ui.on_press(Event(x=80, y=27, x_root=before[0] + 200, y_root=before[1] + 40))
    ui.on_motion(Event(x=80, y=27, x_root=before[0] + 38, y_root=before[1] + 65))
    ui.on_release(Event(x=80, y=27, x_root=before[0] + 38, y_root=before[1] + 65))
    ui.root.update()
    after = (ui.root.winfo_x(), ui.root.winfo_y())
    check("bar drags where released", after == (before[0] - 162, before[1] + 25), (before, after))
    saved = bar.load_saved_position(position)
    check("bar persists position", saved == after, (saved, after))

    # totals file updates show up
    totals_file.write_text(json.dumps({"version": 1, "sessions": {session_id: {"turns": 20, "steps": 300, "generatedTokens": 300000, "activeStreamMs": 500000}}}), encoding="utf-8")
    ui.poll()
    ui.root.update()
    check("bar follows totals updates", "20 turns" in " | ".join(texts()) and "600 tok/s" in " | ".join(texts()), " | ".join(texts()))

    # Without a current session the last completed session's totals remain visible.
    current_file.write_text(json.dumps({"available": False}), encoding="utf-8")
    ui.poll()
    ui.root.update()
    check("fallback keeps last session totals", "20 turns" in " | ".join(texts()), " | ".join(texts()))
    ui.shutdown()

    # --- Desktop tab tracking --------------------------------------------------
    import sqlite3

    desktop_db = work / "drafts.sqlite"

    def write_tabs(session_id):
        # The real Desktop keeps one connection open in WAL mode, so commits land
        # in the -wal file and the main database keeps its timestamp. Closing the
        # connection per write (as an earlier version of this test did) would
        # checkpoint into the main file and hide the very case under test.
        keeper.execute("INSERT OR REPLACE INTO state VALUES (?, ?)", ("tabs.recent", json.dumps({"key": f"sidecar/server/c2lkZWNhcg/session/{session_id}"})))
        keeper.commit()

    keeper = sqlite3.connect(desktop_db)
    keeper.execute("PRAGMA journal_mode=WAL")
    keeper.execute("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT)")
    keeper.commit()

    event_session = "ses_event00000000000000001"
    desktop_session = "ses_desktop000000000000001"
    other_session = "ses_desktop000000000000002"
    current_file.write_text(json.dumps({"available": True, "sessionID": event_session, "observedAt": int(time.time() * 1000)}), encoding="utf-8")
    totals_file.write_text(json.dumps({"version": 1, "sessions": {
        event_session: {"turns": 3, "steps": 8, "generatedTokens": 3000, "activeStreamMs": 10000},
        desktop_session: {"turns": 7, "steps": 21, "generatedTokens": 7000, "activeStreamMs": 10000},
        other_session: {"turns": 9, "steps": 30, "generatedTokens": 9000, "activeStreamMs": 10000},
    }}), encoding="utf-8")
    write_tabs(desktop_session)

    tabs_ui = bar.Bar(status, current_file, totals_file, best_file, position, 0, desktop_db)
    tabs_ui.poll()
    tabs_ui.root.update()
    check("desktop tab wins over events", tabs_ui.current_session_id == desktop_session, tabs_ui.current_session_id)
    check("desktop tab totals shown", "7 turns" in " | ".join(texts_of(tabs_ui)), " | ".join(texts_of(tabs_ui)))

    # Switching tabs in the app changes the row, and the bar follows it even
    # though the main database file keeps its timestamp (WAL write).
    database_mtime = desktop_db.stat().st_mtime_ns
    write_tabs(other_session)
    check("wal write keeps database mtime", desktop_db.stat().st_mtime_ns == database_mtime, (database_mtime, desktop_db.stat().st_mtime_ns))
    tabs_ui.poll()
    tabs_ui.root.update()
    check("bar follows tab switch", tabs_ui.current_session_id == other_session, tabs_ui.current_session_id)
    check("switched tab totals shown", "9 turns" in " | ".join(texts_of(tabs_ui)), " | ".join(texts_of(tabs_ui)))
    keeper.close()

    # No database: the bar falls back to the plugin's event session.
    tabs_ui.shutdown()
    missing_db_ui = bar.Bar(status, current_file, totals_file, best_file, position, 0, work / "missing.sqlite")
    missing_db_ui.poll()
    missing_db_ui.root.update()
    check("missing database falls back to events", missing_db_ui.current_session_id == event_session, missing_db_ui.current_session_id)
    check("fallback totals shown", "3 turns" in " | ".join(texts_of(missing_db_ui)), " | ".join(texts_of(missing_db_ui)))
    missing_db_ui.shutdown()

    # --- no display: exits quietly -------------------------------------------
    env = {**os.environ, "DISPLAY": "", "WAYLAND_DISPLAY": ""}
    probe = subprocess.run([sys.executable, str(ROOT / "bar.py")], env=env, capture_output=True, text=True, timeout=20)
    check("bar exits without display", probe.returncode == 0 and not probe.stderr.strip(), (probe.returncode, probe.stderr[:200]))
finally:
    shutil.rmtree(work, ignore_errors=True)

passed = sum(1 for _name, ok, _detail in RESULTS if ok)
for name, ok, detail in RESULTS:
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f" {detail}" if detail and not ok else ""))
print(f"\n{passed}/{len(RESULTS)} checks passed")
if passed != len(RESULTS):
    raise SystemExit(1)
