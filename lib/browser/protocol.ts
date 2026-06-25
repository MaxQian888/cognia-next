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
  /** Emitted on each top-level navigation of the preview. */
  navigated: "browser://navigated",
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
}

export interface BrowserNavigated {
  paneId: string
  url: string
}

/**
 * Compose the chat prompt for a selected element + the user's comment. The
 * agent uses the selector / dom path / outerHTML to grep the project source
 * (zero-config fuzzy mapping — no source-location plugin required).
 */
export function formatSelectionComment(sel: BrowserSelection, comment: string): string {
  const lines: string[] = [comment.trim(), "", "— Selected element (in-app browser) —"]
  lines.push(`Selector: ${sel.selector}`)
  if (sel.domPath) lines.push(`Path: ${sel.domPath}`)
  if (sel.text) lines.push(`Text: ${sel.text}`)
  lines.push(`Page: ${sel.pageUrl}`)
  if (sel.outerHTML) {
    lines.push("HTML:", "```html", sel.outerHTML, "```")
  }
  return lines.join("\n")
}

/**
 * Normalize a user-typed address into a loadable http(s) URL, defaulting a
 * bare host to `http://`. Returns null for empty/unparseable input.
 */
export function normalizePreviewUrl(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  try {
    return new URL(withScheme).toString()
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
