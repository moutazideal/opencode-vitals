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
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

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
]

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

export function uninstall({ pluginsDir, packageRoot = PACKAGE_ROOT, name, force = false } = {}) {
  const manifest = readManifest(packageRoot)
  const directory = name ?? manifest.name
  const target = join(pluginsDir, directory)
  const existing = describeExisting(target)
  if (existing.kind === "absent") return { target, action: "nothing-to-do" }
  // Removing the folder that carries our name is not proof it is ours: compare
  // the manifest, and refuse a stranger unless --force says otherwise.
  const installed = readInstalledManifest(target)
  const ours = existing.kind === "link" || (installed !== null && installed.name === manifest.name)
  if (!ours && !force) {
    throw new Error(`${target} does not look like ${manifest.name}; pass --force to remove it anyway.`)
  }
  rmSync(target, { recursive: true, force: true })
  // The readout leaves a copy of the app's renderer and a launcher entry behind
  // the plugin folder. Both are ours, both are outside the plugin directory, and
  // both must go with it: leaving them means an uninstalled plugin still changes
  // how the app starts.
  const readout = removeReadout()
  return { target, action: "removed", wasLink: existing.kind === "link", readout }
}

export function status({ pluginsDir, name = "opencode-vitals" } = {}) {
  const target = join(pluginsDir, name)
  const existing = describeExisting(target)
  if (existing.kind === "absent") return { target, installed: false, kind: existing.kind }
  const manifest = readInstalledManifest(target)
  return {
    target,
    installed: true,
    kind: existing.kind,
    points: existing.points ?? null,
    version: manifest?.version ?? null,
    name: manifest?.name ?? null,
  }
}

const USAGE = `opencode-vitals

  npx opencode-vitals               install into the plugin directory OpenCode reads
  npx opencode-vitals install       the same, said out loud
  npx opencode-vitals status        report what is installed and which version
  npx opencode-vitals uninstall     remove it again

  --link          symlink instead of copying, for working on the source
  --dir <path>    use this plugin directory instead of the detected one
  --force         replace what is there, even if it is a different package
                  (with uninstall: remove it even when it does not look like ours)
`

function parseArgs(argv) {
  const options = { mode: "copy", force: false, dir: null, action: "install" }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--link") options.mode = "link"
    else if (argument === "--force") options.force = true
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
      process.stdout.write(`not installed in ${pluginsDir}\n`)
      return 0
    }
    // "other-package" is an internal kind name; a person reading about their own
    // install should be told it is a copy.
    const label = report.kind === "link" ? "link" : "copy"
    process.stdout.write(
      `installed in ${report.target}\n  version ${report.version}\n  ${label}${report.points ? ` -> ${report.points}` : ""}\n`,
    )
    return 0
  }

  if (options.action === "uninstall") {
    const report = uninstall({ pluginsDir, force: options.force })
    process.stdout.write(
      report.action === "nothing-to-do" ? `nothing to remove in ${pluginsDir}\n` : `removed ${report.target}\n`,
    )
    return 0
  }

  const report = install({ pluginsDir, mode: options.mode, force: options.force })
  const verb = { installed: "installed", updated: "updated", linked: "linked", "already-linked": "already linked" }[report.action]
  process.stdout.write(`${verb} ${report.target}\n  version ${report.version}\n  files ${report.files}\n  plugin directory ${pluginsDir}\n`)
  if (report.missing?.length) {
    process.stdout.write(`  not in this package, skipped: ${report.missing.join(", ")}\n`)
  }
  process.stdout.write("\nRestart OpenCode. The bar appears within a few seconds.\n")
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
