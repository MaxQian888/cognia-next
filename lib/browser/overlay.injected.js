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

  // -----------------------------------------------------------------------
  // Agent browser loop (Phase 1): snapshot, act-by-ref, console + network.
  // Rust pulls these via `webview.eval_with_callback` (JSON string returns).
  // Every entry point wraps its body in try/catch and returns an error-as-value
  // because eval_with_callback swallows exceptions on Windows.
  // -----------------------------------------------------------------------

  var refMap = {}
  var refSeq = 0
  var generation = 0

  var INTERACTIVE = {
    button: "button",
    a: "link",
    input: "textbox",
    select: "combobox",
    textarea: "textbox",
    summary: "button",
  }

  function roleOf(el) {
    var explicit = el.getAttribute && el.getAttribute("role")
    if (explicit) return explicit
    var tag = el.tagName.toLowerCase()
    if (tag === "input") {
      var t = (el.getAttribute("type") || "text").toLowerCase()
      if (t === "checkbox") return "checkbox"
      if (t === "radio") return "radio"
      if (t === "button" || t === "submit") return "button"
      if (t === "hidden") return ""
      return "textbox"
    }
    return INTERACTIVE[tag] || ""
  }

  function accessibleName(el) {
    var label = el.getAttribute && el.getAttribute("aria-label")
    if (label) return truncate(label, MAX_TEXT)
    if (el.tagName.toLowerCase() === "input") {
      var ph = el.getAttribute("placeholder")
      if (ph) return truncate(ph, MAX_TEXT)
    }
    return truncate((el.textContent || "").replace(/\s+/g, " ").trim(), MAX_TEXT)
  }

  function isVisible(el) {
    // jsdom reports 0x0 for every rect, so we cannot filter on size. Exclude
    // only elements explicitly hidden via attribute or computed style.
    if (el.hasAttribute && el.hasAttribute("hidden")) return false
    var st = typeof getComputedStyle === "function" ? getComputedStyle(el) : null
    if (st && (st.display === "none" || st.visibility === "hidden")) return false
    return true
  }

  function tristate(v) {
    return v === true ? true : v === false ? false : null
  }

  function snapshotNode(el, ref) {
    return {
      ref: ref,
      role: roleOf(el),
      name: accessibleName(el),
      tag: el.tagName.toLowerCase(),
      rect: roundRect(el.getBoundingClientRect()),
      value: typeof el.value === "string" ? truncate(el.value, MAX_TEXT) : null,
      state: {
        disabled: !!el.disabled,
        checked: el.type === "checkbox" || el.type === "radio" ? !!el.checked : null,
        expanded:
          el.getAttribute && el.getAttribute("aria-expanded") != null
            ? tristate(el.getAttribute("aria-expanded") === "true")
            : null,
      },
    }
  }

  function buildSnapshot() {
    refMap = {}
    generation++
    var all = document.querySelectorAll("*")
    var nodes = []
    for (var i = 0; i < all.length; i++) {
      var el = all[i]
      if (el.id === HOVER_BOX_ID) continue
      if (!roleOf(el)) continue
      if (!isVisible(el)) continue
      var ref = "e" + ++refSeq
      el.setAttribute("data-cognia-ref", ref)
      refMap[ref] = el
      nodes.push(snapshotNode(el, ref))
    }
    return {
      generation: generation,
      url: String(window.location.href),
      title: String(document.title || ""),
      nodes: nodes,
    }
  }

  function safeSnapshot() {
    try {
      return JSON.stringify({ ok: true, error: null, snapshot: buildSnapshot() })
    } catch (err) {
      return JSON.stringify({ ok: false, error: String(err), snapshot: null })
    }
  }

  function nativeSetValue(el, value) {
    var proto =
      el.tagName.toLowerCase() === "textarea"
        ? window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement && window.HTMLInputElement.prototype
    var desc = proto && Object.getOwnPropertyDescriptor(proto, "value")
    if (desc && desc.set) desc.set.call(el, value)
    else el.value = value
    el.dispatchEvent(new Event("input", { bubbles: true }))
    el.dispatchEvent(new Event("change", { bubbles: true }))
  }

  function performAct(ref, action, args) {
    var el = refMap[ref]
    if (!el) return { ok: false, error: "unknown ref: " + ref, generation: generation }
    try {
      if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" })
    } catch (e) {
      // scrollIntoView is a no-op stub under jsdom; ignore.
    }
    switch (action) {
      case "click":
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
        break
      case "hover":
        el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))
        break
      case "focus":
        if (el.focus) el.focus()
        break
      case "type":
      case "fill":
        if (el.focus) el.focus()
        nativeSetValue(el, String(args.text == null ? "" : args.text))
        break
      case "select":
        nativeSetValue(el, String(args.value == null ? "" : args.value))
        break
      default:
        return { ok: false, error: "unknown action: " + action, generation: generation }
    }
    return { ok: true, error: null, generation: generation }
  }

  function safeAct(ref, action, argsJson) {
    try {
      var args = argsJson ? JSON.parse(argsJson) : {}
      return JSON.stringify(performAct(ref, action, args))
    } catch (err) {
      return JSON.stringify({ ok: false, error: String(err), generation: generation })
    }
  }

  var RING = 200
  var consoleBuf = []
  var networkBuf = []
  var tick = 0

  function pushRing(buf, entry) {
    buf.push(entry)
    if (buf.length > RING) buf.shift()
  }

  function fmtArg(a) {
    if (typeof a === "string") return a
    try {
      return JSON.stringify(a)
    } catch (e) {
      return String(a)
    }
  }

  function installConsoleHook() {
    var levels = ["log", "info", "warn", "error", "debug"]
    for (var i = 0; i < levels.length; i++) {
      ;(function (level) {
        var orig = console[level]
        console[level] = function () {
          try {
            var parts = []
            for (var j = 0; j < arguments.length; j++) parts.push(fmtArg(arguments[j]))
            pushRing(consoleBuf, {
              level: level,
              text: truncate(parts.join(" "), 1000),
              ts: ++tick,
            })
          } catch (e) {
            // never let logging instrumentation break the page
          }
          if (typeof orig === "function") return orig.apply(console, arguments)
        }
      })(levels[i])
    }
  }

  function installNetworkHook() {
    if (typeof window.fetch !== "function") return
    var orig = window.fetch
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || ""
      var method = (init && init.method) || (input && input.method) || "GET"
      var start = ++tick
      return orig.apply(window, arguments).then(
        function (res) {
          pushRing(networkBuf, {
            url: url,
            method: method,
            status: res.status,
            ok: !!res.ok,
            durationMs: ++tick - start,
          })
          return res
        },
        function (err) {
          pushRing(networkBuf, { url: url, method: method, status: 0, ok: false, durationMs: null })
          throw err
        }
      )
    }
  }

  function drain(buf) {
    var copy = buf.slice()
    buf.length = 0
    return JSON.stringify(copy)
  }

  installConsoleHook()
  installNetworkHook()

  // Rust drives select mode via `webview.eval("window.__cogniaSetSelectMode(true)")`.
  window.__cogniaSetSelectMode = setSelectMode
  window.__cogniaSnapshot = safeSnapshot
  window.__cogniaAct = safeAct
  window.__cogniaDrainConsole = function () {
    try {
      return drain(consoleBuf)
    } catch (e) {
      return "[]"
    }
  }
  window.__cogniaDrainNetwork = function () {
    try {
      return drain(networkBuf)
    } catch (e) {
      return "[]"
    }
  }
  // Pure helpers exposed for unit tests (and debugging).
  window.__cogniaOverlay = {
    cssSelector: cssSelector,
    domPath: domPath,
    buildPayload: buildPayload,
    snapshot: buildSnapshot,
    resolveRef: function (ref) {
      return refMap[ref] || null
    },
    installNetworkHook: installNetworkHook,
    isActive: function () {
      return active
    },
  }
})()
