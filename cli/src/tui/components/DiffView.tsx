/**
 * Shared renderer for a parsed file-edit diff ({@link DiffLine}[]): an old/new
 * line-number gutter, a +/- marker, and syntax-highlighted + diff-role-tinted
 * text. Used by the tool card (full) and the permission prompt (capped preview),
 * so the two never drift.
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
        const gutter =
          line.kind === "meta"
            ? "    "
            : `${(line.oldNo ?? "").toString().padStart(3)} ${(line.newNo ?? "")
                .toString()
                .padStart(3)} `
        return (
          <Text key={i}>
            <Text dimColor>{gutter}</Text>
            {line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}
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
