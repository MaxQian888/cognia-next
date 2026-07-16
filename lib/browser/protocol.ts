/**
 * Shared types + pure helpers for the in-app browser preview.
 *
 * Event payloads mirror what `src-tauri/src/browser/{commands,overlay}.rs`
 * emits. `paneId` is the Tauri window/webview label; the element's own `id`
 * attribute is a separate field.
 */
import type { SubmittedFile } from "@/lib/chat/attachments/dispatch"

export const BROWSER_EVENTS = {
  /** Emitted when the user clicks an element in select mode. */
  elementSelected: "browser://element-selected",
  /** Emitted on each top-level navigation of the preview (nav *start*). */
  navigated: "browser://navigated",
  /** Emitted once a real document has finished loading (`window` `load`). */
  loaded: "browser://loaded",
  /** Emitted when a fresh agent snapshot is available. */
  snapshot: "browser://snapshot",
  /** Emitted when console output is captured. */
  console: "browser://console",
  /** Emitted when a network request is captured. */
  network: "browser://network",
} as const

export interface ElementRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ViewportSize {
  width: number
  height: number
}

export interface ContentArea {
  selector: string
  left: number
  right: number
  width: number
  centerX: number
}

export interface ParentLayout {
  display: "flex" | "grid"
  selector: string
  flexDirection?: string
  gridTemplateColumns?: string
  gap?: string
}

/**
 * Best-effort element→source mapping (tier 2). Populated only when the previewed
 * dev server emits `data-inspector-relative-path` / `-line` / `-column` on the
 * DOM (the react-dev-inspector convention); read verbatim from the node, so it
 * survives React 19 which dropped the fiber `_debugSource`.
 */
export interface SourceHint {
  path: string
  line: number
  column?: number
}

export interface BrowserSelection {
  paneId: string
  selector: string
  domPath: string
  tagName: string
  /** The element's `id` attribute, or null. */
  id: string | null
  classes: string | null
  rect: ElementRect
  outerHTML: string
  text: string
  pageUrl: string
  pageTitle: string
  viewport?: ViewportSize
  contentArea?: ContentArea
  parentLayout?: ParentLayout
  nearbyText?: string
  computedStyles?: Record<string, string>
  accessibility?: { role: string; name: string }
  devicePixelRatio?: number
  timestamp?: string
  // --- Component-aware enrichment (tier 1, React only) --------------------
  // Read from the DOM node's React fiber at pick time; absent on non-React
  // pages (the payload then degrades to the DOM-only fields above).
  /** Nearest owning component's display name, e.g. `"SubmitButton"`. */
  componentName?: string | null
  /** Outermost→innermost component chain, e.g. `"App > CheckoutForm > SubmitButton"`. */
  componentStack?: string | null
  /** Shallow, truncated `memoizedProps` of the owning component (primitives only). */
  props?: Record<string, string> | null
  /** Framework the enrichment came from, or null when undetected. */
  framework?: "react" | null
  /** Exact source location when the dev build emits inspector attributes (tier 2). */
  sourceHint?: SourceHint | null
  /** What the user targeted. Area selections intentionally carry empty element fields. */
  kind?: "element" | "area" | "text"
  /** Exact text represented by the browser's current Range. */
  selectedText?: string
  /** Explicit disclosure when per-element detail was reduced for a large batch. */
  detailReduced?: {
    selectionCount: number
    outerHTMLLimit: number
    reason: "multi-selection-budget"
  }
}

export type OutputDetailLevel = "compact" | "standard" | "detailed" | "forensic"

export interface BrowserSelectionSignal {
  paneId: string
  count: number
  generation: number
}

export interface BrowserNavigated {
  paneId: string
  url: string
}

/** Payload for `browser://loaded` — the preview finished loading a document. */
export interface BrowserLoaded {
  paneId: string
  url: string
}

/** Render a shallow props map as `key=value` pairs for the prompt. */
function formatProps(props: Record<string, string>): string {
  return Object.entries(props)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ")
}

/**
 * The closing directive that tells the agent how to reach the source: a precise
 * pointer when the dev build supplied an inspector source hint, otherwise the
 * component name as the resolution anchor, otherwise nothing (the agent falls
 * back to grepping by selector / outerHTML, the zero-config default).
 */
function resolutionDirective(sel: BrowserSelection): string | null {
  if (sel.sourceHint) {
    const { path, line } = sel.sourceHint
    return `Likely source: ${path}:${line} — start there.`
  }
  if (sel.componentName) {
    return `Rendered by the <${sel.componentName}> component; locate its definition (grep/LSP) and edit there.`
  }
  return null
}

