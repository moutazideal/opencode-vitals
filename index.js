import { spawn, spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const PLUGIN_ID = "opencode-vitals"
// The status directory and the OPENCODE_LATENCY_* variables keep the name this
// plugin had before it was called opencode-vitals. The bar, the selftest and
// every installed copy agree on those strings, so renaming them here would
// orphan a bar that is already running. PLUGIN_ID only ever appears in a log
// line, so it carries the name people actually recognise.
const STORAGE_KEY = "history-v2"
const DEFAULT_HISTORY_LIMIT = 20
const MAX_HISTORY_LIMIT = 100
const STATUS_DIR = join(tmpdir(), "opencode-latency-monitor")
const STATUS_FILE = join(STATUS_DIR, "latest.json")
const CURRENT_SESSION_FILE = join(STATUS_DIR, "current-session.json")
const SESSION_TOTALS_FILE = join(STATUS_DIR, "session-totals.json")
const BAR_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "bar.py")
const RESPONSE_MARKER_TTL_MS = 10 * 60 * 1000
const STORAGE_LOCK_TTL_MS = 5 * 1000
const MAX_IGNORED_MESSAGE_IDS = 500
const MAX_CLOSED_TURNS = 500
const MAX_INBOX_TYPES = 200
const MARKER_PRUNE_INTERVAL_MS = 60 * 1000
// A bar that starts and dies at once (no tkinter, no display, crashed Tk) used to
// be retried every five seconds forever. Consecutive short-lived exits back off
// instead, and a bar that stays up resets the counter.
const POPUP_BACKOFF_BASE_MS = 15 * 1000
const POPUP_BACKOFF_MAX_MS = 5 * 60 * 1000
const POPUP_SHORT_LIVED_MS = 10 * 1000
// The bar exits with this code when another instance already owns the lock.
// That is the correct outcome, not a crash, so it must not escalate the backoff
// or fill the log with a bar that "failed".
const LOCK_HELD_EXIT_CODE = 6
const LOCK_HELD_RETRY_MS = 30 * 1000
const SESSION_CONTEXT_TIMEOUT_MS = 3000
// A stream that stops for longer than this and then continues under the same
// message id was interrupted (a reconnect, a resumed generation). The idle gap
// is not model time, so it must not end up in the denominator of tok/s.
const STREAM_GAP_LIMIT_MS = 30 * 1000
// The status directory lives in a temporary directory, which on Linux is
// world-writable and shared. 0700 keeps another local user out of the files.
const STATUS_DIR_MODE = 0o700
const UNKNOWN_TYPE_LIMIT = 50
const UNKNOWN_TYPE_LOG_INTERVAL_MS = 5 * 60 * 1000

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const now = () => Date.now()
// Runtimes and companions are keyed on globalThis so repeated module evaluation shares them.
const RUNTIME_KEY = Symbol.for("opencode.latency-monitor.runtimes")

// OpenCode runs plugin setup once per location and may evaluate this module more
// than once in the same process, so the companion state lives on globalThis.
const COMPANIONS_KEY = Symbol.for("opencode.latency-monitor.companions")
const companions = globalThis[COMPANIONS_KEY] ?? (globalThis[COMPANIONS_KEY] = {
  popup: null,
  popupBuild: 0,
  popupChain: Promise.resolve(),
  popupUnavailableUntil: 0,
  popupFailures: 0,
  popupStartedAt: 0,
  popupPython: null,
  lastMarkerPruneAt: 0,
  desktopCheck: null,
})

const BAR_LOCK = join(STATUS_DIR, "popup.lock")
const PLUGIN_VERSION_FILE = join(STATUS_DIR, "plugin-version.json")
// How many recent responses the bar averages for its "last 10" reading. The
// session average answers "is this session fast"; this answers "was the work I
// just watched fast", which is the question a long session's average stops
// being able to answer.
const RECENT_RATE_COUNT = 10
// Mirrors SUBAGENT_FIELDS in bar.py: the delegated-work counters travel with the
// snapshot, so a bar from another version still keeps them.
const SUBAGENT_FIELDS = ["subagentTurns", "subagentSteps"]
// A slow or absent session API must not hold a finished measurement open: the
// turn is already complete and its numbers are already known.
const SESSION_LOOKUP_TIMEOUT_MS = 2000
// How often the plugin reconsiders whether a bar belongs on the screen, and how
// long a session may go without any event before the bar stands down. OpenCode
// keeps running with no session open, and a measurement bar outliving every
// session it was measuring is the bug this pair removes. The tick is a fraction
// of the idle window so the bar leaves when it says it will.
const COMPANION_TICK_MS = 1000
const IDLE_HIDE_MS = 10_000
// The OpenCode service is supervised by systemd and outlives the Desktop app, so
// the bar cannot be tied to the plugin process alone. No server event reports a
// client disconnect, so the app process itself is the signal.
const DESKTOP_PROCESS_NAMES = ["ai.opencode.desktop", "opencode-desktop", "OpenCode"]
const DESKTOP_MISSING_GRACE_MS = 10 * 60 * 1000
const DESKTOP_CHECK_TTL_MS = 4000

// Every OpenCode instance on the machine shares one status directory, so a
// session number is only meaningful next to the project it belongs to. The
// canonical project root is preferred over this instance's own directory, so a
// worktree or a nested package files under the project it belongs to.
function projectKeyFor(location) {
  const canonical = location?.project?.canonical
  const directory = typeof canonical === "string" && canonical ? canonical : location?.directory
  return typeof directory === "string" && directory ? directory : null
}

function runtimeFor(location, project = null) {
  const root = globalThis[RUNTIME_KEY] ?? (globalThis[RUNTIME_KEY] = new Map())
  const key = location || "__global__"
  let runtime = root.get(key)
  if (!runtime) {
    runtime = { controller: null, companionTimer: null, markerTimer: null, project: null }
    root.set(key, runtime)
  }
  if (project) runtime.project = project
  return runtime
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === "EPERM"
  }
}

// A pid from the lock file is not proof that the process is the bar: pids are
// recycled. Nothing is ever signalled unless the command line says bar.py, so a
// stale lock can never kill an unrelated process. Windows is the exception, and
// it is fail-open: the lock is ours and nothing cheaper can tell us more.
function processIsBar(pid) {
  if (!pidIsAlive(pid)) return false
  if (process.platform === "linux") {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("bar.py")
    } catch {
      return false
    }
  }
  if (process.platform === "darwin") {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 3000 })
    return !result.error && (result.stdout ?? "").includes("bar.py")
  }
  return true
}

// The retry gate after a bar process ends. A signal we sent ourselves, a bar
// that lived long enough to be useful, and a bar that declined because another
// instance already owns the lock all reset the count; a short-lived exit
// escalates 15s, 30s, 60s ... up to five minutes.
function nextPopupRetry({ failures = 0, uptimeMs = 0, signal = null, code = null, now: at = Date.now() } = {}) {
  if (signal === "SIGTERM" || signal === "SIGINT") return { failures: 0, retryAt: 0 }
  if (uptimeMs >= POPUP_SHORT_LIVED_MS) return { failures: 0, retryAt: 0 }
  if (code === LOCK_HELD_EXIT_CODE) {
    // Somebody else is already drawing the bar. That is the wanted state, so
    // the counter is reset and the next look is a slow, quiet one.
    return { failures: 0, retryAt: at + LOCK_HELD_RETRY_MS }
  }
  const consecutive = failures + 1
  const wait = Math.min(POPUP_BACKOFF_MAX_MS, POPUP_BACKOFF_BASE_MS * 2 ** (consecutive - 1))
  return { failures: consecutive, retryAt: at + wait }
}

function withTimeout(promise, milliseconds) {
  let timer = null
  // No unref here on purpose: the timer must be able to fire on its own, and it
  // is cleared as soon as the race settles either way.
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(undefined), milliseconds)
  })
  return Promise.race([Promise.resolve(promise).catch(() => undefined), timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

// The bar needs a Python that can import tkinter. On Windows "python3" is often
// the Store alias or missing entirely, so the candidates are probed instead of
// trusted, in the same order the selftest launcher uses.
function pythonCandidates(platform = process.platform, configured = process.env.OPENCODE_LATENCY_PYTHON) {
  if (configured) return [{ command: configured, prefix: [] }]
  if (platform === "win32") {
    return [
      { command: "py", prefix: ["-3"] },
      { command: "python", prefix: [] },
      { command: "python3", prefix: [] },
    ]
  }
  return [
    { command: "python3", prefix: [] },
    { command: "python", prefix: [] },
  ]
}

function probePython(candidate) {
  const probe = spawnSync(candidate.command, [...candidate.prefix, "-c", "import tkinter"], { stdio: "ignore", timeout: 5000 })
  return !probe.error && probe.status === 0
}

function resolvePython() {
  if (companions.popupPython) return companions.popupPython
  const candidates = pythonCandidates()
  const working = candidates.find(probePython)
  if (!working) {
    console.error(
      `[${PLUGIN_ID}] no Python with tkinter found (tried ${candidates.map((candidate) => candidate.command).join(", ")}); ` +
        "run npx opencode-vitals-selftest to see what this machine needs",
    )
  }
  companions.popupPython = working ?? candidates[0]
  return companions.popupPython
}

// Asynchronous on purpose: this runs on the server's event loop, and a
// readdirSync plus one readFileSync per pid is a stall nobody asked for. The
// scan happens every few seconds for the whole life of the process.
async function listLinuxProcesses(root, names) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return null
  }
  const wanted = new Set(names)
  const found = []
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) return
      try {
        // /proc/<pid>/comm is capped at 15 characters, so it truncates
        // "ai.opencode.desktop" to "ai.opencode.d" and never matches. The
        // cmdline file carries the whole argv.
        const raw = await readFile(join(root, entry.name, "cmdline"), "utf8")
        const argv0 = raw.split("\0")[0] ?? ""
        const command = argv0.split(/[\\/]/).pop() ?? ""
        if (wanted.has(command) || wanted.has(argv0)) found.push({ pid: Number(entry.name), command })
      } catch {
        // The process exited between listing and reading.
      }
    }),
  )
  return found
}

