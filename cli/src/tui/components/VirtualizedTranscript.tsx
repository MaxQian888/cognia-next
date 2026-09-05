import React from "react"
import { Box, Text } from "ink"

import type { Cell } from "../state/types"
import { buildVirtualBlockIndex, virtualWindow } from "../state/virtual-block-index"
import type { VirtualBlockMetric } from "../state/virtual-block-index"
import { cellToTerminalBlock, TerminalBlockCache } from "../render/cell-terminal-block"
import { buildTerminalBlock } from "../render/terminal-block"
import type { TerminalBlock, TerminalStyle } from "../render/terminal-block"
import { groupContextRuns, contextGroupLines } from "../format/context-group"
import { needsBlankAfter } from "../render/transcript-spacing"
import { useTheme } from "../theme/context"
import { useRenderPrefs } from "../render/context"
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
    plain: theme.text,
    muted: theme.muted,
    accent: theme.accent,
    success: theme.success,
    warning: theme.warning,
    danger: theme.danger,
    code: theme.secondary,
  }
  return (
    <Box data-testid="terminal-block" flexDirection="column" flexShrink={0}>
      {block.lines.map((line, index) => (
        // A row carries one span per styled run, so a tool header can tint its
        // status glyph, its label and its result chip independently. An empty
        // row still prints a space, or Yoga collapses it and the block's
        // measured height stops matching `rowCount`.
        <Text key={index}>
          {line.plain.length === 0
            ? " "
            : line.spans.map((span, spanIndex) => (
                <Text
                  key={spanIndex}
                  // An explicit colour comes from a syntax highlighter and wins
                  // over the semantic style token (and its dimming with it).
                  color={span.color ?? colors[span.style]}
                  bold={span.bold}
                  italic={span.italic}
                  underline={span.underline}
                  dimColor={span.style === "muted" && !span.color}
                >
                  {span.text}
                </Text>
              ))}
        </Text>
      ))}
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
  const prefs = useRenderPrefs()
  // Never paint a transcript line into the terminal's final column. A line
  // whose last grapheme lands there arms the terminal's deferred auto-wrap;
  // Ink then positions the following row and the terminal consumes/overwrites
  // its first grapheme. Reserving one cell keeps Yoga's rows and the terminal's
  // cursor model aligned (especially visible on paragraph-leading capitals).
  const safeWidth = Math.max(1, Math.floor(width) - 1)
  const blocks = React.useMemo(
    // Fold settled context bursts into the same bounded action/target preview
    // as the live region. The resulting block owns its actual rendered height.
    () => {
      const runs = groupContextRuns(cells, verbose)
      // `leadCell` is what the spacing rule sees for a run.
      const leadCell = (run: (typeof runs)[number]) =>
        run.kind === "group" ? run.tools[0] : run.cell
      return runs.map((run, index) => {
        const blank = needsBlankAfter(leadCell(run), runs[index + 1] && leadCell(runs[index + 1]))
        if (run.kind === "group") {
          const lines = contextGroupLines(run.tools, safeWidth)
          return blockCache.get(
            {
              id: `context:${run.tools[0].id}`,
              width: safeWidth,
              theme: JSON.stringify(theme),
              preferences: `compact:${blank}`,
              // Inputs can be enriched under the same call ids. Key only the
              // bounded displayed content, without serializing result bodies.
              revision: JSON.stringify(lines),
            },
            () =>
              buildTerminalBlock({
                id: `context:${run.tools[0].id}`,
                spans: lines.map((line, index) => ({
                  text: `${line}${index < lines.length - 1 || blank ? "\n" : ""}`,
                  style: index === 0 ? "success" : "plain",
                })),
                width: safeWidth,
              })
          )
        }
        return blockCache.get(
          {
            id: run.cell.id,
            width: safeWidth,
            theme: JSON.stringify(theme),
            preferences: `${verbose ? "verbose" : "compact"}:${blank}:${JSON.stringify(prefs)}`,
            revision: revisionOf(run.cell),
          },
          () =>
            cellToTerminalBlock(run.cell, {
              width: safeWidth,
              verbose,
              prefs,
              palette: theme,
              trailingBlank: blank,
            })
        )
      })
    },
    [cells, safeWidth, theme, verbose, prefs]
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
