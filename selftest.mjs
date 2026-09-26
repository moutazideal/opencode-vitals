#!/usr/bin/env node
// Launcher for selftest.py.
//
// The bar needs Python with tkinter, but an OpenCode plugin already requires
// Node, so the entry point is a Node script: npm generates working shims for it
// on every platform, while a Python shebang would not survive Windows. The
// launcher finds an interpreter that can actually import tkinter instead of
// trusting the first "python" on PATH.
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

// A closed pipe (someone piped us into head) is not a failure: swallow EPIPE
// instead of printing a stack trace and exiting non-zero.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error) => {
    if (error?.code !== "EPIPE") throw error
  })
}

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "selftest.py")
const PROBE = "import tkinter"

function candidates() {
  const configured = process.env.OPENCODE_LATENCY_PYTHON
  const list = configured ? [[configured, []]] : []
  if (process.platform === "win32") list.push(["py", ["-3"]], ["python", []])
  else list.push(["python3", []], ["python", []])
  return list
}

const attempts = []
for (const [command, prefix] of candidates()) {
  attempts.push(`${command}${prefix.length ? ` ${prefix.join(" ")}` : ""}`)
  const probe = spawnSync(command, [...prefix, "-c", PROBE], { stdio: "ignore" })
  if (!probe.error && probe.status === 0) {
    const result = spawnSync(command, [...prefix, SCRIPT, ...process.argv.slice(2)], { stdio: "inherit" })
    if (result.error) {
      console.error(`opencode-vitals selftest: ${command} failed to start — ${result.error.message}`)
      process.exit(1)
    }
    process.exit(result.status ?? 1)
  }
}

console.error("opencode-vitals selftest: no Python with tkinter found.")
console.error(`Tried: ${attempts.join(", ")}`)
console.error("Install Python 3.9+ with tkinter (Debian/Ubuntu: apt install python3-tk) and run again.")
process.exit(1)
