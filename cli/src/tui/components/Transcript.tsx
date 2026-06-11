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

export function Transcript({ cells, header }: { cells: Cell[]; header?: React.ReactNode }) {
  const rows: Row[] = header
    ? [{ id: HEADER_ID }, ...cells.map((cell) => ({ id: cell.id, cell }))]
    : cells.map((cell) => ({ id: cell.id, cell }))
  return (
    <Static items={rows}>
      {(row: Row) =>
        row.cell ? (
          <Box key={row.id} marginBottom={1}>
            <CellView cell={row.cell} />
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
