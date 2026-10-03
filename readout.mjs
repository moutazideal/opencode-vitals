// The in-app readout.
//
// OpenCode's desktop app loads its renderer from its own bundle. It also honours
// an environment variable that points that load somewhere else, which is how the
// numbers get inside the window instead of on top of it: a copy of the app's
// renderer, with one script tag added beside the app's own bundle, served over
// localhost.
//
// Nothing here is required for the measurement to work. If any step fails —
// no app, no writable directory, a port already taken — the plugin keeps
// measuring and says so once. A readout is a nicety; breaking the editor to get
// one would be a bad trade.
import { createServer } from "node:http"
import { createReadStream } from "node:fs"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { createHash } from "node:crypto"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const READOUT_SCRIPT = join(HERE, "renderer", "vitals.js")
const MARKER = ".vitals-sync.json"

// `?? ""` on HOME for the same reason update.mjs has it: a host that does not
// set it must not turn a missing variable into a TypeError while this module is
// still being imported, before any of the readout's best-effort guards can run.
const DATA_HOME = process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? "", ".local", "share")
const WORK_DIR = process.env.OPENCODE_VITALS_DIR ?? join(DATA_HOME, "opencode-vitals")
const RENDERER_DIR = join(WORK_DIR, "renderer")
const DESKTOP_DIR = join(DATA_HOME, "applications")
const PORT = Number(process.env.OPENCODE_VITALS_PORT ?? 8971)

// The app's own renderer entry point, and the tag that pulls our script in. The
// tag goes beside the app's bundle, never inside it: the bundle is a build
// artefact and rewriting one would be undone by the next update anyway.
const SCRIPT_TAG = '<script type="module" src="./vitals.js"></script>'

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
}

// -- finding the app ---------------------------------------------------------

// Candidates rather than one path: the app is packaged differently per platform
// and per distributor, and a wrong guess here must degrade to "not available"
// rather than to a crash on the plugin's startup path.
//
// An explicit OPENCODE_DESKTOP_APP is the whole answer, not the first of several.
// Someone who points this at a specific bundle means it, and quietly falling
// through to a guessed path would make the setting a lie.
function appCandidates() {
  const fromEnv = process.env.OPENCODE_DESKTOP_APP
  if (fromEnv) return [fromEnv]
  return [
    "/opt/OpenCode/resources/app.asar",
    "/usr/lib/opencode/resources/app.asar",
    "/usr/share/opencode/resources/app.asar",
    "/Applications/OpenCode.app/Contents/Resources/app.asar",
    join(process.env.HOME ?? "", "Applications", "OpenCode.app", "Contents", "Resources", "app.asar"),
    "C:/Program Files/OpenCode/resources/app.asar",
  ]
}

function findApp() {
  for (const candidate of appCandidates()) {
    try {
      if (candidate && existsSync(candidate)) return candidate
    } catch {
      // An unreadable candidate is not the app we want.
    }
  }
  return null
}

// -- reading app.asar --------------------------------------------------------

// An asar is a length-prefixed JSON directory followed by the file data. Reading
// the few entries we need is a few dozen lines, which is a lot better than
// making the published package depend on an extractor to start.
function openAsar(path) {
  const handle = readFileSync(path)
  const headerSize = handle.readUInt32LE(4)
  const jsonSize = handle.readUInt32LE(12)
  const tree = JSON.parse(handle.subarray(16, 16 + jsonSize).toString("utf8"))
  const base = 8 + headerSize
  const walk = (node, parts) => {
    let current = tree
    for (const part of parts) {
      current = current?.files?.[part]
      if (!current) return null
    }
    return current
  }
  return {
    has: (parts) => Boolean(walk(null, parts)),
    // A directory entry has children and no data; a file entry is the opposite.
    // Callers need to tell them apart, or they skip every directory they meet —
    // which silently produced a renderer with no assets.
    isDir: (parts) => Boolean(walk(null, parts)?.files),
    read: (parts) => {
      const entry = walk(null, parts)
      if (!entry || entry.files) return null
      const start = base + Number(entry.offset)
      return handle.subarray(start, start + entry.size)
    },
    list: (parts) => Object.keys(walk(null, parts)?.files ?? {}),
  }
}

