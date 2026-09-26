# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-09-26

### Added

- `npx opencode-vitals-install`: installs the plugin into the directory OpenCode
  already reads, so a first-time install needs no editing of `opencode.json`.
  Flags: `--link` to symlink while working on the source, `--status` to report
  what is installed, `--uninstall` to remove it, `--dir` to choose the plugin
  directory, `--force` to replace something else.
- The install command copies exactly the files npm ships, plus the manifest, and
  removes files a newer release no longer ships, so running it twice is an
  update rather than a second copy.

### Fixed

- The install command refused to run at all: the guard that nothing is written
  outside the plugin directory compared path prefixes with the PATH separator
  (`:` on Linux) instead of the path separator, so every path failed the check.
- An install over an existing copy was reported as "a different package", because
  the guard looked for any manifest instead of comparing the package name, so a
  second run could not update.

### Fixed after an audit of the shipped code

- **Windows: liveness checking killed the process it checked.** Python documents
  that on Windows any signal other than `CTRL_C_EVENT`/`CTRL_BREAK_EVENT` is
  handed to `TerminateProcess`, so the usual `os.kill(pid, 0)` existence test
  would have terminated the OpenCode process the bar belongs to. Windows now
  asks `OpenProcess`/`GetExitCodeProcess`, and `os.kill` is never used there.
- **A bar that died at once was retried every five seconds forever** — measured:
  four spawns in sixteen seconds. Consecutive short-lived exits now back off
  15s, 30s, 60s … up to five minutes, the reason is logged once, and a bar that
  lived or that we stopped ourselves resets the counter. Measured after the fix:
  attempts at 0s, 15s, 30s in a fifty second window.
- **A failed compaction swallowed the next response**: the "ignore this session"
  flag was cleared only when an execution completed, so after
  `session.compaction.failed` the following response produced zero records. A
  compaction that ends outside an execution now unmutes the session, and a
  synthetic item no longer mutes the next real prompt.
- **Signalling trusted the pid alone.** A stale lock whose pid had been recycled
  could send SIGTERM to an unrelated process. Nothing is signalled now unless the
  command line says `bar.py` (Linux and macOS); otherwise the lock is simply
  reclaimed. On Windows the lock is ours and the check is deliberately fail-open.
- **One malformed event ended every later measurement**, because the event loop
  body had no try/catch of its own; a throwing event is now skipped and counted.
- The selftest called a machine untrustworthy before the plugin was installed and
  after a fresh install that had not finished a response yet. Runtime facts are
  notes now; only what the machine can do is required, and the verdict names the
  real state (not installed / restart OpenCode / no bar up right now / ready).
- The install command's Windows plugin directory was `%APPDATA%\opencode\plugins`
  and it *created* that folder when nothing existed. The shipped CLI computes
  `XDG_CONFIG_HOME || ~/.config` on every platform, so the installer now uses
  `~/.config/opencode/plugins` there too — and it no longer guesses: the path is
  printed.
- `--force` over a plain file crashed with `ENOTDIR` instead of replacing it;
  `--uninstall` removed whatever carried the folder name without checking the
  manifest (the guard that meant to check it could never fire).
- The selftest counted any plugin folder with an `index.js` as an installed
  Vitals; it requires a manifest naming this package now.
- Smaller hardening from the same audit: the bar's session-id pattern accepts
  `-` and `_`; the host call for missing token counts has a three second
  deadline; the storage lock waits five seconds before its fail-open path; session
  totals are evicted by least recently updated; `python3` is not trusted on
  Windows (the bar probes `py -3`, `python`, `python3` for tkinter, like the
  selftest launcher).

### Measured

- 156 plugin checks and 54 bar checks, all green, up from 103 and 44 at 0.1.0.
  New coverage: the popup retry gate, the interpreter candidates, the context
  deadline, process identity before signalling, a response after a failed
  compaction, a compaction inside an execution, a synthetic item followed by a
  real prompt, a hostile event that throws, `--force` over a file, uninstall
  identity, the one plugin-directory rule, and the Windows liveness branch
  (asserted never to reach `os.kill`).

## [0.1.0] - 2026-09-26

The first public release.

### Added

- Session line in a small always-on-top bar: turns, steps, and average streaming
  tok/s, where the average is generated tokens divided by active stream time so
  tool executions stay out of the denominator.
- Bar interaction: drag anywhere with a remembered position, a close button that
  collapses the bar to a square, and the square restores it.
- Follows the Desktop tab you are looking at, read from the app's own
  `tabs.recent` row (read-only, WAL aware), falling back to the session of your
  latest prompt and then to the last measured session.
- Leaves when the OpenCode app is closed, decided from the OS process list
  (`/proc`, `pgrep`, `tasklist`), and never hides the bar when a check cannot
  run.
- `selftest` command that reports whether the bar can run on this machine, with
  every line a measured fact.
- Announce a new version once, in place of the metrics, with no network call: the
  plugin compares its own `package.json` version against the one it recorded.
- Window lifetime hygiene: stale response markers are swept on a timer instead of
  waiting for the next message.

### Measured, not assumed

- 103 plugin checks and 44 bar checks ran before this release; the test suites
  keep their own status directory and never touch the one belonging to the
  person running them.
- The bar is verified on Linux with GNOME/Mutter on X11. The macOS and Windows
  paths are ordinary platform code with a fail-open rule, and their decision
  logic is covered by tests driven by a fake process list, but no macOS or
  Windows machine has run it yet.

[0.1.1]: https://github.com/moutazideal/opencode-vitals/releases/tag/v0.1.1
[0.1.0]: https://github.com/moutazideal/opencode-vitals/releases/tag/v0.1.0
