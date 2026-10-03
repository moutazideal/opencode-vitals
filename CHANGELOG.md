# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.12] - 2026-10-03

The readout stops taking itself away from other projects, and the numbers it
shows are the ones that happened.

### Fixed

- **Cleaning up one project's plugin instance closed the readout for all of
  them.** `readoutServer` is one server for the machine, shared by the instance
  OpenCode loads per project, and every instance's cleanup closed it
  unconditionally. Closing a window left the other open projects with a row that
  never came back, because nothing starts the server again until that project
  reloads. The instance now leaves the pool first, and the socket is closed only
  by the last one to go.
- **A file that vanished between the stat and the read crashed the plugin host.**
  The server pipes the copy of the app's interface straight to the response, and
  a read stream with no error handler turns a deleted asset into an uncaught
  exception — in the process that also measures. The stream now has a handler: a
  plain 503 before the headers, the connection closed after them, never a crash.
- **Two responses that ran at the same speed became one in the last-ten list.**
  The list dropped a rate that equalled the one before it, on the theory that a
  replay had arrived twice. Replays are refused earlier, so the only thing that
  rule could catch was a real response whose speed coincided with its
  neighbour's — and it made the last-ten mean a mean of nine.
- **Publishing the session totals could lose another project's session.** The
  read-merge-write took no lock, while `persist` took one for exactly that
  reason; two instances finishing a turn at once could each write over the
  other. It now takes the same lock.
- **An app update that changed a bundle without changing the asar's size went
  unnoticed.** The fingerprint walked only the top level of `out/renderer` and
  skipped directories, and the app's own bundles live one level down in
  `assets/`. It now hashes every file at every depth, name and content.
- **A failed update was written off until a newer version appeared.** The latch
  recorded the version as attempted whether the update worked or not, so a
  transient failure — a moment offline, a busy registry — was never retried. Only
  success is recorded as attempted now; a failure is retried after the check
  interval.
- **The updater ran `process.execPath`.** On the desktop host that is the
  Electron application, and only some builds answer `plugin update`. The CLI the
  app ships is preferred when it can be found, with `process.execPath` as the
  fallback.
- **The status report was a heartbeat, not a state change.** A composer whose
  slot was missing sent the diagnostic to the server every second for as long as
  it was missing. It is sent on the first failure and on the recovery.
- **A poll with no deadline could hang the readout.** A server that accepted the
  connection and never answered left the fetch pending forever, so `misses` never
  grew and a dead row could never be withdrawn. The poll has a deadline.
- **A plugin registered only in `opencode.jsonc` was reported as not
  registered** when an `opencode.json` also existed, because the config was read
  only until the first file that existed. Both files are read before the answer.
- **A host with no `HOME` crashed the readout module on import**, before any of
  its best-effort guards could run. The fallback is an empty string, as it
  already was in the updater.
- **`install --dir` with no path silently used the default**, and `status`
  created the plugin directory it was only reporting on. Both are fixed.
- The selftest printed a renderer it could not read under the label for one it
  found.

### Changed

- The test suite covers the readout's own invariants now: one server shared by
  many instances and the cleanup that must not close it, an asset that vanishes
  mid-request, two responses with the same rate, a fingerprint over `assets/`,
  the stale lock holder, a failed update retried, and both config files. Three
  claims in the page that described tests from the window era — a WAL timestamp,
  a fake process list for macOS and Windows, a window covering OpenCode — are
  gone, and the check count is checked against the suite instead of remembered.

### Measured

- 419 checks, up from 400.

## [0.1.11] - 2026-09-29

The number that moves is gone, and the page that describes this plugin is true
again.

### Removed

