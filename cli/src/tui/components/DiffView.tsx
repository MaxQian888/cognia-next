/**
 * Shared renderer for a parsed file-edit diff ({@link DiffLine}[]): an old/new
 * line-number gutter, a +/- marker, and syntax-highlighted text. The add/del
 * signal lives in the **sign column** — the marker and gutter are tinted with
 * the diff-role colour, so the code body keeps its full syntax highlight instead
 * of being flattened green/red. Used by the tool card (full) and the permission
 * prompt (capped preview), so the two never drift.
 */
import React from "react"
import { Box, Text } from "ink"

import { useTheme } from "../theme/context"
import { highlightDiffText } from "../markdown/diff"
import type { DiffLine } from "../markdown/types"

export function DiffView({
  diff,
  lang,
  maxLines,
}: {
  diff: DiffLine[]
  lang?: string
  /** Cap the rendered lines, summarizing the remainder (for the approval prompt). */
  maxLines?: number
}) {
  const theme = useTheme()
  const colors = { add: theme.diffAdded, del: theme.diffRemoved, context: theme.muted }
  const shown = maxLines && diff.length > maxLines ? diff.slice(0, maxLines) : diff
  const hidden = diff.length - shown.length
  return (
    <Box flexDirection="column">
      {shown.map((line, i) => {
        // The sign column (gutter + marker) carries the add/del colour so the
        // code body can show its own syntax highlight uncovered.
        const signColor =
          line.kind === "add"
            ? theme.diffAdded
            : line.kind === "del"
              ? theme.diffRemoved
              : undefined
        const gutter =
          line.kind === "meta"
            ? "    "
            : `${(line.oldNo ?? "").toString().padStart(3)} ${(line.newNo ?? "")
                .toString()
                .padStart(3)} `
        const marker = line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "
        return (
          <Text key={i}>
            <Text color={signColor} dimColor>
              {gutter}
            </Text>
            <Text color={signColor} bold>
              {marker}
            </Text>
            {highlightDiffText(line, lang, colors)}
          </Text>
        )
      })}
      {hidden > 0 ? (
        <Text color={theme.muted} dimColor>
          {`  … +${hidden} more line${hidden === 1 ? "" : "s"}`}
        </Text>
      ) : null}
    </Box>
  )
}
