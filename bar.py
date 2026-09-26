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
DEFAULT_LOCK_FILE = Path(tempfile.gettempdir()) / "opencode-latency-monitor" / "popup.lock"
DEFAULT_VERSION_FILE = Path(tempfile.gettempdir()) / "opencode-latency-monitor" / "plugin-version.json"
UPDATE_BADGE_MS = 8000
NORMAL_WIDTH = 360
NORMAL_HEIGHT = 54
MINI_WIDTH = 62
MINI_HEIGHT = 62
POLL_MS = 200
CURRENT_SESSION_MAX_AGE_MS = 15 * 1000
MAX_TRACKED_TOTALS = 100
LOCK_ATTEMPTS = 30
LOCK_DELAY_SECONDS = 0.2
DRAG_THRESHOLD = 3
TOTAL_FIELDS = ("turns", "steps", "outputTokens", "reasoningTokens", "generatedTokens", "activeStreamMs")
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


def load_current_session(path: Path) -> dict[str, Any] | None:
    record = load_record(path)
    if record is None or record.get("available") is not True:
        return None
    observed_at = record.get("observedAt")
    if isinstance(observed_at, (int, float)) and not isinstance(observed_at, bool):
        if time.time() * 1000 - observed_at > CURRENT_SESSION_MAX_AGE_MS:
            return None
    session_id = record.get("sessionID")
    return {"sessionID": session_id} if isinstance(session_id, str) and session_id else None


def write_json_atomic(path: Path, value: Any) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        temporary.write_text(json.dumps(value), encoding="utf-8")
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    except OSError:
        pass


def load_saved_position(path: Path) -> tuple[int, int] | None:
    record = load_record(path)
    if record is None:
        return None
    x = record.get("x")
    y = record.get("y")
    if isinstance(x, (int, float)) and isinstance(y, (int, float)) and not isinstance(x, bool) and not isinstance(y, bool):
        return int(x), int(y)
    return None


def save_position(path: Path, x: int, y: int) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        temporary.write_text(json.dumps({"x": int(x), "y": int(y)}), encoding="utf-8")
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    except OSError:
        pass


def merge_totals(target: dict[str, dict[str, float]], sessions: Any) -> bool:
    """Field-wise maximum keeps monotonic totals across plugin or bar restarts."""
    if not isinstance(sessions, dict):
        return False
    changed = False
    for session_id, values in sessions.items():
        if not isinstance(session_id, str) or not isinstance(values, dict):
            continue
        current = target.get(session_id)
        if current is None:
            current = {field: 0 for field in TOTAL_FIELDS}
            target[session_id] = current
        for field in TOTAL_FIELDS:
            number = values.get(field)
            if isinstance(number, (int, float)) and not isinstance(number, bool):
                if number > current.get(field, 0):
                    current[field] = number
                    changed = True
        tokens_per_second = values.get("tokensPerSecond")
        if isinstance(tokens_per_second, (int, float)) and not isinstance(tokens_per_second, bool):
            if tokens_per_second > current.get("tokensPerSecond", 0):
                current["tokensPerSecond"] = tokens_per_second
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


def format_tps(value: Any) -> str:
    if value is None:
        return "–"
    try:
        rate = float(value)
    except (TypeError, ValueError):
        return "–"
    if rate <= 0:
        return "–"
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


def window_is_hidden(state: str) -> bool:
    return "_NET_WM_STATE_HIDDEN" in (state or "")