// -- syncing the renderer ----------------------------------------------------

// Every file under out/renderer, at every depth, because the app's own bundles
// live one level down in assets/. A shallow walk skipped the directories and
// left only the asar's total size to notice an app update by — so a rebuild that
// changed a bundle without changing that size went unnoticed and the readout
// kept serving last week's UI. The name is hashed with the content, so a rename
// is a change too.
function fingerprint(asar) {
  const hash = createHash("sha256")
  const walk = (parts) => {
    for (const name of asar.list(parts).sort()) {
      const child = [...parts, name]
      if (asar.isDir(child)) {
        hash.update(`${name}/\n`)
        walk(child)
        continue
      }
      const entry = asar.read(child)
      if (entry) hash.update(name).update(entry)
    }
  }
  walk(["out", "renderer"])
  hash.update(String(statSync(asar.path ?? "").size))
  return hash.digest("hex").slice(0, 32)
}

function readMarker() {
  try {
    return JSON.parse(readFileSync(join(RENDERER_DIR, MARKER), "utf8"))
  } catch {
    return null
  }
}

// The readout's own script is not the app's. A plugin update changes it while
// the app stays put, so it is part of the copy's stamp: without it a new readout
// never reached a copy whose app had not moved, and renderer fixes sat unused
// until OpenCode itself updated.
function readoutScriptHash() {
  try {
    return createHash("sha256").update(readFileSync(READOUT_SCRIPT)).digest("hex").slice(0, 16)
  } catch {
    return null
  }
}

function injectTag(html) {
  const source = html.toString("utf8")
  if (source.includes("vitals.js")) return source
  // Beside the app's own module bundle. The build's filename changes between
  // releases, so the anchor is the module script itself rather than one build's
  // name. A page with no module script at all cannot be extended, and null says
  // so rather than injecting a tag that would never load.
  const anchor = /<script[^>]*type="module"[^>]*src="[^"]+"[^>]*><\/script>/
  if (!anchor.test(source)) return null
  return source.replace(anchor, (match) => `${match}\n    ${SCRIPT_TAG}`)
}

// Recursive: the app's renderer is a directory tree, and the assets the document
// asks for live a level down. Copying only the top level produced a page that
// referenced bundles that were not there.
function copyTree(asar, from, to) {
  mkdirSync(to, { recursive: true })
  for (const name of asar.list(from)) {
    const parts = [...from, name]
    if (asar.isDir(parts)) {
      if (!copyTree(asar, parts, join(to, name))) return false
      continue
    }
    const entry = asar.read(parts)
    if (!entry) continue
    if (name === "_headers" || name === MARKER) continue
    if (name === "index.html") {
      const html = injectTag(entry)
      if (html === null) return false
      writeFileSync(join(to, name), html)
      continue
    }
    writeFileSync(join(to, name), entry)
  }
  return true
}

// Rebuilding from inside a request handler, at most once per cool-down.
//
// The rebuild is synchronous and copies tens of megabytes, so it blocks the
// plugin host's event loop for as long as it takes. That is a deliberate trade:
// a two-second pause in measuring is a smaller cost than a window that will not
// open, and it only ever happens when the copy is already gone.
//
// The cool-down is the other half. An app whose bundle cannot be read would
// otherwise rebuild on every single asset it asks for — a request loop doing
// forty megabytes of copying per request — and turn a failure into a machine
// that cannot be used for anything else.
let rebuilding = false
let lastRebuildAt = 0
let lastRebuildFailed = false
const REBUILD_COOLDOWN_MS = 30_000

function ensureCopy() {
  if (rendererReady()) return true
  const at = Date.now()
  if (rebuilding) return false
  // The cool-down counts failed attempts, not elapsed time. A copy that was
  // serving a moment ago and has gone is a new failure, and it is the kind worth
  // trying at once — usually someone deleted it, and the fix is to put it back.
  // What must not repeat is a build that cannot succeed, and the only thing that
  // tells those apart is whether the last attempt worked.
  if (lastRebuildFailed && at - lastRebuildAt < REBUILD_COOLDOWN_MS) return false
  rebuilding = true
  lastRebuildAt = at
  try {
    // Forced. Without it the fingerprint of an unchanged app says "already
    // current" and returns without copying anything, which is exactly right for
    // a scheduled sync and exactly wrong for a repair: the app has not changed,
    // the copy has.
    const ok = syncRenderer({ force: true }).ok && rendererReady()
    lastRebuildFailed = !ok
    return ok
  } catch {
    lastRebuildFailed = true
    return false
  } finally {
    rebuilding = false
  }
}

