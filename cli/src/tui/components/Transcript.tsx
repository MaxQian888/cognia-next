/**
 * The committed transcript: every cell, in order. Uses Ink's `<Static>` so the
 * scrollback is written once and never re-rendered as new cells arrive (the
 * recommended Ink pattern for append-only logs).
 */
import React from "react"
import { Box, Static } from "ink"

import { CellView } from "./CellView"
import type { Cell } from "../state/types"

export function Transcript({ cells }: { cells: Cell[] }) {
  return (
    <Static items={cells}>
      {(cell: Cell) => (
        <Box key={cell.id} marginBottom={1}>
          <CellView cell={cell} />
        </Box>
      )}
    </Static>
  )
}
