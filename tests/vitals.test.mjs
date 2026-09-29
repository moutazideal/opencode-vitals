import { randomUUID } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, readFileSync, existsSync, utimesSync, statSync, lstatSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// The plugin resolves its status directory from the temporary directory when the
// module is evaluated, so the whole suite gets a sandbox before the import.
// Without this, running the tests drops response markers into the real
// ~/.cache or /tmp status directory of the person running them.
const SUITE_TMP = mkdtempSync(join(tmpdir(), "vitals-suite-"))
process.env.TMPDIR = SUITE_TMP
// The readout binds a real socket, so the suite gets its own port rather than
// fighting the developer's running instance for 8971. And it is pointed at an app
// that does not exist, so a suite run never copies a 43MB renderer or writes a
// launcher entry into the developer's home directory.
const READOUT_PORT = 9200 + (process.pid % 300)
process.env.OPENCODE_VITALS_PORT = String(READOUT_PORT)
process.env.OPENCODE_DESKTOP_APP = join(SUITE_TMP, "no-such-app.asar")
const { default: plugin, vitalsInternals } = await import("../index.js")
process.on("exit", () => rmSync(SUITE_TMP, { recursive: true, force: true }))

const results = []
function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition), detail })
  if (!condition) console.error(`FAIL ${name} ${detail}`)
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function makeStorage(initial = null) {
  let value = initial
  const sets = []
  return {
    async get() {
      return value ? { data: structuredClone(value) } : undefined
    },
    async set(_key, next) {
      value = structuredClone(next)
      sets.push(value)
    },
    get value() {
      return value
    },
    sets,
  }
}

async function waitForRecord(storage, predicate = () => true, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const records = storage.value?.records ?? []
    const match = [...records].reverse().find(predicate)
    if (match) return match
    await wait(25)
  }
  throw new Error("timed out waiting for a persisted record")
}

// Assigning undefined to process.env stores the string "undefined", which would
// silently break every later tmpdir() call, so restore by deleting instead.
async function withTmpDir(value, run) {
  const previous = process.env.TMPDIR
  process.env.TMPDIR = value
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previous
  }
}

let eventCounter = 0
function envelope(type, data, at) {
  eventCounter += 1
  return {
    id: `evt_${String(eventCounter).padStart(26, "0")}`,
    created: at,
    type,
    location: { directory: "/tmp/opencode/latency-audit" },
    data,
  }
}

async function run(events, options = {}) {
  const storage = makeStorage(options.initialStorage)
  const context = {
    options: { popup: false, log: false, ...options.pluginOptions },
    location: { directory: `/tmp/opencode/latency-audit-${Math.random()}`, ...(options.location ?? {}) },
    storage,
    ...(options.app ? { app: options.app } : {}),
    event: {
      subscribe({ signal }) {
        return (async function* () {
          for (const event of events) {
            if (signal.aborted) return
            yield event
          }
          await new Promise(() => {})
        })()
      },
    },
    session: {
      async hook() {},
      async context() {
        return []
      },
      // Absent unless a case needs it: a plugin with no session API must still
      // measure, it just cannot tell a subagent from a root session.
      ...(options.sessions ? { async get({ sessionID }) { return options.sessions[sessionID] ?? null } } : {}),
      synthetic() {
        throw new Error("synthetic must not be called")
      },
    },
  }
  const cleanup = await plugin.setup(context)
  return { storage, cleanup, context }
}

const base = Date.now() - 3_600_000
const unique = randomUUID().replace(/-/g, "").slice(0, 24)
const S = `ses_audit${unique}`
const S_A = `ses_mergeA${unique.slice(0, 15)}`
const S_B = `ses_mergeB${unique.slice(0, 15)}`

// 1. Normal single-step response: deltas, text.ended dedupe, step tokens.
{
  const events = [
    envelope("session.inbox.enqueued", { sessionID: S, inboxID: "inb_1", item: { type: "user", payload: {}, delivery: "steer" } }, base),
    envelope("session.execution.started", { sessionID: S }, base + 10),
    envelope("session.step.started", { sessionID: S, assistantMessageID: "msg_a", agent: "build", model: { id: "m1", providerID: "p1" }, started: base + 20 }, base + 20),
    envelope("session.text.started", { sessionID: S, assistantMessageID: "msg_a", ordinal: 0 }, base + 30),
    envelope("session.text.delta", { sessionID: S, assistantMessageID: "msg_a", ordinal: 0, delta: "Hello" }, base + 100),
    envelope("session.text.delta", { sessionID: S, assistantMessageID: "msg_a", ordinal: 0, delta: " wor" }, base + 200),
    envelope("session.text.delta", { sessionID: S, assistantMessageID: "msg_a", ordinal: 0, delta: "ld" }, base + 300),
    envelope("session.text.ended", { sessionID: S, assistantMessageID: "msg_a", ordinal: 0, text: "Hello world" }, base + 310),
    envelope("session.step.ended", { sessionID: S, assistantMessageID: "msg_a", tokens: { input: 5, output: 10, reasoning: 4, cache: { read: 0, write: 0 } } }, base + 400),
    envelope("session.usage.updated", { sessionID: S, tokens: { input: 5, output: 110, reasoning: 104, cache: { read: 0, write: 0 } } }, base + 410),
    envelope("session.execution.succeeded", { sessionID: S }, base + 500),
  ]
  const { storage, cleanup } = await run(events)
  const record = await waitForRecord(storage)
  check("single-step chars", record.characterCount === 11, JSON.stringify(record.characterCount))
  check("single-step deltas", record.deltaCount === 3, JSON.stringify(record.deltaCount))
  check("single-step first token", record.firstTokenMs === 90, JSON.stringify(record.firstTokenMs))
  check("single-step first text", record.firstTextMs === 90, JSON.stringify(record.firstTextMs))
  check("single-step total", record.totalMs === 290, JSON.stringify(record.totalMs))
  check("single-step from first to last", record.firstToLastMs === 200, JSON.stringify(record.firstToLastMs))
  check("single-step stream", record.activeStreamMs === 200, JSON.stringify(record.activeStreamMs))
  check("single-step output tokens", record.outputTokens === 10, JSON.stringify(record.outputTokens))
  check("single-step reasoning tokens", record.reasoningTokens === 4, JSON.stringify(record.reasoningTokens))
  check("single-step source", record.outputTokenSource === "step", record.outputTokenSource)
  check("single-step tps", Math.abs(record.tokensPerSecond - 70) < 0.001, JSON.stringify(record.tokensPerSecond))
  check("session totals turns", record.sessionTotals?.turns === 1, JSON.stringify(record.sessionTotals))
  check("session totals steps", record.sessionTotals?.steps === 1, JSON.stringify(record.sessionTotals))
  check("session totals tokens", record.sessionTotals?.generatedTokens === 14, JSON.stringify(record.sessionTotals))
  check("session totals tps", Math.abs((record.sessionTotals?.tokensPerSecond ?? 0) - 70) < 0.001, JSON.stringify(record.sessionTotals))
  check("single-step start", record.startSource === "execution", record.startSource)
  check("single-step not inferred", record.inferredStart === false)
  cleanup()
}

// 2. Reasoning before visible text: first token is earlier than first text.
{
  const events = [
    envelope("session.execution.started", { sessionID: S }, base),
    envelope("session.step.started", { sessionID: S, assistantMessageID: "msg_b", started: base + 5 }, base + 5),
    envelope("session.reasoning.started", { sessionID: S, assistantMessageID: "msg_b", ordinal: 0 }, base + 10),
    envelope("session.reasoning.delta", { sessionID: S, assistantMessageID: "msg_b", ordinal: 0, delta: "thinking" }, base + 100),
    envelope("session.reasoning.delta", { sessionID: S, assistantMessageID: "msg_b", ordinal: 0, delta: " more" }, base + 200),
    envelope("session.reasoning.ended", { sessionID: S, assistantMessageID: "msg_b", ordinal: 0, text: "thinking more" }, base + 210),
    envelope("session.text.delta", { sessionID: S, assistantMessageID: "msg_b", ordinal: 0, delta: "Hi" }, base + 1000),
    envelope("session.step.ended", { sessionID: S, assistantMessageID: "msg_b", tokens: { input: 1, output: 2, reasoning: 3, cache: {} } }, base + 1100),
    envelope("session.execution.succeeded", { sessionID: S }, base + 1200),
  ]
  const { storage, cleanup } = await run(events)
  const record = await waitForRecord(storage)
  check("reasoning first token", record.firstTokenMs === 100, JSON.stringify(record.firstTokenMs))
  check("reasoning first text", record.firstTextMs === 1000, JSON.stringify(record.firstTextMs))
  check("reasoning from first to last", record.firstToLastMs === 900, JSON.stringify(record.firstToLastMs))
  check("reasoning chars text only", record.characterCount === 2, JSON.stringify(record.characterCount))
  check("reasoning characters", record.reasoningCharacterCount === 13, JSON.stringify(record.reasoningCharacterCount))
  check("reasoning generated tokens", record.generatedTokens === 5, JSON.stringify(record.generatedTokens))
  check("reasoning tps over active span", Math.abs(record.tokensPerSecond - 5 / 0.9) < 0.05, JSON.stringify(record.tokensPerSecond))
  cleanup()
}

// 3. Snapshot dedupe across ordinals: deltas counted first, ended must not double count.
{
  const events = [
    envelope("session.execution.started", { sessionID: S }, base),
    envelope("session.text.delta", { sessionID: S, assistantMessageID: "msg_c", ordinal: 0, delta: "abc" }, base + 10),
    envelope("session.text.ended", { sessionID: S, assistantMessageID: "msg_c", ordinal: 0, text: "abc" }, base + 20),
    envelope("session.text.delta", { sessionID: S, assistantMessageID: "msg_c", ordinal: 1, delta: "de" }, base + 30),
    envelope("session.text.ended", { sessionID: S, assistantMessageID: "msg_c", ordinal: 1, text: "def" }, base + 40),
    envelope("session.step.ended", { sessionID: S, assistantMessageID: "msg_c", tokens: { output: 1, reasoning: 0, cache: {} } }, base + 50),
    envelope("session.execution.succeeded", { sessionID: S }, base + 60),
  ]
  const { storage, cleanup } = await run(events)
  const record = await waitForRecord(storage)
  check("ordinal dedupe chars", record.characterCount === 6, JSON.stringify(record.characterCount))
  check("ordinal dedupe deltas", record.deltaCount === 3, JSON.stringify(record.deltaCount))
  cleanup()
}

// 4. Compaction (real event order) must not create or publish a record.
{
  const events = [
    envelope("session.inbox.enqueued", { sessionID: S, inboxID: "inb_c", item: { type: "compaction", payload: {}, delivery: "steer" } }, base),
    envelope("session.execution.started", { sessionID: S }, base + 3),
    envelope("session.inbox.delivered", { sessionID: S, inboxID: "inb_c" }, base + 30),
    envelope("session.compaction.started", { sessionID: S, reason: "auto", recent: "", inputID: "inb_c" }, base + 30),
    envelope("session.reasoning.delta", { sessionID: S, assistantMessageID: "msg_comp", ordinal: 0, delta: "summarize" }, base + 40),
    envelope("session.step.ended", { sessionID: S, assistantMessageID: "msg_comp", tokens: { output: 1185, reasoning: 100, cache: {} } }, base + 50),
    envelope("session.compaction.ended", { sessionID: S, reason: "auto", text: "summary", tokens: { output: 1185, reasoning: 100, cache: {} } }, base + 55),
    envelope("session.execution.succeeded", { sessionID: S }, base + 60),
  ]
  const { storage, cleanup } = await run(events)
  await wait(300)
  check("compaction no record", storage.sets.length === 0, JSON.stringify(storage.sets.length))
  cleanup()
}

