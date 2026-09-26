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


def shows(bar_ui, *parts):
    """Every part is drawn as its own text item, in the order given.

    The bar renders a number in one colour and its unit in another, so the
    checks name both pieces instead of a single joined string.
    """
    texts = texts_of(bar_ui)
    positions = []
    for part in parts:
        if part not in texts:
            return False
        positions.append(texts.index(part))
    return positions == sorted(positions)


bar = load_module("bar_test", ROOT / "bar.py")

work = Path(tempfile.mkdtemp(prefix="vitals-bar-test-", dir="/tmp/opencode"))
try:
    # --- pure helpers ---------------------------------------------------------
    check("format_tps integer", bar.format_tps(274.3) == "274", bar.format_tps(274.3))
    check("format_tps decimal", bar.format_tps(12.5) == "12.5", bar.format_tps(12.5))
    check("format_tps none", bar.format_tps(None) == "–", bar.format_tps(None))
    # Four characters is what one line of a small card can hold next to the live
    # reading; "4.7k" says the same thing as "4686" and fits.
    check("format_tps keeps four digits short", bar.format_tps(4686.4) == "4.7k", bar.format_tps(4686.4))
    check("format_tps rounds thousands", bar.format_tps(12000) == "12k", bar.format_tps(12000))
    check("format_tps keeps three digits exact", bar.format_tps(999) == "999", bar.format_tps(999))
    check("format_count negative", bar.format_count(-4) == 0, bar.format_count(-4))
    totals = {}
    bar.merge_totals(totals, {"ses_a": {"turns": 3, "steps": 9, "generatedTokens": 100, "activeStreamMs": 1000}})
    check("merge takes the snapshot whole", totals["ses_a"]["turns"] == 3 and totals["ses_a"]["generatedTokens"] == 100, totals["ses_a"])
    check("rate from one snapshot", abs((bar.totals_rate(totals["ses_a"]) or 0) - 100) < 0.001, bar.totals_rate(totals["ses_a"]))
    # A later, further-along snapshot replaces the old one entirely. Taking the
    # maximum of each field separately used to build totals no session ever had:
    # 100 tokens from one turn over 2000ms of stream time from another.
    bar.merge_totals(totals, {"ses_a": {"turns": 4, "steps": 11, "generatedTokens": 150, "activeStreamMs": 2000}})
    check("a newer snapshot wins whole", totals["ses_a"]["turns"] == 4 and totals["ses_a"]["activeStreamMs"] == 2000, totals["ses_a"])
    check("no field mixing in the rate", abs((bar.totals_rate(totals["ses_a"]) or 0) - 75) < 0.001, bar.totals_rate(totals["ses_a"]))
    # An older snapshot must not walk the numbers backwards.
    bar.merge_totals(totals, {"ses_a": {"turns": 1, "steps": 2, "generatedTokens": 10, "activeStreamMs": 100}})
    check("an older snapshot is ignored", totals["ses_a"]["turns"] == 4 and totals["ses_a"]["generatedTokens"] == 150, totals["ses_a"])
    # The same turn count with a newer timestamp is the newer snapshot.
    stamped = {}
    bar.merge_totals(stamped, {"ses_b": {"turns": 2, "generatedTokens": 20, "activeStreamMs": 1000, "updatedAt": "2026-01-01T00:00:00.000Z"}})
    bar.merge_totals(stamped, {"ses_b": {"turns": 2, "generatedTokens": 60, "activeStreamMs": 1000, "updatedAt": "2026-01-02T00:00:00.000Z"}})
    check("the timestamp breaks a turn tie", stamped["ses_b"]["generatedTokens"] == 60, stamped["ses_b"])
    check("snapshot rank orders by turns", bar.snapshot_rank({"turns": 9}) > bar.snapshot_rank({"turns": 2}))
    check("snapshot rank rejects junk", bar.snapshot_rank("nope") is None)

    # stale current session is ignored
    current_file = work / "current.json"
    current_file.write_text(json.dumps({"available": True, "sessionID": "ses_x", "observedAt": 1}), encoding="utf-8")
    check("stale session ignored", bar.load_current_session(current_file) is None)
    current_file.write_text(json.dumps({"available": True, "sessionID": "ses_x", "observedAt": int(time.time() * 1000)}), encoding="utf-8")
    check("fresh session accepted", bar.load_current_session(current_file) == {"sessionID": "ses_x"})

    # --- instance lock --------------------------------------------------------
    # Identity comes from the command line: a pid alone is not proof (pids are
    # recycled), so these tests use a process that really runs a file called
    # bar.py, exactly as the identity check expects.
    def spawn_fake_bar():
        script = work / "bar.py"
        script.write_text("import time\ntime.sleep(30)\n", encoding="utf-8")
        return subprocess.Popen([sys.executable, str(script)])

    def wait_for_bar(pid):
        # Popen returns after the fork but before the child has exec'd, so for a
        # few milliseconds /proc/<pid>/cmdline still reads the parent's command
        # line. Wait for the real one instead of assuming it.
        deadline = time.time() + 3
        while time.time() < deadline:
            if bar.process_is_bar(pid):
                return True
            time.sleep(0.02)
        return False

    lock = work / "bar.lock"
    bar.LOCK_ATTEMPTS, bar.LOCK_DELAY_SECONDS = 20, 0.05
    holder = spawn_fake_bar()
    check("a fresh bar process is recognised", wait_for_bar(holder.pid))
    lock.write_text(json.dumps({"pid": holder.pid, "build": 1.0}), encoding="utf-8")
    check("older live revision replaced", bar.acquire_instance(lock, bar.build_token()) is True)
    deadline = time.time() + 5
    while time.time() < deadline and holder.poll() is None:
        time.sleep(0.05)
    check("older revision terminated", holder.poll() is not None)
    bar.release_instance(lock)
    check("lock released", not lock.exists())

    same = spawn_fake_bar()
    try:
        check("the second bar process is recognised", wait_for_bar(same.pid))
        lock.write_text(json.dumps({"pid": same.pid, "build": bar.build_token()}), encoding="utf-8")
        bar.LOCK_ATTEMPTS, bar.LOCK_DELAY_SECONDS = 2, 0.01
        check("same revision not stolen", bar.acquire_instance(lock, bar.build_token()) is False)
        check("same revision still alive", same.poll() is None)
    finally:
        same.terminate()
        same.wait(timeout=5)

    # --- signalling identity --------------------------------------------------
    # A stale lock whose pid was recycled must never be signalled.
    sleeper = subprocess.Popen(["sleep", "30"])
    check("process_is_bar rejects a sleeping process", bar.process_is_bar(sleeper.pid) is False)
    check("process_is_bar rejects nothing", bar.process_is_bar(0) is False)
    check("pid_is_alive rejects nonsense", bar.pid_is_alive(0) is False and bar.pid_is_alive(-7) is False)

    lock.write_text(json.dumps({"pid": sleeper.pid, "build": 1.0}), encoding="utf-8")
    bar.LOCK_ATTEMPTS, bar.LOCK_DELAY_SECONDS = 20, 0.02
    check("a foreign live pid does not block the bar", bar.acquire_instance(lock, bar.build_token()) is True)
    check("the foreign process was left alone", sleeper.poll() is None)
    bar.release_instance(lock)
    sleeper.terminate()
    sleeper.wait(timeout=5)

    fake = spawn_fake_bar()
    try:
        check("process_is_bar accepts bar.py", wait_for_bar(fake.pid))
    finally:
        fake.terminate()
        fake.wait(timeout=5)

    # Windows liveness must never reach os.kill: CPython passes a signal of 0 to
    # TerminateProcess there, so the usual existence check would kill the process
    # it asks about — the OpenCode process included.
    from unittest import mock

    with mock.patch.object(bar, "_win_pid_is_alive", return_value=True), mock.patch.object(
        bar.os, "kill", side_effect=AssertionError("os.kill must never run on nt")
    ) as killer:
        try:
            nt_alive = bar.pid_is_alive(4242, platform="nt")
        except AssertionError:
            nt_alive = "os.kill was reached"
    check("windows liveness never calls os.kill", nt_alive is True and killer.call_count == 0, str(nt_alive))

    # Session ids may carry a dash or an underscore, and a truncated id would
    # silently show the wrong session.
    match = bar.SESSION_ID_PATTERN.search("sidecar/server/c2lkZWNhcg/session/ses_a1-b2_C3")
    check("session ids may contain - and _", match is not None and match.group(0) == "ses_a1-b2_C3", match.group(0) if match else "none")

    dead = subprocess.Popen(["true"])
    dead.wait()
    lock.write_text(json.dumps({"pid": dead.pid, "build": 1.0}), encoding="utf-8")
    bar.LOCK_ATTEMPTS, bar.LOCK_DELAY_SECONDS = 20, 0.02
    check("stale lock recovered", bar.acquire_instance(lock, bar.build_token()) is True)
    bar.release_instance(lock)

    # --- follows the OpenCode window: minimized hides the bar, restoring shows it
    check("window list parsed", bar.parse_window_list("_NET_CLIENT_LIST(WINDOW): window id # 0x1, 0x2a") == ["0x1", "0x2a"])
    check("hidden state recognised", bar.window_is_hidden("_NET_WM_STATE_HIDDEN") is True)
    check("maximized state is not hidden", bar.window_is_hidden("_NET_WM_STATE_MAXIMIZED_HORZ") is False)

    listing = "_NET_CLIENT_LIST(WINDOW): window id # 0x11, 0x22"
    outputs = {
        ("-root", "_NET_CLIENT_LIST"): listing,
        ("-id", "0x11", "WM_CLASS"): 'WM_CLASS(STRING) = "google-chrome", "Google-chrome"',
        ("-id", "0x22", "WM_CLASS"): 'WM_CLASS(STRING) = "ai.opencode.desktop", "ai.opencode.desktop"',
        ("-id", "0x22", "_NET_WM_STATE"): "_NET_WM_STATE_MAXIMIZED_HORZ",
    }

    def fake_probe(args):
        return outputs.get(tuple(args))

    window = bar.DesktopWindow(probe=fake_probe, interval_ms=0)
    check("the OpenCode window is found by class", window.poll(now_ms=1000) is False and window.window_id == "0x22", window.window_id)
    outputs[("-id", "0x22", "_NET_WM_STATE")] = "_NET_WM_STATE_MAXIMIZED_HORZ, _NET_WM_STATE_HIDDEN"
    check("minimizing is seen", window.poll(now_ms=2000) is True)
    outputs[("-id", "0x22", "_NET_WM_STATE")] = "_NET_WM_STATE_MAXIMIZED_HORZ"
    check("restoring is seen", window.poll(now_ms=3000) is False)
    blind = bar.DesktopWindow(probe=lambda args: None, interval_ms=0)
    check("a missing xprop keeps the bar", blind.poll(now_ms=1000) is None)
    blind.supported = False
    check("another platform keeps the bar", blind.poll(now_ms=2000) is None)

    # The search for the window spawns one xprop per candidate, so a window that
    # is not there must not be searched for on every beat, and a window that has
    # been rejected once must never be asked about again.
    calls = []

    def counting_probe(args):
        calls.append(tuple(args))
        return outputs.get(tuple(args))

    searching = bar.DesktopWindow(probe=counting_probe, interval_ms=0)
    searching.poll(now_ms=1000)
    first_pass = len(calls)
    check("the first search does look", first_pass > 0, first_pass)
    check("a rejected window is remembered", "0x11" in searching.rejected, sorted(searching.rejected))
    calls.clear()
    searching.window_id = None
    searching._find_windows(["0x11", "0x22"])
    check("a remembered window is not probed again", not [c for c in calls if c == ("-id", "0x11", "WM_CLASS")], calls)
    check("a fresh window still is", [c for c in calls if c == ("-id", "0x22", "WM_CLASS")], calls)

    # With no window at all the search is on its own, slower beat: an absent
    # window must not cost a process per second, but it must still be looked for
    # so one that appears later is caught.
    search_calls = []

    def absent_probe(args):
        search_calls.append(tuple(args))
        if tuple(args) == ("-root", "_NET_CLIENT_LIST"):
            return "_NET_CLIENT_LIST(WINDOW): window id # 0x99"
        return None

    absent = bar.DesktopWindow(probe=absent_probe, interval_ms=0)
    absent.poll(now_ms=1000)
    look = len(search_calls)
    check("an absent window is looked for at all", look > 0, look)
    absent.poll(now_ms=2000)
    check("an absent window is not searched every beat", len(search_calls) == look, (look, len(search_calls)))
    absent.poll(now_ms=1000 + bar.WINDOW_SEARCH_INTERVAL_MS)
    check("an absent window is searched again later", len(search_calls) > look, (look, len(search_calls)))
    check("the search beat is slower than the state beat", bar.WINDOW_SEARCH_INTERVAL_MS > bar.WINDOW_CHECK_INTERVAL_MS, (bar.WINDOW_SEARCH_INTERVAL_MS, bar.WINDOW_CHECK_INTERVAL_MS))

    # --- focus and covering: two more reasons the bar leaves the screen
    focus_outputs = {
        ("-root", "_NET_CLIENT_LIST"): listing,
        ("-id", "0x11", "WM_CLASS"): 'WM_CLASS(STRING) = "google-chrome", "Google-chrome"',
        ("-id", "0x22", "WM_CLASS"): 'WM_CLASS(STRING) = "ai.opencode.desktop", "ai.opencode.desktop"',
        ("-id", "0x22", "_NET_WM_STATE"): "_NET_WM_STATE_MAXIMIZED_HORZ",
        ("-root", "_NET_ACTIVE_WINDOW"): "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x11",
    }

    def focus_probe(args):
        return focus_outputs.get(tuple(args))

    follow = bar.DesktopWindow(probe=focus_probe, interval_ms=0, geometry=lambda window: None)
    follow.poll(now_ms=1000)
    check("another program taking focus hides the bar", follow.should_hide() is True, (follow.focused, follow.occluded))
    check("the app is known not to be focused", follow.focused is False, follow.focused)
    focus_outputs[("-root", "_NET_ACTIVE_WINDOW")] = "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x22"
    follow.poll(now_ms=2000)
    check("coming back to the app shows the bar", follow.should_hide() is False, follow.focused)
    follow.own_window_id = "0x77"
    focus_outputs[("-root", "_NET_ACTIVE_WINDOW")] = "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x77"
    follow.poll(now_ms=3000)
    check("clicking the bar is not leaving the app", follow.should_hide() is False and follow.focused is True, follow.focused)
    # Tk reports the child it draws in, the window manager tracks the parent, and
    # the parent is what is named as active the moment the bar is clicked. The
    # two are matched up once by the window's title.
    parent_outputs = dict(focus_outputs)
    parent_outputs[("-root", "_NET_CLIENT_LIST")] = "_NET_CLIENT_LIST(WINDOW): window id # 0x22, 0x88"
    parent_outputs[("-id", "0x22", "WM_CLASS")] = 'WM_CLASS(STRING) = "ai.opencode.desktop", "ai.opencode.desktop"'
    parent_outputs[("-id", "0x88", "_NET_WM_NAME")] = '_NET_WM_NAME(UTF8_STRING) = "OpenCode Vitals"'
    parent_outputs[("-id", "0x22", "_NET_WM_NAME")] = '_NET_WM_NAME(UTF8_STRING) = "OpenCode"'
    parent_outputs[("-id", "0x88", "WM_CLASS")] = 'WM_CLASS(STRING) = "tk #2", "Tk"'
    parent_outputs[("-root", "_NET_ACTIVE_WINDOW")] = "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x88"

    def parent_probe(args):
        return parent_outputs.get(tuple(args))

    clicked = bar.DesktopWindow(probe=parent_probe, interval_ms=0, own_window_id="0x89", own_title="OpenCode Vitals")
    clicked.poll(now_ms=1000)
    check("the bar's own managed window is found by title", clicked.own_client_id == "0x88", clicked.own_client_id)
    check("a click on the bar keeps the bar", clicked.should_hide() is False and clicked.focused is True, (clicked.focused, clicked.own_client_id))
    check("the bar is not mistaken for the app", clicked.window_id == "0x22", clicked.window_id)
    parent_outputs[("-root", "_NET_ACTIVE_WINDOW")] = "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x11"
    clicked.poll(now_ms=2000)
    check("leaving the bar still hides it", clicked.should_hide() is True, clicked.focused)
    # Nothing focused at all (the desktop itself is showing) is not a reason to
    # hide anything, and a switch can turn the whole behaviour off.
    focus_outputs[("-root", "_NET_ACTIVE_WINDOW")] = "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0"
    follow.poll(now_ms=4000)
    check("an unfocused desktop keeps the bar", follow.should_hide() is False, follow.focused)
    focus_outputs[("-root", "_NET_ACTIVE_WINDOW")] = "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x11"
    quiet_focus = bar.DesktopWindow(probe=focus_probe, interval_ms=0, hide_unfocused=False)
    quiet_focus.poll(now_ms=1000)
    check("focus following can be turned off", quiet_focus.should_hide() is False, quiet_focus.focused)
    # A CLI or TUI session has no OpenCode window to follow: focus elsewhere in
    # that case is simply the terminal the user is working in, and the bar stays.
    no_window_outputs = {("-root", "_NET_CLIENT_LIST"): "_NET_CLIENT_LIST(WINDOW): window id # 0x11"}
    no_window = bar.DesktopWindow(probe=lambda args: no_window_outputs.get(tuple(args)), interval_ms=0)
    no_window.poll(now_ms=1000)
    check("no OpenCode window means nothing to follow", no_window.should_hide() is None, (no_window.window_id, no_window.focused))

    # Covered by another window: focus stays in OpenCode, a browser is simply on
    # top of it. The window server is asked for rectangles, and only when the app
    # is the one being worked in.
    stack_outputs = dict(focus_outputs)
    stack_outputs[("-root", "_NET_ACTIVE_WINDOW")] = "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x22"
    stack_outputs[("-root", "_NET_CLIENT_LIST_STACKING")] = "_NET_CLIENT_LIST_STACKING(WINDOW): window id # 0x22, 0x11"
    rects = {"0x22": (0, 0, 1000, 800), "0x11": (0, 0, 1000, 800)}

    def stack_probe(args):
        return stack_outputs.get(tuple(args))

    def stack_geometry(window):
        return rects.get(window)

    covered = bar.DesktopWindow(probe=stack_probe, interval_ms=0, geometry=stack_geometry)
    covered.poll(now_ms=1000)
    check("a covering window hides the bar", covered.should_hide() is True, covered.occluded)
    rects["0x11"] = (0, 0, 100, 100)
    covered.poll(now_ms=1000 + bar.OCCLUSION_INTERVAL_MS)
    check("a small window does not hide the bar", covered.should_hide() is False, covered.occluded)
    rects["0x11"] = (0, 0, 1000, 800)
    stack_outputs[("-id", "0x11", "_NET_WM_STATE")] = "_NET_WM_STATE_HIDDEN"
    covered.poll(now_ms=1000 + 2 * bar.OCCLUSION_INTERVAL_MS)
    check("a minimized window covers nothing", covered.should_hide() is False, covered.occluded)
    del stack_outputs[("-id", "0x11", "_NET_WM_STATE")]
    # Geometry is the expensive question, so it is asked on its own slower beat.
    geometry_calls = []

    def counting_geometry(window):
        geometry_calls.append(window)
        return rects.get(window)

    measured = bar.DesktopWindow(probe=stack_probe, interval_ms=0, geometry=counting_geometry)
    measured.poll(now_ms=1000)
    first_measure = len(geometry_calls)
    measured.poll(now_ms=1100)
    check("geometry is not asked every beat", len(geometry_calls) == first_measure, (first_measure, len(geometry_calls)))
    measured.poll(now_ms=1000 + bar.OCCLUSION_INTERVAL_MS)
    check("geometry is asked again later", len(geometry_calls) > first_measure, len(geometry_calls))
    measured.supported = False
    check("no display keeps the bar", measured.poll(now_ms=9000) is None)
    check("parse xwininfo reads the rectangle", bar.parse_xwininfo(
        "  Absolute upper-left X:  120\n  Absolute upper-left Y:  40\n  Width: 800\n  Height: 600\n"
    ) == (120, 40, 800, 600))
    check("a broken xwininfo report is refused", bar.parse_xwininfo("Width: 800") is None)
    check("coverage is a fraction of the target", abs(bar.covered_fraction((0, 0, 50, 100), (0, 0, 100, 100)) - 0.5) < 0.001)
    check("no overlap is no coverage", bar.covered_fraction((200, 200, 10, 10), (0, 0, 100, 100)) == 0.0)
    check("the coverage bar is a real fraction", 0.0 < bar.OCCLUSION_COVERAGE < 1.0, bar.OCCLUSION_COVERAGE)

    # Declining because another bar owns the screen is the wanted state, and it
    # carries its own exit code so the plugin cannot mistake it for a crash.
    check("the lock-held exit code is its own", bar.LOCK_HELD_EXIT_CODE == 6, bar.LOCK_HELD_EXIT_CODE)
    lock_only = work / "held.lock"
    lock_only.write_text(json.dumps({"pid": 0, "build": 1.0}), encoding="utf-8")
    lock_only.unlink()
    holder_lock = work / "second.lock"
    running = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        holder_lock.write_text(json.dumps({"pid": running.pid, "build": bar.build_token()}), encoding="utf-8")
        bar.LOCK_ATTEMPTS, bar.LOCK_DELAY_SECONDS = 2, 0.01
        check("a live same-revision bar holds the lock", bar.acquire_instance(holder_lock, bar.build_token()) is False)
    finally:
        running.terminate()
        running.wait(timeout=5)

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

    scale_file = work / "scale.json"
    ui = bar.Bar(status, current_file, totals_file, best_file, position, 0, work / "absent-drafts.sqlite", work / "ui-version.json", scale_file)
    ui.poll()
    ui.root.update()

    # Minimizing the OpenCode window takes the bar away; restoring it brings the
    # bar back. The probe is injected because no window manager runs under Xvfb.
    class FakeWindow:
        def __init__(self):
            self.hidden = None
            self.focused = None
            self.occluded = None

        def poll(self, now_ms=None):
            return self.hidden

        def should_hide(self):
            if self.hidden is True or self.focused is False or self.occluded is True:
                return True
            if self.hidden is None and self.focused is None and self.occluded is None:
                return None
            return False

    fake_window = FakeWindow()
    ui.desktop_window = fake_window
    fake_window.hidden = True
    ui.poll()
    ui.root.update()
    check("the bar hides when OpenCode is minimized", ui.withdrawn is True and ui.root.winfo_viewable() == 0, (ui.withdrawn, ui.root.winfo_viewable()))
    fake_window.hidden = False
    ui.poll()
    ui.root.update()
    check("the bar returns when OpenCode is restored", ui.withdrawn is False and ui.root.winfo_viewable() == 1, (ui.withdrawn, ui.root.winfo_viewable()))
    # The same machinery covers the other two reasons: the user moved to another
    # program, or another window is simply covering the app.
    fake_window.focused = False
    ui.poll()
    ui.root.update()
    check("the bar leaves when another program takes focus", ui.withdrawn is True and ui.root.winfo_viewable() == 0, ui.withdrawn)
    fake_window.focused = True
    fake_window.occluded = True
    ui.poll()
    ui.root.update()
    check("the bar stays away while the app is covered", ui.withdrawn is True, ui.withdrawn)
    fake_window.occluded = False
    ui.poll()
    ui.root.update()
    check("the bar comes back when the app is visible again", ui.withdrawn is False and ui.root.winfo_viewable() == 1, ui.withdrawn)

    def texts():
        return texts_of(ui)

    joined = " | ".join(texts())
    check("bar shows turns", shows(ui, "12", "turns"), joined)
    check("bar shows steps", shows(ui, "260", "steps"), joined)
    check("bar shows tps", shows(ui, "400", "tok/s"), joined)
    check("bar normal size", ui.root.winfo_width() == bar.NORMAL_WIDTH and ui.root.winfo_height() == bar.NORMAL_HEIGHT, (ui.root.winfo_width(), ui.root.winfo_height()))
    check("close button is a drawn control", len([i for i in ui.canvas.find_all() if ui.canvas.type(i) == "line"]) >= 4, joined)
    ui.on_hover(Event(x=ui.width - 16, y=ui.height // 2))
    ui.root.update()
    check("close button highlights on hover", ui.close_hover is True)
    ui.on_hover_leave(Event())
    ui.root.update()
    check("close button calms on leave", ui.close_hover is False)

    # A viewed session with no totals yet must not crash the bar: it shows the
    # last measured session, and zeros only when nothing is known at all.
    # A session with no totals must not crash, and it must not claim zero work:
    # the last measured response is the honest thing to show.
    empty_totals = work / "empty-totals.json"
    empty_totals.write_text(json.dumps({"version": 1, "sessions": {}}), encoding="utf-8")
    fallback_ui = bar.Bar(status, current_file, empty_totals, work / "fresh-best.json", position, 0, work / "absent-drafts.sqlite", work / "fallback-version.json")
    fallback_ui.poll()
    fallback_ui.root.update()
    check("session without totals shows the last measurement", shows(fallback_ui, "10", "turns") and shows(fallback_ui, "274", "tok/s"), " | ".join(texts_of(fallback_ui)))
    fallback_ui.shutdown()

    # Nothing measured at all: zeros and a dash are the honest display.
    blank_ui = bar.Bar(work / "no-such-status.json", current_file, empty_totals, work / "blank-best.json", position, 0, work / "absent-drafts.sqlite", work / "no-such-version.json")
    blank_ui.poll()
    blank_ui.root.update()
    check("nothing measured renders zeros and a dash", shows(blank_ui, "0", "turns") and shows(blank_ui, "0", "steps") and shows(blank_ui, "–", "tok/s"), " | ".join(texts_of(blank_ui)))
    blank_ui.shutdown()

    # click on the × collapses, click on the mini square restores
    ui.on_press(Event(x=ui.width - 10, y=ui.height / 2))
    ui.root.update()
    check("close click collapses", ui.collapsed is True)
    check("mini size", ui.root.winfo_width() == bar.MINI_WIDTH and ui.root.winfo_height() == bar.MINI_HEIGHT, (ui.root.winfo_width(), ui.root.winfo_height()))
    check("mini shows tps", "400" in " | ".join(texts()), " | ".join(texts()))
    ui.on_press(Event(x=10, y=10, x_root=100, y_root=100))
    ui.on_release(Event(x=10, y=10, x_root=100, y_root=100))
    ui.root.update()
    check("mini click restores", ui.collapsed is False)

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
    check("bar follows totals updates", shows(ui, "20", "turns") and shows(ui, "600", "tok/s"), " | ".join(texts()))

    # The last-ten reading: the mean of the last ten responses, next to the
    # session average it must not be mistaken for. One response is not an
    # average, and a response with no honest rate is skipped rather than zeroed.
    def write_totals(**overrides):
        write_totals.stamp += 1
        payload = {
            "turns": 20,
            "steps": 300,
            "generatedTokens": 300000,
            "activeStreamMs": 500000,
            "updatedAt": f"2026-09-26T18:00:{write_totals.stamp:02d}.000Z",
        }
        payload.update(overrides)
        totals_file.write_text(json.dumps({"version": 1, "sessions": {session_id: payload}}), encoding="utf-8")
        ui.render_key = None
        ui.poll()
        ui.root.update()

    write_totals.stamp = 0

    check("no last-ten reading without rates", bar.totals_recent_rate({"recentRates": []}) is None)
    check("one response is not an average", bar.totals_recent_rate({"recentRates": [400]}) is None)
    check("the mean of the last ten responses", bar.totals_recent_rate({"recentRates": [400, 200]}) == 300)
    check("a rate-less response is not a zero", bar.totals_recent_rate({"recentRates": [400, None, "x", 200]}) == 300)
    check("totals without rates report none", bar.totals_recent_rate({"turns": 3}) is None and bar.totals_recent_rate(None) is None)
    write_totals()
    check("no last-ten reading is drawn without rates", "last10" not in texts(), " | ".join(texts()))
    write_totals(recentRates=[400, 500])
    check("the last-ten reading is drawn", shows(ui, "600", "tok/s", "·", "450", "last10"), " | ".join(texts()))
    write_totals(recentRates=[400, 200, 900])
    check("the average stays the session average", shows(ui, "600", "tok/s"), " | ".join(texts()))
    check("the last-ten reading follows its own list", shows(ui, "·", "500", "last10"), " | ".join(texts()))

    # --- resizing: the bar is the user's to size -------------------------------
    check("the bar starts at its base size", (ui.width, ui.height) == (bar.NORMAL_WIDTH, bar.NORMAL_HEIGHT), (ui.width, ui.height))
    check("scale is clamped at the top", bar.clamp_scale(99.0) == bar.MAX_SCALE, bar.clamp_scale(99.0))
    check("scale is clamped at the bottom", bar.clamp_scale(0.01) == bar.MIN_SCALE, bar.clamp_scale(0.01))
    check("nonsense scale falls back to one", bar.clamp_scale("big") == 1.0 and bar.clamp_scale(True) == 1.0)
    ui.set_scale(1.5)
    ui.root.update()
    check("the window grows with the scale", (ui.width, ui.height) == (round(bar.NORMAL_WIDTH * 1.5), round(bar.NORMAL_HEIGHT * 1.5)), (ui.width, ui.height))
    check("the text grows with it", ui.font_value.cget("size") > 12, ui.font_value.cget("size"))
    check("the size is remembered", bar.load_saved_scale(scale_file) == 1.5, bar.load_saved_scale(scale_file))
    text_items = [item for item in ui.canvas.find_all() if ui.canvas.type(item) == "text"]
    right = max(ui.canvas.bbox(item)[2] for item in text_items)
    bottom = max(ui.canvas.bbox(item)[3] for item in text_items)
    close_left = ui.width - ui.px(15) - ui.px(8)
    check("the content still fits the card", right <= close_left and bottom <= ui.height, (right, close_left, bottom, ui.height))
    ui.on_wheel(Event(), 1)
    check("the wheel steps the size up", abs(ui.scale - 1.6) < 0.001, ui.scale)
    ui.on_wheel(Event(), -1)
    ui.on_wheel(Event(), -1)
    check("the wheel steps the size down", abs(ui.scale - 1.4) < 0.001, ui.scale)
    ui.set_scale(bar.MAX_SCALE)
    ui.root.update()
    max_text_items = [item for item in ui.canvas.find_all() if ui.canvas.type(item) == "text"]
    max_right = max(ui.canvas.bbox(item)[2] for item in max_text_items)
    check("the content fits at the largest size too", max_right <= ui.width - ui.px(15) - ui.px(8), (max_right, ui.width))
    ui.set_scale(bar.MAX_SCALE + 10)
    check("dragging past the limit does not run away", ui.scale == bar.MAX_SCALE, ui.scale)
    ui.on_press(Event(x=ui.width - 3, y=ui.height - 3, x_root=1000, y_root=800))
    check("the corner starts a resize", ui.resize_active is True, (ui.width, ui.height))
    ui.on_motion(Event(x=0, y=0, x_root=1000 - 80, y_root=800 - 30))
    ui.on_release(Event(x=0, y=0, x_root=1000 - 80, y_root=800 - 30))
    ui.root.update()
    check("dragging the corner resizes the bar", ui.scale < bar.MAX_SCALE and bar.load_saved_scale(scale_file) == ui.scale, (ui.scale, bar.load_saved_scale(scale_file)))
    check("the drag did not move the window instead", ui.drag_moved is False, ui.drag_moved)
    ui.on_right_press(Event())
    ui.root.update()
    check("a right click resets the size", ui.scale == 1.0 and bar.load_saved_scale(scale_file) == 1.0, ui.scale)
    collapsed_scale = 1.2
    ui.set_scale(collapsed_scale)
    ui.set_collapsed(True)
    ui.root.update()
    check("the mini bar scales too", (ui.width, ui.height) == (round(bar.MINI_WIDTH * collapsed_scale), round(bar.MINI_HEIGHT * collapsed_scale)), (ui.width, ui.height))
    ui.set_collapsed(False)
    ui.set_scale(1.0)
    ui.root.update()

    # Without a current session the last completed session's totals remain visible.
    current_file.write_text(json.dumps({"available": False}), encoding="utf-8")
    ui.poll()
    ui.root.update()
    check("fallback keeps last session totals", shows(ui, "20", "turns"), " | ".join(texts()))
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

    tabs_ui = bar.Bar(status, current_file, totals_file, best_file, position, 0, desktop_db, work / "tabs-version.json")
    tabs_ui.poll()
    tabs_ui.root.update()
    check("desktop tab wins over events", tabs_ui.current_session_id == desktop_session, tabs_ui.current_session_id)
    check("desktop tab totals shown", shows(tabs_ui, "7", "turns"), " | ".join(texts_of(tabs_ui)))

    # Switching tabs in the app changes the row, and the bar follows it even
    # though the main database file keeps its timestamp (WAL write).
    database_mtime = desktop_db.stat().st_mtime_ns
    write_tabs(other_session)
    check("wal write keeps database mtime", desktop_db.stat().st_mtime_ns == database_mtime, (database_mtime, desktop_db.stat().st_mtime_ns))
    tabs_ui.poll()
    tabs_ui.root.update()
    check("bar follows tab switch", tabs_ui.current_session_id == other_session, tabs_ui.current_session_id)
    check("switched tab totals shown", shows(tabs_ui, "9", "turns"), " | ".join(texts_of(tabs_ui)))
    keeper.close()

    # No database: the bar falls back to the plugin's event session.
    tabs_ui.shutdown()
    missing_db_ui = bar.Bar(status, current_file, totals_file, best_file, position, 0, work / "missing.sqlite", work / "missing-version.json")
    missing_db_ui.poll()
    missing_db_ui.root.update()
    check("missing database falls back to events", missing_db_ui.current_session_id == event_session, missing_db_ui.current_session_id)
    check("fallback totals shown", shows(missing_db_ui, "3", "turns"), " | ".join(texts_of(missing_db_ui)))
    missing_db_ui.shutdown()

    # --- update notice ---------------------------------------------------------
    version_file = work / "plugin-version.json"
    version_ui = bar.Bar(status, current_file, totals_file, best_file, position, 0, work / "absent-drafts.sqlite", version_file)
    version_file.write_text(json.dumps({"version": "0.9.1", "previous": "0.9.0", "updatedAt": int(time.time() * 1000) - 600_000}), encoding="utf-8")
    version_ui.poll()
    version_ui.root.update()
    check("pending update is announced once", "0.9.1 installed" in " | ".join(texts_of(version_ui)), " | ".join(texts_of(version_ui)))
    check("announced update is marked seen", json.loads(version_file.read_text(encoding="utf-8")).get("seenAt", 0) > 0)
    version_ui.notice_started_at -= bar.UPDATE_BADGE_MS + 1
    version_ui.poll()
    version_ui.root.update()
    check("notice returns to metrics", "0.9.1 installed" not in " | ".join(texts_of(version_ui)) and "turns" in " | ".join(texts_of(version_ui)), " | ".join(texts_of(version_ui)))
    version_ui.shutdown()

    # A bar that starts after the notice was already seen shows metrics only.
    seen_file = work / "plugin-version-seen.json"
    seen_file.write_text(json.dumps({"version": "0.9.2", "updatedAt": int(time.time() * 1000) - 3_600_000, "seenAt": int(time.time() * 1000) - 3_000_000}), encoding="utf-8")
    seen_ui = bar.Bar(status, current_file, totals_file, best_file, position, 0, work / "absent-drafts.sqlite", seen_file)
    seen_ui.poll()
    seen_ui.root.update()
    check("already seen update stays quiet", "0.9.2 installed" not in " | ".join(texts_of(seen_ui)), " | ".join(texts_of(seen_ui)))
    seen_ui.shutdown()

    # --- no display: exits with a reason code --------------------------------
    env = {**os.environ, "DISPLAY": "", "WAYLAND_DISPLAY": ""}
    probe = subprocess.run([sys.executable, str(ROOT / "bar.py")], env=env, capture_output=True, text=True, timeout=20)
    check("bar exits 4 without a display", probe.returncode == 4 and not probe.stderr.strip(), (probe.returncode, probe.stderr[:200]))

    # --- selftest: only our own manifest counts as an installed Vitals -------
    selftest = load_module("selftest_test", ROOT / "selftest.py")
    xdg = work / "selftest-xdg"
    plugins_dir = xdg / "opencode" / "plugins"
    (plugins_dir / "someone-else").mkdir(parents=True)
    (plugins_dir / "someone-else" / "index.js").write_text("// not ours\n", encoding="utf-8")
    previous_xdg = os.environ.get("XDG_CONFIG_HOME")
    os.environ["XDG_CONFIG_HOME"] = str(xdg)
    try:
        check("another plugin is not an installation", selftest.find_installed_plugin() is None)
        ours = plugins_dir / "opencode-vitals"
        ours.mkdir()
        (ours / "package.json").write_text(json.dumps({"name": "opencode-vitals"}), encoding="utf-8")
        (ours / "index.js").write_text("// ours\n", encoding="utf-8")
        check("our manifest is found", selftest.find_installed_plugin() == ours, str(selftest.find_installed_plugin()))
    finally:
        if previous_xdg is None:
            del os.environ["XDG_CONFIG_HOME"]
        else:
            os.environ["XDG_CONFIG_HOME"] = previous_xdg
finally:
    shutil.rmtree(work, ignore_errors=True)

passed = sum(1 for _name, ok, _detail in RESULTS if ok)
for name, ok, detail in RESULTS:
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f" {detail}" if detail and not ok else ""))
print(f"\n{passed}/{len(RESULTS)} checks passed")
if passed != len(RESULTS):
    raise SystemExit(1)
