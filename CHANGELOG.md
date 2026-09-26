# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.4] - 2026-09-26

### Added

- **The bar follows the OpenCode window.** Minimize it and the bar goes away;
  restore it and the bar comes back. The window manager is asked over
  `_NET_WM_STATE` with xprop on Linux/X11, at most once a second, and the window
  is found by `WM_CLASS` (verified against the live display: `ai.opencode.desktop`
  found, reported not hidden while maximized). When the question cannot be
  answered — another platform, no xprop, no display — the bar stays up, because
  hiding a measurement is worse than showing one too long.
- Ten bar checks cover the new behaviour: window-list parsing, the hidden state,
  the fail-open paths, and the bar withdrawing and returning.

### Fixed

- The README's images were relative (`docs/bar.png`), which GitHub resolves and
  the npm package page cannot, so the package page showed broken images. Every
  image and the changelog link are absolute now, and the README test rejects a
  relative image source.
- The platform table now states the window-following behaviour per platform, and
  the tested OpenCode versions list 2.0.18.

### Measured

- 166 plugin checks and 66 bar checks. Three of the plugin checks enforce
  npm-safe absolute image URLs; ten of the bar checks cover the new window
  following behaviour.

## [0.1.3] - 2026-09-26

The install command actually works now.

### Fixed

- **The command a newcomer was told to run could not work.** The README said
  `npx opencode-vitals-install`, but npx resolves *package* names, and that is
  the name of a file inside the package, so npm answered 404. There is a bin
  called `opencode-vitals` now, and the documented commands are
  `npx opencode-vitals install` and `npx opencode-vitals selftest`.
- **The installer never actually ran from npx.** It decided whether it was
  started directly by comparing `process.argv[1]` with its own path as strings;
  npm runs bins through a symlink it creates in `node_modules/.bin`, so the two
  never matched and the command exited silently, with no output and status zero.
  Both sides are resolved through symlinks now, with a regression test that runs
  the commands through a shim shaped exactly like npm's.
- A closed pipe (`| head`) printed a node stack trace; EPIPE is swallowed.
- The README test that generated its checks from the README's npx commands now
  also proves that every subcommand it prints is one the dispatcher accepts.

### Measured

- 162 plugin checks and 56 bar checks, up from 156 and 56. The install, status,
  the `--status` alias and uninstall were run end to end from a packed tarball
  installed through npm.

## [0.1.2] - 2026-09-26

0.1.1 was published before an audit of the shipped code found the problems
below, so the dangerous ones are in it. This release is 0.1.1 plus every fix.

**The install command printed in this release's README does not work**: npm
answers `npx opencode-vitals-install` with 404, and the installer exits silently
when npm runs it through a shim. Both are fixed in 0.1.3, which is otherwise the
same code.

### Fixed

- **Windows: the liveness check killed the process it checked.** Python hands
  any signal other than `CTRL_C_EVENT`/`CTRL_BREAK_EVENT` to `TerminateProcess`,
  so `os.kill(pid, 0)` would have terminated the OpenCode process the bar
  belongs to. Windows now asks `OpenProcess`/`GetExitCodeProcess`, and a test
  asserts that branch never reaches `os.kill`.
- **A bar that died at once was retried every five seconds forever** — measured
  four spawns in sixteen seconds. Short-lived exits back off 15s, 30s, 60s ...
  capped at five minutes, the reason is logged once, and a bar that lived or
  that we stopped resets the counter. After the fix: attempts at 0s, 15s and 30s
  over fifty seconds.
- **A failed compaction swallowed the next response** — measured zero records
  where one was expected. A compaction that ends outside an execution unmutes
  the session now, and a synthetic item no longer mutes the next real prompt.
- **Signalling trusted the pid alone**: a recycled pid in a stale lock could
  receive SIGTERM. Nothing is signalled unless the command line says `bar.py`
  (Linux and macOS); Windows is deliberately fail-open.
- One malformed event ended the event subscription for good; it is skipped and
  counted. The host call for missing token counts has a three second deadline.
  The storage lock waits five seconds before its fail-open path. Session totals
  are evicted by least recently updated. Session ids may contain `-` and `_`.
- The install command's Windows directory was `%APPDATA%\opencode\plugins`, and
  it created that folder; the shipped CLI computes `XDG_CONFIG_HOME || ~/.config`
  on every platform, so the installer follows it and prints the path.
- `--force` over a plain file crashed with `ENOTDIR` instead of replacing it.
  `--uninstall` removed whatever carried the folder name without checking the
  manifest, and the guard that meant to check it could never fire.
- The selftest counted any plugin folder with an `index.js` as an installed
  Vitals, and called a machine untrustworthy before the plugin was installed.
  Runtime facts are notes now, only what the machine can do is required, and the
  verdict names the real state: not installed, restart OpenCode, no bar up right
  now, or ready.
- `python3` is not trusted on Windows as the bar's interpreter: it probes
  `py -3`, `python`, `python3` for tkinter, like the selftest launcher.
### Measured

- 156 plugin checks and 56 bar checks, up from 132 and 44. Both headline fixes
  were re-measured with the same probes that found them.

## [0.1.1] - 2026-09-26

The first release with the one command installer, published before the audit
that produced 0.1.2.

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

### Measured

- 132 plugin checks and 44 bar checks. The install command is covered for:
  copying the shipped list, keeping the shell and Python files executable,
  creating nested directories, being idempotent, removing files that a newer
  release drops, refusing to touch a different package, refusing to replace a
  link without `--force`, linking twice being a no-op, uninstalling, and the
  plugin directory resolution on Linux, macOS and Windows.

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

[0.1.4]: https://github.com/moutazideal/opencode-vitals/releases/tag/v0.1.4
[0.1.3]: https://github.com/moutazideal/opencode-vitals/releases/tag/v0.1.3
[0.1.2]: https://github.com/moutazideal/opencode-vitals/releases/tag/v0.1.2
[0.1.1]: https://github.com/moutazideal/opencode-vitals/releases/tag/v0.1.1
[0.1.0]: https://github.com/moutazideal/opencode-vitals/releases/tag/v0.1.0
