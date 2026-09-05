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
  { kind: "markdown"; lines: MdLine[] } | { kind: "text"; lines: string[] }

/**
 * Turn a raw document body into renderable lines. `markdown` runs the markdown
 * tokenizer; `text` is highlighted as a whole (so multi-line constructs colour
 * correctly) then split — highlight.js closes its spans at line boundaries, so
 * each split line is self-contained ANSI.
 */
export function prepareDocumentLines(
  body: string,
  format: DocumentFormat,
  lang?: string,
  panelTitle?: string
): PreparedLines {
  if (format === "markdown") {
    const lines = tokenizeMarkdown(body)
    // The panel already labels the document. Only elide its matching opening
    // heading, never a later section, distinct title, or link with its own target.
    // Work on parsed spans so emphasis, inline code, and Setext headings compare
    // by visible text; the original body remains intact for copy/export.
    const first = lines.findIndex((line) => line.kind !== "blank")
    const heading = lines[first]
    const normalize = (text: string) => text.trim().replace(/\s+/g, " ")
    if (
      panelTitle &&
      heading?.kind === "heading" &&
      !heading.spans.some((span) => span.link) &&
      normalize(heading.spans.map((span) => span.text).join("")) === normalize(panelTitle)
    ) {
      let start = first + 1
      while (lines[start]?.kind === "blank") start++
      return { kind: "markdown", lines: lines.slice(start) }
    }
    return { kind: "markdown", lines }
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

/** Keep the visible text anchored across revisions; use the nearest matching row
 * when repeated text occurs, and clamp when the old anchor was removed. Width
 * changes preserve the character offset when the rendered text is unchanged. */
export function relocateDocumentScroll(
  previous: readonly string[],
  next: readonly string[],
  scroll: number,
  viewport: number
): number {
  const oldStart = clampScroll(scroll, previous.length, 1)
  if (oldStart === 0) return 0
  if (previous.join("") === next.join("")) {
    let offset = previous.slice(0, oldStart).join("").length
    let row = 0
    while (row < next.length - 1 && offset >= next[row].length) {
      offset -= next[row].length
      row++
    }
    return clampScroll(row, next.length, viewport)
  }
  const anchor = previous[oldStart]
  let target = -1
  if (anchor?.trim()) {
    next.forEach((line, i) => {
      if (line === anchor && (target < 0 || Math.abs(i - oldStart) < Math.abs(target - oldStart))) {
        target = i
      }
    })
  }
  return clampScroll(target < 0 ? oldStart : target, next.length, viewport)
}
