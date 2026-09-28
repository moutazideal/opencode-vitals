#!/usr/bin/env python3
"""Cross-platform OpenCode vitals bar: turns, steps, and session tok/s.

Uses only the Python standard library (tkinter), so it runs on Linux, macOS,
and Windows without GTK, gi, sqlite, or any other package.
"""

from __future__ import annotations

import json
import math
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

try:
    import tkinter as tk
    import tkinter.font as tkfont

    TK_AVAILABLE = True
except ImportError:  # python3-tk not installed
    tk = None
    tkfont = None
    TK_AVAILABLE = False

DEFAULT_STATUS_FILE = Path(tempfile.gettempdir()) / "opencode-latency-monitor" / "latest.json"
DEFAULT_CURRENT_SESSION_FILE = Path(tempfile.gettempdir()) / "opencode-latency-monitor" / "current-session.json"
DEFAULT_TOTALS_FILE = Path(tempfile.gettempdir()) / "opencode-latency-monitor" / "session-totals.json"
DEFAULT_BEST_TOTALS_FILE = Path(tempfile.gettempdir()) / "opencode-latency-monitor" / "bar-session-totals.json"
DEFAULT_POSITION_FILE = Path(tempfile.gettempdir()) / "opencode-latency-monitor" / "popup-position.json"
DEFAULT_SCALE_FILE = Path(tempfile.gettempdir()) / "opencode-latency-monitor" / "popup-scale.json"
DEFAULT_LOCK_FILE = Path(tempfile.gettempdir()) / "opencode-latency-monitor" / "popup.lock"
DEFAULT_VERSION_FILE = Path(tempfile.gettempdir()) / "opencode-latency-monitor" / "plugin-version.json"
STATUS_DIR_MODE = 0o700
UPDATE_BADGE_MS = 8000
NORMAL_WIDTH = 450
NORMAL_HEIGHT = 54
MINI_WIDTH = 62
MINI_HEIGHT = 62
# The bar can be scaled to taste: drag the bottom-right grip, or hold Ctrl and
# use the wheel. Every measurement in the drawing code is multiplied by this
# factor, so the card, the dial and the text stay in proportion instead of one
# of them clipping.
MIN_SCALE = 0.6
MAX_SCALE = 2.5
SCALE_STEP = 0.1
GRIP_SIZE = 13
# The size in pixels at scale 1 of the regions the mouse can act on.
CLOSE_ZONE = 34
# The numbers move at the speed of a reply, not of a frame. Half the previous
# rate halves the wake-ups with nothing lost that an eye could follow.
POLL_MS = 500
CURRENT_SESSION_MAX_AGE_MS = 15 * 1000
MAX_TRACKED_TOTALS = 100
# The rates of the most recent responses the bar averages for its "last10"
# reading. The plugin keeps the same number; this is the ceiling, not a promise.
MAX_RECENT_RATES = 10
LOCK_ATTEMPTS = 30
LOCK_DELAY_SECONDS = 0.2
# Read by the plugin: this exit code means "another bar is already up", which is
# the correct outcome and must not be treated as a crash.
LOCK_HELD_EXIT_CODE = 6
DRAG_THRESHOLD = 3
TOTAL_FIELDS = ("turns", "steps", "outputTokens", "reasoningTokens", "generatedTokens", "activeStreamMs")
# Work a session delegated to subagents. Counted apart from the session's own,
# because a subagent runs in a child session with its own stream time: adding
# its tokens to the parent's numerator without that time is how a rate becomes a
# flattering number.
SUBAGENT_FIELDS = ("subagentTurns", "subagentSteps")
WINDOW_BG = "#0b0e15"
CARD_BG = "#161b28"
CARD_BORDER = "#28324a"
CARD_HIGHLIGHT = "#2b3550"
TEXT_COLOR = "#f1f5f9"
MUTED_COLOR = "#8b95a7"
DIM_COLOR = "#5b6678"
ACCENT_COLOR = "#2dd4bf"
GAUGE_TRACK = "#2a3346"
GAUGE_TICK = "#3b465c"
GAUGE_NEEDLE = "#d7e0ee"
# Tk angles: 0 is 3 o'clock and they grow counterclockwise, so a dial with its gap
# at the bottom starts at 225 (lower left) and sweeps -270 through the top.
GAUGE_START_DEGREES = 225.0
GAUGE_SWEEP_DEGREES = 270.0
# INVENTED: the dial needs a full scale to point at. This number is a visual
# reference for the arc only and is never shown; the printed tok/s is the
# measurement and comes from the session totals.
GAUGE_FULL_SCALE_TPS = 500.0
FONT_CANDIDATES = ("Ubuntu", "Segoe UI", "SF Pro Text", "Noto Sans", "DejaVu Sans", "Helvetica")
SESSION_ID_PATTERN = re.compile(r"ses_[A-Za-z0-9_-]+")
DESKTOP_STATE_KEY = "tabs.recent"
# How often the bar asks the window manager whether the OpenCode window is
# minimized. xprop on a local display answers in milliseconds, and asking four
# times a second would be wasteful for something the eye cannot follow.
WINDOW_CHECK_INTERVAL_MS = 1000
# Searching for the window costs one xprop per candidate window, so it is done
# on a slower beat than reading one window's state.
WINDOW_SEARCH_INTERVAL_MS = 5000
# Window geometry is another process per window, so being covered by another
# window is asked about far less often than focus is.
OCCLUSION_INTERVAL_MS = 2500
# How much of the OpenCode window another window has to cover to count as
# covering it. A notification or a small floating window is not a reason to take
# the measurement off the screen; a maximized browser is.
OCCLUSION_COVERAGE = 0.6
MAX_STACKED_WINDOWS = 12
DESKTOP_WINDOW_MATCHES = ("ai.opencode.desktop", "opencode-desktop", "opencode")


def desktop_database_path() -> Path | None:
    """Locate the Desktop app's own state database (Electron's userData path)."""
    home = Path.home()
    config_home = os.environ.get("XDG_CONFIG_HOME")
    app_data = os.environ.get("APPDATA")
    candidates = []
    if config_home:
        candidates.append(Path(config_home) / "ai.opencode.desktop" / "drafts.sqlite")
    if app_data:
        candidates.append(Path(app_data) / "ai.opencode.desktop" / "drafts.sqlite")
    candidates.append(home / ".config" / "ai.opencode.desktop" / "drafts.sqlite")
    candidates.append(home / "Library" / "Application Support" / "ai.opencode.desktop" / "drafts.sqlite")
    for candidate in candidates:
        try:
            if candidate.is_file():
                return candidate
        except OSError:
            continue
    return None


def read_desktop_session(path: Path) -> str | None:
    """Read the open tab's session id from the Desktop state database.

    Opened read-only, and only the tabs.recent row: the key is the sidecar route
    the Desktop last opened, e.g. "sidecar/server/<slug>/session/ses_...".
    """
    try:
        import sqlite3
    except ImportError:
        return None
    connection = None
    try:
        connection = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True, timeout=0.25)
        row = connection.execute("SELECT value FROM state WHERE key = ?", (DESKTOP_STATE_KEY,)).fetchone()
    except (sqlite3.Error, OSError, ValueError):
        return None
    finally:
        if connection is not None:
            connection.close()
    if not row or not isinstance(row[0], str):
        return None
    try:
        value = json.loads(row[0])
    except ValueError:
        return None
    key = value.get("key") if isinstance(value, dict) else value
    if not isinstance(key, str):
        return None
    match = SESSION_ID_PATTERN.search(key)
    return match.group(0) if match else None


class DesktopTabs:
    """Tracks the Desktop's open tab, re-reading only when the database changes."""

    def __init__(self, path: Path | None = None) -> None:
        self.override = path
        self.path: Path | None = None
        self.state_key: tuple[int, int] | None = None
        self.session: str | None = None

    @staticmethod
    def state_key_for(path: Path) -> tuple[int, int] | None:
        try:
            database_mtime = path.stat().st_mtime_ns
        except OSError:
            return None
        # The Desktop writes in WAL mode, so a tab switch lands in the -wal file
        # and the main database keeps its timestamp: both must be watched.
        try:
            wal_mtime = path.with_name(f"{path.name}-wal").stat().st_mtime_ns
        except OSError:
            wal_mtime = 0
        return (database_mtime, wal_mtime)

    def poll(self) -> str | None:
        path = self.override if self.override is not None else desktop_database_path()
        if path != self.path:
            self.path, self.state_key, self.session = path, None, None
        if path is None:
            return None
        state_key = self.state_key_for(path)
        if state_key is None:
            return None
        if state_key == self.state_key:
            return self.session
        self.state_key = state_key
        self.session = read_desktop_session(path)
        return self.session