// Bring the copy in line with the installed app. Returns what happened, so the
// caller can log it once instead of guessing.
export function syncRenderer({ force = false } = {}) {
  const path = findApp()
  if (!path) return { ok: false, reason: "no OpenCode desktop app found" }

  let asar
  try {
    asar = openAsar(path)
  } catch (error) {
    return { ok: false, reason: `could not read ${path}: ${String(error)}` }
  }
  if (!asar.has(["out", "renderer", "index.html"])) {
    return { ok: false, reason: `${path} has no out/renderer/index.html` }
  }

  const app = createHash("sha256").update(path).digest("hex").slice(0, 8)
  const stamp = { app, fingerprint: fingerprint({ ...asar, path }), script: readoutScriptHash() }
  const previous = readMarker()
  if (!force && previous && previous.app === stamp.app && previous.fingerprint === stamp.fingerprint) {
    // The app is unchanged, but the readout script may not be: a plugin update
    // changes it while the app stays put, so it is copied in on its own rather
    // than rebuilding the whole interface for it.
    if (previous.script !== stamp.script && rendererReady()) {
      try {
        copyFileSync(READOUT_SCRIPT, join(RENDERER_DIR, "vitals.js"))
        writeFileSync(join(RENDERER_DIR, MARKER), JSON.stringify(stamp))
        return { ok: true, changed: true, ...stamp }
      } catch (error) {
        return { ok: false, reason: `could not update ${join(RENDERER_DIR, "vitals.js")}: ${String(error)}` }
      }
    }
    return { ok: true, changed: false, ...stamp }
  }

  // Built beside the copy and moved into place, never built over it.
  //
  // Deleting first and copying second — which is what this used to do — creates
  // a window in which there is no index.html at all, and if the copy then fails
  // the window is not a window, it is the state. The launcher entry still points
  // the whole application here, so that state is an application that will not
  // open, left behind by a plugin whose only job was to show some numbers.
  //
  // A rename within one filesystem is atomic, so a reader sees the old copy or
  // the new one. Replacing a directory needs two renames — the old one out, the
  // new one in — and the gap between them is a single pair of syscalls wide
  // rather than a whole copy. A request that did land in it is answered by
  // ensureCopy above rather than by a 404, which is what the two changes are for.
  const staging = `${RENDERER_DIR}.new`
  const retired = `${RENDERER_DIR}.old`
  try {
    rmSync(staging, { recursive: true, force: true })
    if (!copyTree(asar, ["out", "renderer"], staging)) {
      rmSync(staging, { recursive: true, force: true })
      return { ok: false, reason: "the app's index.html no longer loads a module bundle this can sit beside" }
    }
    copyFileSync(READOUT_SCRIPT, join(staging, "vitals.js"))
    writeFileSync(join(staging, MARKER), JSON.stringify(stamp))

    if (existsSync(RENDERER_DIR)) {
      rmSync(retired, { recursive: true, force: true })
      renameSync(RENDERER_DIR, retired)
    }
    try {
      renameSync(staging, RENDERER_DIR)
    } catch (error) {
      // The new copy could not be moved in, so the old one goes back rather than
      // being left renamed out of the way. A stale readout beats no application.
      if (existsSync(retired) && !existsSync(RENDERER_DIR)) renameSync(retired, RENDERER_DIR)
      throw error
    }
    rmSync(retired, { recursive: true, force: true })
    return { ok: true, changed: true, ...stamp }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    return { ok: false, reason: `could not write ${RENDERER_DIR}: ${String(error)}` }
  }
}

