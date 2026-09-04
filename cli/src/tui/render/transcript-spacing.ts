/**
 * How much air goes between two transcript cells.
 *
 * Every cell used to end with a blank row, unconditionally. That is right for
 * a paragraph, where a reply needs separating from the question above it, and
 * wrong for the one-line rows that make up most of a working turn: a run of
 * three tool cards and two notices cost ten rows to say five things, so a
 * 24-row terminal held barely two exchanges and the reader scrolled past
 * whitespace to find the answer.
 *
 * The rule is about the PAIR, not the cell, which is why it lives here rather
 * than inside the cell renderer: a blank belongs between two paragraphs, and
 * between a paragraph and a row, but not between two rows.
 */
import type { Cell } from "../state/types"

/**
 * `block` reads as a paragraph and is separated from its neighbours.
 * `row` is a single line of status and packs against a neighbouring row.
 */
export type CellDensity = "block" | "row"

export function cellDensity(cell: Cell): CellDensity {
  switch (cell.kind) {
    case "tool":
    case "notice":
    case "canonical-event":
    case "content-part":
      return "row"
    case "thinking":
      // Collapsed it is a one-line disclosure. Expanded it is reasoning text.
      return cell.collapsed ? "row" : "block"
    default:
      return "block"
  }
}

/**
 * Whether a blank row goes after `cell`.
 *
 * The last cell always gets one, so the transcript never butts up against the
 * composer, whatever it happens to end with.
 */
export function needsBlankAfter(cell: Cell, next: Cell | undefined): boolean {
  if (!next) return true
  return cellDensity(cell) === "block" || cellDensity(next) === "block"
}