def lerp_color(start: str, end: str, amount: float) -> str:
    """Blend two #rrggbb colours; Tk items have no alpha, so glows are faked."""
    ratio = max(0.0, min(1.0, amount))

    def channel(offset: int) -> int:
        first = int(start[1 + offset : 3 + offset], 16)
        second = int(end[1 + offset : 3 + offset], 16)
        return round(first + (second - first) * ratio)

    return f"#{channel(0):02x}{channel(2):02x}{channel(4):02x}"


def env_int(name: str, fallback: int) -> int:
    try:
        return int(os.environ.get(name, fallback))
    except (TypeError, ValueError):
        return fallback


def load_record(path: Path) -> dict[str, Any] | None:
    try:
        with path.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
        return value if isinstance(value, dict) else None
    except (FileNotFoundError, OSError, ValueError, TypeError):
        return None


class RecordCache:
    """Reads a JSON file only when the file itself changed.

    The bar polls several times a second for the whole life of the session, and
    every one of those polls used to open and parse the same handful of files.
    Stat is enough to know whether the answer can have changed, because the
    plugin writes through a temporary file and renames it into place.
    """

    def __init__(self) -> None:
        self.entries: dict[Path, tuple[tuple[int, int], dict[str, Any] | None]] = {}

    def read(self, path: Path) -> dict[str, Any] | None:
        try:
            info = path.stat()
            stamp = (info.st_mtime_ns, info.st_size)
        except OSError:
            self.entries.pop(path, None)
            return None
        cached = self.entries.get(path)
        if cached is not None and cached[0] == stamp:
            return cached[1]
        value = load_record(path)
        self.entries[path] = (stamp, value)
        return value

    def forget(self, path: Path) -> None:
        self.entries.pop(path, None)


def load_current_session(
    path: Path,
    cache: "RecordCache | None" = None,
    project: str | None = None,
) -> dict[str, Any] | None:
    record = cache.read(path) if cache is not None else load_record(path)
    if not isinstance(record, dict):
        return None
    # v2 keeps one entry per project. v1 had a single slot, so every OpenCode
    # instance on the machine overwrote the others' current session and the bar
    # showed whichever project wrote last. Read v1 too, so a bar and a plugin
    # from different versions can overlap during an update.
    if record.get("version") == 2:
        projects = record.get("projects")
        if not isinstance(projects, dict):
            return None
        if project is None:
            # No project to match and several to choose from: picking one would
            # be a guess, and a guess here is the bug this file shape fixes.
            return None
        entry = projects.get(project)
        if not isinstance(entry, dict):
            return None
        record = entry
    if record.get("available") is not True:
        return None
    observed_at = record.get("observedAt")
    if isinstance(observed_at, (int, float)) and not isinstance(observed_at, bool):
        if time.time() * 1000 - observed_at > CURRENT_SESSION_MAX_AGE_MS:
            return None
    session_id = record.get("sessionID")
    return {"sessionID": session_id} if isinstance(session_id, str) and session_id else None


def write_json_atomic(path: Path, value: Any) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True, mode=STATUS_DIR_MODE)
        temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        temporary.write_text(json.dumps(value), encoding="utf-8")
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    except OSError:
        pass


def load_saved_position(path: Path, cache: "RecordCache | None" = None) -> tuple[int, int] | None:
    record = cache.read(path) if cache is not None else load_record(path)
    if record is None:
        return None
    x = record.get("x")
    y = record.get("y")
    if isinstance(x, (int, float)) and isinstance(y, (int, float)) and not isinstance(x, bool) and not isinstance(y, bool):
        return int(x), int(y)
    return None


def clamp_scale(value: Any) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return 1.0
    return max(MIN_SCALE, min(MAX_SCALE, round(float(value), 3)))


def load_saved_scale(path: Path, cache: "RecordCache | None" = None) -> float:
    record = cache.read(path) if cache is not None else load_record(path)
    if record is None:
        return 1.0
    return clamp_scale(record.get("scale"))


def save_scale(path: Path, scale: float) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True, mode=STATUS_DIR_MODE)
        temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        temporary.write_text(json.dumps({"scale": round(float(scale), 3)}), encoding="utf-8")
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    except OSError:
        pass


def save_position(path: Path, x: int, y: int) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True, mode=STATUS_DIR_MODE)
        temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        temporary.write_text(json.dumps({"x": int(x), "y": int(y)}), encoding="utf-8")
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    except OSError:
        pass


def snapshot_rank(values: Any) -> tuple[int, float] | None:
    """How advanced one session snapshot is.

    Totals are one snapshot, not a bag of independent numbers. Ranking whole
    snapshots is what stops a reader from dividing a token count taken at one
    moment by a stream time taken at another and calling the result a
    measurement. `turns` only grows inside a session, so it leads, with the
    timestamp as the tie-break.
    """
    if not isinstance(values, dict):
        return None
    turns = values.get("turns")
    turns = int(turns) if isinstance(turns, (int, float)) and not isinstance(turns, bool) else -1
    stamp = values.get("updatedAt")
    if isinstance(stamp, str):
        try:
            from datetime import datetime

            moment = datetime.fromisoformat(stamp).timestamp() * 1000
        except ValueError:
            moment = 0.0
    elif isinstance(stamp, (int, float)) and not isinstance(stamp, bool):
        moment = float(stamp)
    else:
        moment = 0.0
    return turns, moment


def merge_totals(target: dict[str, dict[str, float]], sessions: Any) -> bool:
    """Keep the newest whole snapshot per session.

    Taking the maximum of each field separately is what used to happen here, and
    it produced totals that no session ever had: the tokens of one turn over the
    stream time of another. The displayed rate came out of a division that never
    existed, which is the one thing this bar must not print.
    """
    if not isinstance(sessions, dict):
        return False
    changed = False
    for session_id, values in sessions.items():
        if not isinstance(session_id, str) or not isinstance(values, dict):
            continue
        incoming = snapshot_rank(values)
        if incoming is None:
            continue
        current = target.get(session_id)
        placeholder = current is None
        if placeholder:
            current = {field: 0 for field in TOTAL_FIELDS}
        elif incoming <= snapshot_rank(current):
            # An older snapshot must never walk the numbers backwards, nor add
            # its fields to a newer one.
            continue
        merged: dict[str, Any] = {}
        for field in TOTAL_FIELDS:
            number = values.get(field)
            merged[field] = number if isinstance(number, (int, float)) and not isinstance(number, bool) else 0
        tokens_per_second = values.get("tokensPerSecond")
        if isinstance(tokens_per_second, (int, float)) and not isinstance(tokens_per_second, bool):
            merged["tokensPerSecond"] = tokens_per_second
        # The last-ten reading travels with the snapshot: a whole snapshot wins
        # whole, and the list of response rates is part of it.
        recent = values.get("recentRates")
        if isinstance(recent, list):
            merged["recentRates"] = [
                float(rate)
                for rate in recent
                if isinstance(rate, (int, float)) and not isinstance(rate, bool) and rate > 0
            ][-MAX_RECENT_RATES:]
        elif isinstance(current.get("recentRates"), list):
            merged["recentRates"] = current["recentRates"]
        if "updatedAt" in values:
            merged["updatedAt"] = values["updatedAt"]
        # Which project owns the session. Two OpenCode instances on one machine
        # share this file, so the bar needs to tell "no measurements yet" from
        # "these are another project's measurements".
        project = values.get("project")
        if isinstance(project, str) and project:
            merged["project"] = project
        elif isinstance(current.get("project"), str):
            merged["project"] = current["project"]
        for field in SUBAGENT_FIELDS:
            number = values.get(field)
            if isinstance(number, (int, float)) and not isinstance(number, bool):
                merged[field] = number
            elif isinstance(current.get(field), (int, float)) and not isinstance(current.get(field), bool):
                merged[field] = current[field]
        if placeholder or merged != current:
            target[session_id] = merged
            changed = True
    while len(target) > MAX_TRACKED_TOTALS:
        target.pop(next(iter(target)))
    return changed


def totals_rate(totals: dict[str, Any] | None) -> float | None:
    if not totals:
        return None
    generated = totals.get("generatedTokens", 0)
    active_ms = totals.get("activeStreamMs", 0)
    if isinstance(generated, (int, float)) and isinstance(active_ms, (int, float)) and generated > 0 and active_ms > 0:
        return generated / (active_ms / 1000)
    stored = totals.get("tokensPerSecond")
    if isinstance(stored, (int, float)) and not isinstance(stored, bool) and stored > 0:
        return float(stored)
    return None


