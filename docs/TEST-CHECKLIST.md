# Test checklist

Every case a measurement can hit, in one place. Written to be run by hand, with
the result column filled in, because most of these are about how the app behaves
rather than about one function returning a value.

**How to use.** Run a row, record what you saw, mark pass/fail. A row that fails
is either a bug or a gap in the last section — the two are recorded differently
on purpose, because a known gap is not a surprise later.

**Two surfaces are covered.** The bar (the always-on-top window) and the in-app
readout (the numbers inside OpenCode's own composer). Some rows apply to one,
some to both. The column says which.

- `[bar]` — the external window
- `[ui]` — the in-app readout
- `[core]` — the measurement, independent of how it is displayed

---

## 1. Environment matrix

Run the whole sheet at least once per row here.

| # | Environment | How | Result |
|---|---|---|---|
| 1.1 | Linux / X11 / GNOME | native | |
| 1.2 | Linux / no `DISPLAY` (SSH) | `unset DISPLAY` | |
| 1.3 | Two projects open at once | two OpenCode windows | |
| 1.4 | Dark theme | app theme `oc-2` | |
| 1.5 | Light theme | app theme set to light | |
| 1.6 | App window narrow (~700px) | drag the window | |
| 1.7 | App zoom 80% / 150% | app zoom setting | |
| 1.8 | App RTL locale | `LANG=ar` | |
| 1.9 | Screen scale 1.25 / 1.5 | display settings | |

---

## 2. Conversation shapes

The single biggest source of wrong numbers is a conversation that is not the
one the tests assume: one turn, one model, one agent.

| # | Case | Steps | Expected | Surface | Result |
|---|---|---|---|---|---|
| 2.1 | Single word prompt | send `hi` | one turn recorded, one step | core | |
| 2.2 | Single word response | prompt that yields a 1–2 character reply | rate is small but real, not zero | core | |
| 2.3 | Emoji-only response | send `🙂` | no crash, character count sane | core | |
| 2.4 | Very short conversation | 3 prompts, then stop | turns=3, no drift | core | |
| 2.5 | Long conversation | 100+ prompts in one session | turns grows, no snapshot regression | core | |
| 2.6 | Conversation resumed next day | stop, come back tomorrow, send one prompt | totals continue, never go backwards | core | |
| 2.7 | Very long single reply | prompt for a 20k-token answer | rate still meaningful, no overflow | core | |
| 2.8 | Reply with no measurable stream | a reply that arrives as one message | `rateSource` set, rate honest | core | |
| 2.9 | Prompt with no reply (error) | send a prompt that 500s | no phantom turn | core | |
| 2.10 | Interrupted reply | send, then stop the turn mid-stream | turn ends, no negative or huge rate | core | |
| 2.11 | Retry after a provider error | force a retry | counted once, not twice | core | |
| 2.12 | Empty response | a turn that produces nothing | no divide-by-zero, no NaN in the record | core | |
| 2.13 | Compaction mid-session | trigger `/compact`, keep going | totals not reset, no double count | core | |
| 2.14 | Failed compaction | force a compaction failure | next reply still measured | core | |
| 2.15 | Two prompts before the first replies | queue two prompts fast | two turns, not one merged | core | |
| 2.16 | Steer a running turn | send a follow-up while streaming | no merged inflated turn | core | |
| 2.17 | 50+ sessions in the file | open 50 sessions | eviction drops the right one | core | |
| 2.18 | Session title with emoji / RTL | rename a session | no effect on measurement | core | |

---

## 3. Subagents

A subagent runs as its own session, so this is where attribution is easiest to
get wrong. The parent gets the steps and tokens; the parent must **not** get the
subagent's stream time, or the rate becomes a number the session never produced.

| # | Case | Steps | Expected | Surface | Result |
|---|---|---|---|---|---|
| 3.1 | One subagent | ask for a task that spawns one agent | parent `steps` include the subagent's | core | |
| 3.2 | Parent rate unaffected | same, then read the parent's `tok/s` | parent's rate is the parent's own speed | core | |
| 3.3 | Subagent rate on its own tab | open the subagent's session | its own rate, computed with its own time | core | |
| 3.4 | Two subagents in parallel | ask for two agents at once | both credited, no merge into one turn | core | |
| 3.5 | Nested subagent | agent spawns an agent | deepest work reaches the root session | core | |
| 3.6 | Subagent that fails | subagent throws | no partial credit, no crash | core | |
| 3.7 | Subagent interrupted | stop the parent mid-subagent | turn closes cleanly | core | |
| 3.8 | Subagent with many tool calls | deep tool use in the subagent | token count honest, not inflated | core | |
| 3.9 | Subagent counted in `steps` | inspect the parent's totals | `subagentSteps` explains the difference | core | |
| 3.10 | Subagent, then parent replies | mixed sequence | both sessions' numbers stable | core | |

---

## 4. Session and project switching

One machine, many projects, one shared status directory. This is the section
where a readout is most likely to show you the wrong session's numbers.

| # | Case | Steps | Expected | Surface | Result |
|---|---|---|---|---|---|
| 4.1 | Switch session tab | click another tab | numbers follow within a second | ui, bar | |
| 4.2 | Switch project | open a session in another project | numbers follow, never the old project's | ui, bar | |
| 4.3 | New session, nothing measured | open a brand-new session | shows a dash, **not** another session's turns | ui, bar | |
| 4.4 | Return to an old session | go back to a session from yesterday | its own totals, not the newest session's | ui, bar | |
| 4.5 | Two projects, wrong project pinned | two projects open, check the readout | the readout never shows the other project | ui, bar | |
| 4.6 | Session evicted from the file | open 50+ other sessions, return | dash, not a neighbour's numbers | ui, bar | |
| 4.7 | Deleted session still in a tab | delete the session, keep the tab | dash or graceful, never a stranger's numbers | ui | |
| 4.8 | No session at all | the app's home screen, no session open | no readout, or a dash — never a number | ui | |
| 4.9 | Two windows, different sessions | two OpenCode windows | each shows its own session | ui | |

---

## 5. Number integrity

The property that matters most: a number on screen is a number that happened.

| # | Case | Expected | Surface | Result |
|---|---|---|---|---|
| 5.1 | Totals never go backwards | a restart or a stale file never reduces turns/steps | core | |
| 5.2 | Snapshots are whole | never turns from one turn beside steps from another | core | |
| 5.3 | Rate is tokens ÷ that turn's own time | no record where the division never happened | core | |
| 5.4 | Last-ten is the last ten **responses** | not steps; documented as responses | core, ui | |
| 5.5 | A response with no rate is skipped | it does not enter the last-ten list as a zero | core | |
| 5.6 | Fewer than ten responses | average over what exists | core, ui | |
| 5.7 | Last-ten survives a restart | the list is seeded, not restarted | core | |
| 5.8 | No subagent time in a parent rate | see 3.2 | core | |
| 5.9 | Unknown events are visible | a renamed event is reported, not silently dropped | core | |

---

## 6. Edge values

| # | Case | Input | Expected | Surface | Result |
|---|---|---|---|---|---|
| 6.1 | Zero tokens | a turn with no token counts | `null` rate, not `0` | core, ui | |
| 6.2 | Four-digit rate | 4686 tok/s | prints short, `4.7k`, stays on the row | ui, bar | |
| 6.3 | Very slow reply | 2 tok/s | readable, no layout break | ui, bar | |
| 6.4 | Very large counts | 10M tokens | formats, does not overflow the row | ui, bar | |
| 6.5 | Negative or zero stream time | a clock skew | ignored, never a negative rate | core | |
| 6.6 | `NaN` / `Infinity` anywhere | forced | never reaches the record | core | |
| 6.7 | Huge single response | 500k tokens | no truncation to a wrong number | core | |
| 6.8 | Locale with comma decimals | `de_DE` | numbers still readable | ui, bar | |

---

## 7. The in-app readout

The readout is injected into OpenCode's renderer, so these are its own failure
modes. A readout must never be able to break the editor.

| # | Case | Steps | Expected | Result |
|---|---|---|---|---|
| 7.1 | No readout server | stop the local server | editor fine, no readout, no errors | |
| 7.2 | Server dies mid-session | kill it while the app is open | editor fine, no errors, no frozen row | |
| 7.3 | Server returns garbage | point it at a bad file | readout goes blank or dashes, editor fine | |
| 7.4 | `vitals.js` throws | break the script deliberately | editor opens and works | |
| 7.5 | `vitals.js` missing | delete it | editor fine, module 404 only | |
| 7.6 | Script tag missing (old renderer) | serve an unmodified copy | editor fine, no readout | |
| 7.7 | No `ELECTRON_RENDERER_URL` | launch the app normally | original UI, untouched, no readout | |
| 7.8 | Port already in use | start the server twice | second one fails loudly, first one still serves | |
| 7.9 | OpenCode updated | app updates itself | editor fine; readout may go stale (see 11.3) | |
| 7.10 | Composer absent | onboarding / settings screen | no readout, no error | |
| 7.11 | Slot renamed in a new version | app renames `composer-actions` | falls back, or goes blank — **never misplaced** | |
| 7.12 | Narrow window | ~700px | readout truncates or hides, does not push the row | |
| 7.13 | Long numbers | 4-digit rate | row still fits | |
| 7.14 | Theme switch mid-session | dark → light | colours follow the theme | |
| 7.15 | Row re-render | switch tabs fast | one readout, not a pile of them | |
| 7.16 | Click through | click where the readout sits | the send button and selectors still work | |
| 7.17 | Select text across the row | drag-select the composer | readout does not block the selection | |
| 7.18 | Two windows injecting | two app windows | both fine, each with its own readout | |
| 7.19 | Long-running session | 500 messages, then switch tabs | no visible slowdown (see 11.1) | |
| 7.20 | Uninstall | remove the plugin and the copied renderer | the original app is exactly as installed | |

---

## 8. The bar's own lifecycle

If the bar is kept at all. Every row here is about the window, not the numbers.

| # | Case | Expected | Result |
|---|---|---|---|
| 8.1 | Close OpenCode | bar exits with it | |
| 8.2 | OpenCode idle 10s+ | bar stands down | |
| 8.3 | Reply still streaming | bar does **not** stand down | |
| 8.4 | Replayed old events | do not read as a live session | |
| 8.5 | Another instance owns the lock | exits quietly, no error spam | |
| 8.6 | No display | no window, no crash loop | |
| 8.7 | Bar killed | respawns, no 5-second loop | |
| 8.8 | Python missing | says the machine cannot draw, once | |
| 8.9 | Scale at both limits | clamps, layout intact | |
| 8.10 | Collapse / restore | both states render | |
| 8.11 | Window covered by another | steps aside, comes back | |
| 8.12 | Monitor changed | follows to the new screen | |

---

## 9. Install, update, remove

| # | Case | Expected | Result |
|---|---|---|---|
| 9.1 | Install from scratch | one command, prints the path it used | |
| 9.2 | Install twice | an update, not a second copy | |
| 9.3 | Install over a different package | refuses without `--force` | |
| 9.4 | Install outside the plugin directory | refuses | |
| 9.5 | Uninstall a stranger's folder | refuses without `--force` | |
| 9.6 | Update the app, then the plugin | both keep working | |
| 9.7 | Remove the in-app injection | original UI back, no leftovers | |
| 9.8 | Plugin file deleted while running | app keeps working | |
| 9.9 | Reinstall after a broken install | recovers | |

---

## 10. Automated coverage

Run with `npm test`. These do not replace the sheet above; they cover the
arithmetic and the guards, not how the app behaves.

- Plugin: 257 checks — event accounting, totals, snapshot ranking, storage,
  locking, subagent credit, the idle rules, and the README's own commands.
- Bar: 142 checks — rendering, lock, session resolution, project scoping,
  Desktop tab tracking, window following.

---

## 11. Known gaps

Not bugs found by a failure — things the design does not handle yet. Listed so
they are decisions rather than surprises.

1. **Nested subagents stop at one level.** A subagent's parent is resolved once,
   so a subagent of a subagent is credited to the middle session, not to the root
   the user is looking at. Deeper trees need the chain walked to the top.
2. **The readout polls the DOM.** It re-places itself with a `MutationObserver`
   over the whole document, which is O(mutations) on a long session. A 500-message
   session may pay for it. A narrower observer, or hooking the app's own
   re-render, would fix it.
3. **The copied renderer goes stale.** The in-app readout is a copy of the app's
   UI. When OpenCode updates, the copy is behind until it is re-synced. The app
   keeps working; the readout is what is stale.
4. **Sessions are capped in the totals file.** Beyond the cap, the least recently
   updated session is dropped, so an old tab can show a dash rather than its
   history. Correct, but surprising if you did not expect it.
5. **`latest.json` is one file for the machine.** Several OpenCode instances
   write it; whoever wrote last wins. It is a convenience record, not the
   source of truth — the totals file is.
6. **The plugin has no `sandbox` of its own.** It runs with the user's
   privileges, like every OpenCode plugin. Nothing in this design may be allowed
   to assume otherwise.
7. **One readout per window.** Two windows show their own sessions correctly, but
   there is no cross-window coordination to deduplicate the numbers.
8. **The bar and the readout can both be on.** Nothing stops both being visible
   at once; they read the same source and agree, but it is two copies of one
   number until the bar is retired or scoped to the TUI.
