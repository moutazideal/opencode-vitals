# OpenCode Vitals

A local OpenCode V2 plugin that measures each response and shows one compact session line in a small
always-on-top bar:

```
◔ 10 turns 245 steps · 274 tok/s
```

- **turns** — completed responses in the session;
- **steps** — model steps across those responses;
- **tok/s** — session average: generated tokens (output + reasoning) divided by active stream time,
  so tool executions between steps stay out of the denominator.

Compaction executions and synthetic inbox items are excluded. Duplicate completion events, late
deltas, and repeated plugin instances are deduplicated. Only timing metadata, token counts, and
session/message identifiers are stored; prompts and response text are never stored.

## Install

From npm, add the package to your `opencode.json(c)`:

```json
{
  "plugins": [
    {
      "package": "opencode-vitals",
      "options": {
        "popup": true
      }
    }
  ]
}
```

Or copy this folder into the global plugin directory (`~/.config/opencode/plugins/opencode-vitals/`
on Linux); OpenCode discovers it automatically.

## Requirements

- **OpenCode V2** (verified against 2.0.14).
- **Node 18+** for the plugin.
- **Python 3.9+ with tkinter** for the bar. Tkinter is bundled with the official Python installers on
  Windows and macOS; on Ubuntu it is the small `python3-tk` package and is usually already present.
  There is no GTK, `gi`, sqlite, or other dependency.
- No display (server/CI): the plugin still records measurements; the bar is skipped automatically.
- The bar runs on Linux, macOS, and Windows. On macOS the "always on top" hint is best-effort when
  another app is fullscreen.

## Use

The bar starts automatically with the plugin. Drag it anywhere; the position is remembered. Click the
`×` to collapse it into a small square showing the live session `tok/s`; click the square to expand it
again (dragging the square also moves it). Hovering is not required — the bar always shows the
current session.

The tracked session is the one OpenCode reports as viewed (`session.viewed`), or the session of your
latest prompt when the app's own record is unavailable. When the plugin files change, the bar
replaces the previous revision automatically within seconds; no restart is needed.

### Which session the bar follows

The bar follows the tab you are looking at in the Desktop app. OpenCode publishes no event when a
tab is opened, so the bar reads the app's own record of the open tab (`tabs.recent` in its
`drafts.sqlite`) — opened read-only, one row, no lock files and no extra process. The row is
written in WAL mode, so both the database and its `-wal` file are watched. When the database is not
there, the bar falls back to the session of your latest prompt and then to the last measured
session. Point `OPENCODE_LATENCY_DESKTOP_DB` at the file if your app keeps it elsewhere.

### Platform support, honestly

| Part | Linux | macOS | Windows |
|---|---|---|---|
| Measurement core (Node) | code path exercised by the test suite | same code, no OS calls | same code, no OS calls |
| Bar window | **verified here**: GNOME/Mutter on X11 — managed `toolbar` window, undecorated, `_NET_WM_STATE_ABOVE`, drag, minimize, saved position | expected: Tk `overrideredirect` + `-topmost`; always-on-top is best-effort against fullscreen apps | expected: Tk `overrideredirect` + `-topmost` |
| Open-tab tracking | **verified here**: `~/.config/ai.opencode.desktop/drafts.sqlite` | `~/Library/Application Support/ai.opencode.desktop/drafts.sqlite` (Electron convention) | `%APPDATA%\ai.opencode.desktop\drafts.sqlite` (Electron convention) |
| Exit with the app | **verified here**: `/proc` scan | `pgrep` per name | `tasklist /FI` per name |

Only the Linux column was run on real hardware. The macOS and Windows paths are ordinary platform
code with the same fail-open rule — when a check cannot run, the bar stays instead of disappearing —
and the decision logic is covered by the test suite with a fake process list, but no macOS or
Windows machine has run it yet. If the app keeps its database elsewhere, set
`OPENCODE_LATENCY_DESKTOP_DB`; the bar then falls back to the session of your latest prompt.

### Bar lifetime

The bar belongs to the OpenCode app: it stays while the app is running and leaves within a few
seconds after you quit it. The plugin service is supervised by `systemd` and outlives the app, and
OpenCode publishes no event for a client disconnect, so liveness is read from the OS process list
(`/proc` on Linux, `pgrep` on macOS, `tasklist` on Windows) when the service reports
`OPENCODE_CLIENT=desktop`. A check that cannot run keeps the bar instead of hiding it, and a service
that was not started by the Desktop app simply follows the service process.

## Options

The default history limit is 20 measurements. To configure the plugin, move the package outside the
auto-discovered directory and add it explicitly to `opencode.json(c)`:

```json
{
  "plugins": [
    {
      "package": "./opencode-vitals",
      "options": {
        "historyLimit": 50,
        "log": true,
        "popup": true,
        "enabled": true
      }
    }
  ]
}
```

`historyLimit` is bounded to 1–100. Set `popup: false` to run measurements without the bar. When no
provider token counts exist, `tok/s` shows `–` instead of inventing a number; the measurement is
limited by the provider's visible stream.

For a manual bar launch, run `./start-bar.sh`. Set `OPENCODE_LATENCY_POSITION` to `top-right`,
`top-left`, `bottom-right`, or `bottom-left` to choose the default corner (a dragged position wins),
and `OPENCODE_LATENCY_PYTHON` to point at a specific Python interpreter.

To keep working on the source while OpenCode auto-discovers it, link the checkout into the plugins
directory:

```bash
ln -s "$PWD" ~/.config/opencode/plugins/opencode-vitals
```

If OpenCode already discovered this plugin under a different folder name, keep the link under that
name: the running instance holds the path it was loaded from, and renaming the link leaves it
pointing at nothing until OpenCode reloads it.

The bar replaces its running revision within five seconds of an edit, so there is no restart step.

## Privacy

The plugin reads OpenCode's own event stream and writes small JSON status files under the system
temporary directory. It never reads prompts or responses from disk and makes no network requests.
The one exception is the open-tab lookup described above: it reads a single row (`tabs.recent`) from
the Desktop app's own state database, read-only, to know which tab you are looking at. No draft
text is read.

## Development

```bash
npm test        # plugin logic (Node) and bar behaviour (Tkinter)
npm run selftest  # does the bar work on *this* machine?
npm pack        # build the publishable tarball
```

`npm test` needs a window system for the bar suite; on a headless Linux box it prints `skipped`
instead of failing. `npm run selftest` is the one to run first on a new machine: it reports Tkinter,
the window type that stays undecorated and on top, the Desktop database path, and the tab it reads.
Its output is a list of measured facts, so a report from another operating system is worth sending
with a bug.

Run the bar by hand with `./start-bar.sh` while developing.
