#!/usr/bin/env node
// One command install for OpenCode Vitals.
//
//     npx opencode-vitals install
//
// npx resolves *package* names, not the names of the files inside them, so the
// command a newcomer is told to run has to be a bin called `opencode-vitals`.
// This file stays reachable as `opencode-vitals-install` for scripts that add
// the package to a project, but the documented spelling is the package name.
//
// OpenCode loads every plugin folder under its plugin directory, so the
// simplest install is to put the package there and leave the configuration file
// alone. This script copies the same files npm ships, or links them with
// --link when you are working on the source. It performs no network calls: the
// package it installs is the one npx already downloaded.
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  writeFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { compareVersions } from "./update.mjs"

// A closed pipe (someone piped us into head) is not a failure: swallow EPIPE
// instead of printing a stack trace and exiting non-zero.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error) => {
    if (error?.code !== "EPIPE") throw error
  })
}

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)))
// Uninstall has to clean up after the readout, which lives outside the plugin
// directory. Imported here rather than at the top so a checkout without the
// readout (an older copy mid-update) still installs.
// Versions before 0.1.8 left a bar.py running in its own process group, and
// nothing but that process could stop it. Two things identify it safely: the lock
// file it wrote, and the command line of the pid in it. The command line is
// checked as well because pids are recycled — a stale lock whose pid now belongs
// to something else must not cost that process a signal.
export function stopLegacyBar({ statusDir = join(tmpdir(), "opencode-latency-monitor") } = {}) {
  const lockFile = join(statusDir, "popup.lock")
  let holder
  try {
    holder = JSON.parse(readFileSync(lockFile, "utf8"))
  } catch {
    holder = null
  }
  const pid = Number(holder?.pid)
  if (!Number.isInteger(pid) || pid <= 0) return { stopped: false, reason: "no legacy bar" }

  // Only ever signal a process whose command line still names this package's bar.
  let commandLine = ""
  try {
    commandLine = readFileSync(`/proc/${pid}/cmdline`, "utf8")
  } catch {
    try {
      commandLine = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).stdout ?? ""
    } catch {
      commandLine = ""
    }
  }
  if (!commandLine.includes("bar.py") || !commandLine.includes("opencode-vitals")) {
    return { stopped: false, reason: `pid ${pid} is no longer this package's bar` }
  }
  try {
    process.kill(pid, "SIGTERM")
  } catch (error) {
    return { stopped: false, reason: String(error) }
  }
  // The lock goes with it: leaving it would make a later run think the screen
  // is still owned by a window that is on its way out.
  try {
    rmSync(lockFile, { force: true })
  } catch {
    // The bar removes its own lock on the way out; a failure here is harmless.
  }
  return { stopped: true, pid }
}

// The readout lives outside the plugin directory — a copy of the app's renderer
// and a launcher entry — so install and uninstall have to reach it. Imported
// lazily so a checkout without it (an older copy mid-update) still installs.
let installReadout = () => ({ ok: false, reason: "readout module not present" })
let removeReadout = () => ({ ok: false, reason: "readout module not present" })
try {
  const readout = await import("./readout.mjs")
  installReadout = () => {
    const synced = readout.syncRenderer()
    if (!synced.ok) return { ok: false, reason: synced.reason }
    return readout.installDesktopEntry()
  }
  if (typeof readout.removeReadout === "function") removeReadout = readout.removeReadout
} catch {
  // Keep the defaults: nothing to set up is a valid answer.
}
// The readout is drawn by OpenCode's own window, so nothing in the package needs
// to be executable any more: the entry points are Node, and npm already shims
// those on every platform.
const EXECUTABLE_SUFFIXES = []
const FALLBACK_FILES = [
  "index.js",
  "readout.mjs",
  "renderer/vitals.js",
  "cli.mjs",
  "selftest.mjs",
  "install.mjs",
  "README.md",
  "LICENSE",
  "docs/bar.png",
  "docs/bar-mini.png",
  "docs/desktop.png",
]

// -- finding OpenCode ---------------------------------------------------------
//
// This has to be careful in one specific way. On a desktop install, `opencode` on
// PATH is a symlink to the Electron application, and running it to see whether it
// works would launch a second copy of the app. So a candidate is never executed to
// be tested: it is read, and a link is followed by reading it, because the name
// on the far end is the only thing that says whether it is a CLI at all.
const CLI_NAMES = new Set(["opencode", "opencode-cli", "opencode.exe"])