// Everything a check needs to answer "can this machine show the readout", without
// doing any of it.
//
// syncRenderer is how the copy gets made, and it makes one: forty-odd megabytes.
// Using it as a diagnostic meant that running the check left behind a directory
// the person had not asked for — and a check that mutates the machine cannot be
// run twice to see whether anything changed, which is the only reason to run it
// twice. So this reads the bundle, proves the readout could be injected beside
// it, and reports whether a copy is present and current. It writes nothing.
export function inspect() {
  const path = findApp()
  if (!path) return { ok: false, reason: "no OpenCode desktop app found" }
  let asar
  try {
    asar = openAsar(path)
  } catch (error) {
    return { ok: false, reason: `could not read ${path}: ${String(error)}` }
  }
  if (!asar.has(["out", "renderer", "index.html"])) {
    return { ok: false, reason: `${path} has no out/renderer/index.html` }
  }
  const app = createHash("sha256").update(path).digest("hex").slice(0, 8)
  const stamp = { app, fingerprint: fingerprint({ ...asar, path }), script: readoutScriptHash() }
  // The one question a copy cannot answer without being made: is there a module
  // bundle for the readout to sit beside? Injecting into a buffer proves it and
  // costs nothing.
  const injected = injectTag(asar.read(["out", "renderer", "index.html"]))
  const installed = readMarker()
  return {
    ok: true,
    ...stamp,
    injectable: Boolean(injected),
    reason: injected ? null : "the app's index.html loads no module bundle this can sit beside",
    copy: {
      present: rendererReady(),
      // "current" is a claim about the copy on disk, so it is only true when the
      // copy was made from this exact bundle and carries this exact readout.
      current: Boolean(installed && installed.app === stamp.app && installed.fingerprint === stamp.fingerprint && installed.script === stamp.script),
    },
  }
}

export function rendererReady() {
  try {
    return existsSync(join(RENDERER_DIR, "index.html")) && existsSync(join(RENDERER_DIR, "vitals.js"))
  } catch {    return false
  }
}

// -- the launcher's desktop entry -------------------------------------------