// Decides whether the app is running from a process-list tool, or null when the
// tool itself failed. pgrep takes one pattern and exits 1 for "no match" and >1
// for a usage error; tasklist needs /FI filters and reports "No tasks" when
// nothing matched. Anything else is unknown, and unknown keeps the bar.
function processListDecision(platform, names, probe) {
  if (platform === "darwin") {
    for (const name of names) {
      const result = probe("pgrep", ["-x", name])
      if (result.status === 0) return true
      if (result.status !== 1) return null
    }
    return false
  }
  if (platform === "win32") {
    for (const name of names) {
      const result = probe("tasklist", ["/NH", "/FI", `IMAGENAME eq ${name}.exe`])
      const output = result.stdout ?? ""
      if (output.includes(name)) return true
      if (result.status !== 0 || !/no tasks are running|info: no tasks/i.test(output)) return null
    }
    return false
  }
  return null
}

function runProcessListTool(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 5000 })
  if (result.error) return { status: null, stdout: "" }
  return { status: typeof result.status === "number" ? result.status : null, stdout: result.stdout ?? "" }
}

// Returns true when the app cannot be located, so an unknown platform keeps the
// bar rather than hiding a measurement the user asked for.
async function scanDesktopProcess({
  platform = process.platform,
  procRoot = "/proc",
  names = DESKTOP_PROCESS_NAMES,
} = {}) {
  if (platform === "linux") {
    const found = await listLinuxProcesses(procRoot, names)
    return found === null ? true : found.length > 0
  }
  return processListDecision(platform, names, runProcessListTool) ?? true
}

function desktopAppAlive() {
  // The process list only decides anything for the Desktop app. A CLI or TUI
  // session can never be hidden by it, so the scan is not worth running — and
  // on Linux it means walking /proc.
  if (process.env.OPENCODE_CLIENT !== "desktop") return true
  const cached = companions.desktopCheck
  const stamp = Date.now()
  if (cached && stamp - cached.at < DESKTOP_CHECK_TTL_MS) return cached.alive
  companions.desktopCheck = { at: stamp, alive: true }
  // Resolve outside the caller's turn: a scan that is still running must not
  // make the caller guess, and the previous answer is good for a few seconds.
  void scanDesktopProcess().then((alive) => {
    companions.desktopCheck = { at: Date.now(), alive }
  })
  return true
}

// Whether the bar belongs on the screen. "OpenCode is installed" is not the
// question: the process outlives the sessions that use it, so a bar keyed to
// process existence stays up for a program nobody is looking at any more.
function barExpectedFrom({ desktopEnv, desktopAlive, lastDesktopSeenAt, now, openSessionAt }) {
  // A session has to be doing something. An idle OpenCode is a service with
  // nothing to measure, and a bar over it is an overlay nobody asked for.
  if (openSessionAt !== undefined && now - openSessionAt > IDLE_HIDE_MS) return false
  if (desktopEnv !== "desktop") return true
  if (desktopAlive) return true
  if (lastDesktopSeenAt === undefined) return true
  return now - lastDesktopSeenAt > DESKTOP_MISSING_GRACE_MS
}

function barExpected(runtime) {
  const alive = desktopAppAlive()
  if (alive && process.env.OPENCODE_CLIENT === "desktop") runtime.lastDesktopSeenAt = Date.now()
  return barExpectedFrom({
    desktopEnv: process.env.OPENCODE_CLIENT,
    desktopAlive: alive,
    lastDesktopSeenAt: runtime.lastDesktopSeenAt,
    openSessionAt: runtime.openSessionAt,
    now: Date.now(),
  })
}

async function stopPopup() {
  let holder
  try {
    holder = JSON.parse(await readFile(BAR_LOCK, "utf8"))
  } catch {
    return
  }
  const pid = Number(holder?.pid)
  if (!Number.isInteger(pid) || pid <= 0 || !pidIsAlive(pid)) return
  // A recycled pid in a stale lock must never cost somebody their process.
  if (!processIsBar(pid)) return
  try {
    process.kill(pid, "SIGTERM")
  } catch {
    // Already gone.
  }
}

// The bar is current when its lock token matches the script revision on disk.
async function companionIsCurrent(scriptPath) {
  let holder
  try {
    const raw = await readFile(BAR_LOCK, "utf8")
    const data = JSON.parse(raw)
    holder = { pid: Number(data?.pid), build: Number(data?.build) }
  } catch {
    return false
  }
  if (!Number.isInteger(holder.pid) || holder.pid <= 0 || !Number.isFinite(holder.build)) return false
  try {
    const scriptStat = await stat(scriptPath)
    if (Math.abs(scriptStat.mtimeMs - holder.build) > 1.5) return false
  } catch {
    return false
  }
  return pidIsAlive(holder.pid)
}

function spawnBarProcess(runtime, build) {
  const python = resolvePython()
  const child = spawn(python.command, [...python.prefix, BAR_SCRIPT], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      OPENCODE_LATENCY_FILE: STATUS_FILE,
      OPENCODE_LATENCY_CURRENT_FILE: CURRENT_SESSION_FILE,
      OPENCODE_LATENCY_TOTALS_FILE: SESSION_TOTALS_FILE,
      OPENCODE_LATENCY_PARENT_PID: String(process.pid),
      // The bar is one window for one screen, and every project on the machine
      // shares the files it reads. It is told which project spawned it so it
      // never answers with another project's numbers.
      ...(runtime.project ? { OPENCODE_LATENCY_PROJECT: runtime.project } : {}),
    },
  })
  companions.popup = child
  companions.popupBuild = build
  companions.popupUnavailableUntil = 0
  companions.popupStartedAt = Date.now()
  runtime.popup = child
  child.once("error", (error) => {
    console.error(`[${PLUGIN_ID}] bar could not start: ${String(error)}`)
    const retry = nextPopupRetry({ failures: companions.popupFailures })
    companions.popupFailures = retry.failures
    companions.popupUnavailableUntil = retry.retryAt
    if (companions.popup === child) companions.popup = null
  })
  child.once("exit", (code, signal) => {
    if (companions.popup === child) companions.popup = null
    const uptimeMs = companions.popupStartedAt ? Date.now() - companions.popupStartedAt : 0
    const retry = nextPopupRetry({ failures: companions.popupFailures, uptimeMs, signal, code })
    companions.popupFailures = retry.failures
    companions.popupUnavailableUntil = retry.retryAt
    // Another bar already owns the screen: that is the wanted state, and it is
    // not worth a line in the log on every check.
    if (code === LOCK_HELD_EXIT_CODE) return
    // Say why once the pattern repeats, so a machine that cannot draw the bar is
    // not a silent five second loop. Deeper retries already backed off to minutes.
    if (retry.failures >= 1 && retry.failures <= 4) {
      const seconds = Math.max(1, Math.round((retry.retryAt - Date.now()) / 1000))
      console.error(
        `[${PLUGIN_ID}] bar exited after ${Math.round(uptimeMs)} ms ` +
          `(code=${code ?? "none"}, signal=${signal ?? "none"}); retrying in ${seconds}s`,
      )
    }
  })
  child.unref()
}

function startPopup(runtime) {
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return
  if (!barExpected(runtime)) return
  if (companions.popupUnavailableUntil && Date.now() < companions.popupUnavailableUntil) return
  companions.popupChain = companions.popupChain
    .then(async () => {
      if (await companionIsCurrent(BAR_SCRIPT)) return
      let build = 0
      try {
        build = Math.round((await stat(BAR_SCRIPT)).mtimeMs)
      } catch {
        return
      }
      // The lock file only exists once the bar has started, so two locations
      // polling in the same window would each spawn one. Our own live child for
      // this exact revision is proof enough that no second bar is needed.
      const child = companions.popup
      if (child && child.exitCode === null && child.signalCode === null && companions.popupBuild === build) return
      spawnBarProcess(runtime, build)
    })
    .catch(() => {})
}

// The status directory sits in a temporary directory, which on Linux is
// world-writable and shared between users. Creating it 0700 keeps another local
// account out of the measurement files; the mode is only applied when the
// directory is created, so an existing one is left alone.
async function ensureStatusDir() {
  try {
    await mkdir(STATUS_DIR, { recursive: true, mode: STATUS_DIR_MODE })
  } catch (error) {
    if (error?.code !== "EEXIST") throw error
  }
}

async function writeJsonAtomic(path, value) {
  await ensureStatusDir()
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600 })
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

// An update is a new module evaluation, so the plugin can notice the change by
// reading its own version: no registry call, no network, nothing to trust.
function readOwnVersion() {
  try {
    const raw = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "package.json"), "utf8")
    const value = JSON.parse(raw)
    return typeof value?.version === "string" && value.version ? value.version : "unknown"
  } catch {
    return "unknown"
  }
}

