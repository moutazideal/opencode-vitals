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

### Measured

- 129 plugin checks and 44 bar checks. The install command is covered for:
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

[0.1.1]: https://github.com/moutazideal/opencode-vitals/releases/tag/v0.1.1
[0.1.0]: https://github.com/moutazideal/opencode-vitals/releases/tag/v0.1.0
