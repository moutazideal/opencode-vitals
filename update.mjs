// Keeping the installed copy current.
//
// OpenCode already checks unpinned package plugins for updates when its server
// starts, and it deliberately does not swap them under a running process. That is
// the right call, but it leaves the swap to a person, and the point of installing
// a plugin rather than pasting a file somewhere is not having to think about
// versions. This does that half.
//
// Four rules shaped it, and each one is a bug that was available to write:
//
//   1. It is OpenCode's updater, not ours. This plugin runs inside the OpenCode
//      CLI, so `process.execPath` is exactly the binary that has to perform the
//      swap. Asking it to do its own job means the package lands where OpenCode
//      will look for it, in the shape OpenCode expects, with OpenCode's own idea
//      of what is installed. Downloading a tarball and unpacking it over the
//      running install would be a package manager of our own, with a package
//      manager's worth of ways to leave someone with a broken plugin.
//   2. Once per version, not once per launch. The new code cannot be running in
//      the process that installed it — Node has already evaluated these modules —
//      so without a latch this would spawn an update on every single start,
//      forever, until the user happened to restart. The latch is what makes it
//      silent the rest of the time.
//   3. A lower version is never "latest". A registry that answers with something
//      older, or with something that is not a version at all, is ignored rather
//      than obeyed.
//   4. Nothing here can break the measurement. Every call is best-effort, every
//      failure is swallowed, and the plugin keeps counting either way. An update
//      is a convenience; it is never allowed to become the reason numbers stop.
import { spawn } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"

// How long to believe our own last look. A launch is not a network event, and a
// machine that starts OpenCode twenty times a day should not ask npm twenty
// times. Long enough that a new release is picked up the same day; short enough
// that "it is always current" stays true.
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

// The updater rewrites a directory that belongs to a running process. Give it
// room, but not the patience to hang a launch on a wedged npm.
const APPLY_TIMEOUT_MS = 180_000

// Only asked about once the rest of the plugin has finished starting. Spawning a
// package manager in the middle of a launch is rude, and a launch that goes slow
// is a launch that looks broken.
export const START_DELAY_MS = 15_000

const DEFAULT_REGISTRY = "https://registry.npmjs.org"
const PLUGIN_NAME = "opencode-vitals"

const truthy = (value) => value === "1" || value === "true" || value === "yes" || value === "on"

const numeric = (value) => {
  const parsed = Number.parseInt(String(value ?? ""), 10)
  return Number.isFinite(parsed) ? parsed : 0
}

// Enough of semver to order the versions this package has actually published.
// Numeric parts are compared as numbers, so 0.1.10 is newer than 0.1.9 — the bug
// a string compare has — and a prerelease is older than the release it leads to,
// so a pre-release is never installed over the real thing.
export function compareVersions(left, right) {
  const split = (value) => {
    const text = String(value ?? "")
    const [core, pre] = text.split("-", 2)
    return { parts: core.split(".").map(numeric), pre: pre ?? null }
  }
  const a = split(left)
  const b = split(right)
  const width = Math.max(a.parts.length, b.parts.length)
  for (let index = 0; index < width; index += 1) {
    const diff = (a.parts[index] ?? 0) - (b.parts[index] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  if (a.pre === b.pre) return 0
  if (a.pre === null) return 1
  if (b.pre === null) return -1
  return a.pre < b.pre ? -1 : 1
}

// The version of this copy, and whether it is a package OpenCode installed or a
// directory somebody copied. It matters: `plugin update` only knows about the
// first, and asking it about the second produces a confusing error instead of a
// quiet no-op.
export function readInstall({ root = dirname(fileURLToPath(import.meta.url)) } = {}) {
  let name = PLUGIN_NAME
  let version = "0.0.0"
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
    if (typeof manifest?.name === "string" && manifest.name) name = manifest.name
    if (typeof manifest?.version === "string" && manifest.version) version = manifest.version
  } catch {
    // No manifest is not an error to report: the caller is already best-effort,
    // and a version we cannot read is a version we will not try to upgrade past.
  }
  return { name, version, root, packaged: root.split(/[\\/]/).includes("node_modules") }
}

// The kill switches. A file rather than only an environment variable, because a
// user who turns this off once should stay off across restarts, terminals and
// shells, and an env var set in one shell is not that.
export function updatesDisabled({ env = process.env, markerDir } = {}) {
  if (truthy(env.OPENCODE_VITALS_NO_UPDATE)) return "OPENCODE_VITALS_NO_UPDATE is set"
  const marker = markerDir ?? join(
    env.XDG_DATA_HOME ?? join(env.HOME ?? "", ".local", "share"),
    "opencode-vitals",
    "no-update",
  )
  if (existsSync(marker)) return `${marker} exists`
  return null
}

const readLatch = (file) => {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"))
    return raw && typeof raw === "object" ? raw : {}
  } catch {
    return {}
  }
}