async function notePluginVersion() {
  const version = readOwnVersion()
  let previous = null
  try {
    previous = JSON.parse(await readFile(PLUGIN_VERSION_FILE, "utf8"))
  } catch {
    previous = null
  }
  const known = typeof previous?.version === "string" ? previous.version : null
  if (known === version) return { version, changed: false, previous: null }
  const payload = {
    version,
    previous: known,
    updatedAt: now(),
    path: dirname(fileURLToPath(import.meta.url)),
  }
  // The bar marks an announcement as seen in this same file. Carrying the
  // marker over keeps a second instance of the plugin from resurrecting a notice
  // the bar has already shown.
  if (Number.isFinite(previous?.seenAt)) payload.seenAt = previous.seenAt
  await writeJsonAtomic(PLUGIN_VERSION_FILE, payload).catch(() => {})
  return { version, changed: true, previous: known }
}

async function publishStatus(record) {
  await writeJsonAtomic(STATUS_FILE, record)
}

// Pruning is throttled on a timestamp shared by every plugin instance in the
// process, so one instance's sweep also covers the others. `force` skips the
// throttle, which the tests need and a first run at startup may want.
async function pruneResponseMarkers({ force = false } = {}) {
  const attemptedAt = now()
  if (!force && attemptedAt - companions.lastMarkerPruneAt < MARKER_PRUNE_INTERVAL_MS) return
  companions.lastMarkerPruneAt = attemptedAt
  try {
    const names = await readdir(STATUS_DIR)
    for (const name of names) {
      if (!name.endsWith(".marker")) continue
      const path = join(STATUS_DIR, name)
      try {
        const info = await stat(path)
        if (attemptedAt - info.mtimeMs > RESPONSE_MARKER_TTL_MS) await unlink(path)
      } catch {
        // Another instance already removed it.
      }
    }
  } catch {
    // Pruning is opportunistic; failing to prune never blocks a measurement.
  }
}

async function claimResponse(key) {
  if (!key) return true
  const digest = createHash("sha256").update(key).digest("hex")
  const marker = join(STATUS_DIR, `response-${digest}.marker`)
  try {
    await ensureStatusDir()
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(marker, "wx", 0o600)
        try {
          await handle.writeFile(JSON.stringify({ createdAt: now() }))
        } finally {
          await handle.close()
        }
        void pruneResponseMarkers()
        return true
      } catch (error) {
        if (error?.code !== "EEXIST") return true
        try {
          const info = await stat(marker)
          if (now() - info.mtimeMs <= RESPONSE_MARKER_TTL_MS) return false
          await unlink(marker)
        } catch {
          return true
        }
      }
    }
  } catch {
    return true
  }
  return true
}

async function withStorageLock(fn) {
  await ensureStatusDir().catch(() => {})
  const lockPath = join(STATUS_DIR, "storage.lock")
  // Five seconds of patience before the lock is considered abandoned. The path
  // stays fail-open on purpose: losing a measurement matters less than blocking
  // the plugin, but it only happens after this long wait, never immediately.
  // The deadline sits past the TTL on purpose. When both expired at the same
  // instant, a waiter could give up at the exact moment the holder was declared
  // abandoned, and the two would then run the read-modify-write of the same
  // records at once and lose one.
  const deadline = now() + STORAGE_LOCK_TTL_MS + 2000
  while (now() < deadline) {
    let handle
    try {
      handle = await open(lockPath, "wx", 0o600)
    } catch (error) {
      if (error?.code !== "EEXIST") return fn()
      try {
        const info = await stat(lockPath)
        if (now() - info.mtimeMs > STORAGE_LOCK_TTL_MS) {
          await unlink(lockPath).catch(() => {})
          continue
        }
      } catch {
        continue
      }
      await delay(20)
      continue
    }
    try {
      return await fn()
    } finally {
      await handle.close().catch(() => {})
      await unlink(lockPath).catch(() => {})
    }
  }
  return fn()
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function numberOrNull(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function eventTimestamp(event) {
  const created = isRecord(event) ? numberOrNull(event.created) : null
  return created !== null && created > 0 ? created : now()
}

// A session's totals are one snapshot, not eight independent numbers. Ranking
// whole snapshots is what keeps a reader from dividing a token count taken at
// one moment by a stream time taken at another and calling the result a
// measurement. `turns` only ever grows inside a session, so it is the primary
// key, with the timestamp as the tie-break.
function snapshotRank(values) {
  if (!isRecord(values)) return null
  const turns = numberOrNull(values.turns)
  const updatedAt = typeof values.updatedAt === "string" ? Date.parse(values.updatedAt) : numberOrNull(values.updatedAt)
  return [turns ?? -1, Number.isFinite(updatedAt) ? updatedAt : 0]
}

function newerSnapshot(current, candidate) {
  if (!isRecord(candidate)) return current
  if (!isRecord(current)) return candidate
  const left = snapshotRank(current)
  const right = snapshotRank(candidate)
  if (!right) return current
  if (!left) return candidate
  if (right[0] !== left[0]) return right[0] > left[0] ? candidate : current
  return right[1] >= left[1] ? candidate : current
}

function normalizeOptions(raw) {
  const requestedLimit = Number(raw?.historyLimit)
  const historyLimit = Number.isFinite(requestedLimit)
    ? Math.min(MAX_HISTORY_LIMIT, Math.max(1, Math.floor(requestedLimit)))
    : DEFAULT_HISTORY_LIMIT
  const popup = raw?.popup !== false
  return {
    enabled: raw?.enabled !== false,
    historyLimit,
    // Off by default: one line per completed turn in somebody else's log file
    // is noise, and the numbers are on the bar. Errors and version changes are
    // printed whatever this says.
    log: raw?.log === true,
    popup,
  }
}

// The event names this plugin depends on. Anything outside this list is counted
// rather than dropped in silence: a renamed or removed event would otherwise
// delete a measurement with no error anywhere, which is the one failure mode
// that cannot be noticed from the outside.
const HANDLED_TYPES = new Set([
  "session.viewed",
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.compaction.started",
  "session.compaction.ended",
  "session.compaction.failed",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.step.started",
  "session.step.ended",
  "session.step.failed",
  "session.text.started",
  "session.text.delta",
  "session.text.ended",
  "session.reasoning.started",
  "session.reasoning.ended",
  "session.reasoning.delta",
  "session.usage.updated",
  // The model writing a tool call's arguments. These are model output exactly
  // like text is, and they are the only place their generation time is visible:
  // a step's output tokens include its tool call, so ignoring these events left
  // tokens in the numerator with no time in the denominator.
  "session.tool.input.started",
  "session.tool.input.delta",
  "session.tool.input.ended",
])
// Known and deliberately not measured: synthetic inbox items, usage records and
// single bookkeeping events are somebody else's business, and none of them is
// model output.
const IGNORED_TYPES = new Set([
  "session.synthetic",
  "session.usage.recorded",
  "session.idle",
  "session.metadata.updated",
  "session.model.selected",
  "session.agent.selected",
  "session.retry.scheduled",
  "session.step.streamed",
  "session.compaction.delta",
])
// Whole families OpenCode emits around work this plugin does not measure: tool
// execution (as opposed to session.tool.input.*, which is the model writing the
// arguments), shells, skills and interface state. Naming the family keeps a new
// event inside it from being reported as an unknown measurement event, while a
// rename of an event this plugin does depend on still shows up as unknown.
const IGNORED_PREFIXES = [
  "session.tool.",
  "session.shell.",
  "session.skill.",
  "session.tab.",
  "session.form.",
  "session.commands.",
  "session.permission.",
  "session.revert.",
  "session.title.",
  "session.child.",
  "session.message.",
  "session.pending.",
  "session.instructions.",
  "session.sidebar.",
  "session.composer.",
  "session.copy.",
  "session.pin.",
  "session.toggle.",
  "session.page.",
  "session.line.",
  "session.half.",
  "session.input.",
  "session.new.",
]

function isIgnoredEventType(type) {
  return IGNORED_TYPES.has(type) || IGNORED_PREFIXES.some((prefix) => type.startsWith(prefix))
}

function normalizeEvent(event) {
  if (!isRecord(event)) return { type: undefined, value: {} }
  const data = isRecord(event.properties)
    ? event.properties
    : isRecord(event.data)
      ? event.data
      : event
  const nested = isRecord(data.properties)
    ? data.properties
    : isRecord(data.data)
      ? data.data
      : data
  const rawType = typeof event.type === "string" ? event.type : nested.type
  return { type: typeof rawType === "string" ? rawType : undefined, value: nested }
}

function readSessionID(value) {
  return value?.sessionID ?? value?.properties?.sessionID ?? value?.data?.sessionID
}

function readOutputTokens(value) {
  const candidates = [
    value?.tokens?.output,
    value?.tokens?.outputTokens,
    value?.usage?.tokens?.output,
    value?.usage?.output,
    value?.outputTokens,
  ]
  for (const candidate of candidates) {
    const number = Number(candidate)
    if (Number.isFinite(number) && number >= 0) return number
  }
  return null
}

function contextOutputTokens(value, targetMessageID) {
  let latest = null
  const visit = (node, depth = 0) => {
    if (depth > 8 || node === null || node === undefined) return
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1)
      return
    }
    if (!isRecord(node)) return
    const id = node.id ?? node.messageID
    const role = node.role ?? node.info?.role
    if ((!targetMessageID || id === targetMessageID) && (role === "assistant" || id === targetMessageID)) {
      const direct = readOutputTokens(node) ?? readOutputTokens(node.info) ?? readOutputTokens(node.message)
      if (direct !== null) latest = direct
    }
    for (const key of ["data", "messages", "info", "message", "parts"]) {
      if (key in node) visit(node[key], depth + 1)
    }
  }
  visit(value)
  return latest
}

function firstNonWhitespaceIndex(text) {
  for (let index = 0; index < text.length; index += 1) {
    if (!/\s/u.test(text[index])) return index
  }
  return -1
}

function formatMs(value) {
  return value === null || value === undefined ? "unavailable" : `${value.toFixed(2)} ms`
}

