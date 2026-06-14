/**
 * Presentational `@` mention popup shown below the composer. Stateless — the
 * `Input` component owns the keyboard and the highlighted index, which refers to
 * the FLATTENED candidate list so ↑/↓ cross group boundaries seamlessly.
 *
 * Candidates are grouped by kind in a fixed order (Files → Skills → Agents);
 * empty groups are omitted. Each row carries a glyph and an optional muted hint
 * (description / origin). The list is windowed so the highlighted row stays
 * on-screen even when the flattened list overflows `maxRows`.
 */
import React from "react"
import { Box, Text } from "ink"

import { useTheme } from "../theme/context"
import { windowList } from "./list-window"
import type { MentionCandidate, MentionKind } from "../mention/types"

const MAX_ROWS = 8

const GROUP_ORDER: MentionKind[] = ["file", "skill", "agent"]
const GROUP_TITLE: Record<MentionKind, string> = {
  file: "Files",
  skill: "Skills",
  agent: "Agents",
}
const GROUP_GLYPH: Record<MentionKind, string> = {
  file: "📁",
  skill: "🛠",
  agent: "🤖",
}

/** Order candidates by group, preserving each group's incoming order. */
export function orderByGroup(candidates: MentionCandidate[]): MentionCandidate[] {
  return GROUP_ORDER.flatMap((kind) => candidates.filter((c) => c.kind === kind))
}

export function MentionPalette({
  candidates,
  index,
  maxRows = MAX_ROWS,
  width,
  loading = false,
}: {
  /** Already flattened in group order (see {@link orderByGroup}). */
  candidates: MentionCandidate[]
  index: number
  /** Cap the visible rows; the list scrolls to keep the highlight on-screen. */
  maxRows?: number
  /** Box width (terminal columns) so the popup spans the full width. */
  width?: number | string
  /** A skill/agent fetch is in flight — show a `loading…` affordance so the
   * popup appears during the first load instead of flashing in late. */
  loading?: boolean
}) {
  const theme = useTheme()
  if (candidates.length === 0) {
    if (!loading) return null
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.borderSubtle}
        paddingX={1}
        width={width}
      >
        <Text color={theme.muted} dimColor>
          {"  "}loading…
        </Text>
      </Box>
    )
  }
  const win = windowList(candidates.length, index, maxRows)
  const visible = candidates.slice(win.start, win.end)

  // Precompute which visible rows start a new group, so the header prints once
  // per group even when the windowed slice begins mid-group. (Computed before
  // render, no mutation during the map.)
  const showsHeader = visible.map((cand, i) => i === 0 || visible[i - 1].kind !== cand.kind)

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.borderSubtle}
      paddingX={1}
      width={width}
    >
      {win.above > 0 ? <Text color={theme.muted} dimColor>{`  ↑ ${win.above} more`}</Text> : null}
      {visible.map((cand, i) => {
        const row = win.start + i
        const selected = row === index
        const header = showsHeader[i] ? (
          <Text key={`h-${cand.kind}`} color={theme.muted} dimColor>
            {GROUP_GLYPH[cand.kind]} {GROUP_TITLE[cand.kind]}
          </Text>
        ) : null
        const color = selected ? theme.accent : cand.kind === "file" ? theme.info : undefined
        return (
          <React.Fragment key={`${cand.kind}:${cand.id}`}>
            {header}
            <Text color={color} bold={selected}>
              {selected ? "  ❯ " : "    "}
              {cand.label}
              {cand.hint ? <Text color={theme.muted}> — {cand.hint}</Text> : null}
              {cand.origin && cand.kind === "skill" ? (
                <Text color={theme.muted}> ({cand.origin})</Text>
              ) : null}
            </Text>
          </React.Fragment>
        )
      })}
      {win.below > 0 ? <Text color={theme.muted} dimColor>{`  ↓ ${win.below} more`}</Text> : null}
      {loading ? (
        <Text color={theme.muted} dimColor>
          {"  "}loading…
        </Text>
      ) : null}
    </Box>
  )
}
