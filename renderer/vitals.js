// OpenCode Vitals — in-app readout.
//
// Injected beside OpenCode's own bundle, so it runs inside the real renderer
// with the real DOM. It adds one element to the composer's action row and asks
// the local server for the numbers the plugin already computes.
//
// Three rules this file lives by:
//   1. It never breaks OpenCode. Every step is guarded, and a failure is silent —
//      a readout is a nicety, the editor is the product. And it never outlives
//      its own data: a row left showing dashes is a measurement that is not one.
//   2. It never shows a number it cannot attribute. A session with no totals
//      renders a dash, not another session's turns.
//   3. It follows the app. The session shown is read from the app's own active
//      tab, so switching project or session switches the numbers with it.

const SLOT = "composer-actions"
const TAB = '[data-slot="titlebar-tab-item"][data-active="true"]'
const ID = "opencode-vitals-readout"
const POLL_MS = 1000

// How many polls in a row have to fail before the row gives up on its server.
//
// Long enough that a plugin which is merely slow to start — which is what a cold
// OpenCode looks like, since the service loads the plugin while the window is
// already painting — is not punished for it. Short enough that uninstalling
// while a window is open is something you can see happen.
//
// The row comes back by itself the moment the server answers again, so this
// cannot strand a readout that had merely gone quiet.
const GIVE_UP_AFTER = 10

// What each reading is called in the row. The unit is the word that makes the
// number readable without a legend: "123 tok/s" and "114 last10" say what they
// are, where bare numbers do not.
const UNITS = { turns: "turns", steps: "steps", rate: "tok/s", last: "last10" }

const format = (value) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(Math.round(value))
}

const mean = (rates) => {
  if (!Array.isArray(rates)) return null
  const usable = rates.filter((rate) => Number.isFinite(rate) && rate > 0)
  if (usable.length === 0) return null
  return usable.reduce((total, rate) => total + rate, 0) / usable.length
}

