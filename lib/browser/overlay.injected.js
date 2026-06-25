/*
 * cognia in-app browser — injected selection overlay.
 *
 * This file is injected verbatim into the previewed dev-server page via Tauri's
 * `WebviewBuilder::initialization_script` (see `src-tauri/src/browser/overlay.rs`,
 * which `include_str!`s this exact file — keep it dependency-free, ES5-safe,
 * and self-contained). It also runs under jsdom in `overlay.injected.test.ts`.
 *
 * Page -> Rust channel: on selection we navigate to a sentinel URL
 * `https://cognia.invalid/__cognia_select?data=<encodeURIComponent(json)>`.
 * The Rust `on_navigation` handler intercepts that host+path, parses `data`,
 * emits `browser://element-selected`, and cancels the navigation. This works
 * across WKWebView/WebView2 with no IPC injection and no capability grants
 * (a remote/external page cannot reach `__TAURI_INTERNALS__`).
 */
;(function () {
  "use strict"

  // Idempotent: initialization scripts re-run on every document load.
  if (typeof window === "undefined") return
  if (window.__cogniaOverlayInstalled) return
  window.__cogniaOverlayInstalled = true

  var SENTINEL = "https://cognia.invalid/__cognia_select?data="
  var MAX_OUTER_HTML = 4000
  var MAX_TEXT = 200
  var HOVER_BOX_ID = "__cognia-hover-box"

  var active = false
  var hoverBox = null

  function truncate(value, max) {
    if (typeof value !== "string") return ""
    return value.length > max ? value.slice(0, max) + "…" : value
  }

  /**
   * Build a stable CSS selector for `el` by walking up to the nearest ancestor
   * with an id (or <body>). Each step uses tag + :nth-of-type to stay unique
   * even without ids. Returns "" for non-element nodes.
   */
  function cssSelector(el) {
    if (!el || el.nodeType !== 1) return ""
    var parts = []
    var node = el
    while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== "html") {
      var tag = node.tagName.toLowerCase()
      if (node.id) {
        parts.unshift("#" + cssEscape(node.id))
        break
      }
      var nth = nthOfType(node)
      parts.unshift(nth > 1 ? tag + ":nth-of-type(" + nth + ")" : tag)
      node = node.parentElement
    }
    return parts.join(" > ")
  }

  function cssEscape(value) {
    if (typeof CSS !== "undefined" && CSS && typeof CSS.escape === "function") {
      return CSS.escape(value)
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&")
  }

  function nthOfType(node) {
    var i = 1
    var sib = node
    while ((sib = sib.previousElementSibling)) {
      if (sib.tagName === node.tagName) i++
    }
    return i
  }

  /** Short human-readable path: "div.card > button#submit". For the prompt. */
  function domPath(el) {
    if (!el || el.nodeType !== 1) return ""
    var parts = []
    var node = el
    var depth = 0
    while (node && node.nodeType === 1 && depth < 6) {
      var tag = node.tagName.toLowerCase()
      if (tag === "html" || tag === "body") break
      var label = tag
      if (node.id) label += "#" + node.id
      else if (node.classList && node.classList.length) label += "." + node.classList[0]
      parts.unshift(label)
      node = node.parentElement
      depth++
    }
    return parts.join(" > ")
  }

  function roundRect(rect) {
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    }
  }

  /** Compose the selection payload sent to Rust. Exposed for tests. */
  function buildPayload(el) {
    var rect = el.getBoundingClientRect()
    return {
      selector: cssSelector(el),
      domPath: domPath(el),
      tagName: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: el.className && typeof el.className === "string" ? el.className : null,
      rect: roundRect(rect),
      outerHTML: truncate(el.outerHTML, MAX_OUTER_HTML),
      text: truncate((el.textContent || "").replace(/\s+/g, " ").trim(), MAX_TEXT),
      pageUrl: String(window.location.href),
      pageTitle: String(document.title || ""),
    }
  }

  /**
   * Page -> Rust transport. Tests override `window.__cogniaSignal`; production
   * navigates to the sentinel URL (intercepted + cancelled by Rust).
   */
  function signal(payload) {
    if (typeof window.__cogniaSignal === "function") {
      window.__cogniaSignal(payload)
      return
    }
    var json = JSON.stringify(payload)
    window.location.href = SENTINEL + encodeURIComponent(json)
  }

  function ensureHoverBox() {
    if (hoverBox && hoverBox.parentNode) return hoverBox
    hoverBox = document.createElement("div")
    hoverBox.id = HOVER_BOX_ID
    hoverBox.setAttribute("aria-hidden", "true")
    var s = hoverBox.style
    s.position = "fixed"
    s.zIndex = "2147483647"
    s.pointerEvents = "none"
    s.border = "2px solid #6366f1"
    s.background = "rgba(99,102,241,0.12)"
    s.borderRadius = "2px"
    s.transition = "all 60ms ease-out"
    s.display = "none"
    s.top = "0"
    s.left = "0"
    ;(document.body || document.documentElement).appendChild(hoverBox)
    return hoverBox
  }

  function moveHoverBox(el) {
    var box = ensureHoverBox()
    var r = el.getBoundingClientRect()
    box.style.display = "block"
    box.style.left = r.left + "px"
    box.style.top = r.top + "px"
    box.style.width = r.width + "px"
    box.style.height = r.height + "px"
  }

  function clearHoverBox() {
    if (hoverBox) hoverBox.style.display = "none"
  }

  function targetAt(e) {
    var el = e.target
    // Never select our own overlay.
    if (!el || el === hoverBox || el.id === HOVER_BOX_ID) return null
    if (el.nodeType !== 1) return null
    return el
  }

  function onMove(e) {
    if (!active) return
    var el = targetAt(e)
    if (el) moveHoverBox(el)
  }

  function onClick(e) {
    if (!active) return
    var el = targetAt(e)
    if (!el) return
    e.preventDefault()
    e.stopPropagation()
    var payload = buildPayload(el)
    setSelectMode(false)
    signal(payload)
  }

  function onKeyDown(e) {
    if (active && (e.key === "Escape" || e.keyCode === 27)) setSelectMode(false)
  }

  function setSelectMode(on) {
    var next = !!on
    if (next === active) return
    active = next
    if (active) {
      document.addEventListener("mousemove", onMove, true)
      document.addEventListener("click", onClick, true)
      document.addEventListener("keydown", onKeyDown, true)
      if (document.body) document.body.style.cursor = "crosshair"
    } else {
      document.removeEventListener("mousemove", onMove, true)
      document.removeEventListener("click", onClick, true)
      document.removeEventListener("keydown", onKeyDown, true)
      if (document.body) document.body.style.cursor = ""
      clearHoverBox()
    }
  }

  // Rust drives select mode via `webview.eval("window.__cogniaSetSelectMode(true)")`.
  window.__cogniaSetSelectMode = setSelectMode
  // Pure helpers exposed for unit tests (and debugging).
  window.__cogniaOverlay = {
    cssSelector: cssSelector,
    domPath: domPath,
    buildPayload: buildPayload,
    isActive: function () {
      return active
    },
  }
})()
