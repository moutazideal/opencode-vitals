#!/usr/bin/env node
// Can this machine show the readout?
//
// It used to answer a different question — is there a Python with tkinter, so
// the bar can draw — which meant a launcher, a probe interpreter and a Python
// file in the package. The readout is drawn by OpenCode's own window now, so the
// question is whether the app is here, whether its renderer can be copied, and
// whether this plugin is the one serving the numbers.
//
// Answering it without starting anything: every check below reads a file or asks
// this process what it already knows.
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { readoutInternals, rendererReady, syncRenderer } from "./readout.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const lines = []
const say = (ok, label, detail) => {
  lines.push({ ok, label, detail })
  console.log(`${ok ? "ok  " : "    "} ${label}${detail ? `  ${detail}` : ""}`)
}
const note = (label, detail) => {
  lines.push({ ok: null, label, detail })
  console.log(`    ${label}${detail ? `  ${detail}` : ""}`)
}

// When this runs from an installed copy the manifest is one level up; from the
// checkout it is beside this file. Both are real layouts, so both are tried.
const version = (() => {
  for (const candidate of [join(HERE, "package.json"), join(HERE, "..", "package.json")]) {
    try {
      return JSON.parse(readFileSync(candidate, "utf8")).version
    } catch {
      // Try the next layout.
    }
  }
  return "unknown"
})()
console.log(`opencode-vitals ${version}\n`)

const app = readoutInternals.findApp()
if (!app) {
  console.log("  No OpenCode desktop app found, so there is no window to draw in.")
  console.log("  The numbers are still measured and still written; nothing will show them here.")
  console.log(`  Looked in: ${readoutInternals.SYSTEM_ENTRY_DIRS.join(", ")}`)
  process.exit(0)
}
say(true, "the desktop app is installed", app)

const entry = readoutInternals.readSystemEntry(app)
say(Boolean(entry), "the app has a launcher entry", entry ? `${entry.name} → ${entry.exec}` : "none found; the readout can be served but the icon will not start it")
const binary = entry ? readoutInternals.appBinary(entry, app) : null
say(Boolean(binary && existsSync(binary)), "the launcher binary is where the entry says", binary ?? "unknown")

const synced = syncRenderer()
say(synced.ok, "the app's renderer can be copied", synced.ok ? `${synced.fingerprint}${synced.changed ? " (refreshed)" : " (already current)"}` : synced.reason)
say(rendererReady(), "the readout renderer is in place", readoutInternals.RENDERER_DIR)

if (synced.ok) {
  const html = readFileSync(join(readoutInternals.RENDERER_DIR, "index.html"), "utf8")
  say(html.includes("vitals.js"), "the readout is wired into the copied page")
  say(existsSync(join(readoutInternals.RENDERER_DIR, "assets")), "the page's assets came with it")
}

note("the readout is served by the plugin, not by this command")
note("this check does not start OpenCode and does not open a window")
note("open the app and the numbers appear in the composer's action row")

console.log("")
const failed = lines.filter((line) => line.ok === false)
if (failed.length > 0) {
  console.log(`${failed.length} of ${lines.filter((line) => line.ok !== null).length} checks failed`)
  process.exit(1)
}
console.log("this machine can show the readout")
