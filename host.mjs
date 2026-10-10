// The readout host.
//
// The readout server used to live only inside OpenCode's background service, and
// the desktop window is opened before that service has finished starting. On a
// cold start the window asked for `http://127.0.0.1:8971/index.html` while
// nothing was listening, and OpenCode answered with "ERR_CONNECTION_REFUSED" — a
// window that never opened. The launcher entry now runs this file first, so a
// server is listening before the window is.
//
// It is run as Node through the app's own Electron binary
// (`ELECTRON_RUN_AS_NODE=1 <app> host.mjs --launch`), so it needs no runtime the
// machine might not have. It binds the same port as the plugin's own server with
// `reusePort`, so the two coexist: an OpenCode update restarts the service and
// the plugin's server with it, and this one keeps answering for the window's
// whole life. It also serves the totals the service plugin publishes to
// `session-totals.json`, so the readout keeps showing the last known numbers
// while the service is away.
//
// It never builds the renderer copy. The plugin and the installer own that, and
// two processes rebuilding one directory is a race with no upside. If there is
// nothing to serve and nothing already listening, the window is opened without a
// readout rather than against a port that answers nothing.
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { PORT, rendererReady, serve } from "./readout.mjs"

const TOTALS_FILE = join(tmpdir(), "opencode-latency-monitor", "session-totals.json")

// The shape the window reads, matching the plugin's own `totalsFor`. Only these
// fields are sent: everything else stays in the plugin's storage.
export function readTotals(sessionID) {
  const answer = { sessionID: typeof sessionID === "string" && sessionID ? sessionID : null, totals: null }
  if (!answer.sessionID) return answer
  try {
    const record = JSON.parse(readFileSync(TOTALS_FILE, "utf8"))
    const totals = record?.sessions?.[answer.sessionID]
    if (totals) {
      answer.totals = {
        turns: totals.turns,
        steps: totals.steps,
        outputTokens: totals.outputTokens,
        tokensPerSecond: totals.tokensPerSecond,
        recentRates: [...(totals.recentRates ?? [])],
        subagentSteps: totals.subagentSteps,
        updatedAt: totals.updatedAt,
      }
    }
  } catch {
    // No file yet, or a write in flight: the window is shown nothing rather than
    // another session's numbers under this one.
  }
  return answer
}

// Is anything already answering on the readout port? A host that started this
// window is not the only server that may be there — the plugin's own is usually
// up on a warm start, and the window must be pointed at it whether or not this
// process managed to bind.
async function healthy({ port = PORT, timeoutMs = 500, fetch: request = fetch } = {}) {
  try {
    const response = await request(`http://127.0.0.1:${port}/__vitals-health`, { signal: AbortSignal.timeout(timeoutMs) })
    return Boolean(response?.ok)
  } catch {
    return false
  }
}

// Start the readout server, resolving to it once it listens or to null if it
// cannot. `reusePort` is the point: the plugin's server binds the same port and
// the two share it.
async function startServer({ port = PORT } = {}) {
  if (!rendererReady()) return null
  return await new Promise((resolve) => {
    let settled = false
    const settle = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const server = serve({
      getSession: readTotals,
      port,
      onListen: () => settle(server),
      onError: () => settle(null),
    })
  })
}

// The launcher's mode: make sure a server answers, then open the window pointed
// at it. The window is opened without a readout only when nothing is listening
// and nothing could be started.
//
// When the window closes the server is not closed at once. An OpenCode update
// relaunches the app a moment later, and that new window asks the same port
// while the restarted service has not bound one yet: closing here would be the
// refused connection this host exists to prevent. So it keeps serving through a
// grace period and leaves only if nothing comes back.
const LAUNCH_GRACE_MS = 45_000

export async function launch(args, { app = process.execPath, spawn: run = spawn, start = startServer, health = healthy, graceMs = LAUNCH_GRACE_MS } = {}) {
  let server = null
  let serving = await health()
  if (!serving) {
    server = await start()
    serving = Boolean(server) || (await health())
  }

  const env = { ...process.env }
  // The child is the application, not another Node: the flag that made this
  // process a script runner must not follow it.
  delete env.ELECTRON_RUN_AS_NODE
  if (serving) env.ELECTRON_RENDERER_URL = `http://127.0.0.1:${PORT}`
  else delete env.ELECTRON_RENDERER_URL

  let child
  try {
    child = run(app, args, { env, stdio: "inherit" })
  } catch {
    try { server?.close() } catch {}
    return null
  }
  const finish = (code) => {
    const leave = () => {
      // The window is gone and nothing came back; leaving the server behind
      // would be a process the plugin never started and cannot stop.
      try { server?.close() } catch {}
      process.exit(code)
    }
    if (server) setTimeout(leave, graceMs)
    else leave()
  }
  // The application's own exit code is the launcher's answer: swallowing it made
  // every crash look like a clean exit to whatever started the launcher.
  child.on("exit", (code) => finish(typeof code === "number" ? code : 0))
  child.on("error", () => finish(1))
  return child
}

// Run directly (`node host.mjs`, or through the launcher entry) rather than
// imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  if (args[0] === "--launch") {
    await launch(args.slice(1))
  } else {
    // A bare run serves and stays; it is what a manual check or the selftest
    // uses. `serve` unrefs the listener so importers do not hang, so the process
    // has to hold it open itself.
    const server = await startServer()
    if (!server) process.exit(1)
    server.ref?.()
  }
}
