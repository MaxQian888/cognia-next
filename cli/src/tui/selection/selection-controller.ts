/**
 * The imperative half of in-app text selection: turn mouse gestures into a
 * {@link Selection}, paint it on the terminal, and hand the text to the
 * clipboard.
 *
 * It is deliberately NOT a React hook. A drag emits a motion report per cell the
 * pointer crosses; routing each of those through `setState` would re-render the
 * whole Ink tree dozens of times per second for a highlight that isn't part of
 * the React tree at all. Instead the controller keeps the live selection in
 * closure state and repaints only the affected rows straight to the terminal —
 * so dragging costs a handful of escape bytes and zero renders. The App only
 * hears about it once, when a completed gesture copies.
 *
 * Ink owns the same screen, so every committed frame wipes the highlight; the
 * controller re-applies it from {@link FrameBuffer.onFrame}. That also makes the
 * repaint self-healing: whatever Ink draws, the selection is re-asserted on top.
 */
import { highlightColumns } from "./ansi-columns"
import {
  nextGranularity,
  selectionSpans,
  selectionText,
  type Point,
  type RowSpan,
  type Selection,
  type SelectionGranularity,
} from "./text-selection"
import type { FrameBuffer } from "./frame-buffer"
import type { MouseEvent } from "../input/mouse"
import type { CopyResult } from "../clipboard"
import type { SelectionMode } from "../../config/schema"

/** Save / restore the hardware cursor (DEC private, honoured far more widely
 * than `CSI s` / `CSI u`). The repaint must leave the cursor exactly where Ink
 * left it, or `log-update`'s next erase rewinds from the wrong row. */
const SAVE_CURSOR = "\x1b7"
const RESTORE_CURSOR = "\x1b8"
/** Erase from the cursor to the end of the line — clears the tail of a row whose
 * repaint is narrower than what was there (restoring a padded highlight). */
const ERASE_TO_EOL = "\x1b[K"

/** Move the cursor to the start of a 0-based frame row (terminal rows are 1-based). */
function moveToRow(row: number): string {
  return `\x1b[${row + 1};1H`
}

export interface SelectionControllerDeps {
  /** The captured Ink frame — the surface a selection is taken from. */
  frames: FrameBuffer
  /** Live selection mode. Read on every event, so `/select` applies without
   * re-creating the controller. */
  mode: () => SelectionMode
  /** Clipboard writer (the App's `copyClipboard`, so OSC 52 config applies). */
  copy: (text: string) => Promise<CopyResult> | CopyResult
  /** Report a completed copy — the App turns it into a notice. */
  onCopied: (chars: number) => void
  /** Report a failed copy, with the reason the clipboard gave. */
  onCopyFailed: (reason: "unavailable" | "too-large") => void
  /** Injected clock for the double / triple-click window (deterministic in tests). */
  now: () => number
}

export interface SelectionController {
  /**
   * Feed a decoded mouse event. Returns true when the selection consumed it, so
   * the caller stops before its own click handling. A first, unmodified press
   * is deliberately NOT consumed: it only arms the anchor, leaving single-click
   * behaviour (footer pickers, click-to-expand, composer cursor) untouched.
   */
  handleMouse: (event: MouseEvent) => boolean
  /** Whether a selection is currently painted. */
  hasSelection: () => boolean
  /** Copy the current selection. Returns false when nothing is selected. */
  copySelection: () => boolean
  /** Drop the selection and repaint the rows it covered. Returns whether there
   * was one to clear (so Esc can fall through when there wasn't). */
  clear: () => boolean
  /** Unsubscribe from frame commits. */
  dispose: () => void
}

