/**
 * Point at an element and describe it — the artifact preview's half of the
 * "select this thing and change it" loop.
 *
 * ## Why this is not the browser's picker
 *
 * `lib/browser/overlay.injected.js` already picks elements, and this module
 * deliberately does not reuse it. That file is a 3 155-line ES5 IIFE that Rust
 * `include_str!`s into a *native webview*: it patches `window.setTimeout` /
 * `setInterval` / `requestAnimationFrame`, can freeze the page mid-animation,
 * carries a flow recorder and a marquee area-selector, and reports picks by
 * filling a page-side buffer that Rust drains over a Tauri event. None of that
 * is importable as a module, and none of it applies to an iframe. What IS
 * shared is the part that matters — the payload vocabulary
 * (`types/element-selection.ts`) and the two algorithms below — and
 * `element-pick.parity.test.ts` evaluates the real overlay file in jsdom and
 * asserts this module agrees with it on the same DOM, so the two cannot drift
 * silently.
 *
 * ## Why one module serves two very different hosts
 *
 * An artifact renders in one of three ways (`components/artifacts/runtime-adapters.ts`),
 * and they differ in whether the app can reach the rendered DOM at all:
 *
 * - `renderer` types (code / document / mermaid / chart / math) and `jupyter`
 *   draw as live React in the host tree — the app owns those nodes outright;
 * - `html` and `svg` render into an `allow-same-origin` iframe that the parent
 *   *writes* (`renderHTML(doc, …)` in `artifact-preview.tsx`), so the parent
 *   owns that document too;
 * - `react` and interactive `html` render into an `allow-scripts`, opaque-origin
 *   iframe the parent cannot touch at all (ADR-0158).
 *
 * The first two are the same problem — "install a picker on a Document you can
 * reach" — and the third is that same problem executed on the other side of a
 * postMessage boundary. So this module takes the target `Document` as an
 * argument and is bundled into BOTH the app and the in-frame shell
 * (`artifact-shell-entry.ts`). It is therefore written to be hermetic: no
 * imports that survive compilation, no `@/` alias, no framework, and — the one
 * that actually bites — **no reference to the ambient `window`**. In the
 * same-origin iframe case the target document's view is the *frame's* window,
 * not the app's, so reading `window.innerWidth` here would silently describe
 * the wrong viewport and `getComputedStyle` would throw on a foreign node.
 * Every view-dependent read goes through `doc.defaultView`.
 */

import type {
  ContentArea,
  ElementRect,
  ElementSelectionCore,
  ElementSourceHint,
  ParentLayout,
} from "../../../types/element-selection"

/** Budgets, matching `lib/browser/overlay.injected.js` so payloads read alike. */
const MAX_OUTER_HTML = 4000
const MAX_TEXT = 200
const MAX_NEARBY_TEXT = 500
const MAX_STACK_DEPTH = 6
const MAX_PROPS_KEYS = 8
const MAX_PROPS_TOTAL = 400
const MAX_PROP_VALUE = 80
const SOURCE_ATTR_DEPTH = 3

/**
 * Marks every node this module injects into the target document.
 *
 * Load-bearing twice over: the picker must not offer its own highlight as a
 * pick target, and `buildElementSelection` must not capture it inside an
 * ancestor's `outerHTML` — a selection whose markup contained the picker's own
 * chrome would be markup the artifact does not actually have, and the model
 * would be asked to edit a box that only exists while the cursor is down.
 */
export const PICKER_NODE_ATTRIBUTE = "data-cognia-picker"

/** Detail levels shrink `outerHTML` as more elements are picked at once. */
export function outerHtmlLimit(selectionCount: number): number {
  if (selectionCount <= 1) return MAX_OUTER_HTML
  if (selectionCount <= 3) return 2000
  return 800
}