function formatReferenceFrame(sel: BrowserSelection): string[] {
  if (!sel.viewport && !sel.contentArea && !sel.parentLayout) return []
  const lines = ["", "### Reference Frame"]
  if (sel.viewport) lines.push(`- Viewport: \`${sel.viewport.width}×${sel.viewport.height}px\``)
  if (sel.contentArea) {
    const area = sel.contentArea
    lines.push(
      `- Content area: \`${area.width}px\` wide, left edge at \`x=${area.left}\`, right at \`x=${area.right}\` (\`${area.selector}\`)`,
      "- Pixel → CSS translation:",
      `  - Horizontal position in container: \`element.x - ${area.left}\``,
      `  - Width as % of container: \`element.width / ${area.width} × 100\``,
      "  - Vertical gap: `nextElement.y - (prevElement.y + prevElement.height)`",
      `  - Centered when \`|element.centerX - ${area.centerX}| < 20px\`: use \`margin-inline: auto\``
    )
  } else if (sel.viewport) {
    lines.push(
      "- Pixel → CSS translation:",
      `  - Horizontal position in viewport: \`element.x / ${sel.viewport.width} × 100\``,
      `  - Width as % of viewport: \`element.width / ${sel.viewport.width} × 100\``,
      "  - Vertical position in viewport: `element.y / viewport.height × 100`"
    )
  }
  if (sel.parentLayout) {
    const layout = sel.parentLayout
    const details = [
      layout.flexDirection ? `flex-direction: \`${layout.flexDirection}\`` : null,
      layout.gridTemplateColumns
        ? `grid-template-columns: \`${layout.gridTemplateColumns}\``
        : null,
      layout.gap ? `gap: \`${layout.gap}\`` : null,
    ].filter(Boolean)
    lines.push(
      `- Parent: \`${layout.display}\`${details.length ? `, ${details.join(", ")}` : ""} (\`${layout.selector}\`)`
    )
  }
  return lines
}

/**
 * Compose the chat prompt for a selected element + the user's comment. Beyond
 * the DOM signals, it surfaces the owning React component (name / stack / props)
 * and any inspector source hint so the agent maps element→code precisely; the
 * closing directive points it straight at the source (see {@link resolutionDirective}).
 */
export function formatSelectionComment(
  sel: BrowserSelection,
  comment: string,
  level: OutputDetailLevel = "standard"
): string {
  if (level === "compact") {
    const source = sel.sourceHint
      ? `${sel.sourceHint.path}:${sel.sourceHint.line}`
      : sel.componentName
        ? `<${sel.componentName}>`
        : sel.selector
    return `${comment.trim()} — ${sel.tagName} (${source})`
  }
  const lines: string[] = [comment.trim(), "", "— Selected element (in-app browser) —"]
  lines.push(`Selector: ${sel.selector}`)
  if (sel.domPath) lines.push(`Path: ${sel.domPath}`)
  if (sel.componentName) lines.push(`Component: <${sel.componentName}>`)
  if (sel.componentStack) lines.push(`Component path: ${sel.componentStack}`)
  if (sel.sourceHint) {
    const { path, line, column } = sel.sourceHint
    lines.push(`Source: ${path}:${line}${column != null ? `:${column}` : ""}`)
  }
  if (sel.props && Object.keys(sel.props).length > 0) lines.push(`Props: ${formatProps(sel.props)}`)
  if (sel.text) lines.push(`Text: ${sel.text}`)
  if (level === "detailed" || level === "forensic") {
    if (sel.classes) lines.push(`Classes: ${sel.classes}`)
    lines.push(
      `Bounds: x=${sel.rect.x}, y=${sel.rect.y}, width=${sel.rect.width}, height=${sel.rect.height}`
    )
    if (sel.nearbyText) lines.push(`Nearby text: ${sel.nearbyText}`)
  }
  if (level === "forensic") {
    if (sel.computedStyles) lines.push(`Computed styles: ${formatProps(sel.computedStyles)}`)
    if (sel.accessibility) {
      lines.push(`Accessibility: role=${sel.accessibility.role}, name=${sel.accessibility.name}`)
    }
    const environment = [
      sel.devicePixelRatio != null ? `DPR=${sel.devicePixelRatio}` : null,
      sel.timestamp ? `timestamp=${sel.timestamp}` : null,
    ].filter(Boolean)
    if (environment.length) lines.push(`Environment: ${environment.join(", ")}`)
  }
  lines.push(`Page: ${sel.pageUrl}`)
  if (sel.outerHTML) {
    lines.push("HTML:", "```html", sel.outerHTML, "```")
  }
  lines.push(...formatReferenceFrame(sel))
  const directive = resolutionDirective(sel)
  if (directive) lines.push("", directive)
  return lines.join("\n")
}

