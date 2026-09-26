#!/usr/bin/env node
// One command install for OpenCode Vitals.
//
//     npx opencode-vitals-install
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
  rmSync,
  symlinkSync,
} from "node:fs"
import { homedir, platform as hostPlatform } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)))
const EXECUTABLE_SUFFIXES = [".sh", ".py"]
const FALLBACK_FILES = [
  "index.js",
  "bar.py",
  "selftest.mjs",
  "selftest.py",
  "start-bar.sh",
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

// Candidates are ordered by how likely the path is to be the one OpenCode reads.
// Only the first is used, and it is printed, so a wrong guess is visible rather
// than silent.
export function resolvePluginsDir({ env = process.env, platform = hostPlatform, home = homedir() } = {}) {
  const candidates = []
  if (env.XDG_CONFIG_HOME) candidates.push(join(env.XDG_CONFIG_HOME, "opencode", "plugins"))
  if (platform === "win32" && env.APPDATA) candidates.push(join(env.APPDATA, "opencode", "plugins"))
  candidates.push(join(home, ".config", "opencode", "plugins"))
  if (platform === "darwin") candidates.push(join(home, "Library", "Application Support", "opencode", "plugins"))
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0]
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
    action: existing.kind === "absent" ? "installed" : "updated",
    files: copied,
    missing,
    version: manifest.version,
    replacedVersion: samePackage ? existing.version ?? null : null,
  }
}

export function uninstall({ pluginsDir, name = "opencode-vitals" } = {}) {
  const target = join(pluginsDir, name)
  const existing = describeExisting(target)
  if (existing.kind === "absent") return { target, action: "nothing-to-do" }
  if ((existing.kind === "other-package" || existing.kind === "foreign-directory") && !name) {
    throw new Error(`${target} does not look like OpenCode Vitals.`)
  }
  rmSync(target, { recursive: true, force: true })
  return { target, action: "removed", wasLink: existing.kind === "link" }
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

const USAGE = `opencode-vitals install

  npx opencode-vitals-install              copy the plugin into the OpenCode plugin directory
  npx opencode-vitals-install --link       symlink it instead, for working on the source
  npx opencode-vitals-install --status     report what is installed
  npx opencode-vitals-install --uninstall  remove it again

  --dir <path>   use this plugin directory instead of the detected one
  --force        replace what is there, even if it is a different package
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
    const report = uninstall({ pluginsDir })
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

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`opencode-vitals install: ${error?.message ?? error}\n`)
    process.exitCode = 1
  }
}