function resolveLink(path, depth = 0) {
  // Bounded, because a link loop is a thing a file can be.
  if (depth > 8) return path
  let target
  try {
    target = readlinkSync(path)
  } catch {
    return path
  }
  return resolveLink(resolve(dirname(path), target), depth + 1)
}

export function findOpenCodeCli({ env = process.env, home = homedir() } = {}) {
  const seen = new Set()
  const consider = (raw) => {
    if (!raw || seen.has(raw)) return null
    seen.add(raw)
    let path = resolve(String(raw))
    if (path.endsWith(sep)) path = path.slice(0, -1)
    path = resolveLink(path)
    if (!CLI_NAMES.has(basename(path).toLowerCase())) return null
    return existsSync(path) ? path : null
  }

  // An explicit answer beats a search, which is the only reason to have one.
  const named = consider(env.OPENCODE_CLI)
  if (named) return named

  // The CLI the desktop app ships, newest version last. It is the one that is
  // guaranteed to be the same build as the plugin host that will load us.
  for (const root of [
    join(home, ".config", "ai.opencode.desktop", "cli"),
    join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "ai.opencode.desktop", "cli"),
  ]) {
    let versions
    try {
      versions = readdirSync(root)
    } catch {
      continue
    }
    // Newest first, and "newest" is not the same as "last in a string sort": these
    // directories are version numbers, so 2.0.9 sorts after 2.0.19 in text.
    // Registering a plugin with a CLI older than the one that will load it is how
    // a config file ends up in a shape its own host cannot read.
    versions.sort((left, right) => compareVersions(right, left))
    for (const version of versions) {
      const found = consider(join(root, version, "opencode-cli"))
      if (found) return found
    }
  }

  for (const dir of (env.PATH ?? "").split(":")) {
    if (!dir) continue
    const found = consider(join(dir, "opencode"))
    if (found) return found
  }
  return null
}

export function runCli(cli, args, { timeout = 120_000, spawn: run = spawnSync } = {}) {
  let result
  try {
    result = run(cli, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] })
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
  if (result.error) return { ok: false, reason: String(result.error) }
  if (result.status !== 0) {
    // The last line, because that is where a package manager puts the reason, and
    // a plugin's log line wants to be one line. The lines above it are progress
    // and warnings that would only make the message harder to read.
    const last = output.split("\n").map((line) => line.trim()).filter(Boolean).at(-1)
    return { ok: false, reason: last || `exited ${result.status}` }
  }
  return { ok: true, output }
}

// -- the supported install ----------------------------------------------------
//
// OpenCode resolves plugins named in its own config: it fetches the package,
// records the version, and checks unpinned ones for updates whenever its server
// starts. Registering is therefore the whole of the install — a line in
// opencode.json, which `plugin add` writes for us — and everything downstream of
// ownership comes free.
//
// The alternative, copying a directory into plugins/, is a file this plugin
// placed where OpenCode happens to look. It works, and it is what --copy is for,
// but it is invisible to `plugin list`, `plugin check` and `plugin update`, so
// nobody — including OpenCode — can ever update it. That is the difference this
// function exists to make.
export function register({ cli = findOpenCodeCli(), name = "opencode-vitals", run = runCli } = {}) {
  if (!cli) {
    return {
      ok: false,
      reason: "the OpenCode CLI was not found on this machine",
      command: `opencode plugin add ${name}`,
    }
  }
  const result = run(cli, ["plugin", "add", name])
  // `plugin add` prints this when the plugin is already registered, and exits 0.
  return result.ok ? { ok: true, cli, output: result.output } : { ok: false, cli, reason: result.reason }
}

export function unregister({ cli = findOpenCodeCli(), name = "opencode-vitals", run = runCli, env, home } = {}) {
  // Read the list before touching it. A user who never installed this should get
  // no rewrite of their config, and a user who already removed it by hand should
  // not have a command run for them.
  const listed = isRegistered({ name, ...(env ? { env } : {}), ...(home ? { home } : {}) })
  if (!listed.registered) return { ok: true, skipped: true, reason: "not in OpenCode's plugin list" }
  if (!cli) return { ok: false, reason: "the OpenCode CLI was not found on this machine" }
  const result = run(cli, ["plugin", "remove", name])
  return result.ok
    ? { ok: true, cli, output: result.output, file: listed.file }
    : { ok: false, cli, reason: result.reason, file: listed.file }
}