function truncate(value: unknown, max: number): string {
  if (typeof value !== "string") return ""
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function collapse(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim()
}

function cssEscape(view: (Window & typeof globalThis) | null, value: string): string {
  const css = view?.CSS
  if (css && typeof css.escape === "function") return css.escape(value)
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&")
}

function nthOfType(node: Element): number {
  let index = 1
  let sibling = node.previousElementSibling
  while (sibling) {
    if (sibling.tagName === node.tagName) index++
    sibling = sibling.previousElementSibling
  }
  return index
}

/**
 * A stable CSS selector: walk up to the nearest ancestor carrying an id (or to
 * `<html>`), naming each step by tag plus `:nth-of-type` so the path stays
 * unique in a document with no ids at all.
 *
 * Mirrors the overlay's algorithm exactly — including stopping *at* the id
 * rather than continuing past it, and omitting `:nth-of-type(1)`.
 */
export function cssSelector(el: Element | null, view?: Window | null): string {
  if (!el || el.nodeType !== 1) return ""
  const scope = (view ?? el.ownerDocument?.defaultView ?? null) as
    (Window & typeof globalThis) | null
  const parts: string[] = []
  let node: Element | null = el
  while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== "html") {
    const tag = node.tagName.toLowerCase()
    if (node.id) {
      parts.unshift(`#${cssEscape(scope, node.id)}`)
      break
    }
    const nth = nthOfType(node)
    parts.unshift(nth > 1 ? `${tag}:nth-of-type(${nth})` : tag)
    node = node.parentElement
  }
  return parts.join(" > ")
}

/**
 * The short human-readable path the prompt shows — `div.card > button#submit`.
 * Bounded to six levels and stopped at `body`, because its job is to orient a
 * reader, not to re-identify the node (that is `cssSelector`'s job).
 */
export function domPath(el: Element | null): string {
  if (!el || el.nodeType !== 1) return ""
  const parts: string[] = []
  let node: Element | null = el
  let depth = 0
  while (node && node.nodeType === 1 && depth < 6) {
    const tag = node.tagName.toLowerCase()
    if (tag === "html" || tag === "body") break
    let label = tag
    if (node.id) label += `#${node.id}`
    else if (node.classList && node.classList.length) label += `.${node.classList[0]}`
    parts.unshift(label)
    node = node.parentElement
    depth++
  }
  return parts.join(" > ")
}

function roundRect(rect: {
  left: number
  top: number
  width: number
  height: number
}): ElementRect {
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
}

function computedStyleOf(
  view: (Window & typeof globalThis) | null,
  el: Element
): CSSStyleDeclaration | null {
  if (!view || typeof view.getComputedStyle !== "function") return null
  try {
    return view.getComputedStyle(el)
  } catch {
    // A detached node, or a view torn down mid-pick.
    return null
  }
}

function readParentLayout(
  view: (Window & typeof globalThis) | null,
  el: Element
): ParentLayout | null {
  const parent = el.parentElement
  if (!parent) return null
  const style = computedStyleOf(view, parent)
  if (!style) return null
  if (style.display !== "flex" && style.display !== "grid") return null
  const layout: ParentLayout = {
    display: style.display,
    selector: truncate(cssSelector(parent, view), 80),
  }
  if (style.display === "flex" && style.flexDirection) layout.flexDirection = style.flexDirection
  if (style.display === "grid" && style.gridTemplateColumns) {
    layout.gridTemplateColumns = truncate(style.gridTemplateColumns, 60)
  }
  if (style.gap && style.gap !== "normal" && style.gap !== "0px") layout.gap = style.gap
  return layout
}

function readContentArea(
  doc: Document,
  view: (Window & typeof globalThis) | null
): ContentArea | null {
  const container = doc.querySelector("main") ?? widestChild(doc)
  if (!container) return null
  const rect = container.getBoundingClientRect()
  if (!rect.width) return null
  return {
    selector: truncate(cssSelector(container, view), 80),
    left: Math.round(rect.left),
    right: Math.round(rect.right),
    width: Math.round(rect.width),
    centerX: Math.round(rect.left + rect.width / 2),
  }
}