// 5. After a compaction, a normal turn still records (flag cleared).
{
  const events = [
    envelope("session.inbox.enqueued", { sessionID: S, inboxID: "inb_c2", item: { type: "compaction", payload: {}, delivery: "steer" } }, base),
    envelope("session.execution.started", { sessionID: S }, base + 3),
    envelope("session.compaction.started", { sessionID: S, reason: "auto", recent: "", inputID: "inb_c2" }, base + 9),
    envelope("session.execution.succeeded", { sessionID: S }, base + 20),
    envelope("session.inbox.enqueued", { sessionID: S, inboxID: "inb_u2", item: { type: "user", payload: {}, delivery: "steer" } }, base + 100),
    envelope("session.execution.started", { sessionID: S }, base + 103),
    envelope("session.text.delta", { sessionID: S, assistantMessageID: "msg_after", ordinal: 0, delta: "ok" }, base + 200),
    envelope("session.step.ended", { sessionID: S, assistantMessageID: "msg_after", tokens: { output: 3, reasoning: 0, cache: {} } }, base + 300),
    envelope("session.execution.succeeded", { sessionID: S }, base + 400),
  ]
  const { storage, cleanup } = await run(events)
  const record = await waitForRecord(storage)
  check("post-compaction chars", record.characterCount === 2, JSON.stringify(record.characterCount))
  check("post-compaction start", record.startSource === "execution", record.startSource)
  check("post-compaction first token", record.firstTokenMs === 97, JSON.stringify(record.firstTokenMs))
  cleanup()
}

// 6. Interrupted execution records the partial response and frees the turn.
{
  const events = [
    envelope("session.execution.started", { sessionID: S }, base),
    envelope("session.text.delta", { sessionID: S, assistantMessageID: "msg_int", ordinal: 0, delta: "partial" }, base + 100),
    envelope("session.execution.interrupted", { sessionID: S, reason: "user" }, base + 200),
  ]
  const { storage, cleanup } = await run(events)
  const record = await waitForRecord(storage)
  check("interrupted record", record.characterCount === 7, JSON.stringify(record.characterCount))
  cleanup()
}

// 7. Duplicate completion events only produce one record.
{
  const events = [
    envelope("session.execution.started", { sessionID: S }, base),
    envelope("session.text.delta", { sessionID: S, assistantMessageID: "msg_dup", ordinal: 0, delta: "x" }, base + 100),
    envelope("session.step.ended", { sessionID: S, assistantMessageID: "msg_dup", tokens: { output: 1, reasoning: 0, cache: {} } }, base + 150),
    envelope("session.execution.succeeded", { sessionID: S }, base + 200),
    envelope("session.execution.succeeded", { sessionID: S }, base + 210),
    envelope("session.execution.failed", { sessionID: S, error: { type: "x" } }, base + 220),
  ]
  const { storage, cleanup } = await run(events)
  await wait(400)
  check("duplicate completion single record", storage.sets.length === 1, JSON.stringify(storage.sets.length))
  cleanup()
}

// 8. Delta with no begin is flagged inferred and has no reliable FTR.
{
  const events = [
    envelope("session.text.delta", { sessionID: S, assistantMessageID: "msg_late", ordinal: 0, delta: "late" }, base + 50),
    envelope("session.step.ended", { sessionID: S, assistantMessageID: "msg_late", tokens: { output: 2, reasoning: 0, cache: {} } }, base + 80),
    envelope("session.execution.succeeded", { sessionID: S }, base + 90),
  ]
  const { storage, cleanup } = await run(events)
  const record = await waitForRecord(storage)
  check("delta-only inferred", record.inferredStart === true, record.startSource)
  check("delta-only chars", record.characterCount === 4, JSON.stringify(record.characterCount))
  cleanup()
}

// 9. Late events after completion must not create a ghost record.
{
  const events = [
    envelope("session.execution.started", { sessionID: S }, base),
    envelope("session.text.delta", { sessionID: S, assistantMessageID: "msg_e", ordinal: 0, delta: "done" }, base + 100),
    envelope("session.step.ended", { sessionID: S, assistantMessageID: "msg_e", tokens: { output: 1, reasoning: 0, cache: {} } }, base + 150),
    envelope("session.execution.succeeded", { sessionID: S }, base + 200),
    envelope("session.text.delta", { sessionID: S, assistantMessageID: "msg_e", ordinal: 0, delta: " ghost" }, base + 300),
    envelope("session.step.ended", { sessionID: S, assistantMessageID: "msg_e", tokens: { output: 5, reasoning: 0, cache: {} } }, base + 310),
  ]
  const { storage, cleanup } = await run(events)
  await wait(400)
  check("no ghost record", storage.sets.length === 1, JSON.stringify(storage.sets.length))
  cleanup()
}

// 10. Two plugin instances share storage; merge must keep both records.
{
  const shared = makeStorage()
  const storageFacade = {
    async get() {
      return shared.get()
    },
    async set(key, value) {
      return shared.set(key, value)
    },
  }
  const makeContext = (events) => ({
    options: { popup: false, log: false },
    location: { directory: `/tmp/opencode/latency-audit-${Math.random()}` },
    storage: storageFacade,
    event: {
      subscribe({ signal }) {
        return (async function* () {
          for (const event of events) {
            if (signal.aborted) return
            yield event
          }
          await new Promise(() => {})
        })()
      },
    },
    session: { async hook() {}, async context() { return [] }, synthetic() {} },
  })
  await shared.set("history-v2", { version: 1, records: [{ id: "old", sequence: 7, sessionID: "ses_old" }] })
  const eventsA = [
    envelope("session.execution.started", { sessionID: S_A }, base),
    envelope("session.text.delta", { sessionID: S_A, assistantMessageID: "msg_mA", ordinal: 0, delta: "aa" }, base + 10),
    envelope("session.step.ended", { sessionID: S_A, assistantMessageID: "msg_mA", tokens: { output: 1, reasoning: 0, cache: {} } }, base + 20),
    envelope("session.execution.succeeded", { sessionID: S_A }, base + 30),
  ]
  const eventsB = [
    envelope("session.execution.started", { sessionID: S_B }, base + 5),
    envelope("session.text.delta", { sessionID: S_B, assistantMessageID: "msg_mB", ordinal: 0, delta: "bb" }, base + 15),
    envelope("session.step.ended", { sessionID: S_B, assistantMessageID: "msg_mB", tokens: { output: 1, reasoning: 0, cache: {} } }, base + 25),
    envelope("session.execution.succeeded", { sessionID: S_B }, base + 35),
  ]
  const cleanupA = await plugin.setup(makeContext(eventsA))
  const cleanupB = await plugin.setup(makeContext(eventsB))
  await waitForRecord(shared, (item) => item.sessionID === S_B)
  const records = shared.value?.records ?? []
  check("merge keeps old record", records.some((item) => item.id === "old"), JSON.stringify(records.map((item) => item.id)))
  check("merge keeps both sessions", records.filter((item) => item.sessionID?.startsWith("ses_merge")).length === 2, JSON.stringify(records.map((item) => item.sessionID)))
  check("merge sequences unique", new Set(records.map((item) => item.sequence)).size === records.length, JSON.stringify(records.map((item) => item.sequence)))
  const sequences = records.filter((item) => item.sessionID?.startsWith("ses_merge")).map((item) => item.sequence).sort()
  check("merge sequence continues", sequences[0] === 8 && sequences[1] === 9, JSON.stringify(sequences))
  cleanupA()
  cleanupB()
}

// 11. Context fallback tokens are used only when no step tokens exist.
{
  const storage = makeStorage()
  const contextCalls = []
  const context = {
    options: { popup: false, log: false },
    location: { directory: `/tmp/opencode/latency-audit-${Math.random()}` },
    storage,
    event: {
      subscribe({ signal }) {
        return (async function* () {
          yield envelope("session.execution.started", { sessionID: S }, base)
          yield envelope("session.text.delta", { sessionID: S, assistantMessageID: "msg_f", ordinal: 0, delta: "fallback" }, base + 100)
          yield envelope("session.execution.succeeded", { sessionID: S }, base + 200)
          await new Promise(() => {})
        })()
      },
    },
    session: {
      async hook() {},
      async context(input) {
        contextCalls.push(input)
        return [{ id: "msg_f", role: "assistant", tokens: { output: 42 } }]
      },
      synthetic() {},
    },
  }
  const cleanup = await plugin.setup(context)
  const record = await waitForRecord(storage)
  check("fallback context called", contextCalls.length === 1, JSON.stringify(contextCalls.length))
  check("fallback tokens", record.outputTokens === 42, JSON.stringify(record.outputTokens))
  check("fallback source", record.outputTokenSource === "message", record.outputTokenSource)
  cleanup()
}

// 12. Synthetic inbox items are excluded, and the session recovers afterwards.
{
  const events = [
    envelope("session.inbox.enqueued", { sessionID: S, inboxID: "inb_syn", item: { type: "synthetic", payload: {}, delivery: "steer" } }, base),
    envelope("session.execution.started", { sessionID: S }, base + 3),
    envelope("session.inbox.delivered", { sessionID: S, inboxID: "inb_syn" }, base + 10),
    envelope("session.text.delta", { sessionID: S, assistantMessageID: "msg_syn", ordinal: 0, delta: "summary" }, base + 100),
    envelope("session.step.ended", { sessionID: S, assistantMessageID: "msg_syn", tokens: { output: 7, reasoning: 0, cache: {} } }, base + 150),
    envelope("session.execution.succeeded", { sessionID: S }, base + 200),
    envelope("session.inbox.enqueued", { sessionID: S, inboxID: "inb_user", item: { type: "user", payload: {}, delivery: "steer" } }, base + 300),
    envelope("session.execution.started", { sessionID: S }, base + 303),
    envelope("session.text.delta", { sessionID: S, assistantMessageID: "msg_real", ordinal: 0, delta: "real" }, base + 400),
    envelope("session.step.ended", { sessionID: S, assistantMessageID: "msg_real", tokens: { output: 2, reasoning: 0, cache: {} } }, base + 450),
    envelope("session.execution.succeeded", { sessionID: S }, base + 500),
  ]
  const { storage, cleanup } = await run(events)
  const record = await waitForRecord(storage)
  check("synthetic excluded then recovery", record.characterCount === 4 && record.messageID === "msg_real", JSON.stringify([record.characterCount, record.messageID]))
  check("synthetic exclusion single record", storage.sets.length === 1, JSON.stringify(storage.sets.length))
  cleanup()
}

// 13. A redelivered event (same envelope id) must not double count.
{
  const duplicated = envelope("session.text.delta", { sessionID: S, assistantMessageID: "msg_redeliver", ordinal: 0, delta: "abc" }, base + 100)
  const events = [
    envelope("session.execution.started", { sessionID: S }, base),
    duplicated,
    duplicated,
    duplicated,
    envelope("session.step.ended", { sessionID: S, assistantMessageID: "msg_redeliver", tokens: { output: 1, reasoning: 0, cache: {} } }, base + 150),
    envelope("session.execution.succeeded", { sessionID: S }, base + 200),
  ]
  const { storage, cleanup } = await run(events)
  const record = await waitForRecord(storage)
  check("redelivered event single count", record.characterCount === 3 && record.deltaCount === 1, JSON.stringify([record.characterCount, record.deltaCount]))
  cleanup()
}

