<div align="center">
  <img src="https://raw.githubusercontent.com/moutazideal/opencode-vitals/main/docs/bar.png" width="900" alt="The OpenCode Vitals readout inside OpenCode's own composer: a dark prompt box with the placeholder Ask anything, / for commands, @ for context… and, on the row below it beside the agent, model and send controls, the readings 1 turns, 1 steps, 200 tok/s and 200 last10">
  <h1>OpenCode Vitals</h1>
  <p><strong>Stop guessing how fast your model is. Watch it.</strong></p>
  <p>A tiny always-on-top bar for OpenCode V2 that shows one honest line for the session you are
  working in: turns, steps, the average streaming tokens per second, and the average of the last ten
  responses beside it.</p>
  <p>
    <img alt="platform: Linux verified, macOS and Windows expected" src="https://img.shields.io/badge/platform-Linux%20verified%20%7C%20macOS%20%2B%20Windows%20expected-2ea44f">
    <img alt="dependencies: none" src="https://img.shields.io/badge/dependencies-none-2ea44f">
    <img alt="network calls: none" src="https://img.shields.io/badge/network%20calls-none-2ea44f">
    <img alt="license: MIT" src="https://img.shields.io/badge/license-MIT-8b5cf6">
  </p>
  <p>
    <a href="https://github.com/moutazideal/opencode-vitals/blob/main/CHANGELOG.md">Changelog</a> ·
    <a href="https://github.com/moutazideal/opencode-vitals/releases">Releases</a> ·
    <a href="https://github.com/moutazideal/opencode-vitals/issues">Issues</a>
  </p>
</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/moutazideal/opencode-vitals/main/docs/desktop.png" width="900" alt="A real OpenCode window on a Linux desktop with the vitals readout in its composer, reading 1 turns, 1 steps, 200 tok/s and 200 last10, on the same row as the agent, model and send controls">
</p>
<p align="center"><em>A live session on a real desktop, with the numbers where you already look: 1 turn · 1 step · 200 tok/s · 200 last10.</em></p>

---

## Install

Three ways. The first needs nothing on your machine but Node — no clone, no editing a config file —
so it is the one to start with.

**1 — Check your machine first.** It takes ten seconds and tells you whether the bar can run here:

```bash
npx opencode-vitals selftest
```

**2 — Install it with one command:**

```bash
npx opencode-vitals install
```

That copies the plugin into the folder OpenCode already looks in, and prints the path it used. It
never touches your configuration file, and it makes no network calls: the package it installs is the
one `npx` just downloaded.

**3 — Restart OpenCode.** The bar is on screen within seconds.

### Let OpenCode keep the plugin up to date

Instead of a command, add one line to `opencode.json` or `opencode.jsonc`. OpenCode then installs the
package and updates it itself at startup, and the install command above is never needed:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-vitals"]
}
```

To pass options — a different history size, or the bar off — use the object form:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
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

See [Options](#options) for what the object takes.

### Or copy the folder

Files in the plugin directory are loaded automatically, with no configuration and no command at all:

```bash
mkdir -p ~/.config/opencode/plugins
cp -r opencode-vitals ~/.config/opencode/plugins/opencode-vitals
```

Working on the source instead? See [For developers](#for-developers).

### The install command

```bash
npx opencode-vitals               # install into the plugin directory
npx opencode-vitals install       # the same, said out loud
npx opencode-vitals selftest      # can this machine draw the bar?
npx opencode-vitals status        # what is installed, and which version
npx opencode-vitals uninstall     # remove it again