def totals_recent_rate(totals: dict[str, Any] | None) -> float | None:
    """The mean of the last few responses, as the plugin recorded them.

    The session average is the whole session divided as one sum; this is the
    mean of the individual responses, which is what makes a slowdown you just
    watched show up while the session average is still catching up. One response
    is not an average, so it takes two to appear.
    """
    if not isinstance(totals, dict):
        return None
    rates = totals.get("recentRates")
    if not isinstance(rates, list):
        return None
    usable = [
        float(rate)
        for rate in rates
        if isinstance(rate, (int, float)) and not isinstance(rate, bool) and rate > 0
    ]
    if len(usable) < 2:
        return None
    return sum(usable) / len(usable)


def format_tps(value: Any) -> str:
    if value is None:
        return "–"
    try:
        rate = float(value)
    except (TypeError, ValueError):
        return "–"
    if rate <= 0:
        return "–"
    # Four characters at most: the bar has one line, and a five digit number
    # would push the last-ten reading off the card. "4.7k" says the same thing.
    if rate >= 1000:
        short = f"{rate / 1000:.1f}".rstrip("0").rstrip(".")
        return f"{short}k"
    if rate >= 100:
        return f"{rate:.0f}"
    if rate >= 10:
        return f"{rate:.1f}".rstrip("0").rstrip(".")
    return f"{rate:.2f}".rstrip("0").rstrip(".")


def format_count(value: Any) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return 0
    return max(0, number)


def build_token(script: Path | None = None) -> float:
    """mtime of this script in milliseconds: a change means the owner must be replaced."""
    try:
        return round((script or Path(__file__)).resolve().stat().st_mtime * 1000)
    except OSError:
        return 0.0


def _win_pid_is_alive(pid: int) -> bool:
    """Windows liveness, never via os.kill.

    CPython documents that on Windows any signal other than CTRL_C_EVENT or
    CTRL_BREAK_EVENT is passed to TerminateProcess, so the usual
    os.kill(pid, 0) existence check would kill the very process it asks about —
    including the OpenCode process this bar belongs to. OpenProcess plus
    GetExitCodeProcess asks instead of acting.
    """
    import ctypes
    from ctypes import wintypes

    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    SYNCHRONIZE = 0x00100000
    STILL_ACTIVE = 259
    ERROR_ACCESS_DENIED = 5
    ERROR_INVALID_PARAMETER = 87

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, False, int(pid))
    if not handle:
        code = ctypes.get_last_error()
        if code == ERROR_ACCESS_DENIED:
            return True  # It exists; it is just not ours to inspect.
        if code == ERROR_INVALID_PARAMETER:
            return False
        return True  # Unknown means alive: a bar is never hidden by a failed check.
    try:
        status = wintypes.DWORD()
        if kernel32.GetExitCodeProcess(handle, ctypes.byref(status)):
            return status.value == STILL_ACTIVE
        return True
    finally:
        kernel32.CloseHandle(handle)


def pid_is_alive(pid: int, platform: str | None = None) -> bool:
    if pid <= 0:
        return False
    system = platform if platform is not None else ("nt" if os.name == "nt" else "posix")
    if system == "nt":
        return _win_pid_is_alive(pid)
    # A zombie still answers kill(pid, 0); treat it as gone.
    try:
        stat = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8", errors="replace")
        closing = stat.rfind(")")
        if closing != -1 and stat[closing + 2: closing + 3] == "Z":
            return False
    except OSError:
        pass
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def process_is_bar(pid: int) -> bool:
    """True only when the pid runs bar.py, so a recycled pid is never signalled."""
    if not pid_is_alive(pid):
        return False
    if sys.platform.startswith("linux"):
        try:
            command = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8", "replace")
        except OSError:
            return False
        return "bar.py" in command
    if sys.platform == "darwin":
        try:
            probe = subprocess.run(
                ["ps", "-p", str(pid), "-o", "command="],
                capture_output=True, text=True, timeout=3,
            )
        except (OSError, subprocess.SubprocessError):
            return False
        return "bar.py" in (probe.stdout or "")
    # Windows cannot be asked cheaply, and this pid came from our own lock file.
    return True


def parse_window_list(text: str) -> list[str]:
    return re.findall(r"0x[0-9a-fA-F]+", text or "")


def normalize_window_id(value: Any) -> str | None:
    """A window id in one spelling, or None. xprop prints them lower case."""
    if not isinstance(value, str):
        return None
    match = re.search(r"0x[0-9a-fA-F]+", value)
    return match.group(0).lower() if match else None


def window_is_hidden(state: str) -> bool:
    return "_NET_WM_STATE_HIDDEN" in (state or "")


def parse_xwininfo(text: str) -> tuple[int, int, int, int] | None:
    """The absolute rectangle out of xwininfo's report, or None.

    Absolute coordinates matter: comparing two windows' own top-left corners
    would compare each one's corner inside its own frame, not on the screen.
    """
    values = {}
    for line in (text or "").splitlines():
        if ":" not in line:
            continue
        label, _, raw = line.partition(":")
        label = label.strip().lower()
        if label == "absolute upper-left x":
            values["x"] = raw.strip()
        elif label == "absolute upper-left y":
            values["y"] = raw.strip()
        elif label == "width":
            values["width"] = raw.strip()
        elif label == "height":
            values["height"] = raw.strip()
    try:
        x, y, width, height = (int(values[key]) for key in ("x", "y", "width", "height"))
    except (KeyError, ValueError):
        return None
    if width <= 0 or height <= 0:
        return None
    return x, y, width, height


def covered_fraction(cover: tuple[int, int, int, int], target: tuple[int, int, int, int]) -> float:
    """How much of `target` lies inside `cover`, from 0.0 to 1.0."""
    left = max(cover[0], target[0])
    top = max(cover[1], target[1])
    right = min(cover[0] + cover[2], target[0] + target[2])
    bottom = min(cover[1] + cover[3], target[1] + target[3])
    if right <= left or bottom <= top:
        return 0.0
    return ((right - left) * (bottom - top)) / float(target[2] * target[3])


def env_flag(name: str, default: bool = True) -> bool:
    """A switch the user can turn off with 0/false/no, on with 1/true/yes."""
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() not in ("0", "false", "no", "off")