// The session this window is showing. The titlebar keeps one tab per session and
// marks the open one with data-active, and the tab's link carries the session id.
// Reading it here is what makes the readout follow a project switch instead of
// staying pinned to whatever session it happened to start on.
const currentSession = () => {
  try {
    const link = document.querySelector(`${TAB} a[href]`)
    const match = link?.getAttribute("href")?.match(/\/session\/(ses_[a-zA-Z0-9_-]+)/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

// Build the element once and then only change its text, so the readout does not
// fight the app's own layout on every tick.
let root = null
const parts = {}
// Polls in a row that have found no server, and whether there is anything to show
// at all. See GIVE_UP_AFTER.
let misses = 0
let wanted = false

const build = () => {
  root = document.createElement("div")
  root.id = ID
  root.setAttribute("data-vitals", "readout")
  // Borrow the app's own spacing and type so it sits in the row rather than on
  // top of it, and take colour from the theme rather than hardcoding it.
  root.style.cssText = [
    "display:flex",
    "align-items:center",
    "gap:6px",
    "margin-inline-end:10px",
    "font-size:11px",
    "line-height:1",
    "white-space:nowrap",
    "color:var(--text-muted, #8a8a8a)",
    "pointer-events:none",
    "user-select:none",
  ].join(";")

  for (const key of Object.keys(UNITS)) {
    const value = document.createElement("span")
    value.style.cssText = "color:var(--text-base, #a0a0a0);font-variant-numeric:tabular-nums"
    const unit = document.createElement("span")
    unit.textContent = UNITS[key]
    unit.style.cssText = "opacity:.62;margin-inline-start:3px"
    root.append(value, unit)
    parts[key] = { value, unit }
  }

  return root
}

// Find the composer's action row. `composer-actions` is the app's own slot name
// for it, which is a far steadier handle than a class or an index. The fallback
// exists only so a rename degrades into a misplaced readout rather than none.
const anchor = () => {
  const bySlot = document.querySelector(`[data-slot="${SLOT}"]`)
  if (bySlot) return bySlot
  const form = document.querySelector('[data-component="composer"]')
  const row = form?.querySelector('[data-slot="composer-controls"]')
  return row?.parentElement ?? null
}

// Put the row in, if there is a row worth having. `wanted` is what makes this
// safe to call from the mutation observer: the composer re-renders constantly, and
// without it a row that was taken away would be put straight back.
const place = () => {
  if (!wanted) return false
  if (root?.isConnected) return true
  const host = anchor()
  if (!host) return false
  root ??= build()
  // Ahead of the send button, on the right of the row.
  host.insertBefore(root, host.firstChild)
  return true
}

const paint = (payload) => {
  const totals = payload?.totals ?? null
  if (!totals) {
    // No totals for the session on screen. A dash, never another session's turns:
    // borrowing a neighbour's numbers is the bug this readout must not repeat.
    for (const key of Object.keys(UNITS)) {
      parts[key].value.textContent = "—"
      parts[key].unit.style.display = "none"
    }
    root?.style.setProperty("opacity", ".45")
    if (payload?.sessionID) root?.setAttribute("title", `OpenCode Vitals — ${payload.sessionID} (not measured yet)`)
    return
  }
  root?.style.removeProperty("opacity")
  const values = {
    turns: format(totals.turns),
    steps: format(totals.steps),
    rate: format(totals.tokensPerSecond),
    last: format(mean(totals.recentRates)),
  }
  for (const key of Object.keys(UNITS)) {
    const shown = values[key]
    parts[key].value.textContent = shown ?? "—"
    parts[key].unit.style.display = shown === null ? "none" : ""
  }
  if (payload?.sessionID) root?.setAttribute("title", `OpenCode Vitals — ${payload.sessionID}`)
}

// One report so a silent blank row is diagnosable from the server log. It is
// sent when the state changes and not on every poll: a missing composer reports
// once, and its recovery reports once, where the old latch reported the failure
// every second for as long as it lasted.
let lastReported = null
const report = (placed, detail) => {
  const state = placed ? "placed" : "missing"
  if (state === lastReported) return
  lastReported = state
  const query = new URLSearchParams({ placed: String(placed), detail: String(detail).slice(0, 300) })
  fetch(`/__vitals-status?${query}`).catch(() => {})
}

const tick = async () => {
  const sessionID = currentSession()
  let payload = null
  try {
    // Fetch first and place second. Tying the two together meant a composer that
    // was not on screen also silenced the data, which left nothing to diagnose.
    // A server that accepts the connection and never answers must not stall the
    // readout forever: without a deadline the poll hangs, `misses` never grows,
    // and a dead row can never be withdrawn. A timeout is a failed poll.
    const query = sessionID ? `?session=${encodeURIComponent(sessionID)}` : ""
    const response = await fetch(`/vitals${query}`, { cache: "no-store", signal: AbortSignal.timeout(2500) })
    if (response.ok) payload = await response.json()
  } catch {
    // The server going away must not take the editor with it.
  }

  // A server that answers and a session with no numbers are different things.
  // Only the first failure means there is no longer anything here to read: an
  // empty answer is a session that has not been measured yet, and it stays a
  // dash because a dash is honest where a neighbour's numbers would not be.
  if (payload) {
    misses = 0
    wanted = true
  } else if (++misses >= GIVE_UP_AFTER) {
    // The server is not coming back — this is what uninstalling looks like from
    // in here. A row that outlives its data is worse than no row, because it
    // looks like a reading.
    wanted = false
    root?.remove()
    return
  }

  // Asked on every tick, and separately from placing: "the app renamed the slot"
  // is the failure that leaves no other trace anywhere, so the server has to hear
  // it. A blank row is not a report, though — nothing is placed until there is
  // something to put in it.
  const placed = Boolean(place())
  const slots = document.querySelectorAll("[data-slot]").length
  const where = placed ? "composer-actions" : `composer-actions absent; slots=${slots}`
  report(placed, `${where}; session=${sessionID ?? "none"}${payload ? "" : "; no data yet"}`)
  if (payload && placed) paint(payload)
}

// The app re-renders the composer as sessions change, which removes our node.
// Re-place on a timer and on the mutations that matter, rather than hooking
// internals we do not own.
const start = () => {
  place()
  setInterval(tick, POLL_MS)
  new MutationObserver(() => place()).observe(document.documentElement, {
    childList: true,
    subtree: true,
  })
}

try {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true })
  } else {
    start()
  }
} catch {
  // Nothing to do: no readout, working editor.
}
