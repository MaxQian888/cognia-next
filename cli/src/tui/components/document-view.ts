/**
 * Pure helpers for the scrollable {@link DocumentViewer} pager — line
 * preparation, scroll clamping, windowing, and the position label. Kept Ink-free
 * so the scroll math is unit-tested without rendering.
 */
import { highlightCode } from "../markdown/highlight"
import { tokenizeMarkdown } from "../markdown/tokenize"
import type { MdLine } from "../markdown/types"
import type { DocumentFormat } from "../state/types"

/** Markdown bodies tokenize to structured lines; text bodies stay as strings. */
export type PreparedLines =
  | { kind: "markdown"; lines: MdLine[] }
  | { kind: "text"; lines: string[] }

/**
 * Turn a raw document body into renderable lines. `markdown` runs the markdown
 * tokenizer; `text` is highlighted as a whole (so multi-line constructs colour
 * correctly) then split — highlight.js closes its spans at line boundaries, so
 * each split line is self-contained ANSI.
 */
export function prepareDocumentLines(
  body: string,
  format: DocumentFormat,
  lang?: string
): PreparedLines {
  if (format === "markdown") {
    return { kind: "markdown", lines: tokenizeMarkdown(body) }
  }
  const rendered = lang ? highlightCode(body, lang) : body
  // Drop a single trailing newline so the viewer doesn't show a blank tail row.
  const trimmed = rendered.endsWith("\n") ? rendered.slice(0, -1) : rendered
  return { kind: "text", lines: trimmed.split("\n") }
}

/** Number of rendered lines, for scroll math. */
export function lineCount(prepared: PreparedLines): number {
  return prepared.lines.length
}

/** Largest valid scroll offset for `total` lines in a `viewport`-row window. */
export function maxScroll(total: number, viewport: number): number {
  return Math.max(0, total - Math.max(1, viewport))
}

/** Clamp a desired scroll offset into `[0, maxScroll]`. */
export function clampScroll(scroll: number, total: number, viewport: number): number {
  if (!Number.isFinite(scroll) || scroll < 0) return 0
  return Math.min(Math.floor(scroll), maxScroll(total, viewport))
}

/**
 * A compact position indicator for the viewer footer, e.g. `1–20 / 153` or
 * `all` when the whole document fits the viewport.
 */
export function positionLabel(scroll: number, viewport: number, total: number): string {
  if (total === 0) return "empty"
  const win = Math.max(1, viewport)
  if (total <= win) return "all"
  const start = clampScroll(scroll, total, win)
  const end = Math.min(total, start + win)
  return `${start + 1}–${end} / ${total}`
}
