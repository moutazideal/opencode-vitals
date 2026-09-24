#!/usr/bin/env python3
"""Diagnose whether the vitals bar can run on this machine.

Run it after installing the plugin:

    python3 selftest.py        # or: npm run selftest

It answers the only questions that cannot be answered from another operating
system: is Tkinter here, can a topmost undecorated window be made, where is the
Desktop state database, and can the open tab be read from it. Every line is a
measured fact, not an assumption.
"""

from __future__ import annotations

import importlib.util
import json
import os
import platform
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    RESULTS.append((name, bool(condition), detail))


def load_bar():
    spec = importlib.util.spec_from_file_location("vitals_bar", ROOT / "bar.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["vitals_bar"] = module
    spec.loader.exec_module(module)
    return module


def main() -> int:
    print(f"opencode-vitals selftest — {platform.system()} {platform.release()} ({sys.platform})")
    print(f"python {platform.python_version()} at {sys.executable}")

    bar = load_bar()
    check("tkinter available", bar.TK_AVAILABLE)
    if not bar.TK_AVAILABLE:
        finish()
        return 1

    import tkinter
    import tkinter.font as tkfont

    check("Tk runtime present", True, f"Tk {tkinter.TkVersion}, Tcl {tkinter.TclVersion}")

    has_display = (not sys.platform.startswith("linux")) or bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))
    check("a window system is reachable", has_display, "DISPLAY=" + (os.environ.get("DISPLAY") or "unset"))
    if not has_display:
        print("  the bar cannot be drawn here; the measurement core still works")
        finish()
        return 0

    probe = tkinter.Tk()
    try:
        families = set(tkfont.families(probe))
    except tkinter.TclError:
        families = set()
    chosen = next((name for name in bar.FONT_CANDIDATES if name in families), None)
    check("a preferred font exists", chosen is not None, chosen or "only fallback fonts: " + ", ".join(sorted(families)[:6]))

    managed = False
    window_type = "override-redirect"
    if sys.platform.startswith("linux"):
        for candidate in ("toolbar", "splash", "dock"):
            try:
                probe.attributes("-type", candidate)
                managed = True
                window_type = candidate
                break
            except tkinter.TclError:
                continue
    if not managed:
        probe.overrideredirect(True)
    topmost_set = False
    try:
        probe.attributes("-topmost", True)
        # On X11 Tk applies this at map time, so reading it back before the
        # window is mapped always says 0.
        probe.geometry("120x40+40+40")
        probe.update()
        topmost_set = bool(probe.attributes("-topmost")) or sys.platform != "linux"
    except tkinter.TclError:
        topmost_set = False
    alpha_set = False
    try:
        probe.attributes("-alpha", 0.96)
        alpha_set = True
    except tkinter.TclError:
        alpha_set = False
    probe.update()
    check("topmost window accepted", topmost_set, f"type={window_type}, topmost={probe.attributes('-topmost')}")
    check("window transparency accepted", alpha_set, "-alpha 0.96")
    if sys.platform.startswith("linux") and managed:
        check("undecorated window type chosen", window_type in ("toolbar", "splash", "dock"), window_type)
    probe.destroy()

    database = bar.desktop_database_path()
    override = os.environ.get("OPENCODE_LATENCY_DESKTOP_DB")
    check("Desktop state database found", database is not None, str(database) if database else "set OPENCODE_LATENCY_DESKTOP_DB to the real path")
    if database is not None:
        session = bar.DesktopTabs(database).poll()
        check("open tab read from the database", session is not None, session or "tabs.recent is empty or unreadable")

    status_dir = Path(tempfile.gettempdir()) / "opencode-latency-monitor"
    status_file = status_dir / "latest.json"
    totals_file = status_dir / "session-totals.json"
    check("plugin status file present", status_file.is_file(), str(status_file))
    if totals_file.is_file():
        try:
            sessions = json.loads(totals_file.read_text(encoding="utf-8")).get("sessions", {})
        except (OSError, ValueError):
            sessions = {}
        check("session totals readable", bool(sessions), f"{len(sessions)} session(s)")

    lock = status_dir / "popup.lock"
    if lock.is_file():
        try:
            holder = json.loads(lock.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            holder = {}
        check("a bar instance is running", bar.pid_is_alive(int(holder.get("pid", 0))), f"pid {holder.get('pid')}")
    else:
        check("no stale bar lock", True, str(lock))

    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    version_file = status_dir / "plugin-version.json"
    if version_file.is_file():
        try:
            recorded = json.loads(version_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            recorded = {}
        previous = recorded.get("previous")
        check(
            "plugin version recorded",
            recorded.get("version") == package.get("version"),
            f"running {recorded.get('version')}, package {package.get('version')}" + (f", previous {previous}" if previous else ""),
        )
    else:
        check("plugin version recorded", False, f"no {version_file}; the plugin has not started yet")

    finish()
    return 0


def finish() -> None:
    passed = sum(1 for _name, ok, _detail in RESULTS if ok)
    print()
    for name, ok, detail in RESULTS:
        line = f"{'ok  ' if ok else 'FAIL'} {name}"
        if detail:
            line += f" — {detail}"
        print(line)
    print(f"\n{passed}/{len(RESULTS)} checks passed")
    if passed != len(RESULTS):
        print("The bar cannot be trusted on this machine; the README lists what to do per platform.")


if __name__ == "__main__":
    raise SystemExit(main())