function createState(rawOptions, context = {}) {
  const options = normalizeOptions(rawOptions)
  const project = typeof context.project === "string" && context.project ? context.project : null
  const active = new Map()
  const finishing = new Set()
  const finishQueues = new Map()
  const compactingSessions = new Set()
  const ignoredSessions = new Set()
  // Sessions with an execution open, tracked even while compaction ignores the
  // turn itself. Without it, "stop ignoring when the compaction ends" could not
  // tell a compaction that runs inside an execution from one that does not.
  const executions = new Set()
  const inboxTypes = new Map()
  const seenEventIDs = new Set()
  const unknownEventTypes = new Map()
  let unknownEventTotal = 0
  let unknownLoggedAt = 0
  const ignoredMessageIDs = new Set()
  const completedResponseKeys = new Set()
  const closedTurns = new Map()
  const sessionTotals = new Map()
  // sessionID -> the session that delegated to it, or null when it is a root
  // session. A subagent runs as a child session, so its work is invisible to the
  // session that asked for it unless the link is followed.
  const sessionParents = new Map()
  const parentLookups = new Map()
  let storage
  let persistChain = Promise.resolve()
  let currentSession = { known: false, id: null }
  // The last time any event for a measured session arrived, not the last time a
  // response finished: a reply in progress is the bar at its most useful.
  let lastEventAt = null

  function writeLine(ctx, line, level) {
    // One sink, not two: OpenCode's own logger when the host offers it, the
    // console otherwise. Writing the same line to both duplicated every
    // measurement in the log and in the terminal.
    const app = ctx?.app ?? ctx?.client?.app
    if (app && typeof app.log === "function") {
      try {
        void Promise.resolve(app.log({
          body: { service: PLUGIN_ID, level, message: line },
        })).catch(() => {})
        return
      } catch {
        // Fall through to the console.
      }
    }
    try {
      if (level === "info") console.log(line)
      else console.warn(line)
    } catch {
      // A missing console never blocks a measurement.
    }
  }

  // The per-measurement line, off unless it was asked for.
  function log(ctx, message) {
    if (!options.log) return
    writeLine(ctx, `[${PLUGIN_ID}] ${message}`, "info")
  }

  // Everything that says something is wrong, or that something changed. These
  // ignore the `log` option, because a silent failure is the one outcome this
  // plugin must not have.
  function warn(ctx, message) {
    writeLine(ctx, `[${PLUGIN_ID}] ${message}`, "warn")
  }

  function noteUnknownType(ctx, type) {
    unknownEventTotal += 1
    unknownEventTypes.set(type, (unknownEventTypes.get(type) ?? 0) + 1)
    while (unknownEventTypes.size > UNKNOWN_TYPE_LIMIT) {
      unknownEventTypes.delete(unknownEventTypes.keys().next().value)
    }
    // Once every few minutes at most, so a busy session cannot turn this into
    // the noise it was introduced to avoid.
    const stamp = now()
    if (stamp - unknownLoggedAt < UNKNOWN_TYPE_LOG_INTERVAL_MS) return
    unknownLoggedAt = stamp
    warn(ctx, `${unknownEventTotal} event(s) of unknown type ignored: ${summarizeUnknownEvents()}`)
  }

  function summarizeUnknownEvents() {
    return [...unknownEventTypes.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5)
      .map(([type, count]) => `${type}×${count}`)
      .join(", ")
  }

  // One entry per project. This file used to hold a single session, so the last
  // OpenCode instance on the machine to publish won it, and its numbers were
  // shown under whichever project the bar belonged to. Each instance now writes
  // only its own key and merges the rest, so a bar can ask for its project.
  function publishCurrentSession() {
    if (!options.popup) return
    const entry = currentSession.known && currentSession.id
      ? { available: true, sessionID: currentSession.id, source: "events", observedAt: now() }
      : { available: false, source: "events", observedAt: now() }
    // The read and the write are one locked step: a second instance publishing
    // between them would otherwise be lost, which is the bug this shape exists
    // to remove.
    void withStorageLock(async () => {
      const projects = {}
      try {
        const raw = JSON.parse(await readFile(CURRENT_SESSION_FILE, "utf8"))
        if (isRecord(raw?.projects)) Object.assign(projects, raw.projects)
      } catch {
        // No file yet, or a v1 file holding a single slot.
      }
      if (project) projects[project] = entry
      await writeJsonAtomic(CURRENT_SESSION_FILE, { version: 2, observedAt: now(), projects })
    }).catch(() => {})
  }

  function setCurrentSessionId(sessionID) {
    if (typeof sessionID !== "string" || !sessionID) return
    if (currentSession.known && currentSession.id === sessionID) {
      publishCurrentSession()
      return
    }
    currentSession = { known: true, id: sessionID }
    publishCurrentSession()
  }

  // The companion tick asks whether a bar still belongs on the screen, and the
  // answer is "was anything measured recently". Activity, not a completed
  // record: a long reply streams deltas for a minute before it finishes, and a
  // bar that stood down mid-reply would leave exactly when it is worth reading.
  function noteActivityFor(runtime) {
    if (lastEventAt !== null) runtime.openSessionAt = lastEventAt
  }

  function refreshCurrentSession() {
    if (currentSession.known && currentSession.id) publishCurrentSession()
  }

  async function load() {
    if (!storage) return
    try {
      const response = await storage.get(STORAGE_KEY)
      const stored = response?.data ?? response
      if (Array.isArray(stored?.records)) {
        for (const record of stored.records) {
          if (!isRecord(record) || typeof record.sessionID !== "string") continue
          sessionTotals.set(record.sessionID, mergeSeededTotals(sessionTotals.get(record.sessionID), record))
        }
        log(null, `loaded ${stored.records.length} saved measurements`)
      }
    } catch {
      log(null, "could not load saved measurements; continuing with an empty history")
    }
    // History is capped, so a rebuilt session can be behind the totals this or
    // another instance already published. The totals file is the further-along
    // record of the session, and starting from it is what stops a restart from
    // walking a session's numbers — and its last-ten list — backwards.
    try {
      const raw = JSON.parse(await readFile(SESSION_TOTALS_FILE, "utf8"))
      const sessions = isRecord(raw?.sessions) ? raw.sessions : {}
      for (const [sessionID, snapshot] of Object.entries(sessions)) {
        if (typeof sessionID !== "string" || !isRecord(snapshot)) continue
        sessionTotals.set(sessionID, mergeSeededTotals(sessionTotals.get(sessionID), { sessionTotals: snapshot }))
      }
    } catch {
      // No totals file yet (or it is unreadable): history alone is what there is.
    }
    // Publish what was just rebuilt, so the bar gets the merged view — including
    // the last-ten list history supplied — without waiting for a new response.
    void publishSessionTotals().catch(() => {})
  }

  function emptyTotals() {
    return {
      turns: 0,
      steps: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      generatedTokens: 0,
      activeStreamMs: 0,
      // Work this session delegated to subagents. A subagent runs as a child
      // session with its own stream time, so its tokens are counted here but
      // its time is not: adding them to the parent's rate would print a speed
      // the session never produced.
      subagentTurns: 0,
      subagentSteps: 0,
      project,
      tokensPerSecond: null,
      // The rates of the most recent responses, oldest first, so the bar can
      // average the last ten instead of the whole session. A response without a
      // rate contributes nothing rather than a zero.
      recentRates: [],
      updatedAt: null,
    }
  }

  function pushRecentRate(totals, rate) {
    if (!Number.isFinite(rate) || rate <= 0) return
    const rounded = Math.round(rate * 10) / 10
    if (totals.recentRates[totals.recentRates.length - 1] === rounded) {
      // The same response counted twice (a replayed event) is not a new turn.
      return
    }
    totals.recentRates.push(rounded)
    while (totals.recentRates.length > RECENT_RATE_COUNT) totals.recentRates.shift()
  }

  function readRecentRates(value) {
    if (!Array.isArray(value)) return []
    return value
      .filter((rate) => Number.isFinite(rate) && rate > 0)
      .map((rate) => Math.round(rate * 10) / 10)
      .slice(-RECENT_RATE_COUNT)
  }

  function mergeSeededTotals(existing, record) {
    const totals = existing ?? emptyTotals()
    const snapshot = isRecord(record.sessionTotals) ? record.sessionTotals : null
    if (snapshot) {
      // Keep one snapshot whole. Taking the maximum of each field separately
      // can build a pair that never coexisted, and every reader divides one by
      // the other.
      const winner = newerSnapshot(totals, snapshot)
      if (winner === snapshot) {
        for (const field of ["turns", "steps", "outputTokens", "reasoningTokens", "generatedTokens", "activeStreamMs"]) {
          totals[field] = numberOrNull(snapshot[field]) ?? 0
        }
        for (const field of SUBAGENT_FIELDS) {
          totals[field] = numberOrNull(snapshot[field]) ?? 0
        }
        if (typeof snapshot.project === "string" && snapshot.project) totals.project = snapshot.project
        totals.tokensPerSecond = numberOrNull(snapshot.tokensPerSecond) ?? null
        const recent = readRecentRates(snapshot.recentRates)
        if (recent.length > 0) totals.recentRates = recent
        totals.updatedAt = typeof snapshot.updatedAt === "string" ? snapshot.updatedAt : totals.updatedAt
      }
    } else {
      totals.turns += 1
      totals.steps += Number.isFinite(record.stepCount) ? record.stepCount : 0
      for (const field of ["outputTokens", "reasoningTokens", "generatedTokens"]) {
        if (Number.isFinite(record[field]) && record[field] > 0) totals[field] += record[field]
      }
      if (Number.isFinite(record.activeStreamMs) && record.activeStreamMs > 0) {
        totals.activeStreamMs += record.activeStreamMs
      }
      totals.tokensPerSecond = totals.activeStreamMs > 0 && totals.generatedTokens > 0
        ? totals.generatedTokens / (totals.activeStreamMs / 1000)
        : totals.tokensPerSecond
      totals.updatedAt = typeof record.completedAt === "string" ? record.completedAt : totals.updatedAt
    }
    // Deliberately no pushRecentRate here. A rate measured before the tool-call
    // arguments were counted as model time is a different quantity — that is the
    // 4686 tok/s that started all this — and mixing the two would put a number
    // nobody can defend in front of the user. The list starts with the first
    // response measured the current way; a snapshot that already carries a list
    // keeps it.
    return totals
  }

  async function persist(record) {
    if (!storage) return
    persistChain = persistChain
      .catch(() => {})
      .then(() => withStorageLock(async () => {
        let existing = []
        try {
          const response = await storage.get(STORAGE_KEY)
          const stored = response?.data ?? response
          if (isRecord(stored) && Array.isArray(stored.records)) {
            existing = stored.records.filter(isRecord)
          }
        } catch {
          existing = []
        }
        const maxSequence = existing.reduce((maximum, item) => Math.max(maximum, numberOrNull(item.sequence) ?? 0), 0)
        record.sequence = maxSequence + 1
        const merged = [...existing.filter((item) => item.id !== record.id), record]
          .sort((left, right) => (numberOrNull(left.sequence) ?? 0) - (numberOrNull(right.sequence) ?? 0))
          .slice(-options.historyLimit)
        await storage.set(STORAGE_KEY, { version: 1, records: merged })
      }))
      .catch(() => {})
    await persistChain
  }

  function responseKey(sessionID, messageID) {
    return messageID ? `${sessionID}:${messageID}` : null
  }

  function responseWasCompleted(sessionID, messageID) {
    const key = responseKey(sessionID, messageID)
    return key !== null && completedResponseKeys.has(key)
  }

  function rememberTurn(turn) {
    const keys = [
      responseKey(turn.sessionID, turn.assistantMessageID),
      responseKey(turn.sessionID, turn.messageID),
      `${turn.sessionID}:@${turn.startedAt}`,
    ].filter((key) => key !== null)
    const uniqueKeys = [...new Set(keys)]
    for (const key of uniqueKeys) {
      completedResponseKeys.add(key)
      while (completedResponseKeys.size > 2000) {
        completedResponseKeys.delete(completedResponseKeys.values().next().value)
      }
    }
    closedTurns.set(turn.sessionID, uniqueKeys)
    while (closedTurns.size > MAX_CLOSED_TURNS) closedTurns.delete(closedTurns.keys().next().value)
    return true
  }

  function ignoreMessageID(messageID) {
    if (!messageID) return
    ignoredMessageIDs.add(messageID)
    while (ignoredMessageIDs.size > MAX_IGNORED_MESSAGE_IDS) {
      ignoredMessageIDs.delete(ignoredMessageIDs.values().next().value)
    }
  }

  function rememberInboxType(inboxID, type) {
    if (!inboxID || !type) return
    inboxTypes.set(inboxID, type)
    while (inboxTypes.size > MAX_INBOX_TYPES) inboxTypes.delete(inboxTypes.keys().next().value)
  }

  function createTurn(sessionID, messageID, startedAt, startSource) {
    return {
      sessionID,
      messageID: messageID ?? null,
      assistantMessageID: null,
      assistantMessageIDs: new Set(),
      startedAt,
      startSource,
      hasEvidence: false,
      firstTokenAt: null,
      firstTextAt: null,
      firstCharAt: null,
      lastTextAt: null,
      lastAnyAt: null,
      characterCount: 0,
      reasoningCharacterCount: 0,
      deltaCount: 0,
      reasoningDeltaCount: 0,
      toolArgCharacters: 0,
      toolArgDeltaCount: 0,
      toolInputs: new Map(),
      snapshotLengths: new Map(),
      spans: new Map(),
      stepCount: 0,
      stepOutputTokens: 0,
      stepReasoningTokens: 0,
      agentStats: new Map(),
      messageOutputTokens: null,
      usageBaseline: null,
      usageLatest: null,
      model: null,
      agent: null,
      compaction: false,
      ignored: false,
      failed: false,
    }
  }

  function begin(sessionID, messageID, startedAt = now(), startSource = "execution") {
    if (!options.enabled || !sessionID) return undefined
    if (messageID && ignoredMessageIDs.has(messageID)) return undefined
    if (compactingSessions.has(sessionID) || ignoredSessions.has(sessionID)) return undefined
    if (responseWasCompleted(sessionID, messageID)) return undefined
    const existing = active.get(sessionID)
    if (existing) {
      if (!existing.messageID && messageID) existing.messageID = messageID
      return existing
    }
    const closed = closedTurns.get(sessionID)
    if (closed) {
      const sameClosedResponse = messageID && closed.includes(responseKey(sessionID, messageID))
      if (sameClosedResponse) return undefined
      closedTurns.delete(sessionID)
    }
    const turn = createTurn(sessionID, messageID, startedAt, startSource)
    active.set(sessionID, turn)
    return turn
  }

  function ensureTurn(sessionID, messageID, startedAt = now(), startSource = "delta") {
    if (!options.enabled || !sessionID) return undefined
    if (messageID && ignoredMessageIDs.has(messageID)) return undefined
    if (compactingSessions.has(sessionID) || ignoredSessions.has(sessionID)) return undefined
    if (responseWasCompleted(sessionID, messageID)) return undefined
    let turn = active.get(sessionID)
    if (!turn) {
      const closed = closedTurns.get(sessionID)
      if (closed) {
        const knownClosed = messageID && closed.includes(responseKey(sessionID, messageID))
        if (knownClosed || !messageID) return undefined
        closedTurns.delete(sessionID)
      }
      turn = createTurn(sessionID, messageID, startedAt, startSource)
      active.set(sessionID, turn)
    } else if (!turn.messageID && messageID) {
      turn.messageID = messageID
    }
    return turn
  }

  function noteAssistantMessage(turn, messageID) {
    if (!turn || !messageID) return
    turn.assistantMessageID = messageID
    turn.assistantMessageIDs.add(messageID)
  }

  function setMetadata(turn, value) {
    if (!turn) return
    const model = value?.model ?? value
    if (model?.providerID && model?.modelID) {
      turn.model = `${model.providerID}/${model.modelID}`
    } else if (model?.providerID && model?.id) {
      turn.model = `${model.providerID}/${model.id}`
    }
    if (typeof value?.agent === "string") turn.agent = value.agent
  }

  function updateSpan(turn, messageID, at) {
    const key = messageID ?? "unknown"
    const span = turn.spans.get(key)
    if (!span) {
      turn.spans.set(key, { first: at, last: at })
      return
    }
    // A long silence under one message id is an interrupted stream that came
    // back, not the model thinking. Counting the gap as streaming time is what
    // makes a reconnect look like a slow model, so the span restarts instead.
    if (at - span.last > STREAM_GAP_LIMIT_MS) {
      span.first = at
      span.last = at
      return
    }
    span.last = at
  }

  function recordTextDelta(turn, delta, receivedAt) {
    if (!turn || !delta) return
    const characters = [...delta].length
    turn.hasEvidence = true
    if (turn.firstTokenAt === null) turn.firstTokenAt = receivedAt
    if (turn.firstTextAt === null) turn.firstTextAt = receivedAt
    turn.lastTextAt = receivedAt
    turn.lastAnyAt = receivedAt
    turn.deltaCount += 1
    turn.characterCount += characters
    if (turn.firstCharAt === null && firstNonWhitespaceIndex(delta) >= 0) {
      turn.firstCharAt = receivedAt
    }
  }

  function snapshotKey(value) {
    return `${value.assistantMessageID ?? value.messageID ?? "text"}:${value.ordinal ?? 0}`
  }

  function appendSnapshot(turn, key, text, receivedAt) {
    if (!turn || typeof text !== "string") return
    const characters = [...text]
    const previousLength = turn.snapshotLengths.get(key) ?? 0
    if (characters.length > previousLength) {
      turn.snapshotLengths.set(key, characters.length)
      recordTextDelta(turn, characters.slice(previousLength).join(""), receivedAt)
      return
    }
    turn.snapshotLengths.set(key, previousLength)
  }

  function consumeTextDelta(turn, value, receivedAt) {
    const delta = value.delta
    if (typeof delta !== "string" || delta.length === 0) return
    const key = snapshotKey(value)
    const characters = [...delta].length
    turn.snapshotLengths.set(key, (turn.snapshotLengths.get(key) ?? 0) + characters)
    recordTextDelta(turn, delta, receivedAt)
    updateSpan(turn, value.assistantMessageID, receivedAt)
  }

  function consumeReasoningDelta(turn, value, receivedAt) {
    const delta = value.delta
    if (typeof delta !== "string" || delta.length === 0) return
    turn.hasEvidence = true
    if (turn.firstTokenAt === null) turn.firstTokenAt = receivedAt
    turn.lastAnyAt = receivedAt
    turn.reasoningDeltaCount += 1
    turn.reasoningCharacterCount += [...delta].length
    updateSpan(turn, value.assistantMessageID, receivedAt)
  }

  // The model writing out a tool call's arguments. These events carry the same
  // assistantMessageID as the text of the step they belong to, so they extend
  // that message's span instead of starting a new one: a step is text and
  // thinking and tool call together, and the step's tokens cover all three.
  function consumeToolInput(turn, value, receivedAt) {
    turn.hasEvidence = true
    if (turn.firstTokenAt === null) turn.firstTokenAt = receivedAt
    turn.lastAnyAt = receivedAt
    const key = typeof value.id === "string" && value.id ? value.id : (value.assistantMessageID ?? "unknown")
    const previous = turn.toolInputs.get(key) ?? 0
    const delta = typeof value.delta === "string" ? value.delta : ""
    // `ended` carries the finished input as `text`, which is what a tool call
    // whose arguments never streamed has instead of a series of deltas.
    const characters = delta.length > 0
      ? previous + [...delta].length
      : typeof value.text === "string"
        ? Math.max(previous, [...value.text].length)
        : previous
    if (characters !== previous) {
      turn.toolInputs.set(key, characters)
      turn.toolArgCharacters += characters - previous
    }
    if (delta.length > 0) {
      turn.toolArgDeltaCount += 1
    }
    updateSpan(turn, value.assistantMessageID, receivedAt)
  }

  function addStepTokens(turn, tokens) {
    if (!turn || !isRecord(tokens)) return
    const output = numberOrNull(tokens.output)
    const reasoning = numberOrNull(tokens.reasoning)
    turn.stepCount += 1
    if (output !== null) turn.stepOutputTokens += output
    if (reasoning !== null) turn.stepReasoningTokens += reasoning
    // Kept per agent, because a turn that ran a subagent has steps and tokens
    // that belong to somebody else and a single total hides that.
    const key = turn.agent ?? "unknown"
    let stats = turn.agentStats.get(key)
    if (!stats) {
      stats = { steps: 0, outputTokens: 0, reasoningTokens: 0 }
      turn.agentStats.set(key, stats)
    }
    stats.steps += 1
    if (output !== null) stats.outputTokens += output
    if (reasoning !== null) stats.reasoningTokens += reasoning
  }

  function readUsageTokens(value) {
    const tokens = value?.tokens
    if (!isRecord(tokens)) return null
    const output = numberOrNull(tokens.output)
    const reasoning = numberOrNull(tokens.reasoning)
    if (output === null && reasoning === null) return null
    return { output: output ?? 0, reasoning: reasoning ?? 0 }
  }

  function spanTotal(turn) {
    let total = 0
    let count = 0
    for (const span of turn.spans.values()) {
      if (Number.isFinite(span.first) && Number.isFinite(span.last) && span.last > span.first) {
        total += span.last - span.first
        count += 1
      }
    }
    return count > 0 ? total : null
  }

  function tokenCounts(turn) {
    if (turn.stepCount > 0) {
      return { output: turn.stepOutputTokens, reasoning: turn.stepReasoningTokens, source: "step" }
    }
    if (turn.messageOutputTokens !== null) {
      return { output: turn.messageOutputTokens, reasoning: 0, source: "message" }
    }
    if (turn.usageBaseline !== null && turn.usageLatest !== null) {
      return {
        output: Math.max(0, turn.usageLatest.output - turn.usageBaseline.output),
        reasoning: Math.max(0, turn.usageLatest.reasoning - turn.usageBaseline.reasoning),
        source: "usage-delta",
      }
    }
    return { output: null, reasoning: null, source: "unavailable" }
  }

  // A subagent's events carry the child's session id, so the parent's totals
  // never saw the work it delegated. The link is asked of the server once per
  // session and remembered; a failure resolves to null, which leaves the child
  // counted on its own rather than guessing at a parent.
  async function resolveParent(ctx, sessionID) {
    // Every project spawns sessions of its own, and only a session that has
    // already been measured needs its parent asked for.
    if (sessionParents.has(sessionID)) return sessionParents.get(sessionID)
    if (typeof ctx?.session?.get !== "function") {
      sessionParents.set(sessionID, null)
      return null
    }
    const pending = parentLookups.get(sessionID)
    if (pending) return pending
    const lookup = (async () => {
      let parent = null
      try {
        const info = await withTimeout(Promise.resolve(ctx.session.get({ sessionID })), SESSION_LOOKUP_TIMEOUT_MS)
        const candidate = isRecord(info) ? info.parentID ?? info.parentId : null
        if (typeof candidate === "string" && candidate && candidate !== sessionID) parent = candidate
      } catch {
        // No session API, or it did not answer: the child keeps its own totals.
      }
      sessionParents.set(sessionID, parent)
      parentLookups.delete(sessionID)
      return parent
    })()
    parentLookups.set(sessionID, lookup)
    return lookup
  }

  function updateSessionTotals(sessionID, record) {
    let totals = sessionTotals.get(sessionID)
    if (!totals) {
      totals = emptyTotals()
      sessionTotals.set(sessionID, totals)
    }
    totals.turns += 1
    totals.steps += Number.isFinite(record.stepCount) ? record.stepCount : 0
    for (const field of ["outputTokens", "reasoningTokens", "generatedTokens"]) {
      if (Number.isFinite(record[field]) && record[field] > 0) totals[field] += record[field]
    }
    if (Number.isFinite(record.activeStreamMs) && record.activeStreamMs > 0) {
      totals.activeStreamMs += record.activeStreamMs
    }
    totals.tokensPerSecond = totals.activeStreamMs > 0 && totals.generatedTokens > 0
      ? totals.generatedTokens / (totals.activeStreamMs / 1000)
      : totals.tokensPerSecond
    pushRecentRate(totals, numberOrNull(record.tokensPerSecond) ?? NaN)
    totals.updatedAt = record.completedAt
    // Eviction is by least recently updated, not least recently created, so an
    // active long-running session is not dropped while an idle newer one stays.
    sessionTotals.delete(sessionID)
    sessionTotals.set(sessionID, totals)
    while (sessionTotals.size > 50) sessionTotals.delete(sessionTotals.values().next().value)
    return { ...totals, recentRates: [...totals.recentRates] }
  }

  // Credit a parent session with work it delegated. A subagent runs as a child
  // session and streams at its own speed, so its steps and tokens are added to
  // the parent while its stream time is not: the parent's rate is
  // generatedTokens over activeStreamMs, and a subagent's tokens without its
  // seconds would print a speed the parent never ran at. The subagent's own rate
  // stays on its own session, where its own time is known. Delegated work is
  // counted in the parent's steps so "steps" means the work the session caused.
  function creditParentWithSubagent(parentID, record) {
    if (!parentID || parentID === record.sessionID) return
    let parent = sessionTotals.get(parentID)
    if (!parent) {
      parent = emptyTotals()
      sessionTotals.set(parentID, parent)
    }
    parent.steps += Number.isFinite(record.stepCount) ? record.stepCount : 0
    for (const field of ["outputTokens", "reasoningTokens", "generatedTokens"]) {
      if (Number.isFinite(record[field]) && record[field] > 0) parent[field] += record[field]
    }
    parent.subagentTurns += 1
    parent.subagentSteps += Number.isFinite(record.stepCount) ? record.stepCount : 0
    // activeStreamMs, tokensPerSecond and recentRates are deliberately untouched.
    sessionTotals.delete(parentID)
    sessionTotals.set(parentID, parent)
    while (sessionTotals.size > 50) sessionTotals.delete(sessionTotals.values().next().value)
  }

  // OpenCode runs setup once per project directory, so several instances of this
  // plugin share one totals file. Writing only what this instance knows would
  // erase the other projects' sessions from the file the bar reads, so the
  // on-disk sessions are merged in first and the newest snapshot per session
  // wins whole.
  async function publishSessionTotals() {
    const sessions = {}
    for (const [sessionID, totals] of sessionTotals) sessions[sessionID] = totals
    let existing = null
    try {
      const record = JSON.parse(await readFile(SESSION_TOTALS_FILE, "utf8"))
      if (isRecord(record?.sessions)) existing = record.sessions
    } catch {
      existing = null
    }
    if (existing) {
      for (const [sessionID, snapshot] of Object.entries(existing)) {
        if (!Object.hasOwn(sessions, sessionID)) sessions[sessionID] = snapshot
        else sessions[sessionID] = newerSnapshot(sessions[sessionID], snapshot)
      }
    }
    await writeJsonAtomic(SESSION_TOTALS_FILE, {
      version: 1,
      sessions,
      updatedAt: new Date().toISOString(),
    })
  }

  function enqueueFinish(sessionID, ctx, completedAt, turn) {
    const previous = finishQueues.get(sessionID) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(() => finishTurn(sessionID, ctx, completedAt, turn))
    finishQueues.set(sessionID, next.catch(() => {}))
    while (finishQueues.size > 100) finishQueues.delete(finishQueues.keys().next().value)
    return next
  }

  async function finishTurn(sessionID, ctx, completedAt, turn) {
    if (turn.stepCount === 0 && typeof ctx?.session?.context === "function") {
      try {
        // An API call into the host, so it gets a deadline: a call that never
        // answers must not hold this session's finish queue forever.
        const context = await withTimeout(ctx.session.context({ sessionID }), SESSION_CONTEXT_TIMEOUT_MS)
        const outputTokens = context === undefined ? null : contextOutputTokens(context, turn.assistantMessageID)
        if (outputTokens !== null) turn.messageOutputTokens = outputTokens
      } catch {
        // Step tokens are the primary source; the context lookup is a fallback.
      }
    }
    await finish(sessionID, ctx, completedAt, turn)
  }

  function complete(sessionID, ctx, completedAt = now()) {
    const turn = active.get(sessionID)
    compactingSessions.delete(sessionID)
    ignoredSessions.delete(sessionID)
    executions.delete(sessionID)
    if (!turn || finishing.has(turn)) return Promise.resolve()
    finishing.add(turn)
    if (active.get(sessionID) === turn) active.delete(sessionID)
    // Close the turn immediately so late events cannot merge into it while queued.
    rememberTurn(turn)
    if (turn.compaction || turn.ignored) {
      finishing.delete(turn)
      return Promise.resolve()
    }
    return enqueueFinish(sessionID, ctx, completedAt, turn)
      .catch((error) => {
        warn(ctx, `could not finish measurement: ${String(error)}`)
      })
      .finally(() => {
        finishing.delete(turn)
      })
  }

  async function finish(sessionID, ctx, completedAt = now(), capturedTurn = null) {
    if (!options.enabled) return
    const turn = capturedTurn ?? active.get(sessionID)
    if (!turn) return
    if (active.get(sessionID) === turn) active.delete(sessionID)
    const producedSomething = turn.characterCount > 0 ||
      turn.stepCount > 0 ||
      turn.firstTokenAt !== null ||
      turn.firstTextAt !== null
    if (!producedSomething) {
      rememberTurn(turn)
      return
    }
    rememberTurn(turn)
    const responseIdentity = turn.assistantMessageID ?? turn.messageID ?? `@${turn.startedAt}`
    if (!(await claimResponse(`${sessionID}:${responseIdentity}`))) return

    const tokens = tokenCounts(turn)
    const generatedTokens = tokens.output === null ? null : tokens.output + (tokens.reasoning ?? 0)
    const measuredStreamMs = spanTotal(turn)
    const firstToLastMs = turn.firstTokenAt === null || turn.lastTextAt === null
      ? null
      : turn.lastTextAt - turn.firstTokenAt
    const totalMs = turn.lastTextAt !== null
      ? turn.lastTextAt - turn.startedAt
      : turn.lastAnyAt !== null
        ? turn.lastAnyAt - turn.startedAt
        : null
    // A response that arrives in one piece has a stream span of zero, so it used
    // to show no rate at all — the quick replies a person most wants to see. When
    // the whole response is a single message there is no tool execution to leave
    // out of the denominator, so the wall time of that one message is the same
    // quantity and is used instead. The step count has to agree: a turn that ran
    // tools has step tokens whose generation is not inside that wall time at all,
    // and dividing them by it is how a rate nobody could defend gets printed.
    const singleMessage = turn.assistantMessageIDs.size <= 1 && turn.stepCount <= 1
    let activeStreamMs = measuredStreamMs
    let rateSource = measuredStreamMs !== null ? "stream-span" : "unavailable"
    if (activeStreamMs === null && singleMessage) {
      if (firstToLastMs !== null && firstToLastMs > 0) {
        activeStreamMs = firstToLastMs
        rateSource = "first-to-last"
      } else if (totalMs !== null && totalMs > 0) {
        activeStreamMs = totalMs
        rateSource = "single-message-total"
      }
    }
    const streamSeconds = activeStreamMs !== null && activeStreamMs > 0 ? activeStreamMs / 1000 : null
    const totalSeconds = totalMs !== null && totalMs > 0 ? totalMs / 1000 : null
    const record = {
      id: `${PLUGIN_ID}-${now()}-${randomUUID().slice(0, 8)}`,
      kind: "response",
      sessionID: turn.sessionID,
      currentSessionID: currentSession.known ? currentSession.id : null,
      currentSessionKnown: currentSession.known,
      messageID: turn.assistantMessageID ?? turn.messageID,
      model: turn.model,
      agent: turn.agent,
      startSource: turn.startSource,
      inferredStart: turn.startSource === "delta",
      firstTokenMs: turn.firstTokenAt === null ? null : turn.firstTokenAt - turn.startedAt,
      firstTextMs: turn.firstTextAt === null ? null : turn.firstTextAt - turn.startedAt,
      firstCharMs: turn.firstCharAt === null ? null : turn.firstCharAt - turn.startedAt,
      firstToLastMs,
      totalMs,
      activeStreamMs,
      characterCount: turn.characterCount,
      reasoningCharacterCount: turn.reasoningCharacterCount,
      outputTokens: tokens.output,
      reasoningTokens: tokens.output === null ? null : tokens.reasoning,
      generatedTokens,
      outputTokenSource: tokens.source,
      deltaCount: turn.deltaCount,
      reasoningDeltaCount: turn.reasoningDeltaCount,
      toolArgCharacters: turn.toolArgCharacters,
      toolArgDeltaCount: turn.toolArgDeltaCount,
      stepCount: turn.stepCount,
      agents: Object.fromEntries(turn.agentStats),
      rateSource,
      unknownEventTypes: summarizeUnknownEvents(),
      observedCharactersPerSecond: streamSeconds !== null
        ? (turn.characterCount + turn.toolArgCharacters) / streamSeconds
        : firstToLastMs !== null && firstToLastMs > 0
          ? (turn.characterCount + turn.toolArgCharacters) / (firstToLastMs / 1000)
          : null,
      tokensPerSecond: generatedTokens === null || streamSeconds === null
        ? null
        : generatedTokens / streamSeconds,
      endToEndTokensPerSecond: generatedTokens === null || totalSeconds === null
        ? null
        : generatedTokens / totalSeconds,
      completedAt: new Date(completedAt).toISOString(),
    }
    record.sessionTotals = updateSessionTotals(sessionID, record)
    // Work this session delegated is credited to whoever asked for it, so a
    // parent session's steps are the work it caused and not only the replies it
    // typed. Skipped when the session is a root one.
    const parentID = await resolveParent(ctx, sessionID)
    if (parentID) {
      record.parentSessionID = parentID
      creditParentWithSubagent(parentID, record)
    }
    await persist(record)
    // Written after the credit above, so the parent this record delegated to is
    // in the file the bar reads and not only in memory until the next turn.
    if (options.popup) void publishSessionTotals().catch(() => {})
    log(
      ctx,
      `session=${record.sessionID} start=${record.startSource} first_token=${formatMs(record.firstTokenMs)} ` +
        `first_to_last=${formatMs(record.firstToLastMs)} total=${formatMs(record.totalMs)} ` +
        `stream=${formatMs(record.activeStreamMs)} (${record.rateSource}) chars=${record.characterCount} deltas=${record.deltaCount} ` +
        `tokens=${record.outputTokens ?? "n/a"}+${record.reasoningTokens ?? "n/a"} (${record.outputTokenSource}) ` +
        `session_turns=${record.sessionTotals.turns} session_tps=${record.sessionTotals.tokensPerSecond?.toFixed?.(1) ?? "n/a"}` +
        (unknownEventTotal > 0 ? ` unknown_events=${unknownEventTotal} [${record.unknownEventTypes}]` : ""),
    )
    if (options.popup) {
      void publishStatus(record).catch((error) => {
        warn(ctx, `could not publish popup status: ${String(error)}`)
      })
      void publishSessionTotals().catch((error) => {
        warn(ctx, `could not publish session totals: ${String(error)}`)
      })
    }
  }

  function handle(event, ctx) {
    if (!options.enabled) return
    const eventID = isRecord(event) && typeof event.id === "string" ? event.id : null
    if (eventID) {
      if (seenEventIDs.has(eventID)) return
      seenEventIDs.add(eventID)
      while (seenEventIDs.size > 2000) seenEventIDs.delete(seenEventIDs.values().next().value)
    }
    const receivedAt = eventTimestamp(event)
    const { type, value } = normalizeEvent(event)
    if (!type || !isRecord(value)) return
    if (!HANDLED_TYPES.has(type) && !isIgnoredEventType(type)) {
      noteUnknownType(ctx, type)
      return
    }
    const sessionID = readSessionID(value)
    if (!sessionID) return
    // Any event for a session is proof the session is live, including the ones
    // this plugin does not measure. Stamped before the dispatch below so an
    // ignored or unknown event still counts as activity. This is the arrival
    // time and not the event's own `created`: a replayed event is old, and
    // liveness is about now.
    lastEventAt = now()

    if (type === "session.viewed") {
      setCurrentSessionId(sessionID)
      return
    }
    if (type === "session.inbox.enqueued") {
      const inboxID = value.inboxID
      const itemType = value.item?.type
      rememberInboxType(inboxID, itemType)
      if (itemType === "synthetic" || itemType === "move") {
        ignoreMessageID(inboxID)
        return
      }
      if (itemType === "compaction") {
        compactingSessions.add(sessionID)
        return
      }
      if (itemType === "user") {
        setCurrentSessionId(sessionID)
        // A synthetic or move item used to mute the session until some execution
        // completed, which swallowed the next real prompt. A new user prompt is
        // the point at which measuring starts again.
        ignoredSessions.delete(sessionID)
        begin(sessionID, inboxID, receivedAt, "enqueue")
        return
      }
      return
    }
    if (type === "session.inbox.delivered") {
      const itemType = value.inboxID ? inboxTypes.get(value.inboxID) : undefined
      if (value.inboxID) inboxTypes.delete(value.inboxID)
      if (itemType === "compaction") {
        compactingSessions.add(sessionID)
      } else if (itemType === "synthetic" || itemType === "move") {
        ignoredSessions.add(sessionID)
        const turn = active.get(sessionID)
        if (turn && !turn.hasEvidence) {
          active.delete(sessionID)
        } else if (turn) {
          turn.ignored = true
        }
      }
      return
    }
    if (type === "session.compaction.started") {
      compactingSessions.add(sessionID)
      const turn = active.get(sessionID)
      if (turn) turn.compaction = true
      return
    }
    if (type === "session.compaction.ended" || type === "session.compaction.failed") {
      // A compaction that ends without an execution completing used to keep the
      // session muted forever (the flag was only cleared by complete()), and the
      // next response was lost silently: measured 0 records after a failed
      // compaction. If an execution is still open, stay muted until it completes.
      if (!executions.has(sessionID)) compactingSessions.delete(sessionID)
      return
    }
    if (type === "session.synthetic" || type === "session.usage.recorded") return
    if (type === "session.execution.started") {
      // Two executions producing at once in one session means parallel work or
      // a subagent, not one turn. Merging them reported a single turn that never
      // happened and mixed one agent's tokens into another's total, so the first
      // is closed and the second starts clean. complete() is called first
      // because it clears the session's own bookkeeping, including the
      // executions entry added below.
      const open = active.get(sessionID)
      if (open && open.hasEvidence) void complete(sessionID, ctx, receivedAt)
      executions.add(sessionID)
      while (executions.size > 200) executions.delete(executions.values().next().value)
      const turn = begin(sessionID, undefined, receivedAt, "execution")
      if (turn && turn.startSource === "enqueue" && !turn.hasEvidence) {
        turn.startedAt = receivedAt
        turn.startSource = "execution"
      }
      return
    }
    if (
      type === "session.execution.succeeded" ||
      type === "session.execution.failed" ||
      type === "session.execution.interrupted"
    ) {
      void complete(sessionID, ctx, receivedAt)
      return
    }
    if (type === "session.step.started") {
      if (compactingSessions.has(sessionID)) return
      const stepStartedAt = numberOrNull(value.started)
      const turn = ensureTurn(sessionID, value.assistantMessageID, stepStartedAt ?? receivedAt, "step")
      if (!turn) return
      noteAssistantMessage(turn, value.assistantMessageID)
      setMetadata(turn, { model: value.model, agent: value.agent })
      if (!turn.hasEvidence && turn.startSource !== "execution" && stepStartedAt !== null) {
        turn.startedAt = Math.max(turn.startedAt, stepStartedAt)
        turn.startSource = "step"
      }
      return
    }
    if (type === "session.step.ended" || type === "session.step.failed") {
      const turn = ensureTurn(sessionID, value.assistantMessageID, receivedAt, "step")
      if (!turn) return
      noteAssistantMessage(turn, value.assistantMessageID)
      setMetadata(turn, { model: value.model, agent: value.agent })
      addStepTokens(turn, value.tokens)
      if (type === "session.step.failed") turn.failed = true
      return
    }
    if (type === "session.text.started") {
      if (compactingSessions.has(sessionID)) return
      const turn = ensureTurn(sessionID, value.assistantMessageID, receivedAt, "text")
      if (!turn) return
      noteAssistantMessage(turn, value.assistantMessageID)
      return
    }
    if (type === "session.text.delta") {
      if (compactingSessions.has(sessionID)) return
      const turn = ensureTurn(sessionID, value.assistantMessageID, receivedAt, "delta")
      if (!turn) return
      noteAssistantMessage(turn, value.assistantMessageID)
      consumeTextDelta(turn, value, receivedAt)
      return
    }
    if (type === "session.text.ended") {
      if (compactingSessions.has(sessionID)) return
      if (typeof value.text !== "string") return
      const turn = ensureTurn(sessionID, value.assistantMessageID, receivedAt, "text")
      if (!turn) return
      noteAssistantMessage(turn, value.assistantMessageID)
      appendSnapshot(turn, snapshotKey(value), value.text, receivedAt)
      return
    }
    if (type === "session.reasoning.started" || type === "session.reasoning.ended") {
      if (compactingSessions.has(sessionID)) return
      const turn = ensureTurn(sessionID, value.assistantMessageID, receivedAt, "reasoning")
      if (!turn) return
      noteAssistantMessage(turn, value.assistantMessageID)
      return
    }
    if (type === "session.reasoning.delta") {
      if (compactingSessions.has(sessionID)) return
      const turn = ensureTurn(sessionID, value.assistantMessageID, receivedAt, "delta")
      if (!turn) return
      noteAssistantMessage(turn, value.assistantMessageID)
      consumeReasoningDelta(turn, value, receivedAt)
      return
    }
    if (
      type === "session.tool.input.started" ||
      type === "session.tool.input.delta" ||
      type === "session.tool.input.ended"
    ) {
      if (compactingSessions.has(sessionID)) return
      const turn = ensureTurn(sessionID, value.assistantMessageID, receivedAt, "tool-input")
      if (!turn) return
      noteAssistantMessage(turn, value.assistantMessageID)
      consumeToolInput(turn, value, receivedAt)
      return
    }
    if (type === "session.usage.updated") {
      const turn = active.get(sessionID)
      const usage = readUsageTokens(value)
      if (turn && usage) {
        if (turn.usageBaseline === null && turn.firstTokenAt === null && turn.stepCount === 0) {
          turn.usageBaseline = usage
        } else {
          turn.usageLatest = usage
        }
      }
      return
    }
  }

  return {
    options,
    setStorage(value) {
      storage = value
    },
    load,
    log,
    warn,
    begin,
    handle,
    setCurrentSessionId,
    refreshCurrentSession,
    noteActivityFor,
    unknownEventTypes: summarizeUnknownEvents,
  }
}

