/**
 * Functions the agent executor runs inside a tab.
 *
 * Each is passed to `chrome.scripting.executeScript({ func })`, which
 * serializes it: none may reference anything outside its own body. The
 * isolated-world ones call the overlay (`lib/browser/overlay.injected.js`,
 * bundled as `/agent-overlay.js`), which the executor injects first; the
 * main-world ones call the page hooks (`/page-hooks.js`). They return plain
 * JSON-able values.
 */

interface OverlayWindow {
  __cogniaSnapshot?: (optsJson: string) => string
  __cogniaAct?: (ref: string, action: string, argsJson: string) => string
  __cogniaHasText?: (text: string) => boolean
  __cogniaHasSelector?: (selector: string) => boolean
  __cogniaFind?: (query: string, options?: unknown) => unknown
  __cogniaFindClear?: () => unknown
  __cogniaOverlay?: { abi?: number; resolveRef: (ref: string) => Element | null }
}

/** Read the ABI in the isolated world; serialized by chrome.scripting. */
export function pageOverlayAbi(): number | null {
  const abi = (window as unknown as OverlayWindow).__cogniaOverlay?.abi
  return typeof abi === "number" && Number.isSafeInteger(abi) ? abi : null
}

/** `buildSnapshot` through the overlay, or the overlay's own error. */
export function pageSnapshot(optsJson: string): {
  ok: boolean
  error: string | null
  snapshot: unknown
} {
  const overlay = window as unknown as OverlayWindow
  if (typeof overlay.__cogniaSnapshot !== "function") {
    return { ok: false, error: "overlay_missing", snapshot: null }
  }
  return JSON.parse(overlay.__cogniaSnapshot(optsJson))
}

export function pageAct(ref: string, action: string, argsJson: string): unknown {
  const overlay = window as unknown as OverlayWindow
  if (typeof overlay.__cogniaAct !== "function") {
    return { ok: false, error: "overlay_missing", generation: 0 }
  }
  return JSON.parse(overlay.__cogniaAct(ref, action, argsJson))
}

export function pageHas(kind: "text" | "selector", value: string): boolean | null {
  const overlay = window as unknown as OverlayWindow
  const check = kind === "text" ? overlay.__cogniaHasText : overlay.__cogniaHasSelector
  if (typeof check !== "function") return null
  try {
    return check(value) === true
  } catch {
    return false
  }
}

export function pageFind(query: string | null, options: unknown): unknown {
  const overlay = window as unknown as OverlayWindow
  if (query === null) {
    if (typeof overlay.__cogniaFindClear === "function") overlay.__cogniaFindClear()
    return null
  }
  if (typeof overlay.__cogniaFind !== "function") return { matches: 0, index: -1 }
  return overlay.__cogniaFind(query, options)
}

/** A synthetic HTML5 drag from one ref onto another. */
export function pageDrag(
  sourceRef: string,
  targetRef: string
): { ok: boolean; error: string | null } {
  const overlay = (window as unknown as OverlayWindow).__cogniaOverlay
  const source = overlay?.resolveRef(sourceRef) ?? null
  const target = overlay?.resolveRef(targetRef) ?? null
  if (!source) return { ok: false, error: `unknown ref: ${sourceRef}` }
  if (!target) return { ok: false, error: `unknown ref: ${targetRef}` }
  const transfer = new DataTransfer()
  const rect = target.getBoundingClientRect()
  const at = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }
  const fire = (element: Element, type: string) =>
    element.dispatchEvent(
      new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer, ...at })
    )
  fire(source, "dragstart")
  fire(target, "dragenter")
  fire(target, "dragover")
  fire(target, "drop")
  fire(source, "dragend")
  return { ok: true, error: null }
}

/**
 * Put files into a file input the way a person picking them would.
 *
 * Refused for anything but `<input type="file">`, and for a `multiple`-less
 * input given more than one file, so a page sees exactly what a picker could
 * have produced.
 */