function widestChild(doc: Document): Element | null {
  const children = doc.body ? Array.from(doc.body.children) : []
  let widest: Element | null = null
  let widestWidth = 0
  for (const child of children) {
    if (child.hasAttribute(PICKER_NODE_ATTRIBUTE)) continue
    const width = child.getBoundingClientRect().width
    if (width > widestWidth) {
      widestWidth = width
      widest = child
    }
  }
  return widest
}

const COMPUTED_STYLE_KEYS = [
  "display",
  "position",
  "width",
  "height",
  "margin",
  "padding",
  "gap",
  "color",
  "backgroundColor",
  "fontSize",
  "fontWeight",
] as const

function readComputedStyles(
  view: (Window & typeof globalThis) | null,
  el: Element
): Record<string, string> | null {
  const style = computedStyleOf(view, el)
  if (!style) return null
  const result: Record<string, string> = {}
  for (const key of COMPUTED_STYLE_KEYS) {
    const value = style[key as unknown as keyof CSSStyleDeclaration]
    if (typeof value === "string" && value) result[key] = truncate(value, 80)
  }
  return result
}

const INTERACTIVE_ROLES: Record<string, string> = {
  a: "link",
  button: "button",
  select: "combobox",
  textarea: "textbox",
  summary: "button",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  img: "img",
  nav: "navigation",
  main: "main",
  form: "form",
}

function roleOf(el: Element): string {
  const explicit = el.getAttribute?.("role")
  if (explicit) return explicit
  const tag = el.tagName.toLowerCase()
  if (tag === "input") {
    const type = (el.getAttribute("type") || "text").toLowerCase()
    if (type === "checkbox") return "checkbox"
    if (type === "radio") return "radio"
    if (type === "button" || type === "submit") return "button"
    if (type === "hidden") return ""
    return "textbox"
  }
  return INTERACTIVE_ROLES[tag] ?? ""
}

function accessibleName(el: Element): string {
  const label = el.getAttribute?.("aria-label")
  if (label) return truncate(label, MAX_TEXT)
  if (el.tagName.toLowerCase() === "input") {
    const placeholder = el.getAttribute("placeholder")
    if (placeholder) return truncate(placeholder, MAX_TEXT)
  }
  return truncate(collapse(el.textContent), MAX_TEXT)
}

// --- React enrichment -------------------------------------------------------
// Best-effort by construction: a broken fiber tree, a non-React artifact, or a
// future React internals rename must degrade to a DOM-only payload, never fail
// the pick. Every read below is inside the caller's try/catch.

interface FiberLike {
  type?: unknown
  return?: FiberLike | null
  memoizedProps?: Record<string, unknown> | null
}

function reactFiberOf(el: Element): FiberLike | null {
  for (const key of Object.keys(el)) {
    if (key.startsWith("__reactFiber$")) {
      return (el as unknown as Record<string, FiberLike>)[key] ?? null
    }
  }
  return null
}

function displayNameOf(type: unknown): string | null {
  if (typeof type === "function") {
    const fn = type as { displayName?: string; name?: string }
    return fn.displayName || fn.name || null
  }
  if (type && typeof type === "object") {
    const wrapper = type as { displayName?: string; render?: unknown; type?: unknown }
    if (wrapper.displayName) return wrapper.displayName
    if (wrapper.render) return displayNameOf(wrapper.render) // forwardRef
    if (wrapper.type) return displayNameOf(wrapper.type) // memo
  }
  return null
}

/**
 * Shallow, bounded snapshot of a component's props: primitives only, values
 * truncated, handlers skipped, nested values flattened to a marker. Returns
 * null when nothing survives, so "no useful props" and "no component" stay
 * distinguishable from `{}`.
 */