npx opencode-vitals install --dir PATH   # use a plugin directory you choose
```

`npx` resolves *package* names, not the names of the files inside them, so the command has to be
`npx opencode-vitals <what>`. The two older names still exist for scripts that add the package to a
project: `opencode-vitals-install` and `opencode-vitals-selftest` (run them through npm as
`npm exec --package=opencode-vitals -- opencode-vitals-install`).

Installing twice updates in place and removes files that a newer release no longer ships. It refuses
to replace a directory that holds a different package unless you pass `--force`, and it will not write
outside the plugin directory. `--uninstall` refuses to remove a folder that does not carry this
package's manifest unless you add `--force` too.

The plugin directory is the one OpenCode itself reads — `$XDG_CONFIG_HOME/opencode/plugins`, or
`~/.config/opencode/plugins` when that variable is unset — **on every platform, Windows included**
(verified against the shipped CLI, which computes the same path). The path used is printed, so a
different setup is visible rather than silent.

**Do not run `npm install opencode-vitals`.** OpenCode resolves and installs npm plugins itself at
startup — on this machine each package lands in
`~/.cache/opencode/npm/opencode-vitals@latest/<timestamp>/`. A copy you install into a project's
`node_modules` is not what gets loaded, so it only leaves a second, stale copy on your disk. The
config line is the whole install.

---

## Why

You can feel that a session got slower. You cannot see it.

Every dashboard OpenCode ships answers a different question — cost, token count, context size — and
none of them answer the one you actually have while you work: **is this session fast, and is it
getting slower?** Model output arrives in a stream, so the number that matters is throughput while
the model is generating, not the wall-clock time of a turn that also ran a build, a test, and three
tool calls.

OpenCode Vitals puts that number on your screen, in the corner, all session long.

## What you get

```
+  Build ▾   Space Bunny Free ▾   Max ▾      1 turns  1 steps  200 tok/s  200 last10  [↑]
```

On the row you already look at, inside the app.

Every feature, in one place:

| Feature | What it does |
| --- | --- |
| **Session average** | Turns, steps and average streaming tok/s for the session you are looking at, so one fast reply cannot flatter a long session. |
| **Last ten responses** | `· N last10 resp` is the mean of the rates of the last ten completed **responses**, next to the session average. The session average is the whole session divided as one sum; this one moves as soon as a slow reply lands, which is what tells you the session just changed character. A response with no honest rate is skipped, not counted as a zero. It counts responses, not steps: the steps inside one reply are not ten separate answers, and averaging them would answer a question nobody asked. |
| **Subagent work is counted** | A subagent runs as a session of its own, so its steps and tokens are added to the session that delegated the work. Its own streaming time is **not** — the session's tok/s stays a speed that session actually ran at, and the subagent's own rate stays on its own session. |
| **Inside your app** | The numbers sit in OpenCode's own composer, in the row that already holds your agent and model. No window on top of your work, no taskbar entry, no focus steal. |
| **It follows your tab** | Switch sessions in the app and the numbers switch with them. The readout asks for the session the window says it is showing, so switching project switches the numbers with it — it can never show another project's totals. |
| **Nothing to clean up** | It is drawn by OpenCode's own window, so there is no second process, no lock, and nothing left on screen when you close the app. |
| **It tells you when it updated** | A new version announces itself once in the log, so you can tell the copy you are reading about from the one that is running. |
| **You can check what is running** | `npx opencode-vitals selftest` checks whether this machine can show the readout: the app is installed, its renderer can be copied, the copy is current, and the readout is wired into it. |

<p align="center">
  <img src="https://raw.githubusercontent.com/moutazideal/opencode-vitals/main/docs/bar-mini.png" width="640" alt="The readout close up: 1 turns, 1 steps, 200 tok/s and 200 last10, in the app's own muted and bright text colours">
</p>

## The numbers, exactly

No estimates, no invented numbers. Every value is read from OpenCode's own event stream.

| Number | What it is |
| --- | --- |
| **turns** | Responses completed in this session. |
| **steps** | Model steps across those responses, so a response that called tools five times is not mistaken for a fast one. |
| **tok/s** | `generated tokens ÷ active stream time`, where generated tokens are output plus reasoning tokens, and active stream time is the time the model was actually streaming. Tool executions between steps stay **out** of the denominator. |

How the denominator is chosen, and what each record says about it (`rateSource`):

| `rateSource` | The stream time used |
| --- | --- |
| `stream-span` | The real streaming span: from the first delta of a message to its last, summed over the messages of that response. |
| `first-to-last` | The reply arrived as one piece with no measurable span, so the time from its first token to its last is used. |
| `single-message-total` | The same, and the whole turn was that one message and one step: its own wall time is used. |
| `unavailable` | No honest denominator exists (a multi-message or multi-step response with no measurable stream, i.e. mostly tool time), so `tok/s` stays `–`. |

What counts as model time, and what does not:

| Measured as model time | Not measured |
| --- | --- |
| Text deltas (`session.text.delta`) | Running a tool (`session.tool.called`/`success`), however fast or slow |
| Thinking deltas (`session.reasoning.delta`) | Waiting in a queue, compaction, synthetic items |
| The model writing a tool call's arguments (`session.tool.input.delta`) | Anything the provider never reports |

That last row is what makes the number honest: a step's token count includes the tokens it spends
writing a tool call, so the time spent writing them has to be in the denominator too. Skipping it
used to print `4686 tok/s` on a real turn whose only visible text was 80 characters.

A silence longer than 30 seconds under one message is a dropped connection coming back, not a slow
model, so the span restarts there instead of counting the gap. Session totals are replaced as a whole
snapshot rather than field by field: the tokens of one moment are never divided by the stream time of
another.

Deliberately excluded, because including them would flatter the number:

- **Compaction executions** and synthetic inbox items — they are not your work.
- **Duplicate completions, late deltas, and repeated plugin instances** — deduplicated by event and
  response identity, so a reconnect cannot inflate a session.
- **Wall-clock turn time** — it mixes model thinking with your tools.
- **Parallel and subagent executions** — a second execution starting while one is open closes the
  first, so two answers running at once are two turns instead of one inflated one.

Events this plugin does not recognise are counted and reported on the record
(`unknownEventTypes`) rather than dropped in silence: a renamed or removed OpenCode event would
otherwise delete measurements with no error anywhere. Events that are known but not part of the
measurement — running tools, shells, skills, interface state — are listed as ignored and never
reported.

If the provider reports no token counts, `tok/s` shows `–` instead of guessing. Per-turn detail
(`firstTokenMs`, `firstTextMs`, `firstCharMs`, `totalMs`, `activeStreamMs`, `toolArgCharacters`,
`rateSource`, per-model and per-agent token counts) stays in the plugin's own storage, capped at 100
records, if you want to compute something else.

## Requirements

| | |
| --- | --- |
| OpenCode | V2 (developed against 2.0.14, 2.0.16, 2.0.18 and 2.0.19) |
| Node | 18 or newer, for the plugin |
| Python | **not needed any more** |
| Packages to install | **none** |

Nothing has to be installed beyond this package. The readout is drawn by
OpenCode's own window, so there is no interpreter to find, no display to check
and nothing to build.

## Platform support

Being straight about this, because "works everywhere" is usually a claim nobody
checked:

| | Linux | macOS | Windows |
| --- | --- | --- | --- |
| Measurement core | **tested** | same code, no OS calls | same code, no OS calls |
| Readout in the composer | **tested** — 2.0.19 on GNOME/Mutter, X11 | expected — the app's own UI | expected — the app's own UI |
| Finds the installed app | **tested** — `/opt/OpenCode/resources/app.asar` | `/Applications/OpenCode.app/…` | `C:/Program Files/OpenCode/…` |
| Launcher entry | **tested** — copied from the system `.desktop` | same convention | the Start-menu entry is not replaced |

**Only the Linux column has run on real hardware.** The app is packaged
differently on every platform, so the paths it is looked for at are ordinary
guesses — and a wrong guess is reported rather than worked around. Run the
selftest on your machine and you will know in a few seconds:

```bash
npx opencode-vitals selftest    # after installing from npm
node selftest.mjs               # from a clone
```

```
opencode-vitals 0.1.8

