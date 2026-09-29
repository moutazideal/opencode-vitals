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
import { readoutInternals } from "./readout.mjs"

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
  console.log("  No OpenCode desktop app found, so there is nothing to draw in.")
  console.log("  The numbers are still measured; nothing will show them here.")
  console.log(`  Looked for the app bundle in: ${readoutInternals.appCandidates().join(", ")}`)
  process.exit(0)
}
say(true, "the desktop app is installed", app)

const entry = readoutInternals.readSystemEntry(app)
say(Boolean(entry), "the app has a launcher entry", entry ? `${entry.name} → ${entry.exec}` : "none found; the readout can be served but the icon will not start it")
const binary = entry ? readoutInternals.appBinary(entry, app) : null
say(Boolean(binary && existsSync(binary)), "the launcher binary is where the entry says", binary ?? "unknown")

// Read-only on purpose. The question is whether this machine *can* show the
// readout, and the answer comes from reading the app's bundle — making the copy
// to find out would leave forty-odd megabytes behind on a machine that was only
// being asked a question.
const report = readoutInternals.inspect()
say(report.ok, report.ok ? "the app's renderer can be found" : "the app's renderer can be found", report.ok ? report.fingerprint : report.reason)
if (report.ok) {
  say(report.injectable, "the readout can be injected beside the app's bundle", report.injectable ? "the page loads a module bundle" : report.reason)
  // A note, not a check. Whether a copy exists yet is a fact about the install,
  // not about the machine — and this command is meant to be run *before*
  // installing, where "no copy" is the correct answer and failing on it would
  // mean the check could never pass on a machine that has not installed yet.
  if (!report.copy.present) {
    note("no copy of the renderer yet; the first start after installing makes one", readoutInternals.RENDERER_DIR)
  } else if (report.copy.current) {
    note("a copy of the renderer is in place, and it matches this build")
  } else {
    note("a copy of the renderer is in place but from an older build; the next start replaces it")
  }
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