// Exported for the plugin's own test suite; OpenCode only uses the default export.
export const vitalsInternals = {
  DESKTOP_PROCESS_NAMES,
  DESKTOP_MISSING_GRACE_MS,
  RESPONSE_MARKER_TTL_MS,
  LOCK_HELD_EXIT_CODE,
  LOCK_HELD_RETRY_MS,
  STREAM_GAP_LIMIT_MS,
  HANDLED_TYPES,
  IGNORED_TYPES,
  IGNORED_PREFIXES,
  isIgnoredEventType,
  RECENT_RATE_COUNT,
  SUBAGENT_FIELDS,
  SESSION_LOOKUP_TIMEOUT_MS,
  IDLE_HIDE_MS,
  COMPANION_TICK_MS,
  SESSION_TOTALS_FILE,
  CURRENT_SESSION_FILE,
  projectKeyFor,
  barExpectedFrom,
  runtimeFor,
  scanDesktopProcess,
  processListDecision,
  barExpectedFrom,
  stopPopup,
  processIsBar,
  nextPopupRetry,
  pythonCandidates,
  withTimeout,
  readOwnVersion,
  notePluginVersion,
  claimResponse,
  pruneResponseMarkers,
  snapshotRank,
  newerSnapshot,
  normalizeOptions,
}

