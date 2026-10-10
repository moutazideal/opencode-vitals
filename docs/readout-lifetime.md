# The readout server and OpenCode updates

Why the readout keeps a launcher host, and why it still keeps no daemon.

## The problem

The numbers are drawn by OpenCode's own window, which loads a copy of the app's
renderer from a small HTTP server the plugin runs on `127.0.0.1:8971`. That
server lives inside OpenCode's background service, because that is where plugins
run.

The desktop window, however, is opened before that service has finished starting.
Two failures came from that, and they are different:

- **A stale window across an update.** An OpenCode update restarts the service
  while the window keeps running. A window that loaded the previous copy then
  lazily imports its own hashed chunks, and during the moment between the old
  service closing and the new one binding, nothing answers on the port. The first
  start after an update showed "Failed to fetch dynamically imported module".
- **A cold start.** After a reboot the service is not running at all. The window
  asked for `http://127.0.0.1:8971/index.html` about a second after it opened,
  the readout server was twenty seconds away, and the window did not open:
  `ERR_CONNECTION_REFUSED`.

Both were observed in OpenCode's own logs, not inferred.

## The adopted fix

Two halves, each covering one failure.

**Content-addressed assets are served as immutable; everything else is not.**
Every file the build emits is named for its content (`main-B1_1SgTN.js`), so the
same name can never hold different bytes and the window may keep it forever. The
shell, the readout script and the two fonts the build did not hash stay
`no-store`, so a plugin update is still seen at once. The window answers its own
chunk requests from its cache, and the gap during a service restart never reaches
it. This is the remedy Vite documents for the same error ("version skew").

**The launcher entry starts a readout host before the window.** `host.mjs` runs
as Node through the app's own Electron binary — no runtime the machine might not
have — binds the same port, and only then opens the window. The plugin's own
server binds the same port too; `reusePort` lets the two share it, so an OpenCode
update that restarts the service cannot leave the window without a server, and a
cold start meets one that is already listening. The host never builds the renderer
copy (the plugin and the installer own that; two processes rebuilding one
directory is a race with no upside); if there is no copy to serve, the window is
opened without a readout rather than against a port that answers nothing. It also
serves the totals the plugin publishes to `session-totals.json`, so the numbers
survive the service being away.

The host is not a daemon. It is started by the launcher, lives exactly as long as
the window, and is killed when the window closes. Nothing is left behind, and
there is no process the plugin started that it cannot stop.

## Why a host and not a daemon

A long-lived daemon that outlives every window was still rejected. It would trade
a rare, now-covered failure for a class of process failures — an orphaned daemon
holding the port with a stale copy, a port conflict between two daemons, a daemon
running old code after a plugin update — and the plugin is deliberately built with
no second process to supervise. The launcher host is the smallest thing that
covers the cold start while keeping that property: its lifetime is the window's.

## What else was considered

**`reusePort` alone.** Two servers on one port is exactly what the host and the
plugin use; it is what makes them coexist, not a fix on its own. It cannot close
the service-restart gap by itself, because the two servers there do not overlap in
time.

**systemd socket activation.** PID 1 can own the listening socket and hand it to
the service, surviving restarts. Rejected: it requires systemd-managed units, and
the plugin must not impose a service manager on the machine it is installed on.

**Electron custom protocols (`protocol.handle`).** The app could serve its own
renderer from the main process with no HTTP server at all. Rejected: the plugin
cannot modify OpenCode's main process, and the numbers still need a live source.

**A service worker.** It would prefetch and cache every asset and serve them
offline — a stronger version of the HTTP cache. Rejected as more machinery for the
same effect, in a page that is not ours to own.

**Prefetching every chunk in `index.html`.** Rejected: tens of megabytes on every
start, undoing the code splitting the app chose.

**The TUI plugin API.** OpenCode has an official, supported UI extension point for
the terminal (`@opencode/plugin/tui`, with slots at `prompt.footer.status` and
`session.composer.top`) and none at all for the desktop window. The desktop
readout is therefore a hack by construction; a clean plugin is a terminal plugin,
which is a different product. If the desktop ever gains a UI plugin API, this whole
file is what it replaces.

## When to revisit

The desktop readout is the thing to revisit if the launcher host ever fails in a
way the plugin cannot see, or if OpenCode grows a desktop UI plugin API. Until
then, `reusePort` and the launcher host are the two mechanisms that keep a hack
from breaking the window.
