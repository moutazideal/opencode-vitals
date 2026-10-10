// OpenCode Arabic — the part CSS cannot do by itself.
//
// `unicode-bidi: plaintext` in arabic.css already makes each block lay its own
// text out in the right direction. What it does not do is change the element's
// *directionality*, and OpenCode's own stylesheet mirrors things — padding,
// arrows, the side a marker sits on — with `:dir(rtl)` and `[dir=rtl]`. Those
// only match when the element really is right-to-left.
//
// So this file marks the message blocks with `dir="auto"`: "decide your
// direction from your own first strong character". For an Arabic block that is
// `rtl`, which lights up the app's own RTL rules for that block; for an English
// one it stays `ltr`. The browser re-evaluates `dir="auto"` whenever the text
// changes, so a message streaming in switches over on its own — there is nothing
// to poll.
//
// It is deliberately small and defensive: a failure here must leave OpenCode
// exactly as it was.
;(() => {
  const BLOCKS = [
    '[data-component="markdown"] > *',
    '[data-slot="user-message-text"]',
    '[data-slot="session-turn-compaction"]',
    '[data-slot="session-turn-retry-message"]',
    '[data-slot="session-turn-message-content"]',
  ]
  const SELECTOR = BLOCKS.join(",")
  // Anything inside these is code, a path or shell output: it stays LTR, and
  // marking it `dir="auto"` would let a leading Arabic comment flip it.
  const SKIP =
    '[data-component="markdown-code"],[data-component="markdown-mermaid"],pre,code,[data-component="tool-output"],[data-component="bash-output"],[data-component="shell-submessage"]'

  const mark = (element) => {
    try {
      if (!element || element.nodeType !== 1) return
      if (element.getAttribute("dir") === "auto") return
      if (element.closest(SKIP)) return
      element.setAttribute("dir", "auto")
    } catch {
      // A node that cannot be marked is a node left as the app made it.
    }
  }

  const apply = (root) => {
    try {
      const scope = root && root.querySelectorAll ? root : document
      if (scope.matches?.(SELECTOR)) mark(scope)
      for (const element of scope.querySelectorAll(SELECTOR)) mark(element)
    } catch {
      // Never let a pass over the DOM take the window with it.
    }
  }

  let scheduled = false
  const schedule = () => {
    if (scheduled) return
    scheduled = true
    const run = () => {
      scheduled = false
      apply(document.body)
    }
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run)
    else queueMicrotask(run)
  }

  const start = () => {
    apply(document.body)
    try {
      // New messages and new parts arrive as the app renders. The observer only
      // re-marks what appeared; `dir="auto"` keeps itself current after that.
      new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true })
    } catch {
      // Without the observer the initial pass still fixes everything on screen.
    }
  }

  try {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true })
    } else {
      start()
    }
  } catch {
    // Nothing to do: the app is unchanged.
  }
})()
