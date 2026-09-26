import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, readFileSync, existsSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// The plugin resolves its status directory from the temporary directory when the
// module is evaluated, so the whole suite gets a sandbox before the import.
// Without this, running the tests drops response markers into the real
// ~/.cache or /tmp status directory of the person running them.
const SUITE_TMP = mkdtempSync(join(tmpdir(), "vitals-suite-"))
process.env.TMPDIR = SUITE_TMP
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
    location: { directory: `/tmp/opencode/latency-audit-${Math.random()}` },
    storage,
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
  check("seeded totals keep stream", record.sessionTotals?.activeStreamMs === 1000, JSON.stringify(record.sessionTotals))
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

// 17. Bar lifetime follows the OpenCode app, not the systemd-supervised service.
{
  const fakeProc = mkdtempSync(join(tmpdir(), "vitals-proc-"))
  const addProcess = (pid, argv) => {
    mkdirSync(join(fakeProc, pid), { recursive: true })
    const argvText = Array.isArray(argv) ? argv : [argv]
    writeFileSync(join(fakeProc, pid, "cmdline"), `${argvText.join("\0")}\0`)
    // The real /proc always has comm too, and it truncates at 15 characters:
    // "ai.opencode.desktop" appears as "ai.opencode.d" there.
    writeFileSync(join(fakeProc, pid, "comm"), `${(argvText[0] ?? "").slice(-15)}\n`)
  }
  addProcess("101", "/usr/lib/systemd/systemd")
  addProcess("102", "/opt/OpenCode/ai.opencode.desktop")
  addProcess("104", ["/opt/OpenCode/ai.opencode.desktop", "--type=zygote", "--no-zygote-sandbox"])
  check("desktop process found", vitalsInternals.scanDesktopProcess({ platform: "linux", procRoot: fakeProc }) === true)
  check("truncated comm alone is not trusted", vitalsInternals.scanDesktopProcess({ platform: "linux", procRoot: fakeProc, names: ["ai.opencode.d"] }) === false)
  addProcess("103", "/usr/bin/bash")
  check("other processes ignored", vitalsInternals.scanDesktopProcess({ platform: "linux", procRoot: fakeProc, names: ["nothing-here"] }) === false)
  check("unreadable proc root keeps bar", vitalsInternals.scanDesktopProcess({ platform: "linux", procRoot: join(fakeProc, "missing") }) === true)
  check("unknown platform keeps bar", vitalsInternals.scanDesktopProcess({ platform: "aix" }) === true)

  const now = 1_800_000_000_000
  const grace = vitalsInternals.DESKTOP_MISSING_GRACE_MS
  check("cli client never hides bar", vitalsInternals.barExpectedFrom({ desktopEnv: "cli", desktopAlive: false, lastDesktopSeenAt: now, now }) === true)
  check("running app keeps bar", vitalsInternals.barExpectedFrom({ desktopEnv: "desktop", desktopAlive: true, lastDesktopSeenAt: now - grace, now }) === true)
  check("first sighting keeps bar", vitalsInternals.barExpectedFrom({ desktopEnv: "desktop", desktopAlive: false, lastDesktopSeenAt: undefined, now }) === true)
  check("closed app hides bar", vitalsInternals.barExpectedFrom({ desktopEnv: "desktop", desktopAlive: false, lastDesktopSeenAt: now - 60_000, now }) === false)
  check("long absence restores bar", vitalsInternals.barExpectedFrom({ desktopEnv: "desktop", desktopAlive: false, lastDesktopSeenAt: now - grace - 1, now }) === true)
}