export function shallowProps(props: unknown): Record<string, string> | null {
  if (!props || typeof props !== "object") return null
  const out: Record<string, string> = {}
  let count = 0
  let total = 0
  for (const key of Object.keys(props as Record<string, unknown>)) {
    if (count >= MAX_PROPS_KEYS || total >= MAX_PROPS_TOTAL) break
    if (key === "children") continue
    const value = (props as Record<string, unknown>)[key]
    let rendered: string
    if (value === null) rendered = "null"
    else if (typeof value === "string") rendered = truncate(value, MAX_PROP_VALUE)
    else if (typeof value === "number" || typeof value === "boolean") rendered = String(value)
    else if (typeof value === "function") continue
    else if (typeof value === "object") {
      if ((value as { $$typeof?: unknown }).$$typeof) continue // React element/portal
      rendered = Array.isArray(value) ? "[Array]" : "[Object]"
    } else continue
    out[key] = rendered
    total += key.length + rendered.length
    count++
  }
  return count ? out : null
}

function componentInfo(
  el: Element
): { name: string | null; stack: string | null; props: Record<string, string> | null } | null {
  const fiber = reactFiberOf(el)
  if (!fiber) return null
  const names: string[] = []
  let ownerFiber: FiberLike | null = null
  let node: FiberLike | null = fiber
  let guard = 0
  while (node && guard < 80 && names.length < MAX_STACK_DEPTH) {
    guard++
    const type = node.type
    if (type && typeof type !== "string") {
      const name = displayNameOf(type)
      if (name) {
        if (!ownerFiber) ownerFiber = node
        if (names[names.length - 1] !== name) names.push(name)
      }
    }
    node = node.return ?? null
  }
  if (!names.length) return { name: null, stack: null, props: null }
  return {
    name: names[0],
    stack: names.length > 1 ? names.slice().reverse().join(" > ") : null,
    props: ownerFiber ? shallowProps(ownerFiber.memoizedProps) : null,
  }
}

function readSourceHint(el: Element): ElementSourceHint | null {
  let node: Element | null = el
  let depth = 0
  while (node && node.nodeType === 1 && depth < SOURCE_ATTR_DEPTH) {
    const path = node.getAttribute?.("data-inspector-relative-path")
    const rawLine = node.getAttribute?.("data-inspector-line")
    if (path && rawLine) {
      const line = Number.parseInt(rawLine, 10)
      if (!Number.isNaN(line)) {
        const column = Number.parseInt(node.getAttribute("data-inspector-column") ?? "", 10)
        const hint: ElementSourceHint = { path: truncate(path, 300), line }
        if (!Number.isNaN(column)) hint.column = column
        return hint
      }
    }
    node = node.parentElement
    depth++
  }
  return null
}

export interface BuildElementSelectionOptions {
  /**
   * How many elements this pick is part of. Drives the `outerHTML` budget, so
   * a five-element pick cannot bury the prompt in markup.
   */
  selectionCount?: number
  /** What the prompt heading calls this element's origin. */
  originLabel?: string
}

/**
 * Describe one element as an {@link ElementSelectionCore}.
 *
 * Never throws: enrichment is wrapped, and every optional field is genuinely
 * optional. The DOM-only core (selector, path, rect, markup, text) is what the
 * caller is guaranteed.
 */
