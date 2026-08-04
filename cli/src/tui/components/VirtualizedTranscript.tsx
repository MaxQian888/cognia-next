import React from "react"
import { Box, Text } from "ink"

import type { Cell } from "../state/types"
import { buildVirtualBlockIndex, virtualWindow } from "../state/virtual-block-index"
import type { VirtualBlockMetric } from "../state/virtual-block-index"
import { cellToTerminalBlock, TerminalBlockCache } from "../render/cell-terminal-block"
import type { TerminalBlock, TerminalStyle } from "../render/terminal-block"
import { useTheme } from "../theme/context"
import { recordBlockCacheStats, recordRenderDuration } from "../runtime/render-diagnostics"

const blockCache = new TerminalBlockCache()

function revisionOf(cell: Cell): string {
  try {
    return JSON.stringify(cell)
  } catch {
    return `${cell.id}:${cell.kind}`
  }
}

function BlockView({ block }: { block: TerminalBlock }) {
  const theme = useTheme()
  const colors: Record<TerminalStyle, string | undefined> = {
    plain: undefined,
    muted: theme.muted,
    accent: theme.accent,
    success: theme.success,
    warning: theme.warning,
    danger: theme.danger,
    code: theme.secondary,
  }
  return (
    <Box data-testid="terminal-block" flexDirection="column" flexShrink={0}>
      {block.lines.map((line, index) => {
        const span = line.spans[0]
        return (
          <Text
            key={index}
            color={colors[span?.style ?? "plain"]}
            bold={span?.bold}
            italic={span?.italic}
            underline={span?.underline}
            dimColor={span?.style === "muted"}
          >
            {line.plain || " "}
          </Text>
        )
      })}
    </Box>
  )
}

function VirtualizedTranscriptBody({
  cells,
  width,
  top,
  viewportRows,
  verbose,
  onMetrics,
}: {
  cells: Cell[]
  width: number
  top: number
  viewportRows: number
  verbose: boolean
  onMetrics?: (metrics: readonly VirtualBlockMetric[]) => void
}) {
  const theme = useTheme()
  // Never paint a transcript line into the terminal's final column. A line
  // whose last grapheme lands there arms the terminal's deferred auto-wrap;
  // Ink then positions the following row and the terminal consumes/overwrites
  // its first grapheme. Reserving one cell keeps Yoga's rows and the terminal's
  // cursor model aligned (especially visible on paragraph-leading capitals).
  const safeWidth = Math.max(1, Math.floor(width) - 1)
  const blocks = React.useMemo(
    () =>
      cells.map((cell) =>
        blockCache.get(
          {
            id: cell.id,
            width: safeWidth,
            theme: JSON.stringify(theme),
            preferences: verbose ? "verbose" : "compact",
            revision: revisionOf(cell),
          },
          () => cellToTerminalBlock(cell, { width: safeWidth, verbose })
        )
      ),
    [cells, safeWidth, theme, verbose]
  )
  const index = React.useMemo(
    () => buildVirtualBlockIndex(blocks.map((block) => ({ id: block.id, rows: block.rowCount }))),
    [blocks]
  )
  React.useEffect(() => {
    onMetrics?.(index.blocks)
  }, [index, onMetrics])
  // Before Yoga reports a viewport height, render the full (usually tiny)
  // initial transcript. Once measured, the bounded window takes over.
  const effectiveViewport = viewportRows > 0 ? viewportRows : Math.max(1, index.totalRows)
  const window = virtualWindow(index, top, effectiveViewport, 2)
  React.useEffect(() => {
    recordBlockCacheStats(blockCache.stats(), window.end - window.start, blocks.length)
  }, [blocks.length, window.end, window.start])

  return (
    <Box flexDirection="column" flexShrink={0}>
      {window.padTop > 0 ? <Box height={window.padTop} flexShrink={0} /> : null}
      {blocks.slice(window.start, window.end).map((block) => (
        <BlockView key={block.id} block={block} />
      ))}
      {window.padBottom > 0 ? <Box height={window.padBottom} flexShrink={0} /> : null}
    </Box>
  )
}

export function VirtualizedTranscript(
  props: React.ComponentProps<typeof VirtualizedTranscriptBody>
): React.ReactElement {
  return (
    <React.Profiler
      id="virtualized-transcript"
      onRender={(_id, _phase, actualDuration) => recordRenderDuration(actualDuration)}
    >
      <VirtualizedTranscriptBody {...props} />
    </React.Profiler>
  )
}

export function terminalBlockCacheStats() {
  return blockCache.stats()
}