ok   the desktop app is installed  /opt/OpenCode/resources/app.asar
ok   the app has a launcher entry  ai.opencode.desktop.desktop → /opt/OpenCode/ai.opencode.desktop %U
ok   the launcher binary is where the entry says  /opt/OpenCode/ai.opencode.desktop
ok   the app's renderer can be copied  fae2fe5ccfc6602c63fe25ddabae6351 (already current)
ok   the readout renderer is in place  /home/you/.local/share/opencode-vitals/renderer
ok   the readout is wired into the copied page
ok   the page's assets came with it

this machine can show the readout
```

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `popup` | `true` | Show the bar. `false` keeps measuring with no window. |
| `historyLimit` | `20` | Measurements kept in storage, 1–100. |
| `log` | `false` | Log one line per measurement through OpenCode's logger. Errors and version changes are printed either way. |
| `enabled` | `true` | Master switch. |

```json
{
  "plugins": [
    {
      "package": "opencode-vitals",
      "options": { "historyLimit": 50, "log": true, "popup": true, "enabled": true }
    }
  ]
}
```

Environment variables, for the curious:

| Variable | Default | What it does |
| --- | --- | --- |
| `OPENCODE_VITALS_PORT` | `8971` | Port the readout is served on. Also written into the launcher entry, so the two always agree. |
| `OPENCODE_VITALS_DIR` | `~/.local/share/opencode-vitals` | Where the copy of the app's renderer is kept. |
| `OPENCODE_DESKTOP_APP` | detected | Point this at a specific `app.asar` when the app is somewhere unusual. An explicit value is the whole answer, not the first of several guesses. |

The status files (`OPENCODE_LATENCY_FILE`, `OPENCODE_LATENCY_CURRENT_FILE`,
`OPENCODE_LATENCY_TOTALS_FILE`, `OPENCODE_LATENCY_VERSION_FILE`) exist so the measurement can be run
against an isolated directory — the test suite uses them — and rarely need to be set by hand.

## Privacy

This plugin has no network code at all. No registry calls, no analytics, no telemetry, no update
pings. It reads OpenCode's own event stream and writes a handful of small JSON files under your
system temporary directory.

- **Prompts and responses are never stored.** Only counts, timings, model and agent names, and
  session/message identifiers. The last-ten reading is a list of numbers and nothing else.
- **The readout asks the window which session it is showing,** and the answer comes from the app's
  own titlebar. Nothing is read out of the app's state database any more, and no draft text is read
  at any point.
- **One file outside your home directory is read:** the app's own `app.asar`, to copy its renderer
  out so the readout can be wired in. It is opened read-only and never written to.
- **Nothing survives a restart except the numbers.** The status directory is plain files in
  `/tmp`-style temporary storage, and stale response markers are swept on a timer rather than
  waiting for your next message.

## Updating

How you update depends on how you installed it.

| How you installed it | How to update |
| --- | --- |
| `npx opencode-vitals install` | Run the same command again. It updates in place. |
| `npx opencode-vitals install --link` | `git pull` in the checkout; the link picks it up. |
| `"plugins": ["opencode-vitals"]` | OpenCode owns the copy: it resolves the package at startup into `~/.cache/opencode/npm/opencode-vitals@latest/<timestamp>/`. Quit and reopen OpenCode after a new version is published, then check the version below. |
| Copied the folder | Replace the files with the new release. The running plugin picks them up within about five seconds. |

```bash
npm view opencode-vitals version                              # what is published now
ls -d ~/.cache/opencode/npm/opencode-vitals@latest/* 2>/dev/null  # what OpenCode holds
```

OpenCode has its own `update` setting — `"update": "notify" | "auto" | "disable"`, defaulting to
`notify` — and its documentation states that an automatic install does **not** restart a running
server, so something has to restart for a new copy to take effect. Whether that setting also covers
plugins is not something this project has verified.

### Check what is actually running

Do not assume an update landed. The selftest prints the loaded version, and the bar says so out loud:

```bash
npx opencode-vitals selftest
```

```
ok   plugin version recorded — running 0.1.5, package 0.1.5
```

If it still reports the old version, OpenCode reused its cached snapshot. That is the normal case
after a plain restart: each package keeps a single `<timestamp>` directory in the cache, and on this
machine several application restarts produced no second snapshot, so a restart alone is not proof of
a refresh. Quit OpenCode, and if the version still has not moved, stop the leftover sidecar process
— the `opencode-cli serve --service` process — and launch OpenCode again, then run the selftest once
more. On Linux that service is supervised by systemd and can outlive the app window, which is why
reopening the window is not always enough.

### How the plugin announces a new copy

When the module is evaluated it compares its own `package.json` version with the one it recorded in
`plugin-version.json`, with no network call involved:

- the bar shows `0.2.0 installed` for eight seconds, exactly once — even if the update landed while
  OpenCode was closed;
- the plugin log reads `updated 0.1.5 -> 0.2.0`;
- the selftest prints `running <new>, package <new>` and the previous version when there was one.

## For developers

### Work on it from source

```bash
git clone https://github.com/moutazideal/opencode-vitals.git
cd opencode-vitals
npm install
npx opencode-vitals install --link
```

That symlinks the checkout into the plugin directory instead of copying it, so edits reach the
running plugin within five seconds and no restart is needed. Keep the link under the folder name
OpenCode already discovered, or the running instance will be left pointing at nothing.

`npx opencode-vitals status` then reports `link` rather than `copy`, and `npx opencode-vitals
uninstall` removes the link without touching your checkout.

To install a copy of the checkout instead, drop the `--link`. To put it somewhere else, add
`--dir PATH`.

### Development

```bash
npm test           # 215 checks
node selftest.mjs  # can this machine show the readout?
npm pack           # build the publishable tarball
npm run prepublishOnly   # what publish runs first
```

```
opencode-vitals/
├── index.js            the plugin: events, accounting, storage
├── readout.mjs         the readout: reads the app's bundle, serves the copy
├── renderer/vitals.js  the readout as it appears in the composer
├── cli.mjs             npx opencode-vitals (install, selftest, status, uninstall)
├── install.mjs         the installer itself
├── selftest.mjs        can this machine show the readout?
└── tests/vitals.test.mjs
```

Releases are cut by `.github/workflows/release.yml`: bump the version in `package.json`, add the
changelog section, commit. The workflow reads the version, runs the suite, tags and publishes, and
skips a version that is already tagged. A missing changelog entry fails the run rather than
publishing a release with no notes.

The test suite includes the mistakes worth catching twice: zombie holders in the singleton lock, a
session with no totals yet (which must say it has nothing to show rather than borrow another
session's numbers), two projects sharing one status directory, a subagent's tokens reaching its
parent's rate without its stream time, a WAL write that leaves the database timestamp untouched,
process checks on macOS and Windows driven by a fake process list so their logic is verified even
though their hardware was not, a turn whose tokens were counted while the time spent writing its
tool call was not, and a window that covers OpenCode while focus never left it.

## License

MIT. See [LICENSE](LICENSE).