export function buildElementSelection(
  el: Element,
  options: BuildElementSelectionOptions = {}
): ElementSelectionCore {
  const doc = el.ownerDocument
  const view = (doc?.defaultView ?? null) as (Window & typeof globalThis) | null
  const selectionCount = options.selectionCount ?? 1
  const limit = outerHtmlLimit(selectionCount)

  const selection: ElementSelectionCore = {
    selector: cssSelector(el, view),
    domPath: domPath(el),
    tagName: el.tagName.toLowerCase(),
    id: el.id || null,
    classes: typeof el.className === "string" && el.className ? el.className : null,
    rect: roundRect(el.getBoundingClientRect()),
    outerHTML: truncate(el.outerHTML, limit),
    text: truncate(collapse(el.textContent), MAX_TEXT),
    nearbyText: truncate(collapse(el.parentElement?.textContent), MAX_NEARBY_TEXT),
    accessibility: { role: roleOf(el), name: accessibleName(el) },
    timestamp: new Date().toISOString(),
  }
  if (options.originLabel) selection.originLabel = options.originLabel

  if (view) {
    selection.viewport = {
      width: Math.round(view.innerWidth),
      height: Math.round(view.innerHeight),
    }
    selection.devicePixelRatio = view.devicePixelRatio || 1
  }
  const styles = readComputedStyles(view, el)
  if (styles) selection.computedStyles = styles
  const parentLayout = readParentLayout(view, el)
  if (parentLayout) selection.parentLayout = parentLayout
  if (doc) {
    const contentArea = readContentArea(doc, view)
    if (contentArea) selection.contentArea = contentArea
  }
  if (selectionCount > 1) {
    selection.detailReduced = {
      selectionCount,
      outerHTMLLimit: limit,
      reason: "multi-selection-budget",
    }
  }

  try {
    const info = componentInfo(el)
    if (info) {
      if (info.name) selection.componentName = info.name
      if (info.stack) selection.componentStack = info.stack
      if (info.props) selection.props = info.props
      selection.framework = "react"
    }
    const hint = readSourceHint(el)
    if (hint) selection.sourceHint = hint
  } catch {
    // Enrichment is additive — ship the DOM-only payload.
  }

  return selection
}

// --- The picker itself ------------------------------------------------------

/** How the highlight reads, in the target document's own stylesheet-free world. */
const HIGHLIGHT_STYLE = [
  "position:fixed",
  "z-index:2147483646",
  "pointer-events:none",
  "border:2px solid #6366f1",
  "border-radius:3px",
  "background:rgba(99,102,241,0.14)",
  "box-shadow:0 0 0 1px rgba(255,255,255,0.5)",
  "top:0",
  "left:0",
  "will-change:transform,width,height",
].join(";")

const LABEL_STYLE = [
  "position:fixed",
  "z-index:2147483647",
  "pointer-events:none",
  "padding:2px 6px",
  "border-radius:4px",
  "background:#6366f1",
  "color:#fff",
  "font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace",
  "white-space:nowrap",
  "max-width:60vw",
  "overflow:hidden",
  "text-overflow:ellipsis",
  "top:0",
  "left:0",
].join(";")

export interface ElementPickerOptions {
  /** Called with the built payload when the user commits a pick. */
  onPick: (selection: ElementSelectionCore, event: { metaKey: boolean; ctrlKey: boolean }) => void
  /** Called when the user aborts with Escape. */
  onCancel?: () => void
  /** Stamped onto every payload this picker produces. */
  originLabel?: string
}

/**
 * Arm the in-document picker on `doc`, returning a disposer.
 *
 * The disposer is the whole contract: callers arm on toggle-on and MUST call it
 * on toggle-off, on unmount, and before the document is rewritten. The picker
 * installs capture-phase listeners that swallow clicks, so a leaked picker
 * makes the artifact permanently uninteractive — the failure mode is loud but
 * only for the user, never for a test.
 *
 * Motion: the highlight tweens between elements rather than teleporting,
 * because the box IS the feedback — a jump gives the eye nothing to follow
 * across a dense layout. The target document has no app stylesheet, so the
 * `prefers-reduced-motion` kill switch in `app/globals.css` cannot reach it and
 * the query is made here against the document's own view.
 */