export function createSelectionController(deps: SelectionControllerDeps): SelectionController {
  const { frames, mode, copy, onCopied, onCopyFailed, now } = deps

  /** The live gesture, or null when nothing is selected. */
  let selection: Selection | null = null
  /** Rows currently carrying a painted highlight — repainted plain when cleared. */
  let painted: readonly RowSpan[] = []
  /** True once the pointer left the cell it was pressed on: distinguishes a drag
   * from a plain click, which must stay a plain click. */
  let dragged = false
  /** The previous press, for double / triple-click detection. */
  let lastPress: { at: number; point: Point; granularity: SelectionGranularity } | null = null

  /** Rewrite one frame row, optionally with a highlighted span. */
  function rowPaint(row: number, span: RowSpan | undefined): string {
    const styled = frames.frame()[row]
    if (styled === undefined) return ""
    const body = span ? highlightColumns(styled, span.startCol, span.endCol) : styled
    return `${moveToRow(row)}${body}${ERASE_TO_EOL}`
  }

  /**
   * Bring the screen in line with `selection`: paint every covered row and
   * restore any row that was painted before and no longer is. One write, so the
   * terminal never shows a half-updated highlight.
   */
  function repaint(): void {
    const spans = selection ? selectionSpans(selection, frames.plain()) : []
    const byRow = new Map(spans.map((span) => [span.row, span]))
    const rows = new Set<number>([...painted.map((s) => s.row), ...byRow.keys()])
    if (rows.size === 0) {
      painted = spans
      return
    }
    let out = SAVE_CURSOR
    for (const row of [...rows].sort((a, b) => a - b)) out += rowPaint(row, byRow.get(row))
    out += RESTORE_CURSOR
    frames.raw(out)
    painted = spans
  }

  /**
   * Re-assert the highlight after Ink committed a frame. Ink already overwrote
   * the rows with its own content, so nothing needs restoring — drop the paint
   * record first, then paint the selection back on top.
   */
  const unsubscribe = frames.onFrame(() => {
    if (!selection) return
    painted = []
    repaint()
  })

  function currentText(): string {
    return selection ? selectionText(selection, frames.plain()) : ""
  }

  function copySelection(): boolean {
    const text = currentText()
    if (!text) return false
    void Promise.resolve(copy(text)).then((res) => {
      if (res.ok) onCopied(text.length)
      else onCopyFailed(res.reason)
    })
    return true
  }

  function clear(): boolean {
    if (!selection) return false
    selection = null
    repaint()
    return true
  }

  function handleMouse(event: MouseEvent): boolean {
    if (mode() === "off") return false
    switch (event.kind) {
      case "click": {
        const point: Point = { row: event.row - 1, col: event.col - 1 }
        const granularity = nextGranularity(lastPress, now(), point)
        lastPress = { at: now(), point, granularity }
        // A new gesture always supersedes the previous selection.
        if (selection) {
          selection = null
          repaint()
        }
        selection = { anchor: point, head: point, granularity }
        dragged = false
        if (granularity === "char") {
          // Might still turn out to be a plain click: don't paint, don't consume.
          return false
        }
        // A double / triple click is unambiguous — snap and consume it so the
        // click handlers don't also fire on the repeat press.
        repaint()
        return true
      }
      case "drag": {
        if (!selection) return false
        const head: Point = { row: event.row - 1, col: event.col - 1 }
        if (head.row !== selection.head.row || head.col !== selection.head.col) {
          if (head.row !== selection.anchor.row || head.col !== selection.anchor.col) dragged = true
          selection = { ...selection, head }
          repaint()
        }
        return true
      }
      case "release": {
        if (!selection) return false
        // A press and release on the same cell is a plain click: drop the armed
        // anchor and let the caller handle it as one.
        if (!dragged && selection.granularity === "char") {
          selection = null
          return false
        }
        if (mode() === "auto-copy") {
          // Copy, then drop the highlight — the text is on the clipboard and a
          // lingering highlight over content that keeps scrolling is just noise.
          if (copySelection()) clear()
        }
        return true
      }
      default:
        return false
    }
  }

  return {
    handleMouse,
    hasSelection: () => selection !== null,
    copySelection,
    clear,
    dispose: unsubscribe,
  }
}
