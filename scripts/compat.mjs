// Checking this plugin against a new OpenCode, without running OpenCode.
//
// This plugin is plain JavaScript and imports nothing from OpenCode at runtime.
// Its whole contract with the host is the names it matches on: the session
// events it subscribes to, the prompt hook it registers, the context methods it
// calls. A type checker cannot see any of that, because there are no types to
// check — the plugin never mentions the host's types.
//
// What can be checked is the one contract OpenCode publishes as data. Every
// event definition lives in `@opencode/schema`, and `EventManifest.Latest` is
// the map of every event type the current server knows. So this does the only
// honest automatic check available: every event this plugin claims to handle
// must still exist in the schema of the version being tested. A renamed or
// removed handled event is a breaking change and exits non-zero. Everything
// else — events this plugin ignores, session events it has never classified — is
// reported and does not fail the run, because an addition is not a break and a
// check that failed on additions would cry wolf on every release.
//
// Run it against the pinned version with `npm run compat`, or against a
// candidate with `npm run compat` after installing that version. The scheduled
// workflow does the latter and opens an issue when it finds a break.
import { readFileSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"

// The comparison, kept apart from the imports that need a package manager, so a
// test can pin it with plain arrays and no network.
export function compareEventContract({ known, handled, ignored = [], prefixes = [] }) {
  const knownTypes = new Set(known)
  const handledTypes = new Set(handled)
  const ignoredTypes = new Set(ignored)
  const isIgnored = (type) => ignoredTypes.has(type) || prefixes.some((prefix) => type.startsWith(prefix))
  return {
    // A handled event that is gone is the failure this whole script exists for:
    // the measurement would stop without an error anywhere.
    missingHandled: handled.filter((type) => !knownTypes.has(type)),
    // An ignored event that is gone is a rename of something this plugin already
    // decided not to measure. Worth saying, not worth failing.
    missingIgnored: ignored.filter((type) => !knownTypes.has(type)),
    // Session events the plugin neither handles nor deliberately ignores. These
    // are the candidates for a new measurement — or the other half of a rename
    // that `missingHandled` already caught.
    unclassified: [...knownTypes]
      .filter((type) => type.startsWith("session.") && !handledTypes.has(type) && !isIgnored(type))
      .sort(),
  }
}

// Best-effort: the version of the schema actually installed, for the report. A
// package that cannot be read is a version we say we do not know rather than a
// reason to fail a check that already ran.
function readSchemaVersion() {
  try {
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../node_modules/@opencode/schema/package.json", import.meta.url)), "utf8"))
    return typeof manifest?.version === "string" && manifest.version ? manifest.version : "unknown"
  } catch {
    return "unknown"
  }
}

async function main() {
  let manifest
  try {
    manifest = await import("@opencode/schema/event-manifest")
  } catch (error) {
    console.error(`cannot read the event contract: @opencode/schema/event-manifest did not load (${String(error)})`)
    console.error("install it first: npm install")
    process.exit(2)
  }
  const { vitalsInternals } = await import("../index.js")
  const { HANDLED_TYPES, IGNORED_TYPES, IGNORED_PREFIXES } = vitalsInternals
  const known = [...manifest.Latest.keys()]
  const result = compareEventContract({
    known,
    handled: [...HANDLED_TYPES],
    ignored: [...IGNORED_TYPES],
    prefixes: IGNORED_PREFIXES,
  })

  console.log(`OpenCode event contract: @opencode/schema ${readSchemaVersion()}`)
  console.log(`  ${known.length} event types known; this plugin handles ${HANDLED_TYPES.size}, ignores ${IGNORED_TYPES.size} by name and ${IGNORED_PREFIXES.length} by prefix`)
  console.log("")

  if (result.missingHandled.length > 0) {
    console.log(`BREAKING: ${result.missingHandled.length} handled event(s) no longer exist:`)
    for (const type of result.missingHandled) console.log(`  - ${type}`)
    console.log("")
  }
  if (result.missingIgnored.length > 0) {
    console.log(`Notice: ${result.missingIgnored.length} ignored event(s) no longer exist:`)
    for (const type of result.missingIgnored) console.log(`  - ${type}`)
    console.log("")
  }
  if (result.unclassified.length > 0) {
    console.log(`Notice: ${result.unclassified.length} session event(s) are neither handled nor ignored:`)
    for (const type of result.unclassified) console.log(`  - ${type}`)
    console.log("")
  }
  console.log(result.missingHandled.length === 0
    ? "Compatible: every event this plugin handles still exists."
    : "Incompatible: a handled event is gone; the plugin needs an update before this OpenCode release.")
  process.exit(result.missingHandled.length > 0 ? 1 : 0)
}

// Only when run as the entry point: the test imports compareEventContract from
// this file and must not start a network-bound check as a side effect.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