class DesktopWindow:
    """Is the OpenCode window minimized (or on another workspace)?

    Linux and X11 only, and only through xprop. When the question cannot be
    answered — no display, another platform, xprop missing — the answer is None
    and the bar stays visible: hiding a measurement is worse than showing one
    too long.
    """

    def __init__(self, probe=None, patterns=DESKTOP_WINDOW_MATCHES, interval_ms=WINDOW_CHECK_INTERVAL_MS) -> None:
        self.probe = probe or self._xprop
        self.patterns = patterns
        self.interval_ms = interval_ms
        self.supported = sys.platform.startswith("linux") and bool(os.environ.get("DISPLAY"))
        self.hidden: bool | None = None
        self.window_id: str | None = None
        self.checked_at = 0.0

    @staticmethod
    def _xprop(args: list[str]) -> str | None:
        try:
            result = subprocess.run(["xprop", *args], capture_output=True, text=True, timeout=2)
        except (OSError, subprocess.SubprocessError):
            return None
        return result.stdout if result.returncode == 0 else None

    def poll(self, now_ms: float | None = None) -> bool | None:
        stamp = time.time() * 1000 if now_ms is None else now_ms
        if not self.supported:
            return None
        if stamp - self.checked_at < self.interval_ms:
            return self.hidden
        self.checked_at = stamp
        self.hidden = self._read()
        return self.hidden

    def _read(self) -> bool | None:
        listing = self.probe(["-root", "_NET_CLIENT_LIST"])
        if listing is None:
            return None
        windows = parse_window_list(listing)
        if self.window_id not in windows:
            self.window_id = self._find_window(windows)
        if self.window_id is None:
            return None
        state = self.probe(["-id", self.window_id, "_NET_WM_STATE"])
        if state is None:
            return None
        return window_is_hidden(state)

    def _find_window(self, windows: list[str]) -> str | None:
        for window in windows:
            classes = self.probe(["-id", window, "WM_CLASS"])
            if classes is None:
                continue
            lowered = classes.lower()
            if any(pattern.lower() in lowered for pattern in self.patterns):
                return window
        return None


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
        window_probe=None,
    ) -> None:
        self.status_file = status_file
        self.current_session_file = current_session_file
        self.totals_file = totals_file
        self.best_totals_file = best_totals_file
        self.position_file = position_file
        self.version_file = version_file or DEFAULT_VERSION_FILE
        self.parent_pid = parent_pid
        self.desktop_tabs = DesktopTabs(desktop_database)
        self.desktop_window = DesktopWindow(probe=window_probe)
        self.withdrawn = False
        self.notice_shown: tuple[str, int] | None = None
        self.notice_started_at = 0.0
        self.stopping = False
        self.minimized = False
        self.poll_count = 0
        self.render_key: tuple[str, int, int, float | None] | None = None
        self.last_id: str | None = None
        self.current_session_id: str | None = None
        self.last_record_session_id: str | None = None
        self.best_totals: dict[str, dict[str, float]] = {}
        loaded = load_record(best_totals_file)
        if loaded is not None:
            merge_totals(self.best_totals, loaded.get("sessions"))

        self.saved_position = load_saved_position(position_file)
        self.user_positioned = self.saved_position is not None
        self.drag_active = False
        self.drag_moved = False
        self.drag_origin: tuple[int, int] | None = None
        self.drag_window_origin: tuple[int, int] | None = None
        self.drag_position: tuple[int, int] | None = None
        self.suppress_click = False

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
        self.font_value = tkfont.Font(family=family, size=12, weight="bold")
        self.font_unit = tkfont.Font(family=family, size=9)
        self.font_mini_caption = tkfont.Font(family=family, size=7, weight="bold")
        self.font_mini_value = tkfont.Font(family=family, size=14, weight="bold")
        self.close_hover = False

        self.width = NORMAL_WIDTH
        self.height = NORMAL_HEIGHT
        self.canvas = tk.Canvas(self.root, width=self.width, height=self.height, highlightthickness=0, bg=WINDOW_BG)
        self.canvas.pack(fill="both", expand=True)
        self.bind_events()
        self.apply_geometry()

        self.root.after(POLL_MS, self.poll)

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

    def on_hover(self, event: tk.Event) -> None:
        hovering = (not self.minimized) and event.x >= self.width - 34
        if hovering != self.close_hover:
            self.close_hover = hovering
            self.render_totals(force=True)

    def on_hover_leave(self, _event: tk.Event) -> None:
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

    def set_minimized(self, minimized: bool) -> None:
        self.minimized = bool(minimized)
        self.width, self.height = (MINI_WIDTH, MINI_HEIGHT) if self.minimized else (NORMAL_WIDTH, NORMAL_HEIGHT)
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
        radius = 9.0
        fraction = 0.0 if not rate else max(0.0, min(1.0, rate / GAUGE_FULL_SCALE_TPS))
        box = (center_x - radius, center_y - radius, center_x + radius, center_y + radius)

        if rate:
            # Tk has no per item alpha, so the glow is a few rings that step a
            # little closer to the accent colour towards the dial. More than
            # three reads as concentric rings rather than a glow.
            for step in range(3, 0, -1):
                halo = lerp_color(CARD_BG, ACCENT_COLOR, 0.035 + 0.02 * (3 - step))
                halo_radius = radius + 2.1 * step
                self.canvas.create_oval(
                    center_x - halo_radius, center_y - halo_radius,
                    center_x + halo_radius, center_y + halo_radius,
                    outline=halo, width=1,
                )

        self.canvas.create_arc(*box, start=GAUGE_START_DEGREES, extent=-GAUGE_SWEEP_DEGREES, style="arc", outline=GAUGE_TRACK, width=3)
        for tick in (0.0, 0.25, 0.5, 0.75, 1.0):
            tick_x, tick_y = self.gauge_point(center_x, center_y, radius + 3.6, tick)
            self.canvas.create_oval(tick_x - 0.7, tick_y - 0.7, tick_x + 0.7, tick_y + 0.7, fill=GAUGE_TICK, outline=GAUGE_TICK)

        if rate:
            self.canvas.create_arc(*box, start=GAUGE_START_DEGREES, extent=-GAUGE_SWEEP_DEGREES * fraction, style="arc", outline=ACCENT_COLOR, width=3)
            for end in (0.0, fraction):
                cap_x, cap_y = self.gauge_point(center_x, center_y, radius, end)
                self.canvas.create_oval(cap_x - 1.5, cap_y - 1.5, cap_x + 1.5, cap_y + 1.5, fill=ACCENT_COLOR, outline=ACCENT_COLOR)
            needle_x, needle_y = self.gauge_point(center_x, center_y, radius - 2.0, fraction)
            self.canvas.create_line(center_x, center_y, needle_x, needle_y, fill=GAUGE_NEEDLE, width=1.4, capstyle="round")

        self.canvas.create_oval(center_x - 2.8, center_y - 2.8, center_x + 2.8, center_y + 2.8, fill=CARD_BG, outline=CARD_BORDER)
        hub = ACCENT_COLOR if rate else GAUGE_TICK
        self.canvas.create_oval(center_x - 1.2, center_y - 1.2, center_x + 1.2, center_y + 1.2, fill=hub, outline="")

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
        center_x = self.width - 15
        center_y = self.height / 2
        radius = 8.0
        outline = ACCENT_COLOR if self.close_hover else CARD_BORDER
        glyph = "#dbe6f5" if self.close_hover else MUTED_COLOR
        self.canvas.create_oval(center_x - radius, center_y - radius, center_x + radius, center_y + radius, outline=outline, width=1)
        arm = 3.4
        self.canvas.create_line(center_x - arm, center_y - arm, center_x + arm, center_y + arm, fill=glyph, width=1.5, capstyle="round")
        self.canvas.create_line(center_x - arm, center_y + arm, center_x + arm, center_y - arm, fill=glyph, width=1.5, capstyle="round")

    def draw_update_badge(self, version: str) -> None:
        label = f"{version} installed"
        width = self.font_value.measure(label) + 40
        x1 = (self.width - width) / 2
        y1 = self.height / 2 - 12
        x2 = x1 + width
        y2 = y1 + 24
        self.draw_card(x1, y1, x2, y2, 12)
        self.canvas.create_rectangle(x1 + 1.5, y1 + 1.5, x2 - 1.5, y2 - 1.5, fill=lerp_color(CARD_BG, ACCENT_COLOR, 0.10), outline="")
        tick_x = x1 + 15
        tick_y = self.height / 2
        self.canvas.create_line(tick_x - 3.6, tick_y + 0.2, tick_x - 0.9, tick_y + 3, fill=ACCENT_COLOR, width=1.6, capstyle="round")
        self.canvas.create_line(tick_x - 0.9, tick_y + 3, tick_x + 4, tick_y - 3.4, fill=ACCENT_COLOR, width=1.6, capstyle="round")
        self.draw_text(x1 + 26, tick_y, label, self.font_value, ACCENT_COLOR)

    def render_totals(self, force: bool = False) -> None:
        session_id = self.current_session_id or self.last_record_session_id
        # A freshly opened tab has no totals yet: show the last measured session
        # rather than crashing on a missing entry.
        totals = (
            self.best_totals.get(session_id)
            or self.best_totals.get(self.last_record_session_id or "")
            or {}
        )
        turns = format_count(totals.get("turns"))
        steps = format_count(totals.get("steps"))
        rate = totals_rate(totals)
        notice = self.active_update_notice()
        key = (session_id or "", turns, steps, rate, notice[0] if notice else None, self.close_hover)
        if not force and key == self.render_key:
            return
        self.render_key = key
        self.canvas.delete("all")
        center_y = self.height / 2

        if self.minimized:
            self.draw_card(2, 2, self.width - 3, self.height - 3, 15)
            if notice is not None:
                self.draw_text(self.width / 2, 20, "UPDATED", self.font_mini_caption, MUTED_COLOR, anchor="center")
                self.draw_text(self.width / 2, 41, notice[0], self.font_mini_value, ACCENT_COLOR, anchor="center")
                return
            self.draw_text(self.width / 2, 21, "TOK/S", self.font_mini_caption, DIM_COLOR, anchor="center")
            self.draw_text(self.width / 2, 43, format_tps(rate), self.font_mini_value, ACCENT_COLOR, anchor="center")
            return

        self.draw_card(2, 2, self.width - 3, self.height - 3, 14)
        self.draw_close_button()
        if notice is not None:
            self.draw_update_badge(notice[0])
            return

        segments = [
            (str(turns), self.font_value, TEXT_COLOR, 3),
            ("turn" if turns == 1 else "turns", self.font_unit, MUTED_COLOR, 16),
            (str(steps), self.font_value, TEXT_COLOR, 3),
            ("step" if steps == 1 else "steps", self.font_unit, MUTED_COLOR, 22),
            (format_tps(rate), self.font_value, ACCENT_COLOR, 3),
            ("tok/s", self.font_unit, MUTED_COLOR, 0),
        ]
        gauge_width = 28.0
        gap = 13.0
        total_width = gauge_width + gap + self.segments_width(segments)
        start_x = max(34, (self.width - total_width) / 2)
        self.draw_gauge(start_x + 11, center_y, rate)
        self.draw_segments(start_x + gauge_width + gap, center_y, segments)

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
        record = load_record(self.version_file)
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
        record["seenAt"] = now_ms
        write_json_atomic(self.version_file, record)
        self.notice_shown = (version, updated_at)
        self.notice_started_at = now_ms
        return self.notice_shown

    # -- interaction -------------------------------------------------------------
    def on_press(self, event: tk.Event) -> None:
        self.suppress_click = False
        if not self.minimized and event.x >= self.width - 34:
            self.suppress_click = True
            self.set_minimized(True)
            return
        self.drag_active = True
        self.drag_moved = False
        self.drag_origin = (int(event.x_root), int(event.y_root))
        self.drag_window_origin = (self.root.winfo_x(), self.root.winfo_y())
        self.drag_position = None

    def on_motion(self, event: tk.Event) -> None:
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
        if self.minimized:
            self.set_minimized(False)

    # -- state -------------------------------------------------------------------
    def persist_best_totals(self) -> None:
        try:
            self.best_totals_file.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.best_totals_file.with_name(f".{self.best_totals_file.name}.{os.getpid()}.tmp")
            temporary.write_text(json.dumps({"version": 1, "sessions": self.best_totals}), encoding="utf-8")
            os.chmod(temporary, 0o600)
            os.replace(temporary, self.best_totals_file)
        except OSError:
            pass

    def refresh_totals(self) -> None:
        payload = load_record(self.totals_file)
        if payload is not None and merge_totals(self.best_totals, payload.get("sessions")):
            self.persist_best_totals()
        record = load_record(self.status_file)
        if record is not None and record.get("id") != self.last_id:
            self.last_id = record.get("id")
            session_id = record.get("sessionID")
            if isinstance(session_id, str) and session_id:
                self.last_record_session_id = session_id
                if merge_totals(self.best_totals, {session_id: record.get("sessionTotals")}):
                    self.persist_best_totals()

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
        self.apply_window_visibility(self.desktop_window.poll())
        current = load_current_session(self.current_session_file)
        event_session = current.get("sessionID") if current else None
        # The Desktop's own record of the open tab wins: OpenCode publishes no
        # event when a tab is opened, so events alone freeze on the last session
        # that was typed into.
        session_id = self.desktop_tabs.poll() or event_session or self.last_record_session_id
        if session_id != self.current_session_id:
            self.current_session_id = session_id
            self.render_key = None
        self.refresh_totals()
        self.render_totals()
        self.root.after(POLL_MS, self.poll)

    def parent_is_alive(self) -> bool:
        if self.parent_pid <= 0:
            return True
        return pid_is_alive(self.parent_pid)

    def apply_window_visibility(self, hidden: bool | None) -> None:
        """Follow the OpenCode window: minimized takes the bar away, restoring it
        brings the bar back. Unknown (None: another platform, no xprop) keeps the
        bar up, because hiding a measurement is worse than showing one too long.
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


def main() -> int:
    # Exit codes are read by the plugin when the bar cannot stay up, so they are
    # part of the contract: 0 normal, 3 no tkinter, 4 no window system, 5 Tk died.
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
    desktop_database = os.environ.get("OPENCODE_LATENCY_DESKTOP_DB")
    parent_pid = env_int("OPENCODE_LATENCY_PARENT_PID", 0)

    build = build_token()
    if not acquire_instance(lock_file, build):
        return 0
    try:
        bar = Bar(
            status_file,
            current_session_file,
            totals_file,
            best_totals_file,
            position_file,
            parent_pid,
            Path(desktop_database) if desktop_database else None,
            version_file,
        )
        try:
            return bar.run()
        except tk.TclError:
            return 5
    finally:
        release_instance(lock_file)


if __name__ == "__main__":
    raise SystemExit(main())