/** Compose one prompt for an element/area/text selection batch. */
export function formatSelectionsComment(
  selections: BrowserSelection[],
  comment: string,
  level: OutputDetailLevel = "standard"
): string {
  if (selections.length === 0) return comment.trim()
  if (selections.length === 1) return formatSelectionComment(selections[0], comment, level)

  const lines = [comment.trim(), "", `— Selected targets (in-app browser): ${selections.length} —`]
  selections.forEach((selection, index) => {
    const label =
      selection.kind === "area" ? "Area" : selection.kind === "text" ? "Text range" : "Element"
    lines.push("", `### ${index + 1}. ${label}`)
    const formatted = formatSelectionComment(selection, "", level)
    const body = formatted.split("\n").slice(2)
    lines.push(...body)
    if (selection.selectedText) lines.push(`Selected text: ${selection.selectedText}`)
    if (selection.detailReduced) {
      lines.push(
        `Detail reduced: outerHTML capped at ${selection.detailReduced.outerHTMLLimit} characters because ${selection.detailReduced.selectionCount} targets were selected.`
      )
    }
  })
  return lines.join("\n")
}

/**
 * Whether a hostname is local/private by convention (dev servers, LAN) —
 * these are typically served over plain http. Public hosts get https.
 */
export function isLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  return (
    h === "localhost" ||
    h === "::1" ||
    h === "0.0.0.0" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  )
}

/**
 * Normalize a user-typed address into a loadable http(s) URL. A bare host
 * defaults to `https://` for public hosts and `http://` for local/private ones
 * (dev servers). Returns null for empty/unparseable input.
 */
export function normalizePreviewUrl(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  try {
    if (/^https?:\/\//i.test(trimmed)) return new URL(trimmed).toString()
    const probe = new URL(`http://${trimmed}`)
    const scheme = isLocalHostname(probe.hostname) ? "http" : "https"
    return new URL(`${scheme}://${trimmed}`).toString()
  } catch {
    return null
  }
}

/** Wrap a base64 PNG (from `browser_embed_capture`) as a composer attachment. */
export function screenshotToFile(base64Png: string, filename = "preview.png"): SubmittedFile {
  return {
    url: `data:image/png;base64,${base64Png}`,
    mediaType: "image/png",
    filename,
  }
}

// ---------------------------------------------------------------------------
// Agent browser loop (Phase 1) — canonical types shared by both engines so the
// model's tool surface stays engine-agnostic. See ADR-0055.
// ---------------------------------------------------------------------------

export type TrustTier = "trusted" | "public"

/**
 * Classify a target URL. Loopback hosts (localhost/127.0.0.1/::1) are the
 * trusted dev-preview tier and route to the embedded webview; everything else
 * is public. Fail-closed: unparseable input is treated as public.
 */
export function resolveTrustTier(url: string): TrustTier {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "")
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return "trusted"
    return "public"
  } catch {
    return "public"
  }
}

/** One ref'd node in an agent snapshot of the page's accessibility tree. */
export interface SnapshotNode {
  ref: string
  role: string
  name: string
  tag: string
  rect: ElementRect
  value: string | null
  state: { disabled: boolean; checked: boolean | null; expanded: boolean | null }
  /**
   * True when the node lives inside a (same-origin) iframe. Its `rect` is then
   * frame-relative — act on it by `ref`, not by coordinate.
   */
  frame?: boolean
}

/** Options for `browser_snapshot`. */
export interface SnapshotOptions {
  /** Also surface salient non-interactive text (headings, list items, …). */
  includeText?: boolean
}

/** Result of `browser_evaluate` — the page helper's value/error envelope. */
export interface EvaluateResult {
  ok: boolean
  value?: unknown
  error?: string
}

/** In-flight + completed request counters from the embedded page. */
export interface NetworkState {
  pending: number
  completed: number
}

/** A full accessibility-tree snapshot the model acts against by `ref`. */
export interface BrowserSnapshot {
  generation: number
  url: string
  title: string
  nodes: SnapshotNode[]
}

/** Result of a `browser_*` mutating action. `generation` is the live tree id. */
export interface BrowserActionResult {
  ok: boolean
  error: string | null
  generation: number
}

/** A captured console line from the previewed page. */
export interface ConsoleEntry {
  level: "log" | "info" | "warn" | "error" | "debug"
  text: string
  ts: number
}

/** A captured network request (status/timing only — not the response body). */
export interface NetworkEntry {
  url: string
  method: string
  status: number
  ok: boolean
  durationMs: number | null
}