const writeLatch = (file, value) => {
  try {
    writeFileSync(file, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

// The newest version on the registry, or null for every reason there might be one:
// offline, a private registry, a 404 because the package was unpublished, a
// response that is not a version. This is a convenience and none of these are
// worth interrupting anybody's editor for.
export async function latestPublished({ registry = DEFAULT_REGISTRY, name = PLUGIN_NAME, timeoutMs = 5000, fetch: request = fetch } = {}) {
  try {
    const response = await request(`${registry.replace(/\/$/, "")}/${encodeURIComponent(name).replace("%40", "@")}/latest`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response?.ok) return null
    const body = await response.json()
    const version = body?.version
    return typeof version === "string" && version ? version : null
  } catch {
    return null
  }
}

// The binary that should run OpenCode's own updater. On the desktop host
// `process.execPath` is the Electron application, and only some builds answer
// `plugin update`; the CLI the app ships is the better answer when one can be
// found. `cli` is the other way in, for a caller that already knows.
async function findUpdaterBinary() {
  try {
    // Lazy, because install.mjs imports this module and the cycle must stay
    // dynamic rather than at module-evaluation time.
    const { findOpenCodeCli } = await import("./install.mjs")
    return findOpenCodeCli() ?? process.execPath
  } catch {
    return process.execPath
  }
}

// Hand the swap to OpenCode. Its own updater, its own view of what is installed,
// its own idea of where packages live — ours is only the argument.
export function applyUpdate({ cli, name = PLUGIN_NAME, timeoutMs = APPLY_TIMEOUT_MS, spawn: run = spawn } = {}) {
  return new Promise((resolve) => {
    void (async () => {
      const binary = cli ?? (await findUpdaterBinary())
      let child
      try {
        child = run(binary, ["plugin", "update", name], { stdio: ["ignore", "pipe", "pipe"] })
      } catch (error) {
        resolve({ ok: false, reason: String(error) })
        return
      }
      // Captured rather than inherited: this output belongs in the plugin's own
      // log line if anything went wrong, not interleaved into the service's.
      let output = ""
      child.stdout?.on("data", (chunk) => { output += chunk })
      child.stderr?.on("data", (chunk) => { output += chunk })
      const timer = setTimeout(() => {
        child.kill("SIGKILL")
        resolve({ ok: false, reason: `opencode plugin update did not finish in ${Math.round(timeoutMs / 1000)}s` })
      }, timeoutMs)
      timer.unref?.()
      child.on("error", (error) => {
        clearTimeout(timer)
        resolve({ ok: false, reason: String(error) })
      })
      child.on("close", (code) => {
        clearTimeout(timer)
        resolve(code === 0 ? { ok: true } : { ok: false, reason: output.trim().split("\n").slice(-3).join(" ") || `exited ${code}` })
      })
    })()
  })
}

// The whole decision, in one pure-ish function, so it can be pinned by tests
// without a network, a clock or a subprocess.
export async function considerUpdate({
  version,
  name = PLUGIN_NAME,
  packaged = true,
  disabled = null,
  latch,
  now = Date.now(),
  checkIntervalMs = CHECK_INTERVAL_MS,
  registry,
  fetch: request,
  spawn: run,
  cli,
  latchFile,
} = {}) {
  if (disabled) return { action: "disabled", reason: disabled }
  if (!packaged) {
    // A copied directory has no version to move. Saying so once is more use than
    // a subprocess error, and the fix — install it as a package — is a real one.
    return { action: "not-packaged", reason: "installed as a copy, not as a package OpenCode can update" }
  }
  // Read from the file unless a caller passed the latch in, so that writing it
  // and reading it back cannot come apart. A latch written here and read
  // somewhere else is a latch that quietly stops working the first time a caller
  // forgets one argument — and the symptom is an update on every single launch.
  const seen = latch ?? (latchFile ? readLatch(latchFile) : {})
  if (seen.attempted === version) {
    // Already installed this one. It is not running yet, because a running
    // process cannot become the version it just installed, and it will be on the
    // next start. Asking again would do the same work for the same answer.
    return { action: "awaiting-restart", latest: seen.attempted }
  }
  if (seen.checkedAt && now - seen.checkedAt < checkIntervalMs) {
    return { action: "recent", reason: "checked recently" }
  }
  const latest = await latestPublished({ registry, name, fetch: request })
  if (!latest) return { action: "unknown", reason: "the registry did not answer" }
  if (compareVersions(latest, version) <= 0) {
    if (latchFile) writeLatch(latchFile, { ...seen, checkedAt: now, latest })
    return { action: "current", latest }
  }
  const applied = await applyUpdate({ cli, name, spawn: run })
  // Success is what `attempted` records: "this version is installed and waiting
  // for a restart" is the only reason not to ask again. A failure is remembered
  // through `checkedAt` alone, so a transient one — a momentary network failure,
  // a registry that was busy — is retried after the check interval instead of
  // being written off until a newer version is published.
  if (latchFile) {
    writeLatch(latchFile, applied.ok
      ? { ...seen, checkedAt: now, latest, attempted: version }
      : { ...seen, checkedAt: now, latest })
  }
  return applied.ok
    ? { action: "installed", latest, version }
    : { action: "failed", latest, version, reason: applied.reason }
}

// The entry point the plugin calls, later. Everything above is a decision; this
// is the decision being made once, quietly, and reported once.
export async function updateIfNeeded({ statusDir = join(tmpdir(), "opencode-latency-monitor"), onReport, ...options } = {}) {
  const latchFile = options.latchFile ?? join(statusDir, "update-check.json")
  const install = readInstall()
  const disabled = updatesDisabled()
  const outcome = await considerUpdate({ ...options, version: install.version, name: install.name, packaged: install.packaged, disabled, latchFile })
  // Only two outcomes are worth a line in someone's terminal. A machine that is
  // offline, or already current, or has opted out, is the normal case and says
  // nothing — a plugin that logs on every launch is a plugin people mute.
  if (outcome.action === "installed") {
    onReport?.(`opencode-vitals ${install.version} → ${outcome.latest}: installed. Restart OpenCode to run it.`)
  } else if (outcome.action === "failed") {
    onReport?.(`opencode-vitals ${outcome.latest} is published but the update did not apply: ${outcome.reason}. Run: opencode plugin update ${install.name}`)
  }
  return outcome
}

export const updateInternals = {
  APPLY_TIMEOUT_MS,
  DEFAULT_REGISTRY,
  PLUGIN_NAME,
  readLatch,
  writeLatch,
  truthy,
}