- **The figure for the reply in flight.** The readout showed a live rate beside
  the session's settled one, and it was wrong by construction rather than by
  accident. Tokens only arrive when a model step ends, so a rate had to be
  counted in **characters** while the number beside it was counted in **tokens** —
  and a token is about four characters, so `1600` next to `143` was off by a
  factor of four every single time, with no unit on the provisional one to say
  which was which. On a real session it read as a model running at a third of the
  speed the same session was reporting, which is the one thing this plugin
  exists not to do.

  Its numerator was also missing a term its own denominator included. The time
  the model spends writing a tool call's arguments is streaming time, so it was
  in the denominator, and the characters of those arguments were not in the
  numerator — which is why the figure dipped every time the model called a tool,
  for a reason that had nothing to do with speed. It also disagreed with this
  codebase's own character-based measure, which does include them: the live
  figure counted `characterCount + reasoningCharacterCount`, and the settled
  record's `observedCharactersPerSecond` counted `characterCount +
  toolArgCharacters`. Two rates, both called characters per second, off by
  whatever the model spent writing tools.

  A labelled version would have fixed the unit and left a row carrying two
  different quantities. A token rate could not be produced mid-flight at all
  without estimating, and this project does not estimate. So it is gone rather
  than renamed: a reply in progress has no settled rate to report, and now says
  nothing.

### Fixed

- **Installing reported a version it could not know.** The updater's exit code
  was read as proof of what was installed, which on this machine disagreed with
  the result every time: the command fetches the release correctly and then exits
  non-zero with a stack trace out of its own bundle. Installing asks OpenCode
  which version it ended up with and reports that, which is a fact. A machine
  left on an older release — the failure that second command exists to prevent —
  exits clean and says nothing, so only asking catches it.
- **The documented command failed in a checkout.** `npx opencode-vitals uninstall`
  without a version makes `npx` run whatever the current directory already has,
  which is `node_modules/.bin/opencode-vitals` — stale or absent in a clone — and
  fails with `sh: 1: opencode-vitals: not found`. So the command in the README
  failed for the person most likely to be reading it, standing in the repository.
  Every example now carries `@latest`, and the reason is written beside it,
  because the fix is invisible and the next person to tidy it away solves nothing.

### Documentation

- **"macOS and Windows expected" is now "Linux only".** Expected is a prediction
  wearing a plan's clothes, and a reader cannot tell it from tested. The plugin
  installs and measures on any platform — that part is plain Node with no OS calls
  in it — but the file that starts OpenCode pointed at the readout is a
  `.desktop` entry, and macOS and Windows have no such convention to copy. So on
  those two this measures your sessions correctly and shows you nothing, and the
  page now says exactly that instead of implying a plan it does not have. The
  screenshots, the badge, and the platform table all agree, and a check keeps
  them agreeing.

  The two requirements are now stated where a reader meets them before running
  anything: in the summary at the top of the page, in the requirements table, and
  in the install steps. **Linux**, because the launcher that starts OpenCode
  pointed at the readout is a `.desktop` file, which is a Linux format.
  **OpenCode V2 Desktop**, because the numbers are drawn in the desktop app's
  composer — on the terminal client this measures your sessions correctly and
  shows you nothing, and there is no terminal version of the readout. Neither is a
  preference, and finding either out by trying is how a stranger loses an
  afternoon.

  The badge said "coming soon", which is a promise. The page names what is
  missing and says the other two are not supported, so the badge says that too,
  and gained a second one for the app — a reader who has OpenCode on their
  machine already, in a terminal, is as likely to get this wrong as one on the
  wrong operating system.

- **"This plugin has no network code at all. No registry calls, no update pings."
  That stopped being true in 0.1.9.** A privacy claim one release behind the code
  is worse than no claim, because it is believed. The page now names the one host
  the plugin contacts, says what is sent — a package name — and how often, says
  how to turn it off, and says what it writes outside your home: the launcher
  entry, and when that entry exists. There are checks so these cannot go stale
  quietly again.
- The window on top of the app is gone from the page: the tagline, the install
  steps, the `popup` option, the selftest sample and the updating section all
  described a bar. The updating section is now about the update that happens on
  its own, and includes what to do if OpenCode will not start — which is a thing
  that can happen while this plugin is installed, and is one `rm` away from
  being undone.
- The screenshots are named for what they show. `docs/bar.png` was a picture of
  a composer.
- The issue templates asked for a Python version, which this project has not used
  since 0.1.8, and told people to run a bin name that the page no longer prints.
  Both templates now use the documented command, and the bug report asks for what
  is actually decisive when the readout does not appear: `status`, `plugin list`,
  and whether removing the launcher entry lets OpenCode open.
- `OPENCODE_LATENCY_FILE`, `OPENCODE_LATENCY_TOTALS_FILE` and
  `OPENCODE_LATENCY_VERSION_FILE` were documented in the page and named in a
  comment in the code, and have not been read by this package for some time. The
  status directory follows `TMPDIR`, which is what the page says now. Every
  variable the page names is checked against the code, because a variable that
  exists only in a manual and a comment is indistinguishable from one that works
  until somebody sets it and nothing happens.

### Measured

- 400 checks, up from 373. The removed feature took its checks with it, and what
  replaced them is the property that matters: a response carries the session and
  its totals and nothing else, and a payload that still arrives with a
  provisional figure is drawn without it. The rest are the page checking itself:
  that it names only variables the code reads, that it makes no network claim the
  updater has invalidated, and that what it says about platforms, the badge and
  the requirements table cannot drift apart.

## [0.1.10] - 2026-09-29

Uninstalling a registered install actually uninstalls it.

### Fixed

- **Uninstalling a package install left the launcher entry behind.** The removal
  of the copy in the plugin directory ran first and returned early when there
  was none — which there never is for a registered install, because the package
  is in `node_modules` and no folder is ever written to the plugin directory. So
  the launcher entry, the copy of the app's interface and every measurement
  survived, and what was left pointing at a server that had stopped was the one
  thing that stops OpenCode opening. Found by asking how to uninstall and
  reinstall this by hand, which is how most people will ever do it.
- **Uninstalling said "nothing to remove".** It reported on the copy in the
  plugin directory and nothing else, so on every install made this way it
  announced a no-op immediately after unregistering the package and deleting
  things. It now lists what it removed, and says the one part that is neither
  obvious nor optional: restart OpenCode, because a plugin that is loaded keeps
  running and will put its launcher entry back on its next tick.
- **Installing reported a version it could not know.** The updater's exit code
  was read as proof of what was installed, which on this machine disagreed with
  the result every single time: the command fetches the release correctly and
  then exits non-zero with a stack trace out of its own bundle. So every install
  announced a failure that had not happened, and the second attempt at fixing it
  only made the message vaguer. Installing asks OpenCode which version it ended
  up with, and reports that — which is a fact — instead of an exit code, which
  is not. A machine left on an older release is now caught by the same question,
  which is the failure the exit code would never have shown.

### Changed

- The directories a launcher entry is searched for are read when they are needed
  rather than when the module is loaded, like every other environment lookup in
  this file. A test whose environment changes after the import was searching the
  directories the process started with, and "found nothing" is a reason for a
  removal to be skipped rather than an error — so the case passed for free.

### Measured

- 377 checks, up from 363. The new ones describe the shape every install made
  this way has: no folder, and everything outside it still ours to remove.

## [0.1.9] - 2026-09-29

OpenCode is never allowed to stop opening. Everything else in this release is in
service of that, including two bugs this one introduced and one it could not
have fixed from where it was standing.

### Fixed

- **The readout could stop OpenCode from opening at all.** An empty window with
  a 404 on `index.html`, reported on a real machine after adding the plugin. The
  server is not a side channel: the launcher entry points the whole application
  at it, so a 404 is not a missing readout, it is an application that will not
  start. The entry was being written on every start whatever the copy was doing,
  so a copy emptied behind our back — an uninstall while OpenCode is open, an
  `rm -rf`, a failed sync, a tmp reaper — left the app pointed at a server with
  nothing to serve, until the next ten-minute tick, and for good if the rebuild
  was what had failed. The entry is now written only while there is something to
  serve and removed when there is not, and the ten-minute tick makes the same
  decision, so anything that empties the directory is noticed whatever the cause.
- **A request that missed rebuilt the copy and was answered.** This is what
  closes the window for every cause at once, without this having to know which
  one happened. The cost is a rebuild that blocks the plugin host's event loop
  for as long as the copy takes, which is a trade made on purpose: a two-second
  pause in measuring against an application that will not open.
- **A rebuild no longer deletes the copy before making it.** It builds beside the
  copy and renames, which is atomic, so a reader sees the old copy or the new
  one. A failure in between used to leave no `index.html` at all — a broken
  application, left behind by a plugin that draws numbers.
- **The listening socket is closed with the plugin that opened it.** `unref()`
  stops it holding the event loop open, which is a different thing: the port
  stayed taken, so a reloaded plugin was refused the bind and left with no server
  at all. A readout that stops silently, on every reload.
- **Installing fetches the current release, not only registers the package.**
  OpenCode checks unpinned packages for updates on startup and deliberately does
  not swap the installed one, so a machine that resolved this package while an
  older version was the latest kept it indefinitely — and a version without an
  update check cannot get itself out, because the code that would fix it is the
  code that is not running. Found by installing over a real 0.1.7 and watching
  the old window's files appear in the status directory.
- **The readout gives up its row when the plugin that feeds it is gone.**
  Uninstalling while a window was open left four dashes sitting in the composer
  forever. It goes after ten failed polls and comes straight back if the server
  does.
- **An OpenCode update was silent.** A window left open across one went on
  running the old app's code against the new service, with nothing to say so. It
  says so now, once per update.

### Added

- **Installing registers the package with OpenCode and keeps it current.**
  `npx opencode-vitals install` runs `opencode plugin add`, OpenCode fetches the
  package and checks it on every start, and this plugin applies an update it
  finds through OpenCode's own updater — the binary already running it — and
  tells you to restart. `--no-update` turns it off for good.
- **The launcher entry and the copy of the app's interface are made by the
  plugin, not by the installer.** `opencode plugin add` runs none of this
  package's code, so a plugin that set itself up only when its own installer ran
  would have been a plugin with no readout.

### Changed

- The readout is now served from inside OpenCode's own composer rather than a
  window on top of it, and shows the reply in flight beside the session's own
  figures without ever folding a provisional rate into them.
- `npx opencode-vitals selftest` no longer writes anything. It used to prove it
  could copy the app's renderer by copying it, so running the check on a clean
  machine left 43MB behind — and a check that mutates cannot be run twice to see
  whether anything changed.

### Measured

- 363 checks, up from 257. Fewer things have no tests at all now: the renderer in
  the app's own window, the update path, and the states in which OpenCode must
  still open.

## [0.1.8] - 2026-09-29

The window is gone. The numbers are drawn by OpenCode's own UI now.

### Added

- **The install is now a package OpenCode owns, and it keeps itself current.**
  Installing runs `opencode plugin add opencode-vitals`, which adds one unpinned line to
  `opencode.json`; OpenCode fetches the package itself and checks it for a newer release on every
  start. Because it will not swap code under a running process, this plugin applies the update a few
  seconds after launch through OpenCode's own updater — the binary already running it — and says so
  in the log. `npx opencode-vitals status` reports which of the two shapes a machine has, and a copy
  is now labelled as the shape that can never update itself.
- `npx opencode-vitals install --no-update` turns the automatic update off for good, by writing a
  marker; `OPENCODE_VITALS_NO_UPDATE=1` does the same for one process.
- **The numbers move while a reply is streaming.** They used to be written only
  when a response finished, so the readout sat on the previous reply's figures for
  the whole of the current one — the one moment they are worth watching. The
  figures for a reply in progress now appear beside the session's, dimmed and
  labelled `now`, and they are never folded into the session's own totals: a rate
  that will still change, counted as though it had not, would make one number mean
  two things at once.

### Changed

- **The readout lives inside OpenCode's composer.** The row that already holds
  your agent, your model and the send button now also holds `9 turns · 35 steps ·
  129 tok/s · 114 last10`. No window on top of your work, no taskbar entry, no
  focus steal, and nothing to close by hand.
- The readout is a copy of the app's renderer with **one script tag added beside
  the app's own bundle**. The app's bundle is never rewritten, and the app is
  pointed at the copy through the variable it already reads, so the ordinary
  OpenCode icon starts it — no new launcher to learn, and nothing under the
  install prefix is touched.
- **One server, in the plugin's own process.** There is no child to start,
  supervise, lock or stop. The server answers for the session the window says it
  is showing, so switching project switches the numbers with it.
- Installing sets up the renderer copy and the launcher entry; uninstalling takes
  both away, so a removed plugin cannot leave the app starting differently.
- `npx opencode-vitals selftest` now answers a different question: whether this
  machine can show the readout at all. It checks the app is installed, that its
  renderer can be read and copied, that the copy is current, and that the readout
  is wired into it. It starts nothing and opens nothing.
- The readout follows OpenCode's own theme, taking colour from the app's CSS
  variables rather than hardcoding it, and lays out with `margin-inline-end` so
  it is correct in a right-to-left locale.

### Removed

- **`bar.py`, `selftest.py` and `start-bar.sh`** — about 2,800 lines of Tkinter, a
  singleton lock file, a respawn backoff ladder, a parent-pid liveness check and
  four platform-specific ways of asking whether the app was still open. All of it
  existed because the drawing happened outside the app. The package no longer
  needs Python, and the test suite is one file.
- The idle rules, the window-following, the resize and collapse, the position and
  scale files, and the scale and window-hiding variables. They described a
  window. Nothing about a row inside a composer needs them.
- 142 bar checks, replaced by 24 that cover what is left — the asar reader
  against the documented format, the injection, the launcher entry, and the
  numbers the readout is actually served.
- **`latest.json` and `current-session.json`**, which existed only to tell a
  separate process which session was on screen. The readout is asked directly, so
  the second was taking a storage lock — the same one the totals take — on every
  prompt, to write a file nobody read.
- **Eight of the nine fields in the shared plugin state**, which tracked a
  spawned bar's retries, and with them the two functions that existed only to
  feed them.

### Fixed

- **The readout could only ever know the first project.** The server belonged to
  whichever plugin instance started it, so a project that loaded later found no
  numbers at all. Session ids are unique across the machine, so the answer is now
  whichever live instance knows the session, and an instance leaves the pool with
  its cleanup.
- **The server and the renderer copy were coupled.** A machine with no desktop app
  — headless, TUI-only — had its numbers go nowhere, because the server only
  started if the copy could be made. They are independent: the numbers are served
  whether or not anything can draw them.
- The listening socket no longer holds the event loop open, so importing this no
  longer leaves a process hanging on exit.
- **The package depended on itself.** `"dependencies": {"opencode-vitals":
  "^0.1.7"}` arrived by accident in a documentation commit. Anyone who installed
  it pulled a second copy of this plugin into their `node_modules` — the previous
  one, complete with the Python window. This had not shipped, but it broke the
  zero-dependency promise outright.
- **The readout had no way to report that it was missing.** The one diagnostic
  for "the app renamed a slot and the row silently is not there" was answered
  with the app's whole HTML page, once a second, forever. It is answered now, and
  a failure is reported once rather than continuously.
- **Uninstall left half of itself behind.** It emptied the work directory without
  removing it, and left the measurements in the temporary directory: a readable
  record of every session on the machine, and a fresh install that seeded itself
  from the last one's numbers. Both are gone; anything in that shared directory
  that is not this plugin's is left alone.
- `npx opencode-vitals selftest` reported the `.desktop` directories when the
  paths it had actually searched were the app bundles, and the installer still
  told the user a window was about to appear.
- `docs/desktop.png` is used by this page and was not in the shipped file list.
- **The readout's own launcher entry is written by the plugin, not only by the installer.** The
  supported way to install this plugin runs none of its code — `opencode plugin add` only edits a
  config file — so a plugin that set itself up only when its own installer ran would have been a
  plugin with no readout. Writing the entry is a no-op when it is already correct, so it does not
  touch the file's timestamp on every launch.
- **A machine that had resolved an older release could never leave it.** OpenCode
  checks unpinned packages for updates on startup and does not swap the installed
  one — it loads the cached copy immediately and checks in the background. So a
  machine that resolved this package while an older version was the latest kept
  that version indefinitely. It was found by installing over a real 0.1.7 and
  watching the bar's own files appear: `plugin add` registered it, and the
  package that loaded was the cached 0.1.7, complete with `bar.py`. Installing now
  fetches as well as registers, and reports the two outcomes apart, because
  "installed" and "installed the right one" are different claims. A fresh machine
  is unaffected either way, which is why only machines already on an old version
  ever saw it — and why the version that could have fixed it was the version that
  never ran.
- Uninstalling and reinstalling left the plugin loading twice: once as the registered package and
  once as the copy the old installer had made. Installing removes the copy; `status` names both
  shapes if it finds them.
- A test run could reach the real OpenCode CLI, because uninstalling now calls it. The config root is
  redirected to a temporary directory for the whole suite.

### Measured

- 351 checks, up from 257 — the renderer and the update path were the two parts with no tests at all. Fewer because a window is gone; the ones that remain
  cover the measurement, the readout, and the failure modes of both.

## [0.1.7] - 2026-09-28

The idle window is ten seconds, and it no longer mistakes a slow reply for an
idle machine.

### Fixed

- **A long reply took the bar down with it.** The idle window was measured from
  the last *finished* response, so a reply that streamed for a minute — before
  any record existed — put the bar away at the exact moment its numbers were
  worth reading. Liveness is now stamped by any event for a session, so work in
  progress keeps the bar up.
- **A replayed batch of events could pass for a live session.** The stamp used
  the event's own `created`, and a replayed event carries the time it was
  recorded, not the time it arrived. It is the arrival time now.
- The companion tick is 1s, down from 5s, so the bar leaves inside the ten
  seconds it promises instead of at the next five-second boundary.

### Changed

- `IDLE_HIDE_MS` is 10 seconds, down from fifteen minutes, and `COMPANION_TICK_MS`
  is 1s. Both are exported. A session that has never sent an event still keeps
  the bar, so a first run is not a bar that never appears.

### Measured

- 250 plugin checks and 142 bar checks, unchanged from 0.1.6 in count and
  different in content: the idle cases now pin that activity beats a finished
  record, that a replayed event counts as activity now, that the tick fits
  inside the window, and that the same runtime stands the bar down once the
  events stop.

## [0.1.6] - 2026-09-28

The bar stopped showing you somebody else's numbers, and stopped ignoring the
work you delegated.

### Fixed

- **A session with no measurements displayed another session's totals.** The bar
  resolved no session for a freshly opened tab and fell back to the last session
  that published a record, so a new session showed another one's turns and
  tok/s with nothing on screen to say so. It now says it is waiting for a
  response, and names no number it cannot attribute.
- **Every OpenCode instance on the machine overwrote the current session.** The
  status directory is one temporary path shared by all of them, and the current
  session was a single slot, so the last instance to publish won it. The file is
  now a map keyed by project, and the plugin merges the other entries instead of
  replacing them. A v1 file is still read, so a bar and a plugin from different
  versions can overlap during an update.
- **The bar is told which project spawned it.** It is one window for one screen
  and every project shares the files it reads; it now answers only with sessions
  belonging to its own project, and falls back to a guess only when there is
  exactly one candidate and so nothing to choose between.
- **Subagent work was never counted.** A subagent runs as a session of its own,
  so its steps and tokens landed in a bucket nobody was looking at: measured on
  one machine, 22 of 50 tracked sessions were subagents holding 3267 of 5044
  steps. The parent link is now asked of the session API once per session, and
  the delegated steps and tokens are credited to the session that asked for the
  work.
- **A bar outlived every session it was measuring.** Whether a bar belongs on the
  screen was decided from the OpenCode process being alive, and a service stays
  alive with nothing open, so the bar stayed up for a program nobody was using.
  It now stands down ten seconds after the last event from a session. A session
  that has never sent an event keeps the bar, so a first run still shows it.
- **A long reply no longer takes the bar down with it.** The idle window counts
  any event, not a finished response, so a reply that streams for a minute keeps
  the bar on screen — which is when it is worth reading. The stamp is the
  arrival time and not the event's own `created`, so a replayed batch of old
  events cannot pass as a live session. The companion tick is 1s, so the bar
  leaves within the ten seconds it promises rather than at the next multiple.
- The `last10` label now reads `last10 resp`. It is the mean rate of the last ten
  **responses** and always was; the steps inside one reply are not ten separate
  answers. The card is 450 pixels wide to fit the clearer label.

### Changed

- A subagent's streaming time is deliberately **not** added to its parent's. The
  session rate is generated tokens over stream time, and a subagent's tokens
  without its seconds would print a speed the parent never ran at. The parent's
  rate stays its own; the subagent's rate stays on its own session, where its own
  time is known. Delegated work is counted apart in `subagentTurns` and
  `subagentSteps` so the split is visible in the record.
- Sessions carry their `project`, and every totals snapshot carries it too, so a
  bar can tell "not measured yet" from "another project's measurement".
- `barExpectedFrom` takes an `openSessionAt`; `SUBAGENT_FIELDS`,
  `SESSION_LOOKUP_TIMEOUT_MS`, `IDLE_HIDE_MS` and `COMPANION_TICK_MS` are
  exported for the tests.

### Measured

- 250 plugin checks and 142 bar checks, up from 223 and 135. The bar suite grew
  by seven checks that pin the new attribution rules: no borrowing another
  session's numbers, per-project isolation, a v1 file still readable, and the
  delegated work counted in the parent without touching its rate. The plugin
  suite grew by nine: the subagent credit and every way it must not leak into
  the parent's rate, a root session, a missing session API, the project on the
  record, and the per-project current-session map. The idle rules are pinned as
  well: a session active now keeps the bar, an idle one loses it, a session never
  heard from keeps it, the tick fits inside the window, and a replayed event
  counts as activity now rather than as the hour-old stamp it carries.

## [0.1.5] - 2026-09-26

Honest numbers, a second reading, and a bar you can size.

### Added

- **The average of the last ten responses, next to the session average.**
  `· N last10` is the mean of the rates of the last ten completed responses for
  the session on screen. The session average is the whole session divided as one
  sum and barely moves once a session is long; the last-ten reading reacts to the
  reply you just watched. The per-response rates are kept in the session totals
  (`recentRates`), so they survive a plugin reload and travel with the totals
  snapshot the bar already reads. A response with no honest rate is skipped
  rather than counted as zero.
- **The bar is yours to size.** Drag the bottom-right grip, or hold Ctrl and use
  the wheel; everything scales together and the size is remembered in
  `popup-scale.json`. Right-click resets it to 100%, `OPENCODE_LATENCY_SCALE`
  pins it from the environment, and the range is 0.6×–2.5×. The collapsed bar
  scales with the same number.
- **The bar steps aside when your attention moves.** On Linux/X11 the window is
  followed three ways now: minimized (`_NET_WM_STATE`), another program focused
  (`_NET_ACTIVE_WINDOW`), or another window covering OpenCode
  (`_NET_CLIENT_LIST_STACKING` plus real window geometry, 60% coverage). Everything
  is fail-open — when a question cannot be answered the bar stays visible — and
  each part can be switched off with `OPENCODE_LATENCY_HIDE_UNFOCUSED=0` or
  `OPENCODE_LATENCY_HIDE_OCCLUDED=0`.
- The selftest reports whether `xprop` and `xwininfo` are present, as notes.
- New screenshots: the bar and the collapsed bar captured at 2× from the running
  program with the last-ten reading on screen, and a real desktop capture sent in
  by the project's author, whose bar is reading `7 turns · 66 steps · 243 tok/s ·
  311 last10`. Every caption in the README shows the numbers its picture shows.

### Fixed

- **Clicking the bar made it flicker.** Tk's `winfo_id()` names the child window
  it draws in, while the window manager tracks its parent — and the parent is
  what `_NET_ACTIVE_WINDOW` reports the moment the bar is clicked. The bar only
  knew the child id, so its own window looked like another application: click,
  hide, focus back to OpenCode, show, click again. The window manager's window is
  now matched once by title (`_NET_WM_NAME`), and a click on the bar counts as
  being in the app.
- **A restart could freeze a session's totals, last-ten list included.** History
  keeps twenty records across every session, so a plugin that rebuilt its view
  from history alone came back *behind* the totals it had already published; the
  whole-snapshot rule then correctly kept the newer on-disk entry, and the
  rebuilt count had to catch up before anything moved again. The totals file is
  now part of the seed — history first, then the file, newest snapshot per
  session — and the merged view is published at startup instead of waiting for
  the next response.
- **The last-ten list is not seeded from rates measured the old way.** A rate
  from before the tool-call fix is a different quantity (that is where the
  4686 tok/s came from), so mixing it into an average would put a number nobody
  can defend in front of the user. The list starts with the first response
  measured the current way, and a totals snapshot that already carries one keeps
  it.
- **The bar's second reading was the wrong reading.** A rolling window of the
  last chunks was briefly tried and removed: what the number is for is the
  average speed of the last ten responses, and a per-chunk reading answered a
  question nobody asked — while a session average already answers the long view.
- **A four digit rate pushed the second reading off the card.** Rates of 1000 and
  above are printed short (`4.7k`), so one line always fits, and the card is 390
  pixels wide instead of 360.
- **Model speed was overstated, sometimes wildly.** A step's token count includes
  the tokens spent writing its tool call, and those arguments stream as
  `session.tool.input.*` rather than text — they were counted in the numerator
  with no time in the denominator. On this machine that printed `4686 tok/s` for
  a turn whose visible output was 80 characters. The tool-call arguments are now
  measured as model time, and the record carries `toolArgCharacters` and
  `toolArgDeltaCount` so the arithmetic can be checked.
- **The one-message wall-clock fallback no longer fires on a tool-using turn.**
  It is only used when the turn really was a single message and a single step;
  otherwise the record reports `unavailable` instead of a flattering number.
- **Session totals could describe a state the session never had.** The plugin
  and the bar each took the maximum of every field separately when merging
  totals, so a record could hold one turn's token count next to another turn's
  stream time — and every reader divides one by the other. Totals are ranked and
  replaced as a whole snapshot now (`turns` first, timestamp as the tie-break),
  in `mergeSeededTotals`, `updateSessionTotals`, `publishSessionTotals` and the
  bar's `merge_totals`, with `snapshotRank` and `newerSnapshot` on the plugin
  side and `snapshot_rank` in the bar. An older snapshot can no longer walk the
  numbers backwards.
- **Publishing totals erased the other projects' sessions.** Several instances
  of this plugin share one totals file, one per project directory, and each wrote
  only what it knew. The on-disk sessions are merged in before writing now.
- **A reconnect inflated the denominator.** A stream that stops for longer than
  30 seconds and continues under the same message id was interrupted, not slow;
  the span restarts there instead of counting the silence (`STREAM_GAP_LIMIT_MS`).
- **A reply that arrived in one piece showed no rate at all.** When there is no
  measurable stream span and the response is a single message, the rate falls
  back to first-to-last and then to that message's own wall time. A multi-message
  response still refuses a rate, because there the wall time is mostly tool time.
  The record now carries `rateSource` so the fallback is visible.
- **Two executions running at once were reported as one turn.** A second
  `session.execution.started` with evidence closes the open turn first, so
  parallel work and subagents no longer merge into a single inflated turn. Step
  tokens are kept per agent on the record (`agents`).
- **Unknown event types were dropped in silence.** Anything outside
  `HANDLED_TYPES`/`IGNORED_TYPES` is counted, reported on the record as
  `unknownEventTypes` and logged at most once every few minutes. A renamed or
  removed event used to delete measurements with no error anywhere.
- **The bar was polling far harder than it needed to.** Records are read through
  a stat-based cache (`RecordCache`), the poll beat went from 200ms to 500ms,
  the search for the OpenCode window runs on its own slower beat with rejected
  window ids remembered, and the announcement write moved out of the render path
  (`announce_pending_update`).
- **A bar that correctly stood down was counted as a crash.** The bar now exits
  with code 6 when another instance owns the lock, and the plugin treats that as
  the wanted state: the failure count resets and the next look is 30 seconds
  later, instead of an escalating backoff and a failure line in the log.
- **The `/proc` walk no longer blocks the event loop**, and a desktop-process
  scan is cached while it resolves, so `desktopAppAlive()` answers immediately
  instead of holding up every other event.
- The status directory is created `0700`; the lock deadline is 2 seconds past
  the TTL so a waiter and its holder cannot expire together; the plugin no longer
  resurrects a version notice the bar has already shown; `install.mjs` documents
  `npx opencode-vitals install` rather than the name npm answers with 404.

### Changed

- `log` defaults to **`false`**: one line per completed turn in somebody else's
  log file is noise, and the numbers are on the bar. Errors and version changes
  go through a new `warn()` path that prints whatever the option says.
- `PLUGIN_ID` is `opencode-vitals` in log lines. The status directory and the
  `OPENCODE_LATENCY_*` variables keep their older names on purpose: the bar, the
  selftest and every installed copy already agree on those strings.
- The bar's collapsed state is `set_collapsed`/`collapsed` rather than reusing
  `set_minimized`, which is a different thing (the window manager's).
- Tool execution events (`session.tool.*` apart from `session.tool.input.*`),
  `session.step.streamed` and the interface families are listed as known and
  deliberately unmeasured, so a normal session no longer reports them as unknown
  events. A renamed measurement event still shows up as unknown.

### Measured

- 223 plugin checks and 135 bar checks, up from 166 and 66.

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

[0.1.8]: https://github.com/moutazideal/opencode-vitals/releases/tag/v0.1.8
[0.1.7]: https://github.com/moutazideal/opencode-vitals/releases/tag/v0.1.7
[0.1.6]: https://github.com/moutazideal/opencode-vitals/releases/tag/v0.1.6
[0.1.5]: https://github.com/moutazideal/opencode-vitals/releases/tag/v0.1.5
[0.1.4]: https://github.com/moutazideal/opencode-vitals/releases/tag/v0.1.4
[0.1.3]: https://github.com/moutazideal/opencode-vitals/releases/tag/v0.1.3
[0.1.2]: https://github.com/moutazideal/opencode-vitals/releases/tag/v0.1.2
[0.1.1]: https://github.com/moutazideal/opencode-vitals/releases/tag/v0.1.1
[0.1.0]: https://github.com/moutazideal/opencode-vitals/releases/tag/v0.1.0
