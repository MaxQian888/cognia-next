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
import { Box, Static, Text } from "ink"

import { CellView } from "./CellView"
import { useTheme } from "../theme/context"
import { groupContextRuns, summarizeContextGroup } from "../format/context-group"
import type { Cell, ToolCell } from "../state/types"

/** A folded run of completed context-gathering tools, shown as one dim summary
 * line ("⚙ 3 reads, 2 searches") so a burst doesn't bury the actual work. */
function ContextGroupView({ tools }: { tools: ToolCell[] }) {
  const theme = useTheme()
  return (
    <Text color={theme.muted} dimColor>
      ⚙ {summarizeContextGroup(tools)}
    </Text>
  )
}

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
  mode = "static",
}: {
  cells: Cell[]
  header?: React.ReactNode
  verbose?: boolean
  /** Re-keys `<Static>` so it re-prints every cell at the current width / mode.
   * `<Static>` never re-renders in place, so this remount is the only repaint. */
  epoch?: number
  /**
   * `"static"` (default) writes cells once into the terminal's native scrollback
   * via Ink's `<Static>`. `"live"` renders them in a plain column instead — for
   * the fullscreen layout, where the whole transcript lives inside an
   * app-managed scroll viewport (no scrollback) and the banner is a fixed header
   * rendered separately, so no header row is emitted here.
   */
  mode?: "static" | "live"
}) {
  const renderCell = (cell: Cell) => (
    <Box key={cell.id} marginBottom={1}>
      <CellView cell={applyVerbose(cell, verbose)} />
    </Box>
  )

  if (mode === "live") {
    // The fullscreen viewport re-renders in place (unlike `<Static>` below), so
    // it can safely fold completed context-tool bursts into one summary row.
    const runs = groupContextRuns(cells, verbose)
    return (
      <Box flexDirection="column">
        {runs.map((run) =>
          run.kind === "group" ? (
            <Box key={run.tools[0].id} marginBottom={1}>
              <ContextGroupView tools={run.tools} />
            </Box>
          ) : (
            renderCell(run.cell)
          )
        )}
      </Box>
    )
  }

  const rows: Row[] = header
    ? [{ id: HEADER_ID }, ...cells.map((cell) => ({ id: cell.id, cell }))]
    : cells.map((cell) => ({ id: cell.id, cell }))
  return (
    <Static key={epoch} items={rows}>
      {(row: Row) =>
        row.cell ? (
          renderCell(row.cell)
        ) : (
          <Box key={row.id} marginBottom={1}>
            {header}
          </Box>
        )
      }
    </Static>
  )
}