export function pageSetFiles(
  ref: string,
  files: { name: string; mediaType: string; dataBase64: string }[]
): { ok: boolean; error: string | null } {
  const overlay = (window as unknown as OverlayWindow).__cogniaOverlay
  const element = overlay?.resolveRef(ref) ?? null
  if (!element) return { ok: false, error: `unknown ref: ${ref}` }
  if (!(element instanceof HTMLInputElement) || element.type !== "file") {
    return { ok: false, error: "the element is not a file input" }
  }
  if (files.length > 1 && !element.multiple) {
    return { ok: false, error: "this file input accepts one file" }
  }
  const transfer = new DataTransfer()
  for (const file of files) {
    const binary = atob(file.dataBase64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    transfer.items.add(new File([bytes], file.name, { type: file.mediaType }))
  }
  element.files = transfer.files
  element.dispatchEvent(new Event("input", { bubbles: true }))
  element.dispatchEvent(new Event("change", { bubbles: true }))
  return { ok: true, error: null }
}

/** An element's box in CSS pixels, for an element screenshot. */
export function pageElementRect(
  ref: string
): { x: number; y: number; width: number; height: number; dpr: number } | null {
  const overlay = (window as unknown as OverlayWindow).__cogniaOverlay
  const element = overlay?.resolveRef(ref) ?? null
  if (!element) return null
  element.scrollIntoView({ block: "center", inline: "center" })
  const rect = element.getBoundingClientRect()
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
    dpr: window.devicePixelRatio || 1,
  }
}

/** What a full-page capture needs to plan its scroll steps. */
export function pageScrollMetrics(): {
  scrollHeight: number
  viewportHeight: number
  viewportWidth: number
  scrollY: number
  dpr: number
} {
  const root = document.scrollingElement ?? document.documentElement
  return {
    scrollHeight: Math.max(root.scrollHeight, document.body?.scrollHeight ?? 0),
    viewportHeight: window.innerHeight,
    viewportWidth: window.innerWidth,
    scrollY: window.scrollY,
    dpr: window.devicePixelRatio || 1,
  }
}

export function pageScrollTo(y: number): number {
  window.scrollTo(0, y)
  return window.scrollY
}

/** Web storage through the DOM, which both worlds share. */
export function pageStorage(
  action: "get" | "set" | "clear",
  area: "local" | "session",
  key: string | null,
  value: string | null
): {
  ok: boolean
  origin: string
  entries: Record<string, string | null>
  /** Single-key read: whether the key is set at all. */
  exists?: boolean
  error: string | null
} {
  const origin = location.origin
  try {
    const storage = area === "local" ? window.localStorage : window.sessionStorage
    if (action === "set" && key !== null) {
      storage.setItem(key, value ?? "")
      return { ok: true, origin, entries: { [key]: value ?? "" }, error: null }
    }
    if (action === "clear") {
      storage.clear()
      return { ok: true, origin, entries: {}, error: null }
    }
    if (key !== null) {
      const value = storage.getItem(key)
      return { ok: true, origin, entries: { [key]: value }, exists: value !== null, error: null }
    }
    const entries: Record<string, string | null> = {}
    for (let index = 0; index < storage.length; index++) {
      const name = storage.key(index)
      if (name !== null) entries[name] = storage.getItem(name)
    }
    return { ok: true, origin, entries, error: null }
  } catch (error) {
    return { ok: false, origin, entries: {}, error: String(error) }
  }
}

export function pageStopLoading(): boolean {
  window.stop()
  return true
}

// ── Main world (page hooks) ────────────────────────────────────────────────

interface PageHooksWindow {
  __cogniaPageHooks?: {
    drainConsole(): unknown[]
    drainNetwork(): unknown[]
    networkState(): { pending: number; completed: number }
    setDialogPolicy(policy: { accept: boolean; promptText?: string } | null): void
    lastDialog(): unknown
  }
}

export function mainHooksCall(
  call: "drainConsole" | "drainNetwork" | "networkState" | "lastDialog"
): unknown {
  const hooks = (window as unknown as PageHooksWindow).__cogniaPageHooks
  if (!hooks)
    return call === "networkState"
      ? { pending: 0, completed: 0 }
      : call === "lastDialog"
        ? null
        : []
  return hooks[call]()
}

export function mainSetDialogPolicy(
  policy: { accept: boolean; promptText?: string } | null
): boolean {
  const hooks = (window as unknown as PageHooksWindow).__cogniaPageHooks
  if (!hooks) return false
  hooks.setDialogPolicy(policy)
  return true
}

/**
 * Evaluate an expression in the page's own world.
 *
 * Through `Function`, which the page's Content-Security-Policy governs: a page
 * that forbids `unsafe-eval` refuses it, and that refusal is reported as its
 * own code rather than as a broken page.
 */