// 18. Closing the app stops the running bar, proven in an isolated status dir.
{
  const pluginPath = new URL("../index.js", import.meta.url).href
  const sandbox = mkdtempSync(join(tmpdir(), "vitals-stop-"))
  const isolated = await withTmpDir(sandbox, () => import(`${pluginPath}?sandbox=${Date.now()}`))
  const lockDir = join(sandbox, "opencode-latency-monitor")
  mkdirSync(lockDir, { recursive: true })
  const lockFile = join(lockDir, "popup.lock")
  const victim = spawn("sleep", ["30"])
  writeFileSync(lockFile, JSON.stringify({ pid: victim.pid, build: 1 }))
  await isolated.vitalsInternals.stopPopup()
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && victim.exitCode === null && victim.signalCode === null) await wait(25)
  check("stopPopup terminates the bar", victim.exitCode !== null || victim.signalCode !== null, JSON.stringify({ code: victim.exitCode, signal: victim.signalCode }))
  if (victim.exitCode === null && victim.signalCode === null) victim.kill("SIGKILL")
  writeFileSync(lockFile, JSON.stringify({ pid: 999_999, build: 1 }))
  let threw = false
  try {
    await isolated.vitalsInternals.stopPopup()
  } catch {
    threw = true
  }
  check("stopPopup tolerates a stale holder", threw === false)
  rmSync(lockFile, { force: true })
  rmSync(sandbox, { recursive: true, force: true })
}

// 19. The macOS/Windows process checks are correct and fail open.
{
  const names = ["ai.opencode.desktop", "OpenCode"]
  const pgrep = (status) => (_command, args) => ({ status, stdout: "", args })
  check("darwin pgrep match", vitalsInternals.processListDecision("darwin", names, pgrep(0)) === true)
  check("darwin pgrep no match", vitalsInternals.processListDecision("darwin", names, pgrep(1)) === false)
  check("darwin pgrep usage error keeps bar", vitalsInternals.processListDecision("darwin", names, pgrep(2)) === null)
  check("darwin pgrep spawn failure keeps bar", vitalsInternals.processListDecision("darwin", names, pgrep(null)) === null)
  // A real tasklist answers the filter it was given, so the fake reads the name
  // out of the filter instead of returning one canned answer for every name.
  const tasklist = (status, outputs = {}) => (_command, args) => {
    const filter = args[2] ?? ""
    const name = filter.replace("IMAGENAME eq ", "").replace(/\.exe$/, "")
    return { status, stdout: outputs[name] ?? "INFO: No tasks are running which match the specified criteria." }
  }
  check("windows tasklist match", vitalsInternals.processListDecision("win32", names, tasklist(0, { OpenCode: "OpenCode.exe  1234 Console" })) === true)
  check("windows tasklist empty", vitalsInternals.processListDecision("win32", names, tasklist(0)) === false)
  check("windows tasklist failure keeps bar", vitalsInternals.processListDecision("win32", names, tasklist(1)) === null)
  const calls = []
  vitalsInternals.processListDecision("win32", names, (command, args) => {
    calls.push({ command, args })
    return { status: 0, stdout: "INFO: No tasks are running which match the specified criteria." }
  })
  check("windows asks per image name", calls.length === names.length && calls.every((call) => call.command === "tasklist"), JSON.stringify(calls.length))
  check("windows uses an image filter", calls[0]?.args?.[2] === "IMAGENAME eq ai.opencode.desktop.exe", JSON.stringify(calls[0]))
  let pgrepArgs = null
  vitalsInternals.processListDecision("darwin", names, (command, args) => {
    pgrepArgs = args
    return { status: 1, stdout: "" }
  })
  check("darwin passes one pattern per call", Array.isArray(pgrepArgs) && pgrepArgs.length === 2, JSON.stringify(pgrepArgs))
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
  check("updating tells users how to verify", /opencode-vitals-selftest/.test(updating) && /plugin version recorded — running \d+\.\d+\.\d+/.test(updating))
  check("updating links both screenshots", readme.includes("docs/bar.png") && readme.includes("docs/bar-mini.png"))
  for (const image of [...readme.matchAll(/src="([^"]+\.png)"/g)].map((match) => match[1])) {
    check(`README image ${image} exists`, existsSync(new URL(`../${image}`, import.meta.url)))
  }
}

for (const result of results) {
  console.log(`${result.ok ? "ok  " : "FAIL"} ${result.name}${result.detail ? ` ${result.detail}` : ""}`)
}
const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exit(1)
