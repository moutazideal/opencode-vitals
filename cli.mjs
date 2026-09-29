#!/usr/bin/env node
// One entry point that carries the package name.
//
// npx resolves *package* names, not the names of the files inside them: with
// this package on the registry, `npx opencode-vitals-install` asks for a
// package called opencode-vitals-install and gets a 404. A bin named exactly
// `opencode-vitals` is what makes `npx opencode-vitals install` work.
//
//   npx opencode-vitals               install (the same as `install`)
//   npx opencode-vitals install       register the package with OpenCode
//   npx opencode-vitals selftest      check this machine before installing
//   npx opencode-vitals status        report what is installed
//   npx opencode-vitals uninstall     remove it again
import { spawnSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// A closed pipe (someone piped us into head) is not a failure: swallow EPIPE
// instead of printing a stack trace and exiting non-zero.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error) => {
    if (error?.code !== "EPIPE") throw error
  })
}

const ROOT = dirname(fileURLToPath(import.meta.url))
const USAGE = `opencode-vitals

  npx opencode-vitals               install: register this package with OpenCode
  npx opencode-vitals install       the same, said out loud
  npx opencode-vitals selftest      check this machine before installing
  npx opencode-vitals status        report what is installed and which version
  npx opencode-vitals uninstall     remove it again

Flags:
  --copy          copy the files into the plugin directory instead of registering
                  the package. Works without the OpenCode CLI, but OpenCode then
                  cannot list, check or update the install, so it never updates.
  --link          symlink into the plugin directory, for working on the source
  --no-update     never check for, or install, a newer version automatically
  --dir <path>    use this plugin directory instead of the detected one
  --force         replace what is there, even if it is a different package
                  (with uninstall: remove it even when it does not look like ours)
`

// The subcommands this entry point answers to, mapped to what they run. Exported
// so the README test can prove that every command the documentation prints is
// one this file really accepts.
export const COMMANDS = {
  install: { script: "install.mjs", args: [] },
  selftest: { script: "selftest.mjs", args: [] },
  status: { script: "install.mjs", args: ["--status"] },
  uninstall: { script: "install.mjs", args: ["--uninstall"] },
}

const ALIASES = { "--status": "status", "--uninstall": "uninstall" }

function run(script, args) {
  const result = spawnSync(process.execPath, [join(ROOT, script), ...args], { stdio: "inherit" })
  if (result.error) {
    process.stderr.write(`opencode-vitals: ${result.error.message}\n`)
    return 1
  }
  return result.status ?? 1
}

export function main(argv) {
  const command = argv[0]
  const rest = argv.slice(1)
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE)
    return 0
  }
  const name = command === undefined ? "install" : ALIASES[command] ?? command
  const entry = COMMANDS[name]
  if (!entry) {
    process.stderr.write(`opencode-vitals: unknown command: ${command}\n\n${USAGE}`)
    return 1
  }
  return run(entry.script, [...entry.args, ...rest])
}

// npm runs bins through a symlink it creates in node_modules/.bin, and Node
// resolves the module URL through that link while process.argv[1] keeps the
// link's path. Comparing the two as strings would therefore be false and the
// whole script would exit silently; resolving both is what makes it run.
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
  process.exitCode = main(process.argv.slice(2))
}
