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
import { Box, Static, Text, measureElement, type DOMElement } from "ink"

import { CellView } from "./CellView"
import { useTheme } from "../theme/context"
import { groupContextRuns, summarizeContextGroup } from "../format/context-group"
import type { Cell, ToolCell } from "../state/types"
import { cellToTerminalBlock } from "../render/cell-terminal-block"

/** Reports its measured row-height for the find cursor's row map. Wraps a cell
 * only while find is active (measurement is gated), so the static-history path
 * pays nothing. */
function MeasuredCell({
  id,
  onHeight,
  children,
}: {
  id: string
  onHeight: (id: string, height: number) => void
  children: React.ReactNode
}) {
  const ref = React.useRef<DOMElement | null>(null)
  React.useEffect(() => {
    if (ref.current) onHeight(id, measureElement(ref.current).height)
  })
  return (
    <Box ref={ref} flexDirection="column">
      {children}
    </Box>
  )
}

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

/** Keep the newest complete cells whose rendered height fits the replay budget.
 * The first over-budget cell is retained so a single tall result is not lost. */
export function limitReplayCells(
  cells: Cell[],
  maxRows: number,
  width: number,
  verbose: boolean
): Cell[] {
  if (maxRows === 0) return cells
  let rows = 0
  let start = cells.length
  while (start > 0) {
    const next = cellToTerminalBlock(cells[start - 1], { width, verbose }).rowCount + 1
    if (rows > 0 && rows + next > maxRows) break
    rows += next
    start -= 1
  }
  return cells.slice(start)
}

/** In verbose mode, tool/thinking cells render expanded regardless of their own
 * collapsed flag — the user opted into detailed output globally. */
function applyVerbose(cell: Cell, verbose: boolean): Cell {
  if (!verbose) return cell
  if (cell.kind === "tool" || cell.kind === "thinking") return { ...cell, collapsed: false }
  return cell
}

function TranscriptImpl({
  cells,
  header,
  verbose = false,
  epoch = 0,
  mode = "static",
  measuring = false,
  focusedCellId = null,
  onCellHeight,
  replayMaxRows = 10000,
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
  /** Find active: render every cell individually (no context folding) and
   * report each cell's measured height so the cursor can jump to it. */
  measuring?: boolean
  /** The cell the find cursor points at — highlighted with a left accent bar. */
  focusedCellId?: string | null
  /** Receives `(cellId, height)` for every cell while {@link measuring}. */
  onCellHeight?: (id: string, height: number) => void
  /** Native-scrollback repaint cap. Zero replays the complete transcript. */
  replayMaxRows?: number
}) {
  const theme = useTheme()
  const renderCell = (cell: Cell) => {
    const focused = cell.id === focusedCellId
    const body = <CellView cell={applyVerbose(cell, verbose)} />
    const inner = focused ? (
      <Box
        borderStyle="single"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderColor={theme.accent}
        paddingLeft={1}
      >
        {body}
      </Box>
    ) : (
      body
    )
    return (
      <Box key={cell.id} marginBottom={1}>
        {onCellHeight && measuring ? (
          <MeasuredCell id={cell.id} onHeight={onCellHeight}>
            {inner}
          </MeasuredCell>
        ) : (
          inner
        )}
      </Box>
    )
  }

  if (mode === "live") {
    // The fullscreen viewport re-renders in place (unlike `<Static>` below), so
    // it can fold completed context-tool bursts into one summary row — EXCEPT
    // while find is active, when every cell must stay individually addressable.
    const runs = groupContextRuns(cells, verbose || measuring)
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

  const replayCells =
    epoch > 0
      ? limitReplayCells(cells, replayMaxRows, process.stdout.columns ?? 80, verbose)
      : cells
  const rows: Row[] = header
    ? [{ id: HEADER_ID }, ...replayCells.map((cell) => ({ id: cell.id, cell }))]
    : replayCells.map((cell) => ({ id: cell.id, cell }))
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

export const Transcript = React.memo(TranscriptImpl)
