#!/usr/bin/env python3
"""Cross-platform OpenCode vitals bar: turns, steps, and session tok/s.

Uses only the Python standard library (tkinter), so it runs on Linux, macOS,
and Windows without GTK, gi, sqlite, or any other package.
"""

from __future__ import annotations

import json
import os
import re
import signal
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
CARD_BG = "#171c28"
CARD_BORDER = "#2a3345"
TEXT_COLOR = "#e2e8f0"
MUTED_COLOR = "#8b95a7"
DIM_COLOR = "#5b6678"
ACCENT_COLOR = "#2dd4bf"
FONT_CANDIDATES = ("Ubuntu", "Segoe UI", "SF Pro Text", "Noto Sans", "DejaVu Sans", "Helvetica")
SESSION_ID_PATTERN = re.compile(r"ses_[A-Za-z0-9]+")
DESKTOP_STATE_KEY = "tabs.recent"


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


def pid_is_alive(pid: int) -> bool:
    if pid <= 0:
        return False
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
            if holder and pid_is_alive(int(holder.get("pid", 0))):
                if holder.get("build") != build:
                    try:
                        os.kill(int(holder["pid"]), signal.SIGTERM)
                    except OSError:
                        pass
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
    ) -> None:
        self.status_file = status_file
        self.current_session_file = current_session_file
        self.totals_file = totals_file
        self.best_totals_file = best_totals_file
        self.position_file = position_file
        self.version_file = version_file or DEFAULT_VERSION_FILE
        self.parent_pid = parent_pid
        self.desktop_tabs = DesktopTabs(desktop_database)
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
        self.font_text = tkfont.Font(family=family, size=11, weight="bold")
        self.font_close = tkfont.Font(family=family, size=12, weight="bold")
        self.font_mini_caption = tkfont.Font(family=family, size=7, weight="bold")
        self.font_mini_value = tkfont.Font(family=family, size=13, weight="bold")

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
        self.canvas.create_polygon(points, smooth=True, splinesteps=16, fill=CARD_BG, outline=CARD_BORDER, width=1)

    def draw_gauge(self, center_x: float, center_y: float, active: bool) -> None:
        radius = 8.0
        ring = "#94a3b8" if active else MUTED_COLOR
        needle = ACCENT_COLOR if active else MUTED_COLOR
        self.canvas.create_oval(center_x - radius, center_y - radius, center_x + radius, center_y + radius, outline=ring, width=2)
        self.canvas.create_line(center_x, center_y, center_x + radius * 0.6, center_y - radius * 0.6, fill=needle, width=2)
        self.canvas.create_oval(center_x - 1.6, center_y - 1.6, center_x + 1.6, center_y + 1.6, fill=needle, outline=needle)

    def draw_text(self, x: float, y: float, text: str, font: tkfont.Font, fill: str, anchor: str = "w") -> None:
        self.canvas.create_text(x, y, text=text, font=font, fill=fill, anchor=anchor)

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
        key = (session_id or "", turns, steps, rate, notice[0] if notice else None)
        if not force and key == self.render_key:
            return
        self.render_key = key
        self.canvas.delete("all")
        if self.minimized:
            self.draw_card(2, 2, self.width - 2, self.height - 2, 14)
            caption = "TOK/S" if notice is None else "UPDATED"
            self.draw_text(self.width / 2, 18, caption, self.font_mini_caption, DIM_COLOR, anchor="center")
            self.draw_text(self.width / 2, 40, format_tps(rate) if notice is None else notice[0], self.font_mini_value, ACCENT_COLOR, anchor="center")
            return
        self.draw_card(2, 2, self.width - 2, self.height - 2, 13)
        self.draw_text(self.width - 16, self.height / 2, "×", self.font_close, MUTED_COLOR, anchor="center")
        center_y = self.height / 2
        if notice is not None:
            text = f"{notice[0]} installed"
            self.draw_centered(text, center_y, ACCENT_COLOR)
            return
        turns_text = "1 turn" if turns == 1 else f"{turns} turns"
        steps_text = "1 step" if steps == 1 else f"{steps} steps"
        tps_text = f"{format_tps(rate)} tok/s"
        gap = 8
        icon_width = 18
        total_width = (
            icon_width + gap
            + self.font_text.measure(turns_text) + gap
            + self.font_text.measure(steps_text) + gap
            + self.font_text.measure("·") + gap
            + self.font_text.measure(tps_text)
        )
        start_x = max(14, (self.width - total_width) / 2)
        self.draw_gauge(start_x + icon_width / 2, center_y, turns > 0)
        cursor = start_x + icon_width + gap
        self.draw_text(cursor, center_y, turns_text, self.font_text, TEXT_COLOR)
        cursor += self.font_text.measure(turns_text) + gap
        self.draw_text(cursor, center_y, steps_text, self.font_text, TEXT_COLOR)
        cursor += self.font_text.measure(steps_text) + gap
        self.draw_text(cursor, center_y, "·", self.font_text, DIM_COLOR)
        cursor += self.font_text.measure("·") + gap
        self.draw_text(cursor, center_y, tps_text, self.font_text, TEXT_COLOR)

    def draw_centered(self, text: str, center_y: float, fill: str) -> None:
        width = self.font_text.measure(text)
        self.draw_text(max(14, (self.width - width) / 2), center_y, text, self.font_text, fill)

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
    if not TK_AVAILABLE:
        return 0
    if sys.platform.startswith("linux") and not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        return 0
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
            return 0
    finally:
        release_instance(lock_file)


if __name__ == "__main__":
    raise SystemExit(main())
