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

  // Bounds for the recursive scan so a pathological page (deeply nested frames,
  // huge DOM) can't produce an unbounded snapshot.
  var MAX_SNAPSHOT_NODES = 2000
  var MAX_FRAME_DEPTH = 8

  // Block-level tags whose direct text is worth surfacing when the caller opts
  // into `includeText` (non-interactive content the agent may need to read).
  var TEXT_TAGS = {
    h1: 1,
    h2: 1,
    h3: 1,
    h4: 1,
    h5: 1,
    h6: 1,
    p: 1,
    li: 1,
    td: 1,
    th: 1,
    label: 1,
    legend: 1,
    figcaption: 1,
    caption: 1,
    dt: 1,
    dd: 1,
    blockquote: 1,
  }

  /** Direct (non-descendant) text of an element, whitespace-collapsed. */
  function directText(el) {
    var s = ""
    var kids = el.childNodes
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].nodeType === 3) s += kids[i].nodeValue
    }
    return s.replace(/\s+/g, " ").trim()
  }

  function textRole(tag) {
    return /^h[1-6]$/.test(tag) ? "heading" : "text"
  }

  function snapshotNode(el, ref, role, nameOverride) {
    return {
      ref: ref,
      role: role != null ? role : roleOf(el),
      name: nameOverride != null ? truncate(nameOverride, MAX_TEXT) : accessibleName(el),
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

  function pushSnap(el, role, nameOverride, ctx) {
    var ref = "e" + ++refSeq
    el.setAttribute("data-cognia-ref", ref)
    refMap[ref] = el
    var node = snapshotNode(el, ref, role, nameOverride)
    if (ctx.frame) node.frame = true
    ctx.nodes.push(node)
  }

  /**
   * Flat-scan a root (Document/ShadowRoot) for interactive (and, when opted in,
   * salient text) nodes, then descend into shadow roots and same-origin iframes
   * — neither of which `querySelectorAll` crosses. Cross-origin frames throw on
   * `contentDocument` access and are skipped. Nodes carry `frame: true` when
   * they originate inside an iframe (their rect is frame-relative — act by ref,
   * not by coordinate).
   */
  function scanRoot(root, ctx) {
    if (ctx.depth > MAX_FRAME_DEPTH) return
    var all
    try {
      all = root.querySelectorAll("*")
    } catch (e) {
      return
    }
    for (var i = 0; i < all.length; i++) {
      if (ctx.nodes.length >= MAX_SNAPSHOT_NODES) return
      var el = all[i]
      if (el.id === HOVER_BOX_ID) continue
      var role = roleOf(el)
      if (role && isVisible(el)) {
        pushSnap(el, role, null, ctx)
      } else if (ctx.includeText && !role && isVisible(el)) {
        var tag = el.tagName.toLowerCase()
        if (TEXT_TAGS[tag]) {
          var txt = directText(el)
          if (txt) pushSnap(el, textRole(tag), txt, ctx)
        }
      }
      if (el.shadowRoot) {
        ctx.depth++
        scanRoot(el.shadowRoot, ctx)
        ctx.depth--
      }
      if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
        var doc = null
        try {
          doc = el.contentDocument
        } catch (e) {
          doc = null
        }
        if (doc) {
          var wasFrame = ctx.frame
          ctx.frame = true
          ctx.depth++
          scanRoot(doc, ctx)
          ctx.depth--
          ctx.frame = wasFrame
        }
      }
    }
  }

  function buildSnapshot(opts) {
    refMap = {}
    generation++
    var ctx = {
      nodes: [],
      includeText: !!(opts && opts.includeText),
      depth: 0,
      frame: false,
    }
    scanRoot(document, ctx)
    return {
      generation: generation,
      url: String(window.location.href),
      title: String(document.title || ""),
      nodes: ctx.nodes,
    }
  }

  function safeSnapshot(optsJson) {
    try {
      var opts = optsJson ? JSON.parse(optsJson) : {}
      return JSON.stringify({ ok: true, error: null, snapshot: buildSnapshot(opts) })
    } catch (err) {
      return JSON.stringify({ ok: false, error: String(err), snapshot: null })
    }
  }

  /** Whether the page currently has an element matching the CSS selector. */
  function hasSelector(selector) {
    try {
      return !!document.querySelector(String(selector))
    } catch (e) {
      return false
    }
  }

  /** Whether the page's visible text currently contains `text`. */
  function hasText(text) {
    try {
      var body = document.body
      var hay = (body && (body.innerText || body.textContent)) || ""
      return hay.indexOf(String(text)) >= 0
    } catch (e) {
      return false
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

  // --- Keyboard synthesis (browser_press_key) ----------------------------
  // Mirrors the chord vocabulary of the Rust keymap (automation/platform/shared/
  // keymap.rs) so one notation works across the pixel and DOM surfaces.
  // press_key dispatches keydown/(keypress)/keyup with the right modifier flags;
  // it does NOT insert text (use type/fill for that) — it is for shortcuts and
  // navigation keys (Enter/Tab/Escape/Arrow*, Ctrl+A, …).
  var NAMED_KEYS = {
    enter: { key: "Enter", code: "Enter" },
    return: { key: "Enter", code: "Enter" },
    tab: { key: "Tab", code: "Tab" },
    escape: { key: "Escape", code: "Escape" },
    esc: { key: "Escape", code: "Escape" },
    backspace: { key: "Backspace", code: "Backspace" },
    delete: { key: "Delete", code: "Delete" },
    del: { key: "Delete", code: "Delete" },
    space: { key: " ", code: "Space" },
    spacebar: { key: " ", code: "Space" },
    home: { key: "Home", code: "Home" },
    end: { key: "End", code: "End" },
    pageup: { key: "PageUp", code: "PageUp" },
    pgup: { key: "PageUp", code: "PageUp" },
    pagedown: { key: "PageDown", code: "PageDown" },
    pgdn: { key: "PageDown", code: "PageDown" },
    up: { key: "ArrowUp", code: "ArrowUp" },
    uparrow: { key: "ArrowUp", code: "ArrowUp" },
    arrowup: { key: "ArrowUp", code: "ArrowUp" },
    down: { key: "ArrowDown", code: "ArrowDown" },
    downarrow: { key: "ArrowDown", code: "ArrowDown" },
    arrowdown: { key: "ArrowDown", code: "ArrowDown" },
    left: { key: "ArrowLeft", code: "ArrowLeft" },
    leftarrow: { key: "ArrowLeft", code: "ArrowLeft" },
    arrowleft: { key: "ArrowLeft", code: "ArrowLeft" },
    right: { key: "ArrowRight", code: "ArrowRight" },
    rightarrow: { key: "ArrowRight", code: "ArrowRight" },
    arrowright: { key: "ArrowRight", code: "ArrowRight" },
  }

  function modifierFlag(token) {
    switch (String(token).toLowerCase()) {
      case "shift":
        return "shiftKey"
      case "ctrl":
      case "control":
        return "ctrlKey"
      case "alt":
      case "option":
      case "opt":
        return "altKey"
      case "meta":
      case "cmd":
      case "command":
      case "win":
      case "windows":
      case "super":
        return "metaKey"
      default:
        return null
    }
  }

  function functionKey(lower) {
    if (lower.charAt(0) !== "f") return null
    var rest = lower.slice(1)
    var n = parseInt(rest, 10)
    if (String(n) !== rest) return null
    if (n >= 1 && n <= 24) return { key: "F" + n, code: "F" + n }
    return null
  }

  function charCode(ch) {
    if (/^[a-zA-Z]$/.test(ch)) return "Key" + ch.toUpperCase()
    if (/^[0-9]$/.test(ch)) return "Digit" + ch
    return ""
  }

  /**
   * Parse a "+"-joined chord into a KeyboardEvent init. Throws on an empty chord
   * or one with two main keys (matching the Rust parser's contract).
   */
  function parseKeyChord(raw) {
    var trimmed = String(raw == null ? "" : raw).trim()
    if (!trimmed) throw new Error("empty key chord")
    var init = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }
    var main = null
    var parts = trimmed.split("+")
    for (var i = 0; i < parts.length; i++) {
      var token = parts[i]
      if (!token) throw new Error("empty segment in chord: " + raw)
      var flag = modifierFlag(token)
      if (flag) {
        init[flag] = true
        continue
      }
      if (main) throw new Error("more than one main key in chord: " + raw)
      var lower = token.toLowerCase()
      if (NAMED_KEYS[lower]) main = NAMED_KEYS[lower]
      else if (functionKey(lower)) main = functionKey(lower)
      else if (token.length === 1) main = { key: token, code: charCode(token), printable: true }
      else throw new Error("unknown key token: " + token)
    }
    if (!main) throw new Error("chord has no main key: " + raw)
    init.key = main.key
    init.code = main.code || ""
    // Only printable single chars without a non-shift modifier emit keypress.
    init.printable = !!main.printable && !init.ctrlKey && !init.altKey && !init.metaKey
    return init
  }

  function dispatchKey(target, init) {
    var opts = {
      bubbles: true,
      cancelable: true,
      key: init.key,
      code: init.code || "",
      ctrlKey: init.ctrlKey,
      shiftKey: init.shiftKey,
      altKey: init.altKey,
      metaKey: init.metaKey,
    }
    target.dispatchEvent(new KeyboardEvent("keydown", opts))
    if (init.printable) target.dispatchEvent(new KeyboardEvent("keypress", opts))
    target.dispatchEvent(new KeyboardEvent("keyup", opts))
  }

  function performKey(ref, args) {
    var target = ref ? refMap[ref] : null
    if (ref && !target) return { ok: false, error: "unknown ref: " + ref, generation: generation }
    if (!target) target = document.activeElement || document.body
    var spec = parseKeyChord(args && args.key)
    if (ref && target.focus) target.focus()
    dispatchKey(target, spec)
    return { ok: true, error: null, generation: generation }
  }

  function modifierInit(mods) {
    var init = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }
    if (Array.isArray(mods)) {
      for (var i = 0; i < mods.length; i++) {
        var f = modifierFlag(mods[i])
        if (f) init[f] = true
      }
    }
    return init
  }

  function docScrollHeight() {
    var b = document.body
    var d = document.documentElement
    return Math.max((b && b.scrollHeight) || 0, (d && d.scrollHeight) || 0)
  }

  function performScroll(ref, args) {
    if (ref) {
      var el = refMap[ref]
      if (!el) return { ok: false, error: "unknown ref: " + ref, generation: generation }
      try {
        if (el.scrollIntoView) el.scrollIntoView({ block: "center" })
      } catch (e) {
        // no-op under jsdom
      }
      return { ok: true, error: null, generation: generation }
    }
    var dir = String((args && args.direction) || "down").toLowerCase()
    var amount = args && typeof args.amount === "number" ? args.amount : null
    var page = Math.round((window.innerHeight || 600) * 0.9)
    try {
      if (dir === "top") window.scrollTo(0, 0)
      else if (dir === "bottom") window.scrollTo(0, docScrollHeight())
      else if (dir === "up") window.scrollBy(0, -(amount || page))
      else if (dir === "down") window.scrollBy(0, amount || page)
      else if (dir === "left") window.scrollBy(-(amount || 400), 0)
      else if (dir === "right") window.scrollBy(amount || 400, 0)
      else return { ok: false, error: "unknown scroll direction: " + dir, generation: generation }
    } catch (e) {
      // window.scrollTo/scrollBy are no-op stubs under jsdom; ignore.
    }
    return { ok: true, error: null, generation: generation }
  }

  function performAct(ref, action, args) {
    // Ref-optional actions (key target defaults to the focused element; page
    // scroll has no ref) are handled before the ref lookup.
    if (action === "key") return performKey(ref, args)
    if (action === "scroll") return performScroll(ref, args)
    var el = refMap[ref]
    if (!el) return { ok: false, error: "unknown ref: " + ref, generation: generation }
    try {
      if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" })
    } catch (e) {
      // scrollIntoView is a no-op stub under jsdom; ignore.
    }
    switch (action) {
      case "click": {
        var ci = modifierInit(args.modifiers)
        el.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            ctrlKey: ci.ctrlKey,
            shiftKey: ci.shiftKey,
            altKey: ci.altKey,
            metaKey: ci.metaKey,
          })
        )
        break
      }
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
  // In-flight request count + monotonic completed counter power network-idle
  // waiting (the ring buffer only records completed requests and is drained).
  var pendingRequests = 0
  var netCompleted = 0

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

  function recordNet(url, method, status, ok, durationMs) {
    pushRing(networkBuf, {
      url: url,
      method: method,
      status: status,
      ok: ok,
      durationMs: durationMs,
    })
  }

  function installNetworkHook() {
    if (typeof window.fetch !== "function") return
    var orig = window.fetch
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || ""
      var method = (init && init.method) || (input && input.method) || "GET"
      var start = ++tick
      pendingRequests++
      var settled = false
      function settle() {
        if (settled) return
        settled = true
        pendingRequests--
        netCompleted++
      }
      return orig.apply(window, arguments).then(
        function (res) {
          settle()
          recordNet(url, method, res.status, !!res.ok, ++tick - start)
          return res
        },
        function (err) {
          settle()
          recordNet(url, method, 0, false, null)
          throw err
        }
      )
    }
  }

  function installXhrHook() {
    if (typeof window.XMLHttpRequest !== "function") return
    var XHR = window.XMLHttpRequest
    var open = XHR.prototype.open
    var send = XHR.prototype.send
    if (!open || !send) return
    XHR.prototype.open = function (method, url) {
      this.__cogniaMethod = method || "GET"
      this.__cogniaUrl = url || ""
      return open.apply(this, arguments)
    }
    XHR.prototype.send = function () {
      var start = ++tick
      pendingRequests++
      var settled = false
      // `xhr` is the request instance (the loadend handler's `this`); reading it
      // through the event handler avoids aliasing `this` to a local.
      function settle(xhr) {
        if (settled) return
        settled = true
        pendingRequests--
        netCompleted++
        recordNet(
          xhr.__cogniaUrl || "",
          xhr.__cogniaMethod || "GET",
          xhr.status || 0,
          xhr.status >= 200 && xhr.status < 400,
          ++tick - start
        )
      }
      try {
        this.addEventListener("loadend", function () {
          settle(this)
        })
      } catch (e) {
        // jsdom XHR may lack addEventListener in some envs; degrade gracefully.
      }
      return send.apply(this, arguments)
    }
  }

  function drain(buf) {
    var copy = buf.slice()
    buf.length = 0
    return JSON.stringify(copy)
  }

  installConsoleHook()
  installNetworkHook()
  installXhrHook()

  // Rust drives select mode via `webview.eval("window.__cogniaSetSelectMode(true)")`.
  window.__cogniaSetSelectMode = setSelectMode
  window.__cogniaSnapshot = safeSnapshot
  window.__cogniaAct = safeAct
  window.__cogniaHasText = function (text) {
    return hasText(text)
  }
  window.__cogniaHasSelector = function (selector) {
    return hasSelector(selector)
  }
  // In-flight + completed request counters as a JSON string (eval_with_callback
  // can only marshal strings reliably across WKWebView/WebView2).
  window.__cogniaNetworkState = function () {
    return JSON.stringify({ pending: pendingRequests, completed: netCompleted })
  }
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
    hasText: hasText,
    hasSelector: hasSelector,
    parseKeyChord: parseKeyChord,
    networkState: function () {
      return { pending: pendingRequests, completed: netCompleted }
    },
    resolveRef: function (ref) {
      return refMap[ref] || null
    },
    installNetworkHook: installNetworkHook,
    installXhrHook: installXhrHook,
    isActive: function () {
      return active
    },
  }
})()