export function mainEvaluate(expression: string): {
  ok: boolean
  value?: unknown
  error?: string
  code?: string
} {
  let run: () => unknown
  try {
    run = new Function(`return (${expression})`) as () => unknown
  } catch (error) {
    const text = String(error)
    if (/Content Security Policy|unsafe-eval|EvalError/i.test(text)) {
      return { ok: false, error: text, code: "browser_evaluate_blocked_by_csp" }
    }
    return { ok: false, error: text }
  }
  try {
    const value = run()
    const seen = new WeakSet<object>()
    const json = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "bigint") return item.toString()
      if (typeof item === "function")
        return `[function ${(item as { name?: string }).name || "anonymous"}]`
      if (item instanceof Element) return `[element ${item.tagName.toLowerCase()}]`
      if (item && typeof item === "object") {
        if (seen.has(item as object)) return "[circular]"
        seen.add(item as object)
      }
      return item
    })
    return { ok: true, value: json === undefined ? null : JSON.parse(json) }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

// ── The acting bar ──────────────────────────────────────────────────────────

/**
 * Show, update or remove the in-page bar that says Cognia is acting here.
 *
 * Lives in a closed shadow root so the page's CSS cannot restyle it and its
 * scripts cannot reach its buttons. The buttons message the extension; they
 * are the person's Stop and Take over (ADR-0228 §7). Labels arrive translated.
 */
export function pageActingBar(
  state: null | {
    session: string
    takenOver: boolean
    labels: { acting: string; paused: string; stop: string; takeOver: string; resume: string }
  }
): boolean {
  const HOST_ID = "__cognia-acting-bar"
  const existing = document.getElementById(HOST_ID)
  if (!state) {
    existing?.remove()
    return true
  }
  const host = existing ?? document.createElement("div")
  if (!existing) {
    host.id = HOST_ID
    host.setAttribute("data-cognia-chrome", "1")
    // `all: initial` first, so nothing the page styles on a bare div leaks in.
    host.style.cssText =
      "all:initial;position:fixed;z-index:2147483647;left:50%;bottom:16px;transform:translateX(-50%);"
    document.documentElement.appendChild(host)
  }
  const root =
    (host as HTMLElement & { __cogniaRoot?: ShadowRoot }).__cogniaRoot ??
    host.attachShadow({ mode: "closed" })
  ;(host as HTMLElement & { __cogniaRoot?: ShadowRoot }).__cogniaRoot = root
  root.innerHTML = ""
  const style = document.createElement("style")
  style.textContent =
    ".bar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:999px;" +
    "font:500 13px system-ui,-apple-system,sans-serif;color:#fff;background:#1f2937;" +
    "box-shadow:0 6px 24px rgba(0,0,0,.25)}.dot{width:8px;height:8px;border-radius:50%;" +
    "background:#34d399}.paused .dot{background:#fbbf24}button{all:unset;cursor:pointer;" +
    "padding:4px 10px;border-radius:999px;background:rgba(255,255,255,.14)}" +
    "button:hover{background:rgba(255,255,255,.26)}button:focus-visible{outline:2px solid #93c5fd}"
  const bar = document.createElement("div")
  bar.className = state.takenOver ? "bar paused" : "bar"
  bar.setAttribute("role", "status")
  const dot = document.createElement("span")
  dot.className = "dot"
  const text = document.createElement("span")
  text.textContent = state.takenOver ? state.labels.paused : state.labels.acting
  const send = (action: "stop" | "takeover" | "resume") =>
    void chrome.runtime.sendMessage({
      kind: "cognia-agent-control",
      session: state.session,
      action,
    })
  const toggle = document.createElement("button")
  toggle.type = "button"
  toggle.textContent = state.takenOver ? state.labels.resume : state.labels.takeOver
  // Only a person's click: a synthetic one is the page (or the agent) trying
  // to press the person's own controls.
  toggle.addEventListener("click", (event) => {
    if (event.isTrusted) send(state.takenOver ? "resume" : "takeover")
  })
  const stop = document.createElement("button")
  stop.type = "button"
  stop.textContent = state.labels.stop
  stop.addEventListener("click", (event) => {
    if (event.isTrusted) send("stop")
  })
  bar.append(dot, text, toggle, stop)
  root.append(style, bar)
  return true
}