// The app is launched through a .desktop file. A user-level file with the same
// name takes precedence over the system one, so writing ours means the ordinary
// OpenCode icon starts the app with the renderer pointed at us — no new launcher
// for anyone to learn, and nothing under /opt is touched.
//
// Ours is a copy of the system entry with one line changed. Reconstructing the
// file instead would lose whatever the packager put in it — the icon, the WM
// class, the deep-link handler — and those are exactly the details that make a
// launcher work.
// Read when it is needed, not when the module is loaded. findApp() already reads
// the environment on every call, and this was the one place that did not — so a
// process whose environment changed after it was imported, which is what a test
// does, kept searching the directories it had at startup. That is a hidden
// dependency on import order, and it is the reason a case here could pass for
// free: the search found nothing, and "found nothing" is a reason for the removal
// to be skipped rather than an error.
function systemEntryDirs() {
  return [
    ...(process.env.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share").split(":").map((dir) => join(dir, "applications")),
    "/var/lib/flatpak/exports/share/applications",
  ]
}

function readSystemEntry(app) {
  for (const dir of systemEntryDirs()) {
    let names
    try {
      names = readdirSync(dir).filter((name) => name.endsWith(".desktop"))
    } catch {
      continue
    }
    for (const name of names) {
      let body
      try {
        body = readFileSync(join(dir, name), "utf8")
      } catch {
        continue
      }
      const exec = body.match(/^Exec=(.*)$/m)?.[1] ?? ""
      // The entry belongs to this app when its Exec points at the app directory
      // the renderer was found in.
      const appDir = dirname(dirname(app))
      if (!exec.includes(appDir)) continue
      return { name, body, exec }
    }
  }
  return null
}

// The binary, taken from the system entry's own Exec rather than guessed from the
// asar path: the asar is always "app.asar" and says nothing about what runs.
function appBinary(systemEntry, app) {
  if (!systemEntry) {
    const guess = app.replace(/\/resources\/app\.asar$/, "")
    return existsSync(guess) ? guess : null
  }
  const exec = systemEntry.exec.trim().split(/\s+/)[0]
  return exec || null
}

function markedEntryBody(systemEntry, binary) {
  return systemEntry.body
    .replace(/^Exec=.*$/m, `Exec=env ELECTRON_RENDERER_URL=http://127.0.0.1:${PORT} ${binary} %U`)
    .trimEnd()
    .concat("\nX-OpenCode-Vitals=readout\n")
}

export function installDesktopEntry() {
  const app = findApp()
  if (!app) return { ok: false, reason: "no app" }
  const systemEntry = readSystemEntry(app)
  if (!systemEntry) return { ok: false, reason: `no system launcher for ${app}` }
  const binary = appBinary(systemEntry, app)
  if (!binary || !existsSync(binary)) return { ok: false, reason: `launcher binary not found: ${binary}` }
  try {
    mkdirSync(DESKTOP_DIR, { recursive: true })
    const target = join(DESKTOP_DIR, systemEntry.name)
    const body = markedEntryBody(systemEntry, binary)
    // The plugin writes this on every start now, not only when its installer
    // runs, so it has to be a no-op when there is nothing to change. Rewriting an
    // identical file would touch its timestamp on every launch, and a timestamp
    // is exactly what a desktop environment watches.
    let current = null
    try {
      current = readFileSync(target, "utf8")
    } catch {
      // Not there, or unreadable: write it, and let the write report a problem.
    }
    if (current === body) return { ok: true, path: target, copiedFrom: systemEntry.name, unchanged: true }
    writeFileSync(target, body)
    return { ok: true, path: target, copiedFrom: systemEntry.name }
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
}

export function removeDesktopEntry({ dir } = {}) {
  const target = dir ?? DESKTOP_DIR
  // Found by what it says about itself, not by mirroring the system entry's
  // name. After an OpenCode update the system entry can move or disappear, and
  // the entry this plugin wrote is exactly the file that must not be left
  // pointing at a server that cannot serve — so it is located by its own marker
  // and removed whether or not the system entry can still be found.
  let names
  try {
    names = readdirSync(target)
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: true, path: null, removed: 0 }
    return { ok: false, reason: String(error), removed: 0 }
  }
  let removed = 0
  let first = null
  for (const name of names) {
    if (!name.endsWith(".desktop")) continue
    const path = join(target, name)
    let body
    try {
      body = readFileSync(path, "utf8")
    } catch {
      continue
    }
    // Only ever removes the entry we wrote, and only while it still carries our
    // marker: a file the user has since edited is theirs, not ours to delete.
    if (!body.includes("X-OpenCode-Vitals")) continue
    try {
      rmSync(path, { force: true })
      removed += 1
      if (first === null) first = path
    } catch {
      // A file that cannot be removed is reported by the count not moving.
    }
  }
  return { ok: true, path: first, removed }
}

// Uninstall has to take both halves with it. Leaving either behind means a
// removed plugin still changes how the app starts, which is the one thing an
// uninstall must not do.
// `workDir` is overridable for the same reason `removeStatus` takes a directory:
// a test that cannot name the directory cannot check that it is gone, and the
// directory it defaults to is the developer's own.
export function removeReadout({ workDir, desktopDir } = {}) {
  const target = workDir ?? WORK_DIR
  const entry = removeDesktopEntry({ dir: desktopDir })
  const renderer = { ok: true, path: target }
  try {
    // The whole work directory, not just the renderer inside it: leaving an
    // empty shell behind means "uninstalled" still has a directory named after
    // this plugin sitting in the user's data path.
    rmSync(target, { recursive: true, force: true })
  } catch (error) {
    if (error?.code !== "ENOENT") renderer.ok = false, (renderer.reason = String(error))
  }
  return { entry, renderer }
}

// -- the server --------------------------------------------------------------

// A file that was there when it was stat'd and gone by the time it is opened is
// a read stream that emits an error. Left unhandled that is an uncaught
// exception in the plugin host — the one thing this readout is not allowed to
// cause. The answer is the same as a miss: a plain 503 before the headers, the
// connection closed after them, never a crash.
export function serveAsset(response, path) {
  const stream = createReadStream(path)
  stream.on("error", () => {
    if (response.headersSent) response.destroy()
    else response.writeHead(503, { "Content-Type": "text/plain" }).end("asset unavailable")
  })
  // A client that goes away must not leave the file being read to the end.
  response.on("close", () => stream.destroy())
  stream.pipe(response)
}

// Serves the copied renderer and the numbers. It runs inside the plugin host, so
// there is no second process to start, stop, supervise or leave behind.
// `port` defaults to the one the launcher entry names, which is what the app is
// pointed at. It is overridable so a test can bind a second server beside the
// real one instead of fighting it for the port.
export function serve({ getSession, onListen, onError, onStatus, port } = {}) {
  const fileExists = (candidate) => {
    try {
      return statSync(candidate).isFile()
    } catch {
      return false
    }
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost")
    const { pathname } = url

    // The injected script reports whether it found the composer. It is the only
    // signal for the failure that matters most — the app renaming a slot, and
    // the readout quietly vanishing with no error anywhere — so it has to land
    // somewhere. Without this the request fell through to the asset lookup and
    // was answered with the whole index.html, once a second, forever.
    if (pathname === "/__vitals-status") {
      const { placed, detail } = Object.fromEntries(url.searchParams)
      onStatus?.({ placed: placed === "true", detail: detail ?? "" })
      response.writeHead(204).end()
      return
    }

    if (pathname === "/vitals") {
      let payload
      try {
        payload = getSession?.(url.searchParams.get("session")) ?? { sessionID: null, totals: null }
      } catch (error) {
        payload = { sessionID: null, totals: null, error: String(error) }
      }
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
      response.end(JSON.stringify(payload))
      return
    }

    // Assets are looked up by name as well as by path. The app does not always
    // load the document from "/", and a relative "./assets/x.js" then resolves
    // against a deeper path. A miss is a real 404 and never index.html: a .js
    // answered with text/html is rejected on MIME type and the app breaks.
    const name = pathname.split("/").pop()
    const find = () => {
      const direct = join(RENDERER_DIR, pathname)
      return fileExists(direct) ? direct : [join(RENDERER_DIR, name), join(RENDERER_DIR, "assets", name)].find(fileExists)
    }
    let found = find()
    // A miss is rebuilt once, here, rather than answered.
    //
    // This server is not a side channel. The launcher entry points the whole
    // application at it, so a 404 is not a missing picture, it is an application
    // that will not start. Anything that can empty that directory — an
    // uninstall while OpenCode is open, a `rm -rf`, a failed sync, a tmp
    // reaper — would otherwise be a window that stays broken until the next
    // ten-minute tick, and broken for good if the rebuild is what failed.
    // Rebuilding here makes the cause of the failure irrelevant: the request
    // that would have been a 404 is the request that repairs it.
    if (!found) found = ensureCopy() ? find() : null
    if (found) {
      response.writeHead(200, { "Content-Type": TYPES[found.slice(found.lastIndexOf("."))] ?? "application/octet-stream", "Cache-Control": "no-store" })
      serveAsset(response, found)
      return
    }
    if (pathname.includes(".", pathname.lastIndexOf("/") + 1)) {
      response.writeHead(404, { "Content-Type": "text/plain" }).end("not found")
      return
    }
    const shell = join(RENDERER_DIR, "index.html")
    if (!fileExists(shell)) {
      response.writeHead(503, { "Content-Type": "text/plain" }).end("readout renderer not installed")
      return
    }
    response.writeHead(200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-store" })
    createReadStream(shell).pipe(response)
  })

  server.on("error", (error) => onError?.(error))
  server.listen(port ?? PORT, "127.0.0.1", () => onListen?.(port ?? PORT))
  // A listening socket is a handle that keeps the event loop alive. The plugin
  // host is long-lived and would not care, but anything that imports this — a
  // test run, a script — would hang on exit with nothing left to do.
  server.unref()
  return server
}

// Exported for the selftest and the test suite. Only what is actually read from
// here is listed: an export nobody reads is a second copy of the truth.
export const readoutInternals = {
  RENDERER_DIR,
  PORT,
  SCRIPT_TAG,
  MARKER,
  systemEntryDirs,
  appCandidates,
  findApp,
  inspect,
  openAsar,
  injectTag,
  readSystemEntry,
  appBinary,
  markedEntryBody,
}
