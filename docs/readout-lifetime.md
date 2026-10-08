# The readout server and OpenCode updates

Why the readout keeps no second process, and what would have to be true to
change that.

## The problem

The numbers are drawn by OpenCode's own window, which loads a copy of the app's
renderer from a small HTTP server the plugin runs on `127.0.0.1:8971`. That
server lives inside OpenCode's background service, because that is where plugins
run.

An OpenCode update restarts that service. The app window, however, outlives the
restart: it was started pointed at the readout server and keeps asking it for the
renderer's chunks. Between the old service closing its listener and the new
service's plugin binding one, nothing answers on port 8971, and a window that
asks for a chunk in that moment is told the module failed to fetch — the red
"Something went wrong" screen on the first start after an update. The second
start works because by then the copy is already current and the server comes up
at once.

This was observed in OpenCode's own logs, not inferred:

- the failing session was app `2.0.25` while the renderer it loaded reported
  `2.0.24`;
- the renderer wrote its fatal error *before* the new service had loaded the
  plugin at all;
- the chunk it could not fetch had been loaded before — Chromium's code cache
  held it — but the HTTP cache did not, because the server answered `no-store`.

## The adopted fix

Content-addressed assets are served as immutable; everything else is not.

Every file the build emits is named for its content (`main-B1_1SgTN.js`,
`migration-status-Dh5dTlMu.js`), so the same name can never hold different bytes
and the window may keep it forever. Those files are served
`public, max-age=31536000, immutable`. The shell, the readout script and the two
fonts the build did not hash stay `no-store`, so a plugin update is still seen at
once.

The window then answers its own chunk requests from its cache, and the gap in
which no server is listening never reaches it. This is the remedy Vite documents
for the same error ("version skew"): keep old chunks, cache content-addressed
assets, do not cache the HTML. The plugin already keeps the previous copy
(0.1.13); this is the other half.

## What was considered and rejected

**A separate host process (app-session or long-lived).** A process the plugin
starts and supervises, owning port 8971 independently of the service, would close
the gap entirely. It was rejected because it trades a rare, now-mitigated failure
for a class of process failures — an orphaned host holding the port with a stale
copy, a port conflict between two hosts, a host running old code after a plugin
update — and because the plugin is deliberately built with no second process to
start, stop, supervise or leave behind. A supervision bug would break OpenCode,
which is the one thing the plugin may not do.

**`reusePort` (Node 22.12+, Linux 3.9+).** `server.listen({ reusePort: true })`
lets two servers bind the same port at once, the kernel spreading connections
between them. It does not close *this* gap, because the two servers do not
overlap in time: the old one is gone before the new plugin is loaded. It is
recorded here because it is the technique that would make a future host upgrade
seamless — the new host binds before the old one exits — and that is the only
reason a host might one day be justified.

**systemd socket activation.** PID 1 can own the listening socket and hand it to
the service, surviving restarts. Rejected: it requires systemd-managed units, and
the plugin must not impose a service manager on the machine it is installed on.

**Electron custom protocols (`protocol.handle`).** The app could serve its own
renderer from the main process with no HTTP server at all. Rejected: the plugin
cannot modify OpenCode's main process, and the numbers still need a live source.

**A service worker.** It would prefetch and cache every asset and serve them
offline — a stronger version of the HTTP cache. Rejected as more machinery for
the same effect, in a page that is not ours to own.

**Prefetching every chunk in `index.html`.** Rejected: tens of megabytes on every
start, undoing the code splitting the app chose.

## When to revisit

The fix covers every failure observed so far, because the window loads the
previous copy during the gap and its chunks were loaded in the previous session.
The trigger to revisit is a failure whose chunk has **no** prior entry in the
app's code cache — that is, a chunk the window asks for during the gap that it
never fetched before. If that is ever seen, a host process becomes justified, and
`reusePort` is how its upgrades stay seamless.