export function readManifest(packageRoot = PACKAGE_ROOT) {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"))
  return manifest
}

export function shippedFiles(manifest) {
  const listed = Array.isArray(manifest.files) && manifest.files.length ? manifest.files : FALLBACK_FILES
  // npm always ships the manifest even though it is not in "files", and the
  // installed copy needs it too: it is how a later run knows what it installed.
  return [...new Set(["package.json", ...listed])]
}

// OpenCode reads global plugins from `<config>/plugins`, where that config
// directory is `$XDG_CONFIG_HOME/opencode` when the variable is set and
// `~/.config/opencode` otherwise — on every platform, Windows included. This is
// not a guess: the shipped CLI computes it as
// `XDG_CONFIG_HOME || join(homedir(), ".config")`, then joins "opencode".
export function resolvePluginsDir({ env = process.env, home = homedir() } = {}) {
  const configRoot = env.XDG_CONFIG_HOME || join(home, ".config")
  return join(configRoot, "opencode", "plugins")
}

// Is this package already in OpenCode's plugin list?
//
// This is read rather than asked, on purpose. `plugin add` and `plugin remove`
// are the supported way to change that file, but they rewrite it — and OpenCode
// leaves an empty `"plugins": []` behind when it removes the last entry, which is
// not the same file it was given. Rewriting a user's config to remove something
// that was never in it is a cost with no benefit, so the list is inspected first
// and the command only runs when there is something for it to do.
export function isRegistered({ name = "opencode-vitals", env = process.env, home = homedir() } = {}) {
  const configRoot = env.XDG_CONFIG_HOME || join(home, ".config")
  for (const file of ["opencode.json", "opencode.jsonc"]) {
    let body
    try {
      body = readFileSync(join(configRoot, "opencode", file), "utf8")
    } catch {
      continue
    }
    // A jsonc file is not JSON, and a comment can hide a comma. This looks for
    // the name as a string among the entries rather than parsing, so a config
    // with comments in it is read correctly instead of being rejected.
    const list = body.match(/"plugins"\s*:\s*\[([^\]]*)\]/)?.[1] ?? ""
    const entries = [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1])
    // The documented control syntax: a leading `-` disables a plugin, and a later
    // entry re-enables one. A disable is not a registration to remove.
    const enabled = entries.filter((entry) => !entry.startsWith("-"))
    if (enabled.includes(name) || entries.includes(`-${name}`)) return { registered: true, file, entries }
    return { registered: false, file, entries }
  }
  return { registered: false, file: null, entries: [] }
}

function targetName(manifest) {
  return manifest.name
}

function readInstalledManifest(target) {
  try {
    return JSON.parse(readFileSync(join(target, "package.json"), "utf8"))
  } catch {
    return null
  }
}

function describeExisting(target) {
  if (!existsSync(target)) return { kind: "absent" }
  const stats = lstatSync(target)
  if (stats.isSymbolicLink()) {
    let points = "an unknown location"
    try {
      points = readlinkSync(target)
    } catch {
      points = "an unknown location"
    }
    return { kind: "link", points }
  }
  if (stats.isDirectory()) {
    const manifest = readInstalledManifest(target)
    if (!manifest) return { kind: "foreign-directory" }
    if (manifest.name) return { kind: "other-package", name: manifest.name, version: manifest.version }
    return { kind: "other-package", name: "(unnamed)", version: manifest.version }
  }
  return { kind: "file" }
}

function copyFile(source, destination) {
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(source, destination)
  const mode = EXECUTABLE_SUFFIXES.some((suffix) => destination.endsWith(suffix)) ? 0o755 : 0o644
  chmodSync(destination, mode)
}