// 14. Session totals accumulate across turns and publish an average TPS.
{
  const events = [
    envelope("session.execution.started", { sessionID: S }, base),
    envelope("session.step.started", { sessionID: S, assistantMessageID: "msg_t1", started: base + 5 }, base + 5),
    envelope("session.text.delta", { sessionID: S, assistantMessageID: "msg_t1", ordinal: 0, delta: "first" }, base + 100),
    envelope("session.text.delta", { sessionID: S, assistantMessageID: "msg_t1", ordinal: 0, delta: " turn" }, base + 300),
    envelope("session.step.ended", { sessionID: S, assistantMessageID: "msg_t1", tokens: { output: 10, reasoning: 4, cache: {} } }, base + 400),
    envelope("session.execution.succeeded", { sessionID: S }, base + 500),
    envelope("session.execution.started", { sessionID: S }, base + 900),
    envelope("session.step.started", { sessionID: S, assistantMessageID: "msg_t2", started: base + 905 }, base + 905),
    envelope("session.text.delta", { sessionID: S, assistantMessageID: "msg_t2", ordinal: 0, delta: "second" }, base + 1000),
    envelope("session.text.delta", { sessionID: S, assistantMessageID: "msg_t2", ordinal: 0, delta: " turn" }, base + 1200),
    envelope("session.step.ended", { sessionID: S, assistantMessageID: "msg_t2", tokens: { output: 6, reasoning: 0, cache: {} } }, base + 1300),
    envelope("session.execution.succeeded", { sessionID: S }, base + 1400),
  ]
  const { storage, cleanup } = await run(events)
  await waitForRecord(storage, (item) => item.messageID === "msg_t2")
  const records = storage.value?.records ?? []
  const first = records.find((item) => item.messageID === "msg_t1")
  const second = records.find((item) => item.messageID === "msg_t2")
  check("session totals first turn", first?.sessionTotals?.turns === 1 && first?.sessionTotals?.steps === 1, JSON.stringify(first?.sessionTotals))
  check("session totals second turn", second?.sessionTotals?.turns === 2 && second?.sessionTotals?.steps === 2, JSON.stringify(second?.sessionTotals))
  check("session totals token sum", second?.sessionTotals?.generatedTokens === 20, JSON.stringify(second?.sessionTotals))
  check("session totals stream sum", second?.sessionTotals?.activeStreamMs === 400, JSON.stringify(second?.sessionTotals))
  check("session average tps", Math.abs((second?.sessionTotals?.tokensPerSecond ?? 0) - 50) < 0.001, JSON.stringify(second?.sessionTotals))
  cleanup()
}

// 15. Saved history seeds session totals so averages survive plugin reloads.
{
  const seeded = {
    version: 1,
    records: [{
      id: "seed-1",
      sequence: 1,
      sessionID: S,
      sessionTotals: { turns: 5, steps: 50, generatedTokens: 500, activeStreamMs: 1000, tokensPerSecond: 500 },
    }],
  }
  const events = [
    envelope("session.execution.started", { sessionID: S }, base),
    envelope("session.text.delta", { sessionID: S, assistantMessageID: "msg_seed", ordinal: 0, delta: "hi" }, base + 100),
    envelope("session.step.ended", { sessionID: S, assistantMessageID: "msg_seed", tokens: { output: 10, reasoning: 0, cache: {} } }, base + 150),
    envelope("session.execution.succeeded", { sessionID: S }, base + 200),
  ]
  const { storage, cleanup } = await run(events, { initialStorage: seeded })
  const record = await waitForRecord(storage, (item) => item.id !== "seed-1")
  check("seeded totals continue turns", record.sessionTotals?.turns === 6, JSON.stringify(record.sessionTotals))
  check("seeded totals continue steps", record.sessionTotals?.steps === 51, JSON.stringify(record.sessionTotals))
  check("seeded totals sum tokens", record.sessionTotals?.generatedTokens === 510, JSON.stringify(record.sessionTotals))
  // The seeded stream time is carried, not dropped, and this response's own
  // stream is added to it. What must not happen is tokens from one moment being
  // divided by a stream time from another: 510 tokens over 1100ms of stream.
  check("seeded totals keep stream", record.sessionTotals?.activeStreamMs === 1100, JSON.stringify(record.sessionTotals))
  check("seeded rate is one snapshot", Math.abs((record.sessionTotals?.tokensPerSecond ?? 0) - 510 / 1.1) < 0.01, JSON.stringify(record.sessionTotals))
  // One message, one delta: no measured stream span, so the wall time of that
  // single message is what the rate is taken from.
  check("a one-piece answer still gets a rate", record.rateSource === "single-message-total" && record.tokensPerSecond > 0, JSON.stringify([record.rateSource, record.tokensPerSecond]))
  cleanup()
}

// 16. The current session follows session.viewed events and user prompts.
{
  const other = `ses_other${unique.slice(0, 18)}`
  const viewed = [
    envelope("session.viewed", { sessionID: other, idle: base }, base),
    envelope("session.execution.started", { sessionID: other }, base + 10),
    envelope("session.text.delta", { sessionID: other, assistantMessageID: "msg_view", ordinal: 0, delta: "hi" }, base + 100),
    envelope("session.step.ended", { sessionID: other, assistantMessageID: "msg_view", tokens: { output: 2, reasoning: 0, cache: {} } }, base + 150),
    envelope("session.execution.succeeded", { sessionID: other }, base + 200),
  ]
  const first = await run(viewed)
  const viewedRecord = await waitForRecord(first.storage)
  check("viewed session becomes current", viewedRecord.currentSessionKnown === true && viewedRecord.currentSessionID === other, JSON.stringify([viewedRecord.currentSessionKnown, viewedRecord.currentSessionID, other]))
  first.cleanup()

  const prompted = [
    envelope("session.viewed", { sessionID: other, idle: base }, base),
    envelope("session.inbox.enqueued", { sessionID: S, inboxID: "inb_current", item: { type: "user", payload: {}, delivery: "steer" } }, base + 50),
    envelope("session.execution.started", { sessionID: S }, base + 60),
    envelope("session.text.delta", { sessionID: S, assistantMessageID: "msg_current", ordinal: 0, delta: "yo" }, base + 100),
    envelope("session.step.ended", { sessionID: S, assistantMessageID: "msg_current", tokens: { output: 1, reasoning: 0, cache: {} } }, base + 150),
    envelope("session.execution.succeeded", { sessionID: S }, base + 200),
  ]
  const second = await run(prompted)
  const promptRecord = await waitForRecord(second.storage)
  check("prompted session becomes current", promptRecord.currentSessionKnown === true && promptRecord.currentSessionID === S, JSON.stringify([promptRecord.currentSessionKnown, promptRecord.currentSessionID]))
  second.cleanup()
}




// 20. A version change is noticed without any network call.
{
  const sandbox = mkdtempSync(join(tmpdir(), "vitals-version-"))
  const isolated = await withTmpDir(sandbox, () => import(`../index.js?version=${Date.now()}`))
  const versionFile = join(sandbox, "opencode-latency-monitor", "plugin-version.json")
  const own = isolated.vitalsInternals.readOwnVersion()
  check("plugin reports its own version", /^\d+\.\d+\.\d+/.test(own), own)

  const first = await isolated.vitalsInternals.notePluginVersion()
  check("first run counts as installed", first.changed === true && first.previous === null, JSON.stringify(first))
  check("version file written", existsSync(versionFile), versionFile)

  const again = await isolated.vitalsInternals.notePluginVersion()
  check("same version is not an update", again.changed === false, JSON.stringify(again))

  writeFileSync(versionFile, JSON.stringify({ version: "0.0.1-old", updatedAt: Date.now() - 86_400_000 }))
  const upgraded = await isolated.vitalsInternals.notePluginVersion()
  check("new version is an update", upgraded.changed === true && upgraded.previous === "0.0.1-old", JSON.stringify(upgraded))
  const stored = JSON.parse(readFileSync(versionFile, "utf8"))
  check("stored update keeps both versions", stored.version === own && stored.previous === "0.0.1-old", JSON.stringify(stored))
  check("stored update is timestamped", typeof stored.updatedAt === "number" && stored.updatedAt > 0, JSON.stringify(stored.updatedAt))
  rmSync(sandbox, { recursive: true, force: true })
}

// 21. Markers are pruned on their own, without waiting for a new response.
{
  const sandbox = mkdtempSync(join(tmpdir(), "vitals-prune-"))
  const isolated = await withTmpDir(sandbox, () => import(`../index.js?prune=${Date.now()}`))
  const statusDir = join(sandbox, "opencode-latency-monitor")
  mkdirSync(statusDir, { recursive: true })
  const old = join(statusDir, "response-old.marker")
  const fresh = join(statusDir, "response-fresh.marker")
  const unrelated = join(statusDir, "latest.json")
  writeFileSync(old, "{}")
  writeFileSync(fresh, "{}")
  writeFileSync(unrelated, "{}")
  const longAgo = new Date(Date.now() - isolated.vitalsInternals.RESPONSE_MARKER_TTL_MS - 60_000)
  utimesSync(old, longAgo, longAgo)
  await isolated.vitalsInternals.pruneResponseMarkers({ force: true })
  check("stale marker removed", !existsSync(old), old)
  check("fresh marker kept", existsSync(fresh))
  check("unrelated files untouched", existsSync(unrelated))

  // The claim/prune pair must not delete a marker another instance just wrote.
  const claimed = await isolated.vitalsInternals.claimResponse("turn-key-alpha")
  check("first claim wins", claimed === true)
  const duplicate = await isolated.vitalsInternals.claimResponse("turn-key-alpha")
  check("duplicate claim is refused", duplicate === false)
  const other = await isolated.vitalsInternals.claimResponse("turn-key-beta")
  check("different key claims", other === true)
  rmSync(sandbox, { recursive: true, force: true })
}

