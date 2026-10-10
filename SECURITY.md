# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private reporting on this repository:

**[Report a vulnerability](https://github.com/moutazideal/opencode-vitals/security/advisories/new)**
(Security tab → Advisories → Report a vulnerability)

If you cannot use that, email **178997476+moutazideal@users.noreply.github.com**
with `opencode-vitals` in the subject.

Please include what you did, what happened, and what you expected. A proof of
concept helps. Never include real prompts or responses; this plugin does not
store them and a report should not either.

Only the latest release is supported. Fixes ship as a new version, not as
patches to an old one.

## What this plugin is, and its trust model

OpenCode V2 Desktop on Linux only. It runs **inside OpenCode's own service
process**, with the same privileges OpenCode already has. There is no separate
daemon, no elevated step and no root: installing writes only inside your home
directory, and uninstalling removes what it wrote.

Worth knowing, because each is a trust boundary:

- **It reads one file outside your home directory, read-only:** the app's own
  `resources/app.asar`, to copy its renderer. It never writes to it and never
  modifies the app.
- **It writes two places under your data directory:**
  - `~/.local/share/opencode-vitals/` — the copy of the app's renderer, and a
    small JSON marker recording which app build it came from.
  - `~/.local/share/applications/ai.opencode.desktop.desktop` — a copy of the
    app's own `.desktop` entry with its `Exec` line changed so the app starts
    through this plugin's launcher host. This is what points the window at the
    copy of the renderer. Uninstalling removes it, and it is found by its own
    marker, never deleted blindly.
- **It runs a local HTTP server, bound to `127.0.0.1` only**, on
  `OPENCODE_VITALS_PORT` (default `8971`). It serves the copied renderer and two
  small JSON endpoints: `/vitals` (the session's turn/step/token totals for the
  session the window is showing) and `/__vitals-health` (a readiness probe). It
  answers a malformed request target with `400` rather than throwing. Any local
  process can reach a loopback server; there is nothing on it that is not
  already visible to a process running as you. It holds no secrets and executes
  nothing it is sent.
- **It makes one network call:** the npm registry, to check for a newer release.
  It is throttled, can be turned off with `OPENCODE_VITALS_NO_UPDATE=1` or
  `--no-update`, and sends nothing about you or your sessions. See the Privacy
  section of the [README](README.md).
- **It never stores prompts or responses.** What it measures are counts and
  timings; what it serves are those numbers. No conversation content leaves the
  process or is written to disk.

## Out of scope

- Vulnerabilities in OpenCode itself, or in the desktop app, Electron or
  Chromium. Report those to their projects.
- Anything that requires an attacker to already be able to write to your
  `~/.local/share/applications` or your plugin directory. Someone who can change
  how your programs start can already do far more than change this one.
- The fact that the loopback readout server is reachable by other local
  processes. That is what a loopback server is; it exposes only numbers you could
  read out of the app yourself.
