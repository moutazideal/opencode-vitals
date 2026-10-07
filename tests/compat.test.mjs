// The compatibility check decides whether a new OpenCode is safe to move to, so
// the decision itself is pinned here. It is the one part that needs no network,
// no schema package and no OpenCode: the comparison is plain arrays in, plain
// arrays out.
import { compareEventContract } from "../scripts/compat.mjs"

const results = []
function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition), detail })
  if (!condition) console.error(`FAIL ${name} ${detail}`)
}

// A removed handled event is the break this check exists to find.
{
  const result = compareEventContract({ known: ["session.text.delta"], handled: ["session.text.delta", "session.execution.started"] })
  check("a missing handled event is reported", result.missingHandled.length === 1 && result.missingHandled[0] === "session.execution.started", JSON.stringify(result.missingHandled))
}
// An added event is not a break, so it must not fail the run.
{
  const result = compareEventContract({ known: ["session.text.delta", "session.new.thing"], handled: ["session.text.delta"] })
  check("a new session event does not fail the check", result.missingHandled.length === 0, JSON.stringify(result))
  check("and it is listed as unclassified", result.unclassified.includes("session.new.thing"), JSON.stringify(result.unclassified))
}
// A renamed ignored event is noticed, not fatal.
{
  const result = compareEventContract({ known: ["session.text.delta"], handled: ["session.text.delta"], ignored: ["session.idle"] })
  check("a missing ignored event is noticed but not fatal", result.missingIgnored.length === 1 && result.missingHandled.length === 0, JSON.stringify(result))
}
// A prefix covers its whole family, so nothing inside it is unclassified noise.
{
  const result = compareEventContract({ known: ["session.tool.output.delta"], handled: [], prefixes: ["session.tool."] })
  check("a prefix suppresses its family", result.unclassified.length === 0, JSON.stringify(result.unclassified))
}
// Only session events are candidates for measurement; the rest is somebody
// else's business and must never show up as a gap.
{
  const result = compareEventContract({ known: ["mcp.tools.changed", "workspace.ready"], handled: [] })
  check("non-session events are not unclassified noise", result.unclassified.length === 0, JSON.stringify(result.unclassified))
}

for (const result of results) {
  console.log(`${result.ok ? "ok  " : "FAIL"} ${result.name}${result.detail ? ` ${result.detail}` : ""}`)
}
const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exit(1)
