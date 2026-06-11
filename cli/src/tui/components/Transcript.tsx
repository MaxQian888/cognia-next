/**
 * The committed transcript: every cell, in order. Uses Ink's `<Static>` so the
 * scrollback is written once and never re-rendered as new cells arrive (the
 * recommended Ink pattern for append-only logs).
 *
 * An optional `header` (the welcome banner) is emitted as the very first static
 * row so it stays pinned to the top of the scrollback for the whole session —
 * Ink prints `<Static>` content above the live frame, in insertion order.
 */
import React from "react"
import { Box, Static } from "ink"

import { CellView } from "./CellView"
import type { Cell } from "../state/types"

/** A sentinel id for the optional header row so the `<Static>` key is stable. */
const HEADER_ID = "__banner__"

type Row = { id: string; cell?: Cell }

/** In verbose mode, tool/thinking cells render expanded regardless of their own
 * collapsed flag — the user opted into detailed output globally. */
function applyVerbose(cell: Cell, verbose: boolean): Cell {
  if (!verbose) return cell
  if (cell.kind === "tool" || cell.kind === "thinking") return { ...cell, collapsed: false }
  return cell
}

export function Transcript({
  cells,
  header,
  verbose = false,
  epoch = 0,
}: {
  cells: Cell[]
  header?: React.ReactNode
  verbose?: boolean
  /** Re-keys `<Static>` so it re-prints every cell at the current width / mode.
   * `<Static>` never re-renders in place, so this remount is the only repaint. */
  epoch?: number
}) {
  const rows: Row[] = header
    ? [{ id: HEADER_ID }, ...cells.map((cell) => ({ id: cell.id, cell }))]
    : cells.map((cell) => ({ id: cell.id, cell }))
  return (
    <Static key={epoch} items={rows}>
      {(row: Row) =>
        row.cell ? (
          <Box key={row.id} marginBottom={1}>
            <CellView cell={applyVerbose(row.cell, verbose)} />
          </Box>
        ) : (
          <Box key={row.id} marginBottom={1}>
            {header}
          </Box>
        )
      }
    </Static>
  )
}
