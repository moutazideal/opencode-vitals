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
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RESULTS: list[tuple[str, bool, str, str]] = []

# A check is "required" when a failure means this machine cannot run the bar.
# "info" checks describe runtime state that is legitimately absent before the
# plugin is installed or before OpenCode has loaded it, and calling those a
# failure tells a new user their machine is broken when it is not.
REQUIRED = "required"
INFO = "info"
# Distinguishes "the plugin is not installed" from "the run stopped before we could
# tell", which is why a plain None was not enough.
UNKNOWN = object()


def check(name: str, condition: bool, detail: str = "", severity: str = REQUIRED) -> None:
    RESULTS.append((name, bool(condition), detail, severity))


def find_installed_plugin() -> Path | None:
    """Where OpenCode reads global plugins, and whether Vitals is one of them.

    The search follows the shipped CLI: XDG_CONFIG_HOME when set, ~/.config
    otherwise, on every platform. The folder must carry a manifest naming this
    plugin — any folder with an index.js used to count as an installation.
    """
    config_home = os.environ.get("XDG_CONFIG_HOME")
    root = Path(config_home) if config_home else Path.home() / ".config"
    directory = root / "opencode" / "plugins"
    try:
        if not directory.is_dir():
            return None
        for entry in directory.iterdir():
            if not entry.is_dir():
                continue
            try:
                manifest = json.loads((entry / "package.json").read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if isinstance(manifest, dict) and manifest.get("name") == "opencode-vitals":
                return entry
    except OSError:
        return None
    return None


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

    # Following the window — minimized, unfocused, or covered — is asked of the
    # window server with xprop and xwininfo. Without them the bar simply stays
    # up, so this is a note, not a failure.
    if sys.platform.startswith("linux") and os.environ.get("DISPLAY"):
        for tool in ("xprop", "xwininfo"):
            found = shutil.which(tool)
            check(f"{tool} available for window following", found is not None, found or "install x11-utils; the bar will stay visible instead of following", INFO)

    database = bar.desktop_database_path()
    override = os.environ.get("OPENCODE_LATENCY_DESKTOP_DB")
    check("Desktop state database found", database is not None, str(database) if database else "set OPENCODE_LATENCY_DESKTOP_DB to the real path")
    if database is not None:
        session = bar.DesktopTabs(database).poll()
        check("open tab read from the database", session is not None, session or "tabs.recent is empty or unreadable")

    status_dir = Path(tempfile.gettempdir()) / "opencode-latency-monitor"
    status_file = status_dir / "latest.json"
    totals_file = status_dir / "session-totals.json"
    version_file = status_dir / "plugin-version.json"
    lock = status_dir / "popup.lock"
    installed = find_installed_plugin()
    started = version_file.is_file()

    # Whether the bar is up right now decides how strict the runtime checks are.
    # A fresh install that has not finished a response yet has no status file,
    # and calling that a broken machine is what this file used to do.
    running = False
    holder: dict = {}
    if lock.is_file():
        try:
            holder = json.loads(lock.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            holder = {}
        running = bar.pid_is_alive(int(holder.get("pid", 0)))
    runtime_severity = REQUIRED if running else INFO

    check("plugin installed on disk", installed is not None, str(installed) if installed else "npx opencode-vitals install", INFO)
    check("plugin status file present", status_file.is_file(), str(status_file) if status_file.is_file() else "no response recorded yet", runtime_severity)
    if totals_file.is_file():
        try:
            sessions = json.loads(totals_file.read_text(encoding="utf-8")).get("sessions", {})
        except (OSError, ValueError):
            sessions = {}
        check("session totals readable", bool(sessions), f"{len(sessions)} session(s)", runtime_severity)

    if lock.is_file():
        check("a bar instance is running", running, f"pid {holder.get('pid')}", runtime_severity)
    else:
        check("no stale bar lock", True, str(lock), INFO)

    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
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
            runtime_severity,
        )
    else:
        check(
            "plugin version recorded",
            False,
            "OpenCode has not loaded the plugin yet; restart it" if installed else "not installed yet",
            INFO,
        )

    finish(installed, started, running)
    return finish.exit_code


def finish(installed=UNKNOWN, started: bool = False, running: bool = False) -> int:
    required = [row for row in RESULTS if row[3] == REQUIRED]
    info = [row for row in RESULTS if row[3] == INFO]
    print()
    for name, ok, detail, severity in RESULTS:
        marker = "ok  " if ok else ("FAIL" if severity == REQUIRED else "note")
        line = f"{marker} {name}"
        if detail:
            line += f" — {detail}"
        print(line)

    passed = sum(1 for row in required if row[1])
    failed = [row for row in required if not row[1]]
    note_word = "note" if len(info) == 1 else "notes"
    print(f"\n{passed}/{len(required)} required checks passed" + (f", plus {len(info)} {note_word}" if info else ""))

    if failed:
        print("The bar cannot be trusted on this machine; the README lists what to do per platform.")
        finish.exit_code = 1
        return finish.exit_code
    if installed is UNKNOWN:
        print("This machine cannot draw the bar. The measurement core still works without it.")
        finish.exit_code = 1
        return finish.exit_code
    if installed is None:
        print("\nOpenCode Vitals is not installed on this machine. That is the normal answer here:")
        print("  npx opencode-vitals install     # install it")
        print("  then restart OpenCode")
        finish.exit_code = 0
        return finish.exit_code
    if not started:
        print("\nInstalled, but OpenCode has not loaded it yet. Restart OpenCode, then run this again.")
        finish.exit_code = 0
        return finish.exit_code
    if not running:
        print("\nThe plugin has run here, but no bar is up right now. OpenCode is probably closed.")
        finish.exit_code = 0
        return finish.exit_code
    print("\nReady: the bar is running on this machine.")
    finish.exit_code = 0
    return finish.exit_code


finish.exit_code = 0


if __name__ == "__main__":
    raise SystemExit(main())