class DesktopWindow:
    """What the OpenCode window is doing right now: minimized, focused, covered.

    Linux and X11 only, and only through xprop and xwininfo. When a question
    cannot be answered — no display, another platform, the tools missing — the
    answer is None and the bar stays visible: hiding a measurement is worse than
    showing one too long.
    """

    def __init__(
        self,
        probe=None,
        patterns=DESKTOP_WINDOW_MATCHES,
        interval_ms=WINDOW_CHECK_INTERVAL_MS,
        geometry=None,
        own_window_id: str | None = None,
        own_title: str | None = None,
        hide_unfocused: bool = True,
        hide_occluded: bool = True,
    ) -> None:
        self.probe = probe or self._xprop
        self.geometry_probe = geometry or self._xwininfo
        self.patterns = patterns
        self.interval_ms = interval_ms
        self.supported = sys.platform.startswith("linux") and bool(os.environ.get("DISPLAY"))
        self.hide_unfocused = hide_unfocused
        self.hide_occluded = hide_occluded
        # The bar's own window, so clicking or dragging it is not mistaken for
        # having moved to another application. Two ids, because Tk's `winfo_id`
        # names the child it draws in while the window manager tracks the parent
        # — and it is the parent that `_NET_ACTIVE_WINDOW` reports when the bar
        # has just been clicked. The parent is found by title, once.
        self.own_window_id = normalize_window_id(own_window_id)
        self.own_client_id: str | None = None
        self.own_title = own_title
        self.own_searched_at = -float("inf")
        self.hidden: bool | None = None
        self.focused: bool | None = None
        self.occluded: bool | None = None
        self.window_id: str | None = None
        self.windows: list[str] = []
        # None on purpose: the first look must always happen, including for a
        # window that is not there yet.
        self.checked_at: float = -float("inf")
        self.occlusion_checked_at: float = -float("inf")
        # A window id whose class was already read once will not change class
        # while it lives, so remembering the answer is what keeps this from
        # spawning one xprop per window per second for the whole session.
        self.rejected: set[str] = set()

    @staticmethod
    def _xprop(args: list[str]) -> str | None:
        try:
            result = subprocess.run(["xprop", *args], capture_output=True, text=True, timeout=2)
        except (OSError, subprocess.SubprocessError):
            return None
        return result.stdout if result.returncode == 0 else None

    @staticmethod
    def _xwininfo(window: str) -> tuple[int, int, int, int] | None:
        """The window's absolute rectangle, or None when it cannot be read."""
        try:
            result = subprocess.run(["xwininfo", "-id", window], capture_output=True, text=True, timeout=2)
        except (OSError, subprocess.SubprocessError):
            return None
        if result.returncode != 0:
            return None
        return parse_xwininfo(result.stdout or "")

    def poll(self, now_ms: float | None = None) -> bool | None:
        stamp = time.time() * 1000 if now_ms is None else now_ms
        if not self.supported:
            return None
        # Once the window is known, a second is often enough for the eye. While
        # it is still unknown the search costs a process per candidate window, so
        # it runs far less often — an absent window must not cost anything.
        interval = self.interval_ms if self.window_id else WINDOW_SEARCH_INTERVAL_MS
        if stamp - self.checked_at < interval:
            return self.hidden
        self.checked_at = stamp
        self.hidden = self._read()
        self.focused = self._read_focus()
        # Covered-by-another-window only matters while the app has focus: the
        # moment focus leaves, the bar is already gone. Asking the window server
        # for geometry is the expensive question, so it is only asked there, and
        # on its own slower beat.
        if self.hide_occluded and self.focused is True:
            if stamp - self.occlusion_checked_at >= OCCLUSION_INTERVAL_MS:
                self.occlusion_checked_at = stamp
                self.occluded = self._read_occluded()
        else:
            self.occluded = False
        return self.hidden

    def should_hide(self) -> bool | None:
        """Hide when minimized, unfocused or covered. None means "cannot tell"."""
        if self.window_id is None:
            # No OpenCode window on this display at all: a CLI or TUI session,
            # or the app is not open. There is no window to follow, and the bar
            # belongs to whatever terminal the user is working in.
            return self.hidden if self.hidden is not None else None
        if self.hidden is True or (self.hide_unfocused and self.focused is False):
            return True
        if self.hide_occluded and self.occluded is True:
            return True
        if self.hidden is None and self.focused is None and self.occluded is None:
            return None
        return False

    def _read(self) -> bool | None:
        listing = self.probe(["-root", "_NET_CLIENT_LIST"])
        if listing is None:
            return None
        windows = parse_window_list(listing)
        self.windows = windows
        self._resolve_own_window(windows)
        matches = self._find_windows(windows)
        if self.window_id not in matches:
            self.window_id = matches[0] if matches else None
        if self.window_id is None:
            return None
        state = self.probe(["-id", self.window_id, "_NET_WM_STATE"])
        if state is None:
            return None
        return window_is_hidden(state)

    def is_own_window(self, window: str) -> bool:
        lowered = (window or "").lower()
        return lowered in {value for value in (self.own_window_id, self.own_client_id) if value}

    def _resolve_own_window(self, windows: list[str]) -> None:
        """Find the window manager's window for this bar, once.

        Tk's `winfo_id` is the child Tk draws in. The window the manager tracks —
        the one `_NET_ACTIVE_WINDOW` names the moment the user clicks the bar —
        is a different id, its parent. Matching them by title costs one xprop per
        window, once, and is what stops a click on the bar from looking like the
        user moved to another application.
        """
        if self.own_client_id is not None or not self.own_title:
            return
        if self.checked_at - self.own_searched_at < WINDOW_SEARCH_INTERVAL_MS:
            return
        self.own_searched_at = self.checked_at
        for window in windows:
            if self.is_own_window(window):
                continue
            name = self.probe(["-id", window, "_NET_WM_NAME"])
            if name and self.own_title in name:
                self.own_client_id = window.lower()
                return

    def _read_focus(self) -> bool | None:
        if not self.hide_unfocused:
            return None
        listing = self.probe(["-root", "_NET_ACTIVE_WINDOW"])
        if listing is None:
            return None
        active = parse_window_list(listing)
        if not active:
            return None
        focused_window = active[0].lower()
        if focused_window in ("0x0", "0x00"):
            # Nothing is focused (the desktop itself is showing). That is not a
            # reason to hide anything.
            return None
        if self.is_own_window(focused_window):
            return True
        if self.window_id and focused_window == self.window_id.lower():
            return True
        if any(focused_window == window.lower() for window in self._find_windows(self.windows)):
            return True
        # A dialog or popup of the app is a different window id with the app's
        # class, and focus is still where the user is working.
        classes = self.probe(["-id", focused_window, "WM_CLASS"])
        if classes is None:
            return None
        return self._matches_class(classes)

    def _read_occluded(self) -> bool | None:
        if self.window_id is None:
            return None
        stacking = self.probe(["-root", "_NET_CLIENT_LIST_STACKING"])
        if stacking is None:
            return None
        windows = parse_window_list(stacking)
        if self.window_id not in windows:
            return None
        target = self.geometry_probe(self.window_id)
        if target is None:
            return None
        above = windows[windows.index(self.window_id) + 1:]
        for window in reversed(above[-MAX_STACKED_WINDOWS:]):
            if self.is_own_window(window):
                continue
            state = self.probe(["-id", window, "_NET_WM_STATE"])
            if state is not None and window_is_hidden(state):
                continue
            rectangle = self.geometry_probe(window)
            if rectangle is None:
                continue
            # The topmost window that is visible and above ours decides it. A
            # notification in a corner does not cover the app; a browser does.
            return covered_fraction(rectangle, target) >= OCCLUSION_COVERAGE
        return False

    def _matches_class(self, classes: str) -> bool:
        lowered = classes.lower()
        return any(pattern.lower() in lowered for pattern in self.patterns)

    def _find_windows(self, windows: list[str]) -> list[str]:
        matches = []
        for window in windows:
            if window in self.rejected:
                continue
            classes = self.probe(["-id", window, "WM_CLASS"])
            if classes is None:
                continue
            if self._matches_class(classes):
                matches.append(window)
            elif len(self.rejected) < 256:
                self.rejected.add(window)
        return matches


def read_lock_holder(path: Path) -> dict[str, Any] | None:
    record = load_record(path)
    if record is None:
        raw = None
        try:
            raw = path.read_text(encoding="utf-8").strip()
        except OSError:
            return None
        if not raw:
            return None
        try:
            return {"pid": int(raw), "build": 0.0}
        except ValueError:
            return None
    try:
        return {"pid": int(record.get("pid", 0)), "build": float(record.get("build", 0.0))}
    except (TypeError, ValueError):
        return None


def acquire_instance(path: Path, build: float) -> bool:
    """Cross-platform singleton: replace a live older revision, else exit."""
    for _attempt in range(LOCK_ATTEMPTS):
        try:
            descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            holder = read_lock_holder(path)
            holder_pid = int(holder.get("pid", 0)) if holder else 0
            if holder and pid_is_alive(holder_pid):
                if holder.get("build") != build:
                    if process_is_bar(holder_pid):
                        try:
                            os.kill(holder_pid, signal.SIGTERM)
                        except OSError:
                            pass
                    else:
                        # A recycled pid in a stale lock: leave that process
                        # alone and take the lock back.
                        try:
                            path.unlink()
                        except OSError:
                            pass
                        continue
                time.sleep(LOCK_DELAY_SECONDS)
                continue
            try:
                path.unlink()
            except OSError:
                pass
            continue
        except OSError:
            return False
        try:
            os.write(descriptor, json.dumps({"pid": os.getpid(), "build": build}).encode("utf-8"))
        finally:
            os.close(descriptor)
        return True
    return False


def release_instance(path: Path) -> None:
    holder = read_lock_holder(path)
    if holder and int(holder.get("pid", 0)) == os.getpid():
        try:
            path.unlink()
        except OSError:
            pass