export default {
  id: PLUGIN_ID,
  async setup(ctx) {
    const project = projectKeyFor(ctx.location)
    const runtime = runtimeFor(ctx.location?.directory, project)
    runtime.controller?.abort()
    if (runtime.companionTimer) clearInterval(runtime.companionTimer)
    const controller = new AbortController()
    runtime.controller = controller
    const state = createState(ctx.options, { project })
    let companionTimer = null
    let markerTimer = null
    const cleanup = () => {
      controller.abort()
      if (companionTimer && runtime.companionTimer === companionTimer) {
        clearInterval(companionTimer)
        runtime.companionTimer = null
      }
      if (markerTimer) clearInterval(markerTimer)
      if (runtime.markerTimer === markerTimer) runtime.markerTimer = null
      if (runtime.controller === controller) runtime.controller = null
    }
    if (state.options.popup) startPopup(runtime)
    // The bar is refreshed within seconds of a script change, the current session
    // heartbeat lets the bar drop a stale session when the plugin is gone, and
    // the bar itself leaves when the OpenCode app is closed.
    if (state.options.popup) {
      companionTimer = setInterval(() => {
        state.noteActivityFor(runtime)
        if (barExpected(runtime)) startPopup(runtime)
        else void stopPopup()
        state.refreshCurrentSession()
      }, COMPANION_TICK_MS)
      companionTimer.unref?.()
      runtime.companionTimer = companionTimer
    }
    state.setStorage(ctx.storage)
    await state.load()
    // Markers used to be pruned only when a new response arrived, so a dormant
    // plugin — which is exactly what the long-lived service becomes once the app
    // is closed — kept every marker forever. The timer makes cleanup independent
    // of activity.
    markerTimer = setInterval(() => void pruneResponseMarkers(), MARKER_PRUNE_INTERVAL_MS)
    markerTimer.unref?.()
    runtime.markerTimer = markerTimer
    const version = await notePluginVersion()
    // The version line is rare and it is how a person finds out whether the
    // copy they are reading about is the copy that is running, so it is printed
    // whether or not per-turn logging is on.
    if (version.changed) state.warn(ctx, `updated ${version.previous ?? "none"} -> ${version.version}`)

    if (!ctx.event?.subscribe) {
      state.warn(ctx, "event subscription unavailable; measurement is disabled")
      return cleanup
    }

    void (async () => {
      let malformed = 0
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          // One hostile event must not end the subscription for the rest of the
          // process: a throw in here used to stop every later measurement.
          try {
            state.handle(event, ctx)
          } catch (error) {
            malformed += 1
            // A hostile event must be visible when it happens: the subscription
            // survives it, so nothing else would ever mention it.
            if (malformed <= 5) state.warn(ctx, `ignored a malformed event: ${String(error)}`)
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) state.warn(ctx, `event subscription stopped: ${String(error)}`)
      }
    })()

    if (typeof ctx.session?.hook === "function") {
      try {
        await ctx.session.hook("prompt", (event) => {
          const sessionID = event?.sessionID ?? event?.prompt?.sessionID
          const messageID = event?.messageID ?? event?.prompt?.messageID
          state.setCurrentSessionId(sessionID)
          state.begin(sessionID, messageID, now(), "hook")
        })
      } catch (error) {
        state.warn(ctx, `prompt hook unavailable; relying on session events: ${String(error)}`)
      }
    }

    return cleanup
  },
}
