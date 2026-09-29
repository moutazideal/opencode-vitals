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

const WORK_DIR = process.env.OPENCODE_VITALS_DIR ?? join(process.env.XDG_DATA_HOME ?? join(process.env.HOME, ".local", "share"), "opencode-vitals")
const RENDERER_DIR = join(WORK_DIR, "renderer")
const DESKTOP_DIR = join(process.env.XDG_DATA_HOME ?? join(process.env.HOME, ".local", "share"), "applications")
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

// A fingerprint of the app's own renderer, so a copy is refreshed when OpenCode
// updates and left alone when it does not. Without this the readout would keep
// serving last week's UI, which is how a patch quietly becomes a lie.
function fingerprint(asar) {
  const hash = createHash("sha256")
  for (const name of asar.list(["out", "renderer"]).sort()) {
    const entry = asar.read(["out", "renderer", name])
    if (entry) hash.update(name).update(entry)
  }
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

function injectTag(html) {
  const source = html.toString("utf8")
  if (source.includes("vitals.js")) return source
  // Beside the app's bundle. If the app ever stops shipping that exact line, say
  // so rather than injecting a tag nothing would load.
  const anchor = /<script[^>]*src="\.\/assets\/main-[^"]+\.js"[^>]*><\/script>/
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
  const stamp = { app, fingerprint: fingerprint({ ...asar, path }) }
  const previous = readMarker()
  if (!force && previous && previous.app === stamp.app && previous.fingerprint === stamp.fingerprint) {
    return { ok: true, changed: false, ...stamp }
  }

  try {
    rmSync(RENDERER_DIR, { recursive: true, force: true })
    if (!copyTree(asar, ["out", "renderer"], RENDERER_DIR)) {
      return { ok: false, reason: "the app's index.html no longer loads a module bundle this can sit beside" }
    }
    copyFileSync(READOUT_SCRIPT, join(RENDERER_DIR, "vitals.js"))
    writeFileSync(join(RENDERER_DIR, MARKER), JSON.stringify(stamp))
    return { ok: true, changed: true, ...stamp }
  } catch (error) {
    return { ok: false, reason: `could not write ${RENDERER_DIR}: ${String(error)}` }
  }
}

export function rendererReady() {
  try {
    return existsSync(join(RENDERER_DIR, "index.html")) && existsSync(join(RENDERER_DIR, "vitals.js"))
  } catch {
    return false
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
const SYSTEM_ENTRY_DIRS = [
  ...(process.env.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share").split(":").map((dir) => join(dir, "applications")),
  "/var/lib/flatpak/exports/share/applications",
]

function readSystemEntry(app) {
  for (const dir of SYSTEM_ENTRY_DIRS) {
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

export function removeDesktopEntry() {
  const app = findApp()
  if (!app) return { ok: false, reason: "no app" }
  const systemEntry = readSystemEntry(app)
  if (!systemEntry) return { ok: false, reason: "no system launcher to mirror" }
  const path = join(DESKTOP_DIR, systemEntry.name)
  try {
    // Only ever removes the entry we wrote, and only while it still carries our
    // marker: a file the user has since edited is theirs, not ours to delete.
    const body = readFileSync(path, "utf8")
    if (!body.includes("X-OpenCode-Vitals")) return { ok: false, reason: "left alone: not our entry" }
    rmSync(path, { force: true })
    return { ok: true, path }
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: true, path }
    return { ok: false, reason: String(error) }
  }
}

// Uninstall has to take both halves with it. Leaving either behind means a
// removed plugin still changes how the app starts, which is the one thing an
// uninstall must not do.
export function removeReadout() {
  const entry = removeDesktopEntry()
  const renderer = { ok: true, path: RENDERER_DIR }
  try {
    // The whole work directory, not just the renderer inside it: leaving an
    // empty shell behind means "uninstalled" still has a directory named after
    // this plugin sitting in the user's data path.
    rmSync(WORK_DIR, { recursive: true, force: true })
  } catch (error) {
    if (error?.code !== "ENOENT") renderer.ok = false, (renderer.reason = String(error))
  }
  return { entry, renderer }
}

// -- the server --------------------------------------------------------------

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
    const direct = join(RENDERER_DIR, pathname)
    const found = fileExists(direct) ? direct : [join(RENDERER_DIR, name), join(RENDERER_DIR, "assets", name)].find(fileExists)
    if (found) {
      response.writeHead(200, { "Content-Type": TYPES[found.slice(found.lastIndexOf("."))] ?? "application/octet-stream", "Cache-Control": "no-store" })
      createReadStream(found).pipe(response)
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
  SYSTEM_ENTRY_DIRS,
  appCandidates,
  findApp,
  openAsar,
  injectTag,
  readSystemEntry,
  appBinary,
  markedEntryBody,
}
