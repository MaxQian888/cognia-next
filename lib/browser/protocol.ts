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