class Bar:
    def __init__(
        self,
        status_file: Path,
        current_session_file: Path,
        totals_file: Path,
        best_totals_file: Path,
        position_file: Path,
        parent_pid: int = 0,
        desktop_database: Path | None = None,
        version_file: Path | None = None,
        scale_file: Path | None = None,
        window_probe=None,
        project: str | None = None,
    ) -> None:
        self.status_file = status_file
        self.current_session_file = current_session_file
        self.totals_file = totals_file
        self.best_totals_file = best_totals_file
        self.position_file = position_file
        self.version_file = version_file or DEFAULT_VERSION_FILE
        self.scale_file = scale_file or DEFAULT_SCALE_FILE
        self.parent_pid = parent_pid
        # The project this bar was spawned for. Several OpenCode instances share
        # one totals file and one screen, so the bar names its project rather
        # than assuming whichever session wrote last is the one on screen.
        self.project = project or None
        self.desktop_tabs = DesktopTabs(desktop_database)
        self.desktop_window = DesktopWindow(
            probe=window_probe,
            hide_unfocused=env_flag("OPENCODE_LATENCY_HIDE_UNFOCUSED"),
            hide_occluded=env_flag("OPENCODE_LATENCY_HIDE_OCCLUDED"),
        )
        self.withdrawn = False
        self.notice_shown: tuple[str, int] | None = None
        self.notice_started_at = 0.0
        self.stopping = False
        # The user's own collapse, not the window manager's minimize. Two
        # different things that used to share one name and one flag.
        self.collapsed = False
        self.cache = RecordCache()
        self.poll_count = 0
        self.render_key: tuple[str, int, int, float | None] | None = None
        self.last_id: str | None = None
        self.current_session_id: str | None = None
        self.last_record_session_id: str | None = None
        self.best_totals: dict[str, dict[str, float]] = {}
        loaded = load_record(best_totals_file)
        if loaded is not None:
            merge_totals(self.best_totals, loaded.get("sessions"))

        self.saved_position = load_saved_position(position_file, self.cache)
        self.user_positioned = self.saved_position is not None
        self.drag_active = False
        self.drag_moved = False
        self.drag_origin: tuple[int, int] | None = None
        self.drag_window_origin: tuple[int, int] | None = None
        self.drag_position: tuple[int, int] | None = None
        self.suppress_click = False
        # The size the user chose. Drag the bottom-right grip, or hold Ctrl and
        # use the wheel, and it is remembered like the position is.
        self.scale = load_saved_scale(self.scale_file, self.cache)
        try:
            requested_scale = float(os.environ.get("OPENCODE_LATENCY_SCALE", ""))
        except ValueError:
            requested_scale = 0.0
        if requested_scale > 0:
            # An explicit environment value wins over the remembered size, so a
            # startup script can pin it.
            self.scale = clamp_scale(requested_scale)
        self.resize_active = False
        self.grip_hover = False

        self.root = tk.Tk()
        self.root.title("OpenCode Vitals")
        self.managed = False
        if sys.platform.startswith("linux"):
            # An override-redirect window is unmanaged, so mutter stacks normal
            # windows above it. A managed window honours -topmost, but only the
            # types below come back without a titlebar (measured: utility and
            # dialog are decorated, toolbar/splash/dock are not).
            for window_type in ("toolbar", "splash", "dock"):
                try:
                    self.root.attributes("-type", window_type)
                    self.managed = True
                    break
                except tk.TclError:
                    continue
        if not self.managed:
            self.root.overrideredirect(True)
        try:
            self.root.attributes("-topmost", True)
        except tk.TclError:
            pass
        try:
            self.root.attributes("-alpha", 0.96)
        except tk.TclError:
            pass
        self.root.configure(bg=WINDOW_BG)

        family = self.pick_font(self.root)
        self.family = family
        self.font_value = tkfont.Font(family=family, size=12, weight="bold")
        self.font_unit = tkfont.Font(family=family, size=9)
        self.font_mini_caption = tkfont.Font(family=family, size=7, weight="bold")
        self.font_mini_value = tkfont.Font(family=family, size=14, weight="bold")
        self.make_fonts()
        self.close_hover = False

        self.width, self.height = self.scaled_size()
        self.canvas = tk.Canvas(self.root, width=self.width, height=self.height, highlightthickness=0, bg=WINDOW_BG)
        self.canvas.pack(fill="both", expand=True)
        # The bar is its own window: having focus on it must not read as having
        # moved to another application.
        try:
            self.desktop_window.own_window_id = f"0x{self.root.winfo_id():x}"
            self.desktop_window.own_title = self.root.title()
        except tk.TclError:
            self.desktop_window.own_window_id = None
            self.desktop_window.own_title = None
        self.bind_events()
        self.apply_geometry()

        self.root.after(POLL_MS, self.poll)

    def px(self, value: float) -> float:
        """A length in the drawing code, at the size the user chose."""
        return value * self.scale

    def scaled_size(self) -> tuple[int, int]:
        base_width, base_height = (MINI_WIDTH, MINI_HEIGHT) if self.collapsed else (NORMAL_WIDTH, NORMAL_HEIGHT)
        return round(base_width * self.scale), round(base_height * self.scale)

    def make_fonts(self) -> None:
        """Re-create the fonts for the current size.

        Tk fonts cannot be resized in place without every widget that uses them
        hearing about it, and this window is one canvas, so making them again is
        the honest way to scale the text with the card.
        """
        def size(points: float, floor: int = 4) -> int:
            return max(floor, round(points * self.scale))

        self.font_value.configure(size=size(12, 7))
        self.font_unit.configure(size=size(9, 5))
        self.font_mini_caption.configure(size=size(7))
        self.font_mini_value.configure(size=size(14, 8))

    def set_scale(self, scale: float, persist: bool = True) -> None:
        value = clamp_scale(scale)
        if value == self.scale:
            return
        self.scale = value
        self.make_fonts()
        self.width, self.height = self.scaled_size()
        self.render_key = None
        self.apply_geometry()
        self.render_totals(force=True)
        if persist:
            save_scale(self.scale_file, self.scale)

    @staticmethod
    def pick_font(widget: tk.Misc) -> str:
        try:
            families = set(tkfont.families(widget))
        except tk.TclError:
            return FONT_CANDIDATES[-1]
        for candidate in FONT_CANDIDATES:
            if candidate in families:
                return candidate
        return FONT_CANDIDATES[-1]

    def bind_events(self) -> None:
        self.canvas.bind("<ButtonPress-1>", self.on_press)
        self.canvas.bind("<B1-Motion>", self.on_motion)
        self.canvas.bind("<ButtonRelease-1>", self.on_release)
        self.canvas.bind("<Motion>", self.on_hover)
        self.canvas.bind("<Leave>", self.on_hover_leave)
        # Ctrl + wheel resizes. Tk reports the wheel as buttons 4 and 5 on X11
        # and as <MouseWheel> elsewhere, and asks for the control modifier in the
        # event name, so both spellings are bound.
        for sequence, delta in (
            ("<Control-Button-4>", 1),
            ("<Control-Button-5>", -1),
            ("<Control-MouseWheel>", 0),
        ):
            self.canvas.bind(sequence, lambda event, step=delta: self.on_wheel(event, step))
        self.canvas.bind("<ButtonPress-3>", self.on_right_press)

    def grip_zone(self) -> tuple[float, float]:
        return self.width - self.px(GRIP_SIZE), self.height - self.px(GRIP_SIZE)

    def on_wheel(self, event: tk.Event, step: int) -> None:
        if step == 0:
            step = 1 if getattr(event, "delta", 0) > 0 else -1
        self.set_scale(self.scale + step * SCALE_STEP)

    def on_right_press(self, _event: tk.Event) -> None:
        """Right-click resets the size, the way a browser resets zoom."""
        self.set_scale(1.0)

    def on_hover(self, event: tk.Event) -> None:
        hovering = (not self.collapsed) and event.x >= self.width - self.px(CLOSE_ZONE)
        if hovering != self.close_hover:
            self.close_hover = hovering
            self.render_totals(force=True)
        grip_x, grip_y = self.grip_zone()
        on_grip = event.x >= grip_x and event.y >= grip_y
        if on_grip != self.grip_hover:
            self.grip_hover = on_grip
            try:
                self.canvas.configure(cursor="size_nw_se" if on_grip else "")
            except tk.TclError:
                pass
            self.render_totals(force=True)

    def on_hover_leave(self, _event: tk.Event) -> None:
        if self.grip_hover:
            self.grip_hover = False
            try:
                self.canvas.configure(cursor="")
            except tk.TclError:
                pass
            self.render_totals(force=True)
        if self.close_hover:
            self.close_hover = False
            self.render_totals(force=True)

    def apply_geometry(self) -> None:
        self.canvas.configure(width=self.width, height=self.height)
        screen_width = self.root.winfo_screenwidth()
        screen_height = self.root.winfo_screenheight()
        if self.user_positioned and self.saved_position is not None:
            x, y = self.saved_position
        else:
            position = os.environ.get("OPENCODE_LATENCY_POSITION", "top-right")
            margin = 16
            positions = {
                "top-right": (screen_width - self.width - margin, margin),
                "top-left": (margin, margin),
                "bottom-right": (screen_width - self.width - margin, screen_height - self.height - margin - 48),
                "bottom-left": (margin, screen_height - self.height - margin - 48),
            }
            x, y = positions.get(position, positions["top-right"])
        x = max(0, min(int(x), max(0, screen_width - self.width)))
        y = max(0, min(int(y), max(0, screen_height - self.height)))
        self.root.geometry(f"{self.width}x{self.height}+{x}+{y}")

    def set_collapsed(self, collapsed: bool) -> None:
        self.collapsed = bool(collapsed)
        self.width, self.height = self.scaled_size()
        self.render_key = None
        self.apply_geometry()
        self.render_totals(force=True)

    # -- drawing -----------------------------------------------------------------
    def draw_card(self, x1: float, y1: float, x2: float, y2: float, radius: float) -> None:
        mid_x = (x1 + x2) / 2
        mid_y = (y1 + y2) / 2
        points = [
            x1 + radius, y1, mid_x, y1, x2 - radius, y1, x2, y1,
            x2, y1 + radius, x2, mid_y, x2, y2 - radius, x2, y2,
            x2 - radius, y2, mid_x, y2, x1 + radius, y2, x1, y2,
            x1, y2 - radius, x1, mid_y, x1, y1 + radius, x1, y1,
        ]
        self.canvas.create_polygon(points, smooth=True, splinesteps=24, fill=CARD_BG, outline=CARD_BORDER, width=1)
        # A one pixel light edge along the top reads as a lit surface and is what
        # separates the card from whatever is behind it.
        self.canvas.create_line(
            x1 + radius * 0.75, y1 + 1.2, x2 - radius * 0.75, y1 + 1.2,
            fill=CARD_HIGHLIGHT, width=1, capstyle="round",
        )

    def gauge_point(self, center_x: float, center_y: float, radius: float, fraction: float) -> tuple[float, float]:
        angle = math.radians(GAUGE_START_DEGREES - GAUGE_SWEEP_DEGREES * max(0.0, min(1.0, fraction)))
        return center_x + radius * math.cos(angle), center_y - radius * math.sin(angle)

    def draw_gauge(self, center_x: float, center_y: float, rate: float | None) -> None:
        radius = self.px(9.0)
        fraction = 0.0 if not rate else max(0.0, min(1.0, rate / GAUGE_FULL_SCALE_TPS))
        box = (center_x - radius, center_y - radius, center_x + radius, center_y + radius)

        if rate:
            # Tk has no per item alpha, so the glow is a few rings that step a
            # little closer to the accent colour towards the dial. More than
            # three reads as concentric rings rather than a glow.
            for step in range(3, 0, -1):
                halo = lerp_color(CARD_BG, ACCENT_COLOR, 0.035 + 0.02 * (3 - step))
                halo_radius = radius + self.px(2.1) * step
                self.canvas.create_oval(
                    center_x - halo_radius, center_y - halo_radius,
                    center_x + halo_radius, center_y + halo_radius,
                    outline=halo, width=1,
                )

        self.canvas.create_arc(*box, start=GAUGE_START_DEGREES, extent=-GAUGE_SWEEP_DEGREES, style="arc", outline=GAUGE_TRACK, width=max(1, round(self.px(3))))
        for tick in (0.0, 0.25, 0.5, 0.75, 1.0):
            tick_x, tick_y = self.gauge_point(center_x, center_y, radius + self.px(3.6), tick)
            dot = self.px(0.7)
            self.canvas.create_oval(tick_x - dot, tick_y - dot, tick_x + dot, tick_y + dot, fill=GAUGE_TICK, outline=GAUGE_TICK)

        if rate:
            self.canvas.create_arc(*box, start=GAUGE_START_DEGREES, extent=-GAUGE_SWEEP_DEGREES * fraction, style="arc", outline=ACCENT_COLOR, width=max(1, round(self.px(3))))
            cap = self.px(1.5)
            for end in (0.0, fraction):
                cap_x, cap_y = self.gauge_point(center_x, center_y, radius, end)
                self.canvas.create_oval(cap_x - cap, cap_y - cap, cap_x + cap, cap_y + cap, fill=ACCENT_COLOR, outline=ACCENT_COLOR)
            needle_x, needle_y = self.gauge_point(center_x, center_y, radius - self.px(2.0), fraction)
            self.canvas.create_line(center_x, center_y, needle_x, needle_y, fill=GAUGE_NEEDLE, width=max(1, round(self.px(1.4))), capstyle="round")

        hub_outer = self.px(2.8)
        self.canvas.create_oval(center_x - hub_outer, center_y - hub_outer, center_x + hub_outer, center_y + hub_outer, fill=CARD_BG, outline=CARD_BORDER)
        hub = ACCENT_COLOR if rate else GAUGE_TICK
        hub_inner = self.px(1.2)
        self.canvas.create_oval(center_x - hub_inner, center_y - hub_inner, center_x + hub_inner, center_y + hub_inner, fill=hub, outline="")

    def draw_text(self, x: float, y: float, text: str, font: tkfont.Font, fill: str, anchor: str = "w") -> None:
        self.canvas.create_text(x, y, text=text, font=font, fill=fill, anchor=anchor)

    def segments_width(self, segments: list[tuple[str, tkfont.Font, str, int]]) -> float:
        return sum(font.measure(text) + gap for text, font, _color, gap in segments)

    def draw_segments(self, x: float, y: float, segments: list[tuple[str, tkfont.Font, str, int]]) -> float:
        cursor = x
        for text, font, color, gap in segments:
            self.draw_text(cursor, y, text, font, color)
            cursor += font.measure(text) + gap
        return cursor

    def draw_close_button(self) -> None:
        center_x = self.width - self.px(15)
        center_y = self.height / 2
        radius = self.px(8.0)
        outline = ACCENT_COLOR if self.close_hover else CARD_BORDER
        glyph = "#dbe6f5" if self.close_hover else MUTED_COLOR
        self.canvas.create_oval(center_x - radius, center_y - radius, center_x + radius, center_y + radius, outline=outline, width=1)
        arm = self.px(3.4)
        width = max(1, round(self.px(1.5)))
        self.canvas.create_line(center_x - arm, center_y - arm, center_x + arm, center_y + arm, fill=glyph, width=width, capstyle="round")
        self.canvas.create_line(center_x - arm, center_y + arm, center_x + arm, center_y - arm, fill=glyph, width=width, capstyle="round")

    def draw_resize_grip(self) -> None:
        """Two short strokes in the corner: the shape everyone reads as 'drag me'."""
        x, y = self.grip_zone()
        color = ACCENT_COLOR if self.grip_hover else GAUGE_TICK
        width = max(1, round(self.px(1.4)))
        for offset in (self.px(4.0), self.px(8.0)):
            self.canvas.create_line(
                self.width - offset, self.height - self.px(3.0),
                self.width - self.px(3.0), self.height - offset,
                fill=color, width=width, capstyle="round",
            )

    def draw_update_badge(self, version: str) -> None:
        label = f"{version} installed"
        width = self.font_value.measure(label) + self.px(40)
        x1 = (self.width - width) / 2
        y1 = self.height / 2 - self.px(12)
        x2 = x1 + width
        y2 = y1 + self.px(24)
        self.draw_card(x1, y1, x2, y2, self.px(12))
        self.canvas.create_rectangle(x1 + 1.5, y1 + 1.5, x2 - 1.5, y2 - 1.5, fill=lerp_color(CARD_BG, ACCENT_COLOR, 0.10), outline="")
        tick_x = x1 + self.px(15)
        tick_y = self.height / 2
        width = max(1, round(self.px(1.6)))
        self.canvas.create_line(tick_x - self.px(3.6), tick_y + 0.2, tick_x - self.px(0.9), tick_y + self.px(3), fill=ACCENT_COLOR, width=width, capstyle="round")
        self.canvas.create_line(tick_x - self.px(0.9), tick_y + self.px(3), tick_x + self.px(4), tick_y - self.px(3.4), fill=ACCENT_COLOR, width=width, capstyle="round")
        self.draw_text(x1 + self.px(26), tick_y, label, self.font_value, ACCENT_COLOR)

    def resolve_session(self) -> str | None:
        """The one session this bar is allowed to show, or None.

        Every source below is a fact about a session the person is looking at.
        When none of them can name one, the answer is None and the bar says it
        has nothing to show — it never borrows another session's numbers, which
        is what made a fresh session display somebody else's totals.
        """
        # The Desktop knows which tab is open, and publishes nothing when a tab
        # is opened, so events alone stay frozen on the last session typed into.
        tab = self.desktop_tabs.poll()
        if isinstance(tab, str) and tab:
            return tab
        current = load_current_session(self.current_session_file, self.cache, self.project)
        event_session = current.get("sessionID") if current else None
        if isinstance(event_session, str) and event_session:
            return event_session
        # No current session published. Fall back to the most recently measured
        # one, but only inside this bar's own project — or, with no project to
        # match on, only when there is exactly one candidate and so no choice.
        candidates = [
            (session_id, values)
            for session_id, values in self.best_totals.items()
            if isinstance(values, dict) and (values.get("turns") or 0) > 0
        ]
        if self.project:
            candidates = [entry for entry in candidates if entry[1].get("project") == self.project]
        if len(candidates) == 1:
            return candidates[0][0]
        if candidates and self.project:
            newest = max(candidates, key=lambda entry: str(entry[1].get("updatedAt") or ""))
            return newest[0]
        return None

    def render_totals(self, force: bool = False) -> None:
        session_id = self.current_session_id
        totals = self.best_totals.get(session_id) if session_id else None
        if totals is None:
            # Nothing measured for the session on screen. Saying so is the point:
            # a number from another session here is worse than no number.
            self.render_empty()
            return
        turns = format_count(totals.get("turns"))
        steps = format_count(totals.get("steps"))
        rate = totals_rate(totals)
        recent = totals_recent_rate(totals)
        notice = self.active_update_notice()
        key = (
            session_id or "", turns, steps, rate,
            round(recent, 1) if recent is not None else None,
            totals.get("subagentSteps"),
            notice[0] if notice else None,
            self.close_hover, self.grip_hover, round(self.scale, 3), self.collapsed,
        )
        if not force and key == self.render_key:
            return
        self.render_key = key
        self.canvas.delete("all")
        center_y = self.height / 2
        inset = self.px(2)

        if self.collapsed:
            self.draw_card(inset, inset, self.width - inset - 1, self.height - inset - 1, self.px(15))
            if notice is not None:
                self.draw_text(self.width / 2, self.px(20), "UPDATED", self.font_mini_caption, MUTED_COLOR, anchor="center")
                self.draw_text(self.width / 2, self.px(41), notice[0], self.font_mini_value, ACCENT_COLOR, anchor="center")
                return
            self.draw_text(self.width / 2, self.px(21), "TOK/S", self.font_mini_caption, DIM_COLOR, anchor="center")
            self.draw_text(self.width / 2, self.px(43), format_tps(rate), self.font_mini_value, ACCENT_COLOR, anchor="center")
            return

        self.draw_card(inset, inset, self.width - inset - 1, self.height - inset - 1, self.px(14))
        self.draw_close_button()
        if notice is not None:
            self.draw_update_badge(notice[0])
            return

        self.draw_resize_grip()
        segments = [
            (str(turns), self.font_value, TEXT_COLOR, self.px(3)),
            ("turn" if turns == 1 else "turns", self.font_unit, MUTED_COLOR, self.px(14)),
            (str(steps), self.font_value, TEXT_COLOR, self.px(3)),
            ("step" if steps == 1 else "steps", self.font_unit, MUTED_COLOR, self.px(18)),
            (format_tps(rate), self.font_value, ACCENT_COLOR, self.px(3)),
            ("tok/s", self.font_unit, MUTED_COLOR, self.px(14) if recent is not None else 0),
        ]
        # The last-ten reading sits beside the session average it must not be
        # mistaken for: same line, its own separator, its own tint, and a label
        # that says what it averages. It is the mean rate of the last ten
        # *responses*, not of the last ten steps — steps inside one response are
        # not ten separate replies and averaging them answers nothing.
        if recent is not None:
            segments += [
                ("·", self.font_unit, DIM_COLOR, self.px(6)),
                (format_tps(recent), self.font_value, ACCENT_COLOR, self.px(3)),
                ("last10 resp", self.font_unit, MUTED_COLOR, 0),
            ]
        # Subagent work is counted inside this session's steps and tokens — a
        # subagent runs as a child session, so its steps are this session's work.
        # It gets no segment of its own: the card is sized for the metrics line,
        # and the count lives in the record and the README instead.
        gauge_width = self.px(28.0)
        gap = self.px(13.0)
        total_width = gauge_width + gap + self.segments_width(segments)
        start_x = max(self.px(20), (self.width - total_width) / 2)
        self.draw_gauge(start_x + self.px(11), center_y, rate)
        self.draw_segments(start_x + gauge_width + gap, center_y, segments)

    def render_empty(self, force: bool = False) -> None:
        """Nothing measured for the session on screen. Name the reason, guess nothing."""
        key = ("empty", self.close_hover, self.grip_hover, round(self.scale, 3), self.collapsed)
        if not force and key == self.render_key:
            return
        self.render_key = key
        self.canvas.delete("all")
        center_y = self.height / 2
        inset = self.px(2)
        if self.collapsed:
            self.draw_card(inset, inset, self.width - inset - 1, self.height - inset - 1, self.px(15))
            self.draw_text(self.width / 2, self.px(21), "TOK/S", self.font_mini_caption, DIM_COLOR, anchor="center")
            self.draw_text(self.width / 2, self.px(43), "—", self.font_mini_value, DIM_COLOR, anchor="center")
            return
        self.draw_card(inset, inset, self.width - inset - 1, self.height - inset - 1, self.px(14))
        self.draw_close_button()
        self.draw_resize_grip()
        self.draw_gauge(self.px(31), center_y, None)
        segments = [("waiting for a response", self.font_unit, MUTED_COLOR, 0)]
        if self.project:
            segments.append(("·", self.font_unit, DIM_COLOR, self.px(6)))
            segments.append((self.project, self.font_unit, DIM_COLOR, 0))
        start_x = max(self.px(20), (self.width - (self.px(28.0) + self.px(13.0) + self.segments_width(segments))) / 2)
        self.draw_segments(start_x + self.px(28.0) + self.px(13.0), center_y, segments)

    def active_update_notice(self) -> tuple[str, int] | None:
        """Show a newly installed version once, for a few seconds, then the metrics.

        The notice is tied to the version file rather than to a countdown from the
        install moment, so an update that lands while OpenCode is closed is still
        announced the next time the bar runs.
        """
        now_ms = time.time() * 1000
        if self.notice_shown and now_ms - self.notice_started_at < UPDATE_BADGE_MS:
            return self.notice_shown
        self.notice_shown = None
        return self.pending_update()

    def pending_update(self) -> tuple[str, int] | None:
        """The version waiting to be announced, if any. Reads only.

        Marking it seen is a separate step, done by the poll loop: a render is
        not the place that decides a file on disk has been written.
        """
        record = self.cache.read(self.version_file)
        if record is None:
            return None
        version = record.get("version")
        updated_at = record.get("updatedAt")
        seen_at = record.get("seenAt")
        if not isinstance(version, str) or not version:
            return None
        if not isinstance(updated_at, (int, float)) or isinstance(updated_at, bool):
            return None
        if isinstance(seen_at, (int, float)) and not isinstance(seen_at, bool) and seen_at >= updated_at:
            return None
        return version, updated_at

    def mark_update_seen(self, notice: tuple[str, int]) -> None:
        """Record that the announcement was shown, without losing a newer write.

        The plugin and the bar both write this file. Re-reading before writing
        and keeping whatever the plugin just recorded means an update is never
        announced twice and never announced under the wrong version.
        """
        now_ms = time.time() * 1000
        for _attempt in range(3):
            record = self.cache.read(self.version_file)
            if record is None:
                return
            updated_at = record.get("updatedAt")
            if updated_at != notice[1]:
                # Somebody recorded a newer version while we were rendering it.
                self.cache.forget(self.version_file)
                return
            record["seenAt"] = now_ms
            write_json_atomic(self.version_file, record)
            self.cache.forget(self.version_file)
            if load_record(self.version_file) is not None:
                break
        self.notice_shown = notice
        self.notice_started_at = now_ms

    # -- interaction -------------------------------------------------------------
    def on_press(self, event: tk.Event) -> None:
        self.suppress_click = False
        grip_x, grip_y = self.grip_zone()
        if event.x >= grip_x and event.y >= grip_y:
            # The bottom-right corner resizes; the window keeps its proportions,
            # because the card is a single line of content and a stretched one
            # would just look broken.
            self.resize_active = True
            self.drag_moved = False
            self.drag_origin = (int(event.x_root), int(event.y_root))
            self.drag_window_origin = (self.width, self.height)
            return
        if not self.collapsed and event.x >= self.width - self.px(CLOSE_ZONE):
            self.suppress_click = True
            self.set_collapsed(True)
            return
        self.drag_active = True
        self.drag_moved = False
        self.drag_origin = (int(event.x_root), int(event.y_root))
        self.drag_window_origin = (self.root.winfo_x(), self.root.winfo_y())
        self.drag_position = None

    def on_motion(self, event: tk.Event) -> None:
        if self.resize_active and self.drag_origin is not None and self.drag_window_origin is not None:
            base_width = MINI_WIDTH if self.collapsed else NORMAL_WIDTH
            base_height = MINI_HEIGHT if self.collapsed else NORMAL_HEIGHT
            width = self.drag_window_origin[0] + int(event.x_root) - self.drag_origin[0]
            height = self.drag_window_origin[1] + int(event.y_root) - self.drag_origin[1]
            # The larger of the two ratios wins, so the drag follows whichever
            # direction the hand actually moved.
            self.set_scale(max(width / base_width, height / base_height), persist=False)
            return
        if not self.drag_active or self.drag_origin is None or self.drag_window_origin is None:
            return
        delta_x = int(event.x_root) - self.drag_origin[0]
        delta_y = int(event.y_root) - self.drag_origin[1]
        if abs(delta_x) > DRAG_THRESHOLD or abs(delta_y) > DRAG_THRESHOLD:
            self.drag_moved = True
        if self.drag_moved:
            origin_x, origin_y = self.drag_window_origin
            self.drag_position = (origin_x + delta_x, origin_y + delta_y)
            self.root.geometry(f"+{self.drag_position[0]}+{self.drag_position[1]}")

    def on_release(self, _event: tk.Event) -> None:
        if self.resize_active:
            self.resize_active = False
            self.drag_origin = None
            self.drag_window_origin = None
            save_scale(self.scale_file, self.scale)
            return
        moved = self.drag_moved
        self.drag_active = False
        self.drag_origin = None
        self.drag_window_origin = None
        if moved:
            self.user_positioned = True
            self.saved_position = self.drag_position or (self.root.winfo_x(), self.root.winfo_y())
            save_position(self.position_file, self.saved_position[0], self.saved_position[1])
            self.drag_position = None
            return
        self.drag_position = None
        if self.suppress_click:
            return
        if self.collapsed:
            self.set_collapsed(False)

    # -- state -------------------------------------------------------------------
    def persist_best_totals(self) -> None:
        try:
            self.best_totals_file.parent.mkdir(parents=True, exist_ok=True, mode=STATUS_DIR_MODE)
            temporary = self.best_totals_file.with_name(f".{self.best_totals_file.name}.{os.getpid()}.tmp")
            temporary.write_text(json.dumps({"version": 1, "sessions": self.best_totals}), encoding="utf-8")
            os.chmod(temporary, 0o600)
            os.replace(temporary, self.best_totals_file)
        except OSError:
            pass

    def refresh_totals(self) -> None:
        payload = self.cache.read(self.totals_file)
        if payload is not None and merge_totals(self.best_totals, payload.get("sessions")):
            self.persist_best_totals()
        record = self.cache.read(self.status_file)
        if record is not None and record.get("id") != self.last_id:
            self.last_id = record.get("id")
            session_id = record.get("sessionID")
            if isinstance(session_id, str) and session_id:
                self.last_record_session_id = session_id
                if merge_totals(self.best_totals, {session_id: record.get("sessionTotals")}):
                    self.persist_best_totals()

    def announce_pending_update(self) -> None:
        """Decide here, once, that a version is announced — not inside a render."""
        if self.notice_shown and time.time() * 1000 - self.notice_started_at < UPDATE_BADGE_MS:
            return
        notice = self.pending_update()
        if notice is None:
            self.notice_shown = None
            return
        self.mark_update_seen(notice)

    def poll(self) -> None:
        if self.stopping or not self.parent_is_alive():
            self.shutdown()
            return
        self.poll_count += 1
        if not self.managed and os.name == "posix" and self.poll_count % 5 == 0:
            # Fallback path only: an unmanaged window is not guaranteed to stay
            # above other windows, so ask the server to raise it periodically.
            try:
                self.root.lift()
            except tk.TclError:
                pass
        self.desktop_window.poll()
        self.apply_window_visibility(self.desktop_window.should_hide())
        # Read the totals before resolving: the resolver's last fallback is a
        # choice among known sessions, so it needs them loaded first.
        self.refresh_totals()
        session_id = self.resolve_session()
        if session_id != self.current_session_id:
            self.current_session_id = session_id
            self.render_key = None
        self.announce_pending_update()
        self.render_totals()
        self.root.after(POLL_MS, self.poll)

    def parent_is_alive(self) -> bool:
        if self.parent_pid <= 0:
            return True
        return pid_is_alive(self.parent_pid)

    def apply_window_visibility(self, hidden: bool | None) -> None:
        """Follow the OpenCode window: minimized, unfocused, or covered takes the
        bar away; coming back brings it back. Unknown (None: another platform, no
        xprop, no OpenCode window at all) keeps the bar up, because hiding a
        measurement is worse than showing one too long.
        """
        if hidden is True and not self.withdrawn:
            self.withdrawn = True
            try:
                self.root.withdraw()
            except tk.TclError:
                self.withdrawn = False
        elif hidden is not True and self.withdrawn:
            self.withdrawn = False
            try:
                self.root.deiconify()
                self.root.attributes("-topmost", True)
                self.root.lift()
            except tk.TclError:
                pass

    def shutdown(self) -> None:
        self.stopping = True
        try:
            self.root.destroy()
        except tk.TclError:
            pass

    def run(self) -> int:
        def stop_handler(*_args: Any) -> None:
            self.stopping = True

        for signame in ("SIGTERM", "SIGINT"):
            if hasattr(signal, signame):
                try:
                    signal.signal(getattr(signal, signame), stop_handler)
                except (ValueError, OSError):
                    pass
        self.render_totals(force=True)
        self.root.mainloop()
        return 0