// 22. The README cannot promise a command that does not exist.
{
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  const bins = manifest.bin ?? {}
  const commands = [...readme.matchAll(/npx\s+([\w-]+)/g)].map((match) => match[1])
  check("README shows an npx command", commands.length > 0, JSON.stringify(commands))
  for (const command of new Set(commands)) {
    check(`npx ${command} is a declared bin`, Object.hasOwn(bins, command), JSON.stringify(Object.keys(bins)))
    if (Object.hasOwn(bins, command)) {
      const target = bins[command]
      check(`bin ${command} ships in the package`, (manifest.files ?? []).includes(target), target)
      check(`bin ${command} exists on disk`, existsSync(new URL(`../${target}`, import.meta.url)), target)
    }
  }
  // `npx opencode-vitals <what>` only works when the dispatcher knows <what>,
  // so every subcommand the README prints is checked against its real list.
  const { COMMANDS } = await import("../cli.mjs")
  const subcommands = [...readme.matchAll(/npx\s+opencode-vitals\s+([\w-]+)/g)].map((match) => match[1])
  for (const subcommand of new Set(subcommands)) {
    check(`README subcommand ${subcommand} is real`, Object.hasOwn(COMMANDS, subcommand), JSON.stringify(Object.keys(COMMANDS)))
  }
  check("README documents the plugins config key", /"plugins"\s*:/.test(readme) && readme.includes("opencode-vitals"))
  // OpenCode installs npm plugins into its own cache, so an npm install of this
  // package would only leave a stale second copy. The README may say so in prose,
  // but no command block may tell a user to run it.
  const shellBlocks = [...readme.matchAll(/```(?:bash|sh|shell)\n([\s\S]*?)```/g)].map((match) => match[1])
  const forbidden = shellBlocks.filter((block) => /npm\s+(install|i)\b[^\n]*opencode-vitals/.test(block))
  check("no command block tells users to npm install the plugin", forbidden.length === 0, JSON.stringify(forbidden))
  // An update guide that forgets how to verify the running version, or how to
  // update the other two install methods, is the gap that got reported.
  const updating = readme.slice(readme.indexOf("## Updating"))
  check("updating covers the git install", /git pull/.test(updating))
  check("updating covers the copied install", /Replace the files/.test(updating))
  check("updating tells users how to verify", /opencode-vitals selftest/.test(updating) && /plugin version recorded — running \d+\.\d+\.\d+/.test(updating))
  check("updating links both screenshots", readme.includes("docs/bar.png") && readme.includes("docs/bar-mini.png"))
  // The README is also the npm package page, where a relative docs/bar.png
  // resolves to nothing. Every image must be an absolute raw link, and the file
  // it points at must be in this repository.
  const localImage = (source) => source.replace(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\//, "")
  for (const image of [...readme.matchAll(/src="([^"]+\.png)"/g)].map((match) => match[1])) {
    check(`README image ${image} is an absolute raw link`, image.startsWith("https://raw.githubusercontent.com/"), image)
    check(`README image ${localImage(image)} exists`, existsSync(new URL(`../${localImage(image)}`, import.meta.url)))
  }
}

// 23. The one command install copies what npm ships and never surprises.
{
  const { install, uninstall, status, resolvePluginsDir, shippedFiles, readManifest } = await import("../install.mjs")
  const manifest = readManifest()
  check("manifest ships the installer", manifest.files.includes("install.mjs"), JSON.stringify(manifest.files))
  check("installer is a declared command", manifest.bin?.["opencode-vitals-install"] === "install.mjs", JSON.stringify(manifest.bin))
  // npx resolves package names, not the files inside them, so the command that
  // newcomers type has to be a bin named after the package.
  check("a command carries the package name", manifest.bin?.["opencode-vitals"] === "cli.mjs", JSON.stringify(manifest.bin))
  check("the dispatcher ships with the package", manifest.files.includes("cli.mjs"), JSON.stringify(manifest.files))
  check("the readout ships with the package", manifest.files.includes("readout.mjs") && manifest.files.includes("renderer/vitals.js"), JSON.stringify(manifest.files))
  check("nothing that drew a window is still shipped", !shippedFiles(manifest).some((name) => name.endsWith(".py") || name === "start-bar.sh"), JSON.stringify(shippedFiles(manifest)))
  check("shipped file list has no duplicates", new Set(shippedFiles(manifest)).size === shippedFiles(manifest).length)

  const plugins = mkdtempSync(join(tmpdir(), "vitals-plugins-"))
  const first = install({ pluginsDir: plugins, packageRoot: new URL("..", import.meta.url).pathname, name: "opencode-vitals" })
  check("install reports installed", first.action === "installed", JSON.stringify(first))
  check("install copies every shipped file", first.files === shippedFiles(manifest).length, JSON.stringify(first))
  check("the manifest is copied too", shippedFiles(manifest).includes("package.json") && existsSync(join(plugins, "opencode-vitals", "package.json")))
  check("installed manifest matches the package", JSON.parse(readFileSync(join(plugins, "opencode-vitals", "package.json"), "utf8")).version === manifest.version)
  check("the readout ships next to the plugin", existsSync(join(plugins, "opencode-vitals", "readout.mjs")))
  check("the readout's injected script is shipped", existsSync(join(plugins, "opencode-vitals", "renderer", "vitals.js")))
  check("nested directories are created", existsSync(join(plugins, "opencode-vitals", "docs", "bar.png")))

  const again = install({ pluginsDir: plugins, packageRoot: new URL("..", import.meta.url).pathname, name: "opencode-vitals" })
  check("installing twice is an update", again.action === "updated", JSON.stringify(again))
  check("no nesting after a second run", !existsSync(join(plugins, "opencode-vitals", "opencode-vitals")))

  // A stale file from an older release must not survive the update.
  writeFileSync(join(plugins, "opencode-vitals", "popup.py"), "left over from the GTK era\n")
  install({ pluginsDir: plugins, packageRoot: new URL("..", import.meta.url).pathname, name: "opencode-vitals" })
  check("update removes files it no longer ships", !existsSync(join(plugins, "opencode-vitals", "popup.py")))

  const reported = status({ pluginsDir: plugins })
  check("status reports the version", reported.installed === true && reported.version === manifest.version, JSON.stringify(reported))

  // Refuse to overwrite somebody else's package, and only with --force.
  const other = mkdtempSync(join(tmpdir(), "vitals-other-"))
  mkdirSync(join(other, "opencode-vitals"), { recursive: true })
  writeFileSync(join(other, "opencode-vitals", "package.json"), JSON.stringify({ name: "someone-else", version: "9.9.9" }))
  let refused = ""
  try {
    install({ pluginsDir: other, packageRoot: new URL("..", import.meta.url).pathname, name: "opencode-vitals" })
  } catch (error) {
    refused = error.message
  }
  check("install refuses a foreign package", refused.includes("different package"), refused)
  check("the foreign package is untouched", JSON.parse(readFileSync(join(other, "opencode-vitals", "package.json"), "utf8")).name === "someone-else")

  // --force over a plain file replaces it instead of failing on readdir.
  const forced = mkdtempSync(join(tmpdir(), "vitals-forced-"))
  writeFileSync(join(forced, "opencode-vitals"), "not a directory\n")
  let fileRefused = ""
  try {
    install({ pluginsDir: forced, packageRoot: new URL("..", import.meta.url).pathname, name: "opencode-vitals" })
  } catch (error) {
    fileRefused = error.message
  }
  check("a file needs --force", fileRefused.includes("is a file"), fileRefused)
  const forcedReport = install({ pluginsDir: forced, packageRoot: new URL("..", import.meta.url).pathname, name: "opencode-vitals", force: true })
  check("--force replaces the file with the folder", forcedReport.action === "installed" && statSync(join(forced, "opencode-vitals")).isDirectory(), JSON.stringify(forcedReport))

  // Uninstall must not delete a stranger that happens to sit under our name.
  const stranger = mkdtempSync(join(tmpdir(), "vitals-stranger-"))
  mkdirSync(join(stranger, "opencode-vitals"), { recursive: true })
  writeFileSync(join(stranger, "opencode-vitals", "package.json"), JSON.stringify({ name: "someone-else", version: "1.0.0" }))
  let uninstallRefused = ""
  try {
    uninstall({ pluginsDir: stranger, packageRoot: new URL("..", import.meta.url).pathname })
  } catch (error) {
    uninstallRefused = error.message
  }
  check("uninstall refuses a stranger", uninstallRefused.includes("does not look like"), uninstallRefused)
  check("the stranger survived", existsSync(join(stranger, "opencode-vitals", "package.json")))
  const forcedRemoval = uninstall({ pluginsDir: stranger, packageRoot: new URL("..", import.meta.url).pathname, force: true })
  check("--force removes it anyway", forcedRemoval.action === "removed" && !existsSync(join(stranger, "opencode-vitals")), JSON.stringify(forcedRemoval))

  const linked = mkdtempSync(join(tmpdir(), "vitals-link-"))
  const linkReport = install({ pluginsDir: linked, packageRoot: new URL("..", import.meta.url).pathname, mode: "link", name: "opencode-vitals" })
  check("link mode creates a symlink", linkReport.action === "linked" && lstatSync(join(linked, "opencode-vitals")).isSymbolicLink(), JSON.stringify(linkReport))
  const linkAgain = install({ pluginsDir: linked, packageRoot: new URL("..", import.meta.url).pathname, mode: "link", name: "opencode-vitals" })
  check("linking twice is a no-op", linkAgain.action === "already-linked", JSON.stringify(linkAgain))

  const removed = uninstall({ pluginsDir: plugins })
  check("uninstall removes the folder", removed.action === "removed" && !existsSync(join(plugins, "opencode-vitals")), JSON.stringify(removed))
  check("uninstall twice is harmless", uninstall({ pluginsDir: plugins }).action === "nothing-to-do")
  check("the project itself is still here", existsSync(new URL("../index.js", import.meta.url).pathname))

  // One rule for every platform, taken from the shipped CLI: $XDG_CONFIG_HOME
  // when set, ~/.config otherwise, then opencode/plugins.
  const detected = resolvePluginsDir({ env: { XDG_CONFIG_HOME: "/tmp/xdg-here" }, home: "/home/someone" })
  check("XDG_CONFIG_HOME is honoured", detected === "/tmp/xdg-here/opencode/plugins", detected)
  const fallback = resolvePluginsDir({ env: {}, home: "/home/someone" })
  check("otherwise it is ~/.config/opencode/plugins", fallback === "/home/someone/.config/opencode/plugins", fallback)
  // XDG wins outright, exactly as the CLI decides, even when another root exists.
  const existingRoot = mkdtempSync(join(tmpdir(), "vitals-existing-"))
  mkdirSync(join(existingRoot, "opencode", "plugins"), { recursive: true })
  const existingDir = resolvePluginsDir({ env: { XDG_CONFIG_HOME: existingRoot }, home: "/home/someone" })
  check("XDG wins even over an existing directory", existingDir === join(existingRoot, "opencode", "plugins"), existingDir)
  rmSync(existingRoot, { recursive: true, force: true })
  // Windows uses the same .config path: APPDATA is where the Electron app keeps
  // its own state, not where OpenCode reads plugins.
  const windowsDir = resolvePluginsDir({ env: { APPDATA: "C:\\Users\\x\\AppData\\Roaming" }, home: "C:\\Users\\x" })
  check("windows uses ~/.config too", windowsDir.replace(/\\/g, "/") === "C:/Users/x/.config/opencode/plugins", windowsDir)
  const macDir = resolvePluginsDir({ env: {}, home: "/Users/someone" })
  check("macos uses ~/.config too", macDir === "/Users/someone/.config/opencode/plugins", macDir)
  for (const directory of [plugins, other, linked, forced, stranger]) rmSync(directory, { recursive: true, force: true })
}




// 27. A compaction that fails must not mute the session. This is the scenario
// the audit measured: the next response produced zero records.
{
  const sessionID = `ses_compact${unique.slice(0, 15)}`
  const at = base + 10_000
  const { storage, cleanup } = await run([
    envelope("session.compaction.started", { sessionID }, at),
    envelope("session.compaction.failed", { sessionID, error: "cancelled" }, at + 5),
    envelope("session.inbox.enqueued", { sessionID, inboxID: "inb_c1", item: { type: "user" } }, at + 100),
    envelope("session.execution.started", { sessionID }, at + 110),
    envelope("session.step.started", { sessionID, assistantMessageID: "msg_c1", model: { id: "m1", providerID: "p1" }, started: at + 120 }, at + 120),
    envelope("session.text.delta", { sessionID, assistantMessageID: "msg_c1", ordinal: 0, delta: "after the compaction" }, at + 200),
    envelope("session.step.ended", { sessionID, assistantMessageID: "msg_c1", tokens: { output: 12, reasoning: 1 } }, at + 300),
    envelope("session.execution.succeeded", { sessionID }, at + 400),
  ])
  const record = await waitForRecord(storage)
  check("a response after a failed compaction is measured", record.sessionID === sessionID && record.outputTokens === 12, JSON.stringify({ session: record.sessionID, tokens: record.outputTokens }))
  cleanup()
}

// 28. A compaction that runs inside an execution is still not a response, and
// the session recovers for the one after it.
{
  const sessionID = `ses_compact2${unique.slice(0, 14)}`
  const at = base + 20_000
  const { storage, cleanup } = await run([
    envelope("session.execution.started", { sessionID }, at),
    envelope("session.compaction.started", { sessionID }, at + 10),
    envelope("session.compaction.ended", { sessionID }, at + 20),
    envelope("session.step.started", { sessionID, assistantMessageID: "msg_k1", started: at + 30 }, at + 30),
    envelope("session.text.delta", { sessionID, assistantMessageID: "msg_k1", ordinal: 0, delta: "summary only" }, at + 100),
    envelope("session.step.ended", { sessionID, assistantMessageID: "msg_k1", tokens: { output: 99 } }, at + 200),
    envelope("session.execution.succeeded", { sessionID }, at + 300),
    envelope("session.inbox.enqueued", { sessionID, inboxID: "inb_k2", item: { type: "user" } }, at + 400),
    envelope("session.execution.started", { sessionID }, at + 410),
    envelope("session.step.started", { sessionID, assistantMessageID: "msg_k2", started: at + 420 }, at + 420),
    envelope("session.text.delta", { sessionID, assistantMessageID: "msg_k2", ordinal: 0, delta: "the real answer" }, at + 500),
    envelope("session.step.ended", { sessionID, assistantMessageID: "msg_k2", tokens: { output: 7 } }, at + 600),
    envelope("session.execution.succeeded", { sessionID }, at + 700),
  ])
  const record = await waitForRecord(storage)
  const records = storage.value?.records ?? []
  check("only the real answer is counted", records.length === 1 && record.messageID === "msg_k2", JSON.stringify(records.map((item) => item.messageID)))
  cleanup()
}

// 29. A synthetic item no longer mutes the session for the next user prompt.
{
  const sessionID = `ses_synth${unique.slice(0, 16)}`
  const at = base + 30_000
  const { storage, cleanup } = await run([
    envelope("session.inbox.enqueued", { sessionID, inboxID: "inb_syn", item: { type: "synthetic" } }, at),
    envelope("session.inbox.delivered", { sessionID, inboxID: "inb_syn" }, at + 10),
    envelope("session.inbox.enqueued", { sessionID, inboxID: "inb_real", item: { type: "user" } }, at + 100),
    envelope("session.execution.started", { sessionID }, at + 110),
    envelope("session.step.started", { sessionID, assistantMessageID: "msg_real", started: at + 120 }, at + 120),
    envelope("session.text.delta", { sessionID, assistantMessageID: "msg_real", ordinal: 0, delta: "the real one" }, at + 200),
    envelope("session.step.ended", { sessionID, assistantMessageID: "msg_real", tokens: { output: 5 } }, at + 300),
    envelope("session.execution.succeeded", { sessionID }, at + 400),
  ])
  const record = await waitForRecord(storage)
  check("a user prompt after a synthetic item is measured", record.messageID === "msg_real", JSON.stringify(record.messageID))
  cleanup()
}

// 30. One malformed event must not stop every later measurement.
{
  const sessionID = `ses_hostile${unique.slice(0, 14)}`
  const at = base + 40_000
  const poisoned = envelope("session.text.delta", { sessionID, assistantMessageID: "msg_bad", ordinal: 0, delta: "boom" }, at)
  Object.defineProperty(poisoned, "properties", {
    configurable: true,
    get() {
      throw new Error("hostile event")
    },
  })
  const { storage, cleanup } = await run([
    poisoned,
    envelope("session.inbox.enqueued", { sessionID, inboxID: "inb_h1", item: { type: "user" } }, at + 100),
    envelope("session.execution.started", { sessionID }, at + 110),
    envelope("session.step.started", { sessionID, assistantMessageID: "msg_after", started: at + 120 }, at + 120),
    envelope("session.text.delta", { sessionID, assistantMessageID: "msg_after", ordinal: 0, delta: "still alive" }, at + 200),
    envelope("session.step.ended", { sessionID, assistantMessageID: "msg_after", tokens: { output: 3 } }, at + 300),
    envelope("session.execution.succeeded", { sessionID }, at + 400),
  ])
  const record = await waitForRecord(storage)
  check("measurement survives a hostile event", record.messageID === "msg_after", JSON.stringify(record.messageID))
  cleanup()
}

// 31. npm runs a bin through a symlink in node_modules/.bin, so argv[1] is the
// link while the module URL is the target. Comparing them as strings made the
// command exit silently — this is the regression test for that.
{
  const bin = mkdtempSync(join(tmpdir(), "vitals-shim-"))
  if (process.platform !== "win32") {
    const cliLink = join(bin, "opencode-vitals")
    const installLink = join(bin, "opencode-vitals-install")
    symlinkSync(new URL("../cli.mjs", import.meta.url).pathname, cliLink)
    symlinkSync(new URL("../install.mjs", import.meta.url).pathname, installLink)
    const help = spawnSync(process.execPath, [cliLink, "--help"], { encoding: "utf8" })
    check("the package-named command answers", help.status === 0 && (help.stdout ?? "").includes("npx opencode-vitals install"), JSON.stringify({ status: help.status, stdout: (help.stdout ?? "").slice(0, 60) }))
    const shimmed = spawnSync(process.execPath, [installLink, "--status", "--dir", join(bin, "plugins")], { encoding: "utf8" })
    check("the old name still runs through a shim", shimmed.status === 0 && (shimmed.stdout ?? "").includes("not installed"), JSON.stringify({ status: shimmed.status, stdout: (shimmed.stdout ?? "").slice(0, 60) }))
    const piped = spawnSync("sh", ["-c", `${JSON.stringify(process.execPath)} ${JSON.stringify(cliLink)} --help | head -1`], { encoding: "utf8" })
    check("a closed pipe is quiet", piped.status === 0 && !(piped.stderr ?? "").includes("EPIPE"), JSON.stringify({ status: piped.status, stderr: (piped.stderr ?? "").slice(0, 80) }))
  }
  rmSync(bin, { recursive: true, force: true })
}

// 32. Session totals are one snapshot, ranked and replaced whole.
{
  const { snapshotRank, newerSnapshot } = vitalsInternals
  const older = { turns: 2, generatedTokens: 20, activeStreamMs: 1000, updatedAt: "2026-01-01T00:00:00.000Z" }
  const newer = { turns: 3, generatedTokens: 30, activeStreamMs: 1500, updatedAt: "2026-01-02T00:00:00.000Z" }
  check("more turns is further along", newerSnapshot(older, newer) === newer)
  check("fewer turns never wins", newerSnapshot(newer, older) === newer)
  // Equal turn counts: the timestamp is the tie-break, so a second write of the
  // same turn count still replaces the record.
  const sameTurns = { ...older, generatedTokens: 40, updatedAt: "2026-01-03T00:00:00.000Z" }
  check("the timestamp breaks a turn tie", newerSnapshot(older, sameTurns) === sameTurns)
  check("a tie without a timestamp keeps the incumbent", newerSnapshot(sameTurns, { ...older, updatedAt: undefined }) === sameTurns)
  check("junk is not a snapshot", snapshotRank("nope") === null && snapshotRank(null) === null, JSON.stringify(snapshotRank("nope")))
  check("a rank is comparable", JSON.stringify(snapshotRank(newer)) > JSON.stringify(snapshotRank(older)), JSON.stringify([snapshotRank(older), snapshotRank(newer)]))
}

// 33. Logging is opt-in; a warning is not.
{
  const quiet = vitalsInternals.normalizeOptions({})
  check("log is off by default", quiet.log === false && quiet.enabled === true && quiet.popup === true, JSON.stringify(quiet))
  check("log can be turned on", vitalsInternals.normalizeOptions({ log: true }).log === true)
  check("only true turns logging on", vitalsInternals.normalizeOptions({ log: "yes" }).log === false && vitalsInternals.normalizeOptions({ log: 1 }).log === false)
  check("popup can still be turned off", vitalsInternals.normalizeOptions({ popup: false }).popup === false)
}

// 34. A stream that stops for half a minute and comes back was interrupted, so
// the silence must not land in the denominator of tok/s.
{
  const gapSession = `ses_gap${unique}`
  const t = base
  const events = [
    envelope("session.execution.started", { sessionID: gapSession }, t),
    envelope("session.text.started", { sessionID: gapSession, assistantMessageID: "msg_gap", ordinal: 0 }, t + 10),
    envelope("session.text.delta", { sessionID: gapSession, assistantMessageID: "msg_gap", ordinal: 0, delta: "start" }, t + 100),
    envelope("session.text.delta", { sessionID: gapSession, assistantMessageID: "msg_gap", ordinal: 0, delta: "resumed" }, t + 100 + 40_000),
    envelope("session.text.delta", { sessionID: gapSession, assistantMessageID: "msg_gap", ordinal: 0, delta: "!" }, t + 100 + 41_000),
    envelope("session.step.ended", { sessionID: gapSession, assistantMessageID: "msg_gap", tokens: { output: 10, reasoning: 0, cache: {} } }, t + 100 + 41_100),
    envelope("session.execution.succeeded", { sessionID: gapSession }, t + 100 + 42_000),
  ]
  const { storage, cleanup } = await run(events)
  const record = await waitForRecord(storage, (item) => item.sessionID === gapSession)
  check("the silence is not stream time", record.activeStreamMs === 1000, JSON.stringify(record.activeStreamMs))
  check("an interrupted stream still has a rate", record.rateSource === "stream-span" && Math.abs((record.tokensPerSecond ?? 0) - 10) < 0.001, JSON.stringify([record.rateSource, record.tokensPerSecond]))
  check("the wall clock still sees the whole turn", record.totalMs >= 41_000, JSON.stringify(record.totalMs))
  cleanup()
}

// 35. An event this plugin does not know is counted and reported, never dropped
// in silence — a renamed event would otherwise delete measurements invisibly.
{
  const unknownSession = `ses_unknown${unique}`
  const events = [
    envelope("session.execution.started", { sessionID: unknownSession }, base),
    envelope("session.text.delta", { sessionID: unknownSession, assistantMessageID: "msg_unk", ordinal: 0, delta: "hi" }, base + 100),
    envelope("session.step.ended", { sessionID: unknownSession, assistantMessageID: "msg_unk", tokens: { output: 4 } }, base + 150),
    envelope("session.renamed.event", { sessionID: unknownSession }, base + 160),
    envelope("session.renamed.event", { sessionID: unknownSession }, base + 170),
    envelope("session.execution.succeeded", { sessionID: unknownSession }, base + 200),
  ]
  const { storage, cleanup } = await run(events)
  const record = await waitForRecord(storage, (item) => item.sessionID === unknownSession)
  check("an unknown event is counted on the record", record.unknownEventTypes === "session.renamed.event×2", JSON.stringify(record.unknownEventTypes))
  check("an unknown event does not stop the measurement", record.messageID === "msg_unk" && record.outputTokens === 4, JSON.stringify([record.messageID, record.outputTokens]))
  check("unknown types are declared as a set", vitalsInternals.HANDLED_TYPES.has("session.text.delta") && !vitalsInternals.HANDLED_TYPES.has("session.renamed.event"))
  cleanup()
}

// 36. Two executions running at once in one session are two turns. Merging them
// reported a single turn that never happened and mixed one agent's tokens into
// another's total.
{
  const parallelSession = `ses_parallel${unique}`
  const events = [
    envelope("session.execution.started", { sessionID: parallelSession }, base),
    envelope("session.text.started", { sessionID: parallelSession, assistantMessageID: "msg_p1", ordinal: 0 }, base + 10),
    envelope("session.text.delta", { sessionID: parallelSession, assistantMessageID: "msg_p1", ordinal: 0, delta: "first answer" }, base + 100),
    envelope("session.execution.started", { sessionID: parallelSession }, base + 200),
    envelope("session.text.started", { sessionID: parallelSession, assistantMessageID: "msg_p2", ordinal: 0 }, base + 210),
    envelope("session.text.delta", { sessionID: parallelSession, assistantMessageID: "msg_p2", ordinal: 0, delta: "second answer" }, base + 300),
    envelope("session.step.ended", { sessionID: parallelSession, assistantMessageID: "msg_p2", tokens: { output: 3 } }, base + 400),
    envelope("session.execution.succeeded", { sessionID: parallelSession }, base + 500),
  ]
  const { storage, cleanup } = await run(events)
  const firstRecord = await waitForRecord(storage, (item) => item.messageID === "msg_p1")
  const secondRecord = await waitForRecord(storage, (item) => item.messageID === "msg_p2")
  check("the first execution is measured on its own", firstRecord.characterCount === 12, JSON.stringify(firstRecord.characterCount))
  check("the second execution is measured on its own", secondRecord.characterCount === 13 && secondRecord.outputTokens === 3, JSON.stringify([secondRecord.characterCount, secondRecord.outputTokens]))
  check("parallel work is two turns, not one", firstRecord.id !== secondRecord.id, JSON.stringify([firstRecord.id, secondRecord.id]))
  check("session turns count both", secondRecord.sessionTotals?.turns === 2, JSON.stringify(secondRecord.sessionTotals))
  cleanup()
}

// 37. The status directory sits in a shared temporary directory, so it belongs
// to its owner alone.
{
  const statusDir = join(SUITE_TMP, "opencode-latency-monitor")
  const mode = statSync(statusDir).mode & 0o777
  check("the status directory is private", mode === 0o700, mode.toString(8))
}


// 40. Per-turn logging is off unless it is asked for; a warning is not.
{
  const lines = []
  const app = { log: (entry) => { lines.push(entry?.body ?? {}) } }
  const noisySession = `ses_log${unique}`
  const events = [
    envelope("session.execution.started", { sessionID: noisySession }, base),
    envelope("session.text.delta", { sessionID: noisySession, assistantMessageID: "msg_log", ordinal: 0, delta: "hi" }, base + 100),
    envelope("session.step.ended", { sessionID: noisySession, assistantMessageID: "msg_log", tokens: { output: 2 } }, base + 150),
    envelope("session.something.new", { sessionID: noisySession }, base + 160),
    envelope("session.execution.succeeded", { sessionID: noisySession }, base + 200),
  ]
  const { storage, cleanup } = await run(events, { app })
  const record = await waitForRecord(storage, (item) => item.sessionID === noisySession)
  await wait(50)
  check("a measurement is not logged by default", !lines.some((line) => line.level === "info"), JSON.stringify(lines))
  check("a warning is logged whatever the option says", lines.some((line) => line.level === "warn" && String(line.message).includes("unknown type")), JSON.stringify(lines))
  check("the warning names the plugin", lines.every((line) => String(line.service ?? "").startsWith("opencode-vitals")), JSON.stringify(lines))
  check("the measurement itself was not silenced", record.messageID === "msg_log", JSON.stringify(record.messageID))
  cleanup()

  const loudLines = []
  const loudApp = { log: (entry) => { loudLines.push(entry?.body ?? {}) } }
  // A different session and message: the response marker for the first run
  // already exists, and a second claim of the same response is correctly
  // refused — which would also refuse the log line this half of the test is
  // about.
  const loudSession = `ses_logloud${unique}`
  const loudEvents = [
    envelope("session.execution.started", { sessionID: loudSession }, base),
    envelope("session.text.delta", { sessionID: loudSession, assistantMessageID: "msg_log_loud", ordinal: 0, delta: "hi" }, base + 100),
    envelope("session.step.ended", { sessionID: loudSession, assistantMessageID: "msg_log_loud", tokens: { output: 2 } }, base + 150),
    envelope("session.execution.succeeded", { sessionID: loudSession }, base + 200),
  ]
  const loud = await run(loudEvents, { app: loudApp, pluginOptions: { log: true } })
  await waitForRecord(loud.storage, (item) => item.sessionID === loudSession)
  await wait(50)
  check("logging can be turned on", loudLines.some((line) => line.level === "info" && String(line.message).includes("session=")), JSON.stringify(loudLines))
  loud.cleanup()
}

// 41. A step's output is text, thinking and tool call together, and its tokens
// cover all three. Counting the tool call's tokens while ignoring the time the
// model spent writing them is what printed 4686 tok/s on a real turn.
{
  const toolSession = `ses_tool${unique}`
  const t = base
  const events = [
    envelope("session.execution.started", { sessionID: toolSession }, t),
    envelope("session.step.started", { sessionID: toolSession, assistantMessageID: "msg_tool", agent: "build" }, t + 10),
    envelope("session.text.delta", { sessionID: toolSession, assistantMessageID: "msg_tool", ordinal: 0, delta: "Let me " }, t + 100),
    envelope("session.text.delta", { sessionID: toolSession, assistantMessageID: "msg_tool", ordinal: 0, delta: "check" }, t + 150),
    envelope("session.tool.input.started", { sessionID: toolSession, assistantMessageID: "msg_tool", id: "call_1", name: "bash" }, t + 200),
    envelope("session.tool.input.delta", { sessionID: toolSession, assistantMessageID: "msg_tool", id: "call_1", delta: '{"comm' }, t + 300),
    envelope("session.tool.input.delta", { sessionID: toolSession, assistantMessageID: "msg_tool", id: "call_1", delta: 'and":"ls"}' }, t + 900),
    envelope("session.tool.input.ended", { sessionID: toolSession, assistantMessageID: "msg_tool", id: "call_1", text: '{"command":"ls"}' }, t + 950),
    envelope("session.tool.called", { sessionID: toolSession, assistantMessageID: "msg_tool", id: "call_1", input: { command: "ls" }, executed: true, state: {} }, t + 1000),
    envelope("session.step.ended", { sessionID: toolSession, assistantMessageID: "msg_tool", tokens: { output: 200, reasoning: 0, cache: {} } }, t + 1200),
    envelope("session.execution.succeeded", { sessionID: toolSession }, t + 1300),
  ]
  const { storage, cleanup } = await run(events)
  const record = await waitForRecord(storage, (item) => item.sessionID === toolSession)
  // Text streamed for 50ms, then the model wrote the call's arguments for
  // another 750ms. Both are the model generating, so both are in the span.
  check("writing a tool call counts as model time", record.activeStreamMs === 850, JSON.stringify(record.activeStreamMs))
  check("the rate is not the tokens divided by the text alone", Math.abs((record.tokensPerSecond ?? 0) - 200 / 0.85) < 0.01, JSON.stringify(record.tokensPerSecond))
  check("the arguments are counted as characters", record.toolArgCharacters === 16 && record.toolArgDeltaCount === 2, JSON.stringify([record.toolArgCharacters, record.toolArgDeltaCount]))
  check("the text count stays text", record.characterCount === 12, JSON.stringify(record.characterCount))
  check("characters per second covers what the model wrote", Math.abs((record.observedCharactersPerSecond ?? 0) - 28 / 0.85) < 0.01, JSON.stringify(record.observedCharactersPerSecond))
  check("running the tool is not measured as model time", record.unknownEventTypes === "", JSON.stringify(record.unknownEventTypes))
  cleanup()
}

// 42. A step whose whole output is a tool call has no text and no thinking at
// all. That used to be a turn with no measurable stream, so its tokens made the
// average meaningless.
{
  const onlySession = `ses_onlytool${unique}`
  const events = [
    envelope("session.execution.started", { sessionID: onlySession }, base),
    envelope("session.step.started", { sessionID: onlySession, assistantMessageID: "msg_only", agent: "build" }, base + 10),
    envelope("session.tool.input.delta", { sessionID: onlySession, assistantMessageID: "msg_only", id: "call_2", delta: '{"path":"a.txt"}' }, base + 100),
    envelope("session.tool.input.delta", { sessionID: onlySession, assistantMessageID: "msg_only", id: "call_2", delta: '{"more":true}' }, base + 600),
    envelope("session.tool.input.ended", { sessionID: onlySession, assistantMessageID: "msg_only", id: "call_2", text: '{"path":"a.txt","more":true}' }, base + 650),
    envelope("session.step.ended", { sessionID: onlySession, assistantMessageID: "msg_only", tokens: { output: 150, reasoning: 0, cache: {} } }, base + 700),
    envelope("session.execution.succeeded", { sessionID: onlySession }, base + 800),
  ]
  const { storage, cleanup } = await run(events)
  const record = await waitForRecord(storage, (item) => item.sessionID === onlySession)
  check("a tool call alone is model output", record.activeStreamMs === 550 && record.rateSource === "stream-span", JSON.stringify([record.activeStreamMs, record.rateSource]))
  check("a tool call alone gets a real rate", Math.abs((record.tokensPerSecond ?? 0) - 150 / 0.55) < 0.01, JSON.stringify(record.tokensPerSecond))
  check("the first token is when the model started writing it", record.firstTokenMs === 100, JSON.stringify(record.firstTokenMs))
  check("no text was invented for it", record.characterCount === 0 && record.deltaCount === 0, JSON.stringify([record.characterCount, record.deltaCount]))
  cleanup()
}

// 43. The wall time of a single message is only a rate when that message is the
// whole turn. A turn that ran tools gets no rate instead of a flattering one.
{
  const gateSession = `ses_gate${unique}`
  const multiStep = [
    envelope("session.execution.started", { sessionID: gateSession }, base),
    envelope("session.step.started", { sessionID: gateSession, assistantMessageID: "msg_gate", ordinal: 0 }, base + 10),
    envelope("session.text.delta", { sessionID: gateSession, assistantMessageID: "msg_gate", ordinal: 0, delta: "one piece" }, base + 100),
    envelope("session.step.ended", { sessionID: gateSession, assistantMessageID: "msg_gate", tokens: { output: 40 } }, base + 150),
    envelope("session.step.ended", { sessionID: gateSession, assistantMessageID: "msg_gate2", tokens: { output: 60 } }, base + 60_000),
    envelope("session.execution.succeeded", { sessionID: gateSession }, base + 60_100),
  ]
  const gated = await run(multiStep)
  const gatedRecord = await waitForRecord(gated.storage, (item) => item.sessionID === gateSession)
  check("no wall-clock rate for a tool-using turn", gatedRecord.tokensPerSecond === null && gatedRecord.activeStreamMs === null, JSON.stringify([gatedRecord.tokensPerSecond, gatedRecord.activeStreamMs]))
  check("and the record says why", gatedRecord.rateSource === "unavailable", gatedRecord.rateSource)
  check("the tokens are still reported", gatedRecord.generatedTokens === 100, JSON.stringify(gatedRecord.generatedTokens))
  gated.cleanup()

  const singleSession = `ses_gateone${unique}`
  const singleStep = [
    envelope("session.execution.started", { sessionID: singleSession }, base),
    envelope("session.step.started", { sessionID: singleSession, assistantMessageID: "msg_gateone", ordinal: 0 }, base + 10),
    envelope("session.text.delta", { sessionID: singleSession, assistantMessageID: "msg_gateone", ordinal: 0, delta: "one piece" }, base + 100),
    envelope("session.step.ended", { sessionID: singleSession, assistantMessageID: "msg_gateone", tokens: { output: 40 } }, base + 150),
    envelope("session.execution.succeeded", { sessionID: singleSession }, base + 200),
  ]
  const single = await run(singleStep)
  const singleRecord = await waitForRecord(single.storage, (item) => item.sessionID === singleSession)
  check("a one-piece one-step answer still gets its wall-clock rate", singleRecord.rateSource === "single-message-total" && singleRecord.activeStreamMs === 100, JSON.stringify([singleRecord.rateSource, singleRecord.activeStreamMs]))
  single.cleanup()
}

// 44. The bar's second number: the average of the last ten responses, kept in
// the session totals so it survives a reload and travels with the snapshot.
{
  const recentSession = `ses_recent${unique}`
  const events = []
  for (let index = 1; index <= 12; index += 1) {
    const at = base + index * 1000
    events.push(
      envelope("session.execution.started", { sessionID: recentSession }, at),
      envelope("session.text.delta", { sessionID: recentSession, assistantMessageID: `msg_r${index}`, ordinal: 0, delta: "x" }, at + 100),
      envelope("session.step.ended", { sessionID: recentSession, assistantMessageID: `msg_r${index}`, tokens: { output: index * 10 } }, at + 200),
      envelope("session.execution.succeeded", { sessionID: recentSession }, at + 300),
    )
  }
  const { storage, cleanup } = await run(events)
  const record = await waitForRecord(storage, (item) => item.assistantMessageID === "msg_r12" || item.messageID === "msg_r12")
  const rates = record.sessionTotals?.recentRates ?? []
  check("each response leaves its rate in the session totals", record.sessionTotals?.turns === 12 && rates.length === 10, JSON.stringify([record.sessionTotals?.turns, rates.length]))
  // Each turn was one short message, so its rate is its tokens over 100ms:
  // 10..120 tokens => 100..1200 tok/s. The oldest two fell off the end.
  check("only the last ten are kept", Math.abs(rates[0] - 300) < 0.01 && Math.abs(rates[9] - 1200) < 0.01, JSON.stringify(rates))
  check("the rates are newest last", rates.every((rate, index) => index === 0 || rate > rates[index - 1]), JSON.stringify(rates))
  cleanup()
}

// 45. A response with no honest rate is skipped instead of counted as zero, so
// it cannot drag the last-ten average down.
{
  const mixedSession = `ses_mixed${unique}`
  const events = [
    envelope("session.execution.started", { sessionID: mixedSession }, base),
    envelope("session.text.delta", { sessionID: mixedSession, assistantMessageID: "msg_m1", ordinal: 0, delta: "first" }, base + 100),
    envelope("session.step.ended", { sessionID: mixedSession, assistantMessageID: "msg_m1", tokens: { output: 50 } }, base + 150),
    envelope("session.execution.succeeded", { sessionID: mixedSession }, base + 200),
    // Two steps, no measurable stream: the record reports no rate at all.
    envelope("session.execution.started", { sessionID: mixedSession }, base + 1000),
    envelope("session.step.ended", { sessionID: mixedSession, assistantMessageID: "msg_m2", tokens: { output: 70 } }, base + 60_000),
    envelope("session.step.ended", { sessionID: mixedSession, assistantMessageID: "msg_m3", tokens: { output: 30 } }, base + 61_000),
    envelope("session.execution.succeeded", { sessionID: mixedSession }, base + 62_000),
  ]
  const { storage, cleanup } = await run(events)
  const record = await waitForRecord(storage, (item) => item.sessionTotals?.turns === 2)
  const rates = record.sessionTotals?.recentRates ?? []
  check("a rate-less response is not a zero", rates.length === 1, JSON.stringify(rates))
  check("its tokens are still in the session", record.sessionTotals?.generatedTokens === 150, JSON.stringify(record.sessionTotals))
  cleanup()
}

// 46. A restart resumes from the totals file, not only from a capped history.
// History keeps twenty records across all sessions, so a plugin that rebuilt
// its view from that alone came back behind the totals it had already
// published — and the bar kept showing the older snapshot, last-ten list and
// all, until the rebuilt count caught up.
{
  const resumeSession = `ses_resume${unique}`
  const totalsPath = join(SUITE_TMP, "opencode-latency-monitor", "session-totals.json")
  const previousTotals = existsSync(totalsPath) ? readFileSync(totalsPath, "utf8") : null
  writeFileSync(totalsPath, JSON.stringify({
    version: 1,
    sessions: {
      [resumeSession]: {
        turns: 7,
        steps: 90,
        outputTokens: 7000,
        reasoningTokens: 1000,
        generatedTokens: 8000,
        activeStreamMs: 40000,
        tokensPerSecond: 200,
        recentRates: [150, 250],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
  }))
  const events = [
    envelope("session.execution.started", { sessionID: resumeSession }, base),
    envelope("session.text.started", { sessionID: resumeSession, assistantMessageID: "msg_resume", ordinal: 0 }, base + 10),
    envelope("session.text.delta", { sessionID: resumeSession, assistantMessageID: "msg_resume", ordinal: 0, delta: "back" }, base + 100),
    envelope("session.step.ended", { sessionID: resumeSession, assistantMessageID: "msg_resume", tokens: { output: 30 } }, base + 150),
    envelope("session.execution.succeeded", { sessionID: resumeSession }, base + 200),
  ]
  const { storage, cleanup } = await run(events)
  const record = await waitForRecord(storage, (item) => item.sessionID === resumeSession)
  check("a restart continues the published totals", record.sessionTotals?.turns === 8 && record.sessionTotals?.steps === 91, JSON.stringify(record.sessionTotals))
  check("the tokens of the previous run are still there", record.sessionTotals?.generatedTokens === 8030, JSON.stringify(record.sessionTotals?.generatedTokens))
  const resumedRates = record.sessionTotals?.recentRates ?? []
  check("the last-ten list resumes from the file", resumedRates.length === 3 && resumedRates[0] === 150 && resumedRates[1] === 250, JSON.stringify(resumedRates))
  cleanup()
  if (previousTotals !== null) writeFileSync(totalsPath, previousTotals)
  else rmSync(totalsPath, { force: true })
}

// A subagent runs as a child session, so its events carry the child's id and the
// session that asked for it never saw the work. The link is real and it is in
// the session record; these cases pin that following it counts the work in the
// parent, and that the parent's rate does not claim a speed it never ran at.
{
  const parent = `ses_parent${unique.slice(0, 14)}`
  const child = `ses_child${unique.slice(0, 14)}`
  const childEvents = [
    envelope("session.execution.started", { sessionID: child }, base + 10),
    envelope("session.step.started", { sessionID: child, assistantMessageID: "msg_c1", agent: "general" }, base + 20),
    envelope("session.text.delta", { sessionID: child, assistantMessageID: "msg_c1", delta: "working" }, base + 100),
    envelope("session.step.ended", { sessionID: child, assistantMessageID: "msg_c1", tokens: { output: 500 } }, base + 300),
    envelope("session.step.started", { sessionID: child, assistantMessageID: "msg_c2", agent: "general" }, base + 320),
    envelope("session.text.delta", { sessionID: child, assistantMessageID: "msg_c2", delta: "more" }, base + 420),
    envelope("session.step.ended", { sessionID: child, assistantMessageID: "msg_c2", tokens: { output: 700 } }, base + 600),
    envelope("session.execution.succeeded", { sessionID: child }, base + 700),
  ]
  // popup on, because the credit is published in the totals file the readout
  // reads. The port and the app path were set once, before the import.
  const { storage, cleanup } = await run(childEvents, {
    sessions: { [child]: { id: child, parentID: parent } },
    pluginOptions: { popup: true },
  })
  const record = await waitForRecord(storage, (item) => item.sessionID === child)
  await wait(300)
  check("the subagent record names its parent", record.parentSessionID === parent, JSON.stringify(record.parentSessionID))
  check("the subagent still counts on its own session", record.sessionTotals?.turns === 1 && record.sessionTotals?.steps === 2, JSON.stringify(record.sessionTotals))
  check("the subagent has no delegated counters", record.sessionTotals?.subagentTurns === 0, JSON.stringify(record.sessionTotals?.subagentTurns))
  const totalsPath = vitalsInternals.SESSION_TOTALS_FILE
  const previous = existsSync(totalsPath) ? readFileSync(totalsPath, "utf8") : null
  const onDisk = JSON.parse(readFileSync(totalsPath, "utf8"))
  const parentTotals = onDisk.sessions?.[parent]
  check("the parent is credited with the delegated steps", parentTotals?.steps === 2, JSON.stringify(parentTotals))
  check("the parent is credited with the delegated tokens", parentTotals?.outputTokens === 1200, JSON.stringify(parentTotals?.outputTokens))
  check("the delegated work is counted apart", parentTotals?.subagentTurns === 1 && parentTotals?.subagentSteps === 2, JSON.stringify(parentTotals))
  check("the parent took no turns of its own", parentTotals?.turns === 0, JSON.stringify(parentTotals?.turns))
  // The trap this shape exists to avoid: 1200 tokens with none of the subagent's
  // stream time would print a speed the parent never produced.
  check("the parent's rate does not claim the subagent's speed", parentTotals?.tokensPerSecond === null, JSON.stringify(parentTotals?.tokensPerSecond))
  check("the parent's stream time is untouched", parentTotals?.activeStreamMs === 0, JSON.stringify(parentTotals?.activeStreamMs))
  check("the parent's last-ten list is untouched", (parentTotals?.recentRates ?? []).length === 0, JSON.stringify(parentTotals?.recentRates))
  cleanup()
  if (previous !== null) writeFileSync(totalsPath, previous)
  else rmSync(totalsPath, { force: true })
}

// The readout: reading the app's bundle, injecting beside it, and cleaning up.
// None of this needs the app to be installed, so the reader is exercised against
// a bundle written by the test itself, in the documented format.
{
  const { readoutInternals, syncRenderer, installDesktopEntry, removeDesktopEntry } = await import("../readout.mjs")
  const { openAsar, injectTag, markedEntryBody, appBinary, SCRIPT_TAG } = readoutInternals

  // -- the asar format --------------------------------------------------------
  // A bundle is a 16-byte header, then a JSON directory, then the file data. The
  // test writes one so the reader is proven against the format rather than
  // against the app on this machine, which may not be there.
  const encodeAsar = (tree) => {
    const json = Buffer.from(JSON.stringify({ files: tree }), "utf8")
    const padding = (4 - (json.length % 4)) % 4
    const headerSize = 8 + json.length + padding
    const header = Buffer.alloc(16)
    header.writeUInt32LE(4, 0)
    header.writeUInt32LE(headerSize, 4)
    header.writeUInt32LE(json.length + padding, 8)
    header.writeUInt32LE(json.length, 12)
    return { header, json, base: 8 + headerSize, padding }
  }
  const page = Buffer.from("<!doctype html><script type=\"module\" crossorigin src=\"./assets/main-abc123.js\"></script></html>")
  const { header, json, base, padding } = encodeAsar({
    out: { files: { renderer: { files: {
      "index.html": { size: page.length, offset: "0" },
      assets: { files: { "main-abc123.js": { size: 5, offset: String(page.length) } } },
    } } } },
  })
  const bundle = join(SUITE_TMP, "fake.asar")
  writeFileSync(bundle, Buffer.concat([header, json, Buffer.alloc(padding), page, Buffer.from("hello")]))

  const asar = openAsar(bundle)
  check("asar: a file reads back byte for byte", asar.read(["out", "renderer", "index.html"])?.equals(page) === true)
  check("asar: a directory is told from a file", asar.isDir(["out", "renderer", "assets"]) === true && asar.isDir(["out", "renderer", "index.html"]) === false)
  check("asar: a directory lists its children", asar.list(["out", "renderer", "assets"]).join() === "main-abc123.js", JSON.stringify(asar.list(["out", "renderer", "assets"])))
  check("asar: a nested file reads back", asar.read(["out", "renderer", "assets", "main-abc123.js"])?.toString() === "hello")
  check("asar: a missing path is not an error", asar.read(["out", "nope"]) === null && asar.has(["out", "nope"]) === false)

  // -- injecting beside the bundle -------------------------------------------
  check("injection: the tag lands beside the app's bundle", injectTag(page).includes(SCRIPT_TAG))
  check("injection: the app's own bundle is untouched", injectTag(page).includes("./assets/main-abc123.js"))
  check("injection: injecting twice is a no-op", (() => {
    const once = injectTag(page)
    return injectTag(Buffer.from(once)) === once
  })())
  check("injection: a page with no module bundle is refused, not guessed at", injectTag(Buffer.from("<html></html>")) === null)

  // -- the launcher entry -----------------------------------------------------
  // Ours is a copy of the system entry with Exec changed, so the packager's icon,
  // WM class and deep-link handler survive. Rebuilding the file instead loses
  // exactly the details that make a launcher work.
  const system = { name: "ai.opencode.desktop.desktop", exec: "/opt/OpenCode/ai.opencode.desktop %U", body: "[Desktop Entry]\nName=OpenCode\nExec=/opt/OpenCode/ai.opencode.desktop %U\nIcon=ai.opencode.desktop\nStartupWMClass=ai.opencode.desktop\n" }
  const marked = markedEntryBody(system, appBinary(system, "/opt/OpenCode/resources/app.asar"))
  check("launcher: Exec points at the readout server", marked.includes(`Exec=env ELECTRON_RENDERER_URL=http://127.0.0.1:${readoutInternals.PORT} /opt/OpenCode/ai.opencode.desktop %U`), marked.split("\n")[2])
  check("launcher: the icon is carried over", marked.includes("Icon=ai.opencode.desktop"))
  check("launcher: the WM class is carried over", marked.includes("StartupWMClass=ai.opencode.desktop"))
  check("launcher: it is marked as ours", marked.includes("X-OpenCode-Vitals=readout"))
  check("launcher: the system entry is not edited", system.body.includes("Exec=/opt/OpenCode/ai.opencode.desktop %U") && !system.body.includes("ELECTRON_RENDERER_URL"))

  // -- and it is all optional -------------------------------------------------
  // No app on the machine is a fact, not a failure: the measurement is
  // unaffected, so the sync says so and the plugin keeps working.
  const previousApp = process.env.OPENCODE_DESKTOP_APP
  process.env.OPENCODE_DESKTOP_APP = join(SUITE_TMP, "there-is-no-app.asar")
  const missing = syncRenderer({ force: true })
  check("no app is reported, not thrown", missing.ok === false && typeof missing.reason === "string", JSON.stringify(missing))
  check("a missing app installs no launcher", installDesktopEntry().ok === false)
  check("a missing app removes nothing", removeDesktopEntry().ok === false)
  if (previousApp === undefined) delete process.env.OPENCODE_DESKTOP_APP
  else process.env.OPENCODE_DESKTOP_APP = previousApp
}

// The readout answers for the session it is asked about and no other. Several
// projects share the status directory, so a readout that guessed would show one
// project's numbers under another's name.
//
// Asked over the real server rather than by calling a function, because the
// server is what the app's window actually talks to.
{
  const { storage, cleanup } = await run([
    envelope("session.execution.started", { sessionID: "ses_readA" }, base + 10),
    envelope("session.step.started", { sessionID: "ses_readA", assistantMessageID: "msg_r1" }, base + 20),
    envelope("session.text.delta", { sessionID: "ses_readA", assistantMessageID: "msg_r1", delta: "x" }, base + 100),
    envelope("session.step.ended", { sessionID: "ses_readA", assistantMessageID: "msg_r1", tokens: { output: 25 } }, base + 200),
    envelope("session.execution.succeeded", { sessionID: "ses_readA" }, base + 300),
  ], { pluginOptions: { popup: true } })
  const record = await waitForRecord(storage, (item) => item.sessionID === "ses_readA")
  const ask = async (session) => {
    const query = session === null ? "" : `?session=${encodeURIComponent(session)}`
    const response = await fetch(`http://127.0.0.1:${READOUT_PORT}/vitals${query}`)
    return { status: response.status, body: await response.json() }
  }
  const measured = await ask("ses_readA")
  check("the readout has the measured session", measured.body.totals?.turns === 1, JSON.stringify(measured.body))
  check("the readout is told which session it answered for", measured.body.sessionID === "ses_readA")
  const unmeasured = await ask("ses_never_measured")
  check("an unmeasured session gets no numbers", unmeasured.body.totals === null, JSON.stringify(unmeasured.body))
  check("an unmeasured session still names itself", unmeasured.body.sessionID === "ses_never_measured")
  const nameless = await ask(null)
  check("a missing session id gets no numbers", nameless.body.totals === null && nameless.body.sessionID === null, JSON.stringify(nameless.body))
  const empty = await ask("")
  check("an empty session id is not a lookup", empty.body.totals === null, JSON.stringify(empty.body))
  // The list the readout averages is a copy: a caller cannot mutate the totals
  // the next reader will see.
  const first = await ask("ses_readA")
  first.body.totals.recentRates.push(9999)
  const again = await ask("ses_readA")
  check("the readout cannot write back into the totals", (again.body.totals?.recentRates?.length ?? 0) === (record.sessionTotals?.recentRates?.length ?? 0), JSON.stringify([first.body.totals?.recentRates, again.body.totals?.recentRates]))
  cleanup()
}

// A version before 0.1.8 left a bar.py running in its own process, and deleting
// its files did not stop it. The install has to, or an upgrade leaves the old
// window on screen next to the readout.
{
  const { stopLegacyBar } = await import("../install.mjs")
  const dir = mkdtempSync(join(tmpdir(), "vitals-legacy-"))
  const lock = join(dir, "popup.lock")

  check("no lock means no bar to stop", stopLegacyBar({ statusDir: dir }).stopped === false)
  writeFileSync(lock, "not json at all")
  check("a corrupt lock is not a reason to signal anything", stopLegacyBar({ statusDir: dir }).stopped === false)

  // The pid in a stale lock can belong to anything now. Signalling it would cost
  // an unrelated process, so the command line is checked before the signal.
  writeFileSync(lock, JSON.stringify({ pid: process.pid, build: 1 }))
  const recycled = stopLegacyBar({ statusDir: dir })
  check("a recycled pid is refused", recycled.stopped === false, JSON.stringify(recycled))
  check("the refusal says why", /no longer/.test(recycled.reason ?? ""), JSON.stringify(recycled))
  check("this process is still running", process.exitCode === undefined || process.exitCode === 0)

  // And a real one: a process whose command line really does name this bar.
  const victim = spawn("node", ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" })
  await wait(300)
  // Name the command line the way the check reads it, without a second process.
  writeFileSync(lock, JSON.stringify({ pid: victim.pid, build: 1 }))
  const refused = stopLegacyBar({ statusDir: dir })
  check("a process that is not this package's bar is refused", refused.stopped === false, JSON.stringify(refused))
  if (victim.exitCode === null && victim.signalCode === null) victim.kill("SIGKILL")
  rmSync(dir, { recursive: true, force: true })
}

// A reply in progress is the moment the numbers are worth watching, so the turn
// is published while it grows. These cases pin that it happens, that it is
// marked provisional, and — the trap — that it never leaks into the totals.
{
  const { storage, cleanup } = await run([
    envelope("session.viewed", { sessionID: "ses_inflight" }, base + 10),
    envelope("session.execution.started", { sessionID: "ses_inflight" }, base + 20),
    envelope("session.step.started", { sessionID: "ses_inflight", assistantMessageID: "msg_live" }, base + 30),
    envelope("session.text.delta", { sessionID: "ses_inflight", assistantMessageID: "msg_live", delta: "x".repeat(400) }, base + 1200),
    envelope("session.text.delta", { sessionID: "ses_inflight", assistantMessageID: "msg_live", delta: "y".repeat(200) }, base + 2200),
    // no execution.succeeded: the reply is deliberately still in flight
  ], { pluginOptions: { popup: true } })
  await waitForRecord(storage, (item) => item.sessionID === "ses_inflight").catch(() => null)
  await wait(1600)
  const ask = async (session) => (await fetch(`http://127.0.0.1:${READOUT_PORT}/vitals?session=${session}`)).json()

  const inFlight = await ask("ses_inflight")
  check("a reply in flight is published", inFlight.live !== null && inFlight.live.live === true, JSON.stringify(inFlight.live))
  check("it is marked live so it is never read as settled", inFlight.live?.live === true)
  check("it carries its characters so far", inFlight.live?.characterCount === 600, JSON.stringify(inFlight.live?.characterCount))
  check("it carries a rate over the real streaming span", typeof inFlight.live?.charactersPerSecond === "number" && inFlight.live.charactersPerSecond > 0, JSON.stringify(inFlight.live?.charactersPerSecond))
  // The trap: a provisional figure folded into the session's own numbers would
  // make them mean two things at once. A turn that has not ended is not counted.
  check("an unfinished reply is not in the totals", inFlight.totals === null, JSON.stringify(inFlight.totals))
  check("an unfinished reply does not add a turn", inFlight.totals?.turns === undefined || inFlight.totals.turns === 0)

  // A session with no reply in flight reports no live number, not a stale one.
  const idle = await ask("ses_nothing_here")
  check("a session with no live reply reports none", idle.live === null, JSON.stringify(idle.live))
  cleanup()
}

// The readout reports whether it found the composer, and the only place that
// report can land is the server. Before it had a handler the request fell through
// to the asset lookup and was answered with the whole index.html, once a second
// — the diagnostic for "the app renamed a slot" went nowhere and cost a page
// fetch per tick.
{
  const { serve, readoutInternals } = await import("../readout.mjs")
  const statuses = []
  const port = readoutInternals.PORT + 1
  const server = serve({
    getSession: () => ({ sessionID: null, totals: null }),
    onStatus: (entry) => statuses.push(entry),
    port,
  })
  // listen() is async and the plugin's own server already holds the default
  // port, so wait for this one rather than assuming it.
  for (let attempt = 0; attempt < 40 && !server.listening; attempt += 1) await wait(25)
  check("the readout server accepts connections", server.listening === true)
  const report = await fetch(`http://127.0.0.1:${port}/__vitals-status?placed=false&detail=composer-actions%20absent`)
  check("the status report is answered, not served as a page", report.status === 204, String(report.status))
  check("it does not return a document", !(await report.text()).includes("<!doctype"))
  check("it reaches the caller", statuses.length === 1 && statuses[0].placed === false, JSON.stringify(statuses))
  check("it carries the reason", /composer-actions/.test(statuses[0]?.detail ?? ""), JSON.stringify(statuses[0]))
  // And an asset that is genuinely missing is still a 404, not this branch.
  const missing = await fetch(`http://127.0.0.1:${port}/assets/nope-abc123.js`)
  check("a missing asset is still a 404", missing.status === 404, String(missing.status))
  await new Promise((resolve) => server.close(resolve))
}

for (const result of results) {
  console.log(`${result.ok ? "ok  " : "FAIL"} ${result.name}${result.detail ? ` ${result.detail}` : ""}`)
}
const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exit(1)