export function install({
  packageRoot = PACKAGE_ROOT,
  pluginsDir,
  mode = "copy",
  force = false,
  name,
} = {}) {
  const manifest = readManifest(packageRoot)
  const directory = name ?? targetName(manifest)
  const target = join(pluginsDir, directory)
  const files = shippedFiles(manifest)

  // Nothing is ever written outside the plugin directory, whatever the name.
  const inside = resolve(pluginsDir)
  if (resolve(target) !== inside && !resolve(target).startsWith(inside + sep)) {
    throw new Error(`refusing to install outside the plugin directory: ${target}`)
  }

  const existing = describeExisting(target)
  const samePackage = existing.kind === "other-package" && existing.name === manifest.name
  if (existing.kind === "other-package" && !samePackage && !force) {
    throw new Error(
      `${target} already holds a different package (${existing.name}@${existing.version}). ` +
        "Pass --force only if you are sure.",
    )
  }
  if (existing.kind === "foreign-directory" && !force) {
    throw new Error(`${target} exists and holds no package manifest. Pass --force to replace it.`)
  }
  if (existing.kind === "file" && !force) {
    throw new Error(`${target} exists and is a file. Pass --force to replace it.`)
  }
  // --force said replace it, so replace it rather than failing on the readdir.
  if (existing.kind === "file") rmSync(target, { force: true })

  if (mode === "link") {
    if (existing.kind === "link" && existing.points === packageRoot) {
      return { target, mode, action: "already-linked", files: files.length, version: manifest.version }
    }
    if (existsSync(target) || lstatSync(target, { throwIfNoEntry: false })) {
      if (!force) throw new Error(`${target} already exists. Pass --force to replace it with a link.`)
      rmSync(target, { recursive: true, force: true })
    }
    symlinkSync(packageRoot, target, "dir")
    return { target, mode, action: "linked", files: files.length, version: manifest.version }
  }

  if (existing.kind === "link" && !force) {
    throw new Error(`${target} is a link to ${existing.points}. Pass --force to replace it with a copy.`)
  }
  if (existing.kind === "link") rmSync(target, { recursive: true, force: true })

  // A copy is an in place update, so stale files from an older release cannot
  // survive: everything not in the shipped list goes.
  if (existsSync(target)) {
    const wanted = new Set(files)
    for (const entry of readdirSync(target)) {
      if (wanted.has(entry)) continue
      rmSync(join(target, entry), { recursive: true, force: true })
    }
  }
  mkdirSync(target, { recursive: true })

  let copied = 0
  const missing = []
  for (const file of files) {
    const source = join(packageRoot, file)
    if (!existsSync(source)) {
      missing.push(file)
      continue
    }
    copyFile(source, join(target, file))
    copied += 1
  }
  return {
    target,
    mode,
    action: existing.kind === "absent" || existing.kind === "file" ? "installed" : "updated",
    files: copied,
    missing,
    version: manifest.version,
    replacedVersion: samePackage ? existing.version ?? null : null,
    // Installing the plugin folder is only half of it: the readout lives in
    // OpenCode's own window, which needs a copy of the app's renderer and a
    // launcher that starts the app pointed at it. Reported, never assumed — a
    // machine with no desktop app gets the measurement and a clear reason.
    readout: installReadout(),
  }
}

// The kill switch, as a file so that turning it off once turns it off for good.
// The environment variable does the same job for a single process, and the
// installer needs a way to clear the file it may have written last time.
export function setUpdateDisabledMarker(disabled, { dataHome = process.env.XDG_DATA_HOME, home = homedir() } = {}) {
  const marker = join(dataHome ?? join(home, ".local", "share"), "opencode-vitals", "no-update")
  try {
    if (disabled) {
      mkdirSync(dirname(marker), { recursive: true })
      writeFileSync(marker, new Date().toISOString())
    } else {
      rmSync(marker, { force: true })
    }
    return { ok: true, path: marker, disabled: Boolean(disabled) }
  } catch (error) {
    return { ok: false, path: marker, reason: String(error) }
  }
}