export function installElementPicker(doc: Document, options: ElementPickerOptions): () => void {
  const view = (doc.defaultView ?? null) as (Window & typeof globalThis) | null
  const host = doc.body ?? doc.documentElement
  if (!host) return () => {}

  const reduceMotion = (() => {
    try {
      return view?.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
    } catch {
      return false
    }
  })()
  const motion = reduceMotion
    ? ""
    : ";transition:transform 90ms ease-out,width 90ms ease-out,height 90ms ease-out"

  const highlight = doc.createElement("div")
  highlight.setAttribute(PICKER_NODE_ATTRIBUTE, "highlight")
  highlight.style.cssText = `${HIGHLIGHT_STYLE};opacity:0${motion}`
  const label = doc.createElement("div")
  label.setAttribute(PICKER_NODE_ATTRIBUTE, "label")
  label.style.cssText = `${LABEL_STYLE};opacity:0`
  host.appendChild(highlight)
  host.appendChild(label)

  let current: Element | null = null

  /** The picker's own nodes are never pick targets. */
  const isPickerNode = (node: Element | null): boolean =>
    !!node?.closest?.(`[${PICKER_NODE_ATTRIBUTE}]`)

  const paint = (el: Element | null) => {
    current = el
    if (!el) {
      highlight.style.opacity = "0"
      label.style.opacity = "0"
      return
    }
    const rect = el.getBoundingClientRect()
    highlight.style.opacity = "1"
    highlight.style.transform = `translate(${rect.left}px, ${rect.top}px)`
    highlight.style.width = `${rect.width}px`
    highlight.style.height = `${rect.height}px`

    // The chip names the element by its most useful identity, and carries no
    // prose — so it needs no translation inside a frame that has no next-intl.
    const info = (() => {
      try {
        return componentInfo(el)
      } catch {
        return null
      }
    })()
    label.textContent = info?.name ? `<${info.name}>` : domPath(el) || el.tagName.toLowerCase()
    label.style.opacity = "1"
    // Above the element, unless that would leave the viewport — then inside it.
    const labelTop = rect.top > 20 ? rect.top - 18 : rect.top + 2
    label.style.transform = `translate(${Math.max(0, rect.left)}px, ${Math.max(0, labelTop)}px)`
  }

  const onPointerMove = (event: Event) => {
    const target = event.target as Element | null
    if (!target || target.nodeType !== 1 || isPickerNode(target)) return
    if (target !== current) paint(target)
  }

  const onPointerLeave = () => paint(null)

  const onClick = (event: MouseEvent) => {
    const target = event.target as Element | null
    if (!target || target.nodeType !== 1 || isPickerNode(target)) return
    // Capture phase + all three, because the artifact's own handlers must not
    // also fire: picking a button in a live React artifact would otherwise
    // submit its form while selecting it.
    event.preventDefault()
    event.stopPropagation()
    options.onPick(buildElementSelection(target, { originLabel: options.originLabel }), {
      metaKey: event.metaKey === true,
      ctrlKey: event.ctrlKey === true,
    })
  }

  /** Swallow the press/release too, or the artifact still sees a full click. */
  const swallow = (event: Event) => {
    const target = event.target as Element | null
    if (isPickerNode(target)) return
    event.preventDefault()
    event.stopPropagation()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return
    event.preventDefault()
    event.stopPropagation()
    options.onCancel?.()
  }

  doc.addEventListener("pointermove", onPointerMove, true)
  doc.addEventListener("pointerleave", onPointerLeave, true)
  doc.addEventListener("click", onClick, true)
  doc.addEventListener("mousedown", swallow, true)
  doc.addEventListener("mouseup", swallow, true)
  doc.addEventListener("keydown", onKeyDown, true)

  const previousCursor = doc.documentElement?.style.cursor ?? ""
  if (doc.documentElement) doc.documentElement.style.cursor = "crosshair"

  return () => {
    doc.removeEventListener("pointermove", onPointerMove, true)
    doc.removeEventListener("pointerleave", onPointerLeave, true)
    doc.removeEventListener("click", onClick, true)
    doc.removeEventListener("mousedown", swallow, true)
    doc.removeEventListener("mouseup", swallow, true)
    doc.removeEventListener("keydown", onKeyDown, true)
    if (doc.documentElement) doc.documentElement.style.cursor = previousCursor
    highlight.remove()
    label.remove()
    current = null
  }
}