def ensure_status_dir(path: Path) -> None:
    """Create the status directory 0700 when it is not there yet.

    It lives in a temporary directory, which on Linux is world-writable and
    shared between users. The files inside are already 0600; this keeps another
    local account from listing or replacing them.
    """
    try:
        path.mkdir(parents=True, exist_ok=True, mode=STATUS_DIR_MODE)
    except OSError:
        pass


def main() -> int:
    # Exit codes are read by the plugin when the bar cannot stay up, so they are
    # part of the contract: 0 normal, 3 no tkinter, 4 no window system, 5 Tk died,
    # 6 another bar already owns the screen (a success, not a failure).
    if not TK_AVAILABLE:
        return 3
    if sys.platform.startswith("linux") and not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        return 4
    status_file = Path(os.environ.get("OPENCODE_LATENCY_FILE", str(DEFAULT_STATUS_FILE)))
    current_session_file = Path(os.environ.get("OPENCODE_LATENCY_CURRENT_FILE", str(DEFAULT_CURRENT_SESSION_FILE)))
    totals_file = Path(os.environ.get("OPENCODE_LATENCY_TOTALS_FILE", str(DEFAULT_TOTALS_FILE)))
    best_totals_file = Path(os.environ.get("OPENCODE_LATENCY_BEST_TOTALS_FILE", str(DEFAULT_BEST_TOTALS_FILE)))
    position_file = Path(os.environ.get("OPENCODE_LATENCY_POSITION_FILE", str(DEFAULT_POSITION_FILE)))
    lock_file = Path(os.environ.get("OPENCODE_LATENCY_LOCK_FILE", str(DEFAULT_LOCK_FILE)))
    version_file = Path(os.environ.get("OPENCODE_LATENCY_VERSION_FILE", str(DEFAULT_VERSION_FILE)))
    scale_file = Path(os.environ.get("OPENCODE_LATENCY_SCALE_FILE", str(DEFAULT_SCALE_FILE)))
    desktop_database = os.environ.get("OPENCODE_LATENCY_DESKTOP_DB")
    parent_pid = env_int("OPENCODE_LATENCY_PARENT_PID", 0)

    build = build_token()
    if not acquire_instance(lock_file, build):
        # Told apart from a crash on purpose: the plugin must not count a bar
        # that correctly stood down as a bar that keeps dying, and must not
        # print a failure for it either.
        return LOCK_HELD_EXIT_CODE
    try:
        ensure_status_dir(lock_file.parent)
        bar = Bar(
            status_file,
            current_session_file,
            totals_file,
            best_totals_file,
            position_file,
            parent_pid,
            Path(desktop_database) if desktop_database else None,
            version_file,
            scale_file,
            project=os.environ.get("OPENCODE_LATENCY_PROJECT") or None,
        )
        try:
            return bar.run()
        except tk.TclError:
            return 5
    finally:
        release_instance(lock_file)


if __name__ == "__main__":
    raise SystemExit(main())