export function uninstall({
  pluginsDir,
  packageRoot = PACKAGE_ROOT,
  name,
  force = false,
  // A copy is one shape and a registered package is another; uninstalling has to
  // deal with whichever is there, and usually both — a machine that was installed
  // before the switch and reinstalled after it has one of each until the copy is
  // taken away, because until then the plugin loads twice.
  unregister: unregisterPlugin = unregister,
  skipUnregister = false,
} = {}) {
  const manifest = readManifest(packageRoot)
  const directory = name ?? manifest.name
  const target = join(pluginsDir, directory)
  const existing = describeExisting(target)
  const registration = skipUnregister ? { ok: true, skipped: true } : unregisterPlugin({ name: manifest.name })
  if (existing.kind === "absent") {
    // Nothing in the plugin directory is not nothing installed: a registered
    // package lives in node_modules and never appears here.
    if (registration.ok) return { target, action: "nothing-to-do", registration }
    return { target, action: "nothing-to-do", registration }
  }
  // Removing the folder that carries our name is not proof it is ours: compare
  // the manifest, and refuse a stranger unless --force says otherwise.
  const installed = readInstalledManifest(target)
  const ours = existing.kind === "link" || (installed !== null && installed.name === manifest.name)
  if (!ours && !force) {
    throw new Error(`${target} does not look like ${manifest.name}; pass --force to remove it anyway.`)
  }
  rmSync(target, { recursive: true, force: true })
  // A version before 0.1.8 drew its numbers in a window it spawned, and that
  // window is a separate process: deleting its files does not stop it, so an
  // upgrade left the old bar on screen next to the readout. It is stopped here,
  // while we still know where it was and what it belonged to.
  const legacy = stopLegacyBar()
  // The readout leaves a copy of the app's renderer and a launcher entry behind
  // the plugin folder. Both are ours, both are outside the plugin directory, and
  // both must go with it: leaving them means an uninstalled plugin still changes
  // how the app starts.
  const readout = removeReadout()
  // The status directory holds this plugin's own measurements: per-session totals,
  // the version file and response markers. They live in a temporary directory,
  // but "uninstall" that leaves them is only half an uninstall — and the next
  // install would seed itself from the last one's numbers.
  const status = removeStatus()
  // And the opt-out, if it was asked for: a marker left behind after the thing it
  // was disabling is gone is a setting for a plugin that is not installed.
  const marker = setUpdateDisabledMarker(false)
  return { target, action: "removed", wasLink: existing.kind === "link", legacy, readout, status, registration, marker }
}

// Only ever removes this package's files inside the status directory, and only
// the files this package writes. The directory is shared and 0700, but a stray
// lock or file from a future version must survive rather than be guessed at.
export function removeStatus({ statusDir = join(tmpdir(), "opencode-latency-monitor") } = {}) {
  const ours = [
    "session-totals.json",
    "current-session.json",
    "latest.json",
    "plugin-version.json",
    "popup.lock",
  ]
  const removed = []
  try {
    for (const name of readdirSync(statusDir)) {
      // Response markers are ours by pattern: a response id and a .marker suffix.
      if (!ours.includes(name) && !name.endsWith(".marker")) continue
      rmSync(join(statusDir, name), { force: true })
      removed.push(name)
    }
  } catch (error) {
    if (error?.code !== "ENOENT") return { removed, ok: false, reason: String(error) }
    return { removed, ok: true }
  }
  return { removed, ok: true }
}

export function status({ pluginsDir, name = "opencode-vitals", env, home } = {}) {
  const target = join(pluginsDir, name)
  const existing = describeExisting(target)
  // Both shapes, because a machine can have either or both, and "installed: no"
  // would be a lie on one that has the registered package and no copy — which is
  // the shape every machine is in after the first install.
  const listed = isRegistered({ name, ...(env ? { env } : {}), ...(home ? { home } : {}) })
  const copy = existing.kind === "absent" ? null : {
    target,
    kind: existing.kind,
    points: existing.points ?? null,
    version: readInstalledManifest(target)?.version ?? null,
  }
  if (!listed.registered && !copy) return { target, installed: false, kind: existing.kind, registered: false, copy: null }
  return {
    target,
    installed: true,
    kind: listed.registered ? "package" : existing.kind,
    registered: listed.registered,
    // A copy is worth saying out loud, because it is the shape that can never
    // update itself, and a person reading this is trying to find out why.
    copy,
    version: copy?.version ?? null,
    updates: listed.registered ? "automatic" : "manual: a copy is not a package OpenCode can update",
  }
}

const USAGE = `opencode-vitals

  npx opencode-vitals               install: register this package with OpenCode
  npx opencode-vitals install       the same, said out loud
  npx opencode-vitals status        report what is installed and which version
  npx opencode-vitals uninstall     remove it again

  --copy          copy the files into the plugin directory instead of registering
                  the package. Works without the OpenCode CLI, but OpenCode then
                  cannot list, check or update the install, so it never updates.
  --link          symlink into the plugin directory, for working on the source
  --no-update     never check for, or install, a newer version automatically
  --dir <path>    use this plugin directory instead of the detected one
  --force         replace what is there, even if it is a different package
                  (with uninstall: remove it even when it does not look like ours)
`

function parseArgs(argv) {
  const options = { mode: "package", force: false, dir: null, action: "install", update: true }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--link") options.mode = "link"
    else if (argument === "--copy") options.mode = "copy"
    else if (argument === "--force") options.force = true
    else if (argument === "--no-update") options.update = false
    else if (argument === "--uninstall") options.action = "uninstall"
    else if (argument === "--status") options.action = "status"
    else if (argument === "--help" || argument === "-h") options.action = "help"
    else if (argument === "--dir") {
      options.dir = argv[index + 1] ?? null
      index += 1
    } else if (argument.startsWith("--dir=")) options.dir = argument.slice("--dir=".length)
    else throw new Error(`unknown argument: ${argument}`)
  }
  return options
}

function main(argv) {
  const options = parseArgs(argv)
  if (options.action === "help") {
    process.stdout.write(USAGE)
    return 0
  }

  const manifest = readManifest()
  const pluginsDir = options.dir ? resolve(options.dir) : resolvePluginsDir()
  mkdirSync(pluginsDir, { recursive: true })

  if (options.action === "status") {
    const report = status({ pluginsDir })
    if (!report.installed) {
      process.stdout.write(`not installed\n`)
      return 0
    }
    if (report.registered) {
      process.stdout.write(
        `registered with OpenCode in ${join(options.dir ? resolve(options.dir) : resolvePluginsDir(), "..", "opencode.json")}\n` +
          `  updates ${report.updates}\n`,
      )
    }
    if (report.copy) {
      process.stdout.write(`also a ${report.copy.kind} at ${report.copy.target}${report.copy.version ? ` (version ${report.copy.version})` : ""}\n`)
    }
    if (!report.registered) {
      process.stdout.write(`installed as a copy at ${report.target}\n  updates ${report.updates}\n`)
    }
    return 0
  }

  if (options.action === "uninstall") {
    const report = uninstall({ pluginsDir, force: options.force })
    process.stdout.write(
      report.action === "nothing-to-do" ? `nothing to remove in ${pluginsDir}\n` : `removed ${report.target}\n`,
    )
    return 0
  }

  if (options.mode === "package") {
    const registered = register()
    if (!registered.ok) {
      // Falling back rather than failing: a copy is worse — OpenCode cannot
      // update it — but it is what this package did until now, and a user who
      // cannot find the CLI should still end up with a working plugin.
      process.stdout.write(
        `could not register the package: ${registered.reason}\n` +
          `  tried: ${registered.command}\n` +
          `  installing a copy instead; OpenCode will not be able to update it.\n\n`,
      )
    } else {
      // Both shapes at once means the plugin loads twice and measures every
      // event twice. This is the one cleanup that has to happen on the way in.
      const stale = describeExisting(join(pluginsDir, targetName(readManifest())))
      if (stale.installed && !options.force) {
        process.stdout.write(`removing the copy at ${stale.target}, which the registered package replaces\n`)
        uninstall({ pluginsDir, force: true })
      }
      process.stdout.write(
        `registered ${readManifest().name} with OpenCode${registered.cli ? ` (${registered.cli})` : ""}\n` +
          "OpenCode downloads it in the background and checks it for updates on every start.\n" +
          "This plugin applies an update it finds and tells you to restart.\n",
      )
      if (options.update) setUpdateDisabledMarker(false)
      process.stdout.write("\nRestart OpenCode. The numbers appear in the composer.\n")
      return 0
    }
  }

  const report = install({ pluginsDir, mode: options.mode === "package" ? "copy" : options.mode, force: options.force })
  const verb = { installed: "installed", updated: "updated", linked: "linked", "already-linked": "already linked" }[report.action]
  process.stdout.write(`${verb} ${report.target}\n  version ${report.version}\n  files ${report.files}\n  plugin directory ${pluginsDir}\n`)
  if (report.missing?.length) {
    process.stdout.write(`  not in this package, skipped: ${report.missing.join(", ")}\n`)
  }
  if (options.update) setUpdateDisabledMarker(false)
  process.stdout.write("\nRestart OpenCode. The numbers appear in the composer.\n")
  return 0
}

// npm runs bins through a symlink it creates in node_modules/.bin, and Node
// resolves the module URL through that link while process.argv[1] keeps the
// link's path. Comparing the two as strings would therefore be false, and the
// command would exit silently without doing anything; resolving both is what
// makes npx and npm's shims work.
function isDirectRun() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isDirectRun()) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`opencode-vitals install: ${error?.message ?? error}\n`)
    process.exitCode = 1
  }
}
