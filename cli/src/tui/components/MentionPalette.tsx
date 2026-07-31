/**
 * Presentational `@` mention popup shown above the composer. Stateless — the
 * `Input` component owns the keyboard and the highlighted index, which refers to
 * the FLATTENED candidate list so ↑/↓ cross group boundaries seamlessly.
 *
 * The popup keeps a CONSTANT height while the user navigates: the body shows
 * `min(rows, candidates.length)` rows (only the query changes that count), and
 * the `↑/↓ more` indicators and the preview line are rendered as fixed slots
 * (blank when empty). So stepping with ↑/↓ (or the wheel) never resizes the box
 * and never pushes the composer below off-screen. See {@link buildMentionView}.
 *
 * Each row self-identifies its kind with a leading glyph (no separate group
 * headers to appear/vanish). Skill rows also carry a ●/○ enabled badge, a `⚠`
 * validation marker, and a muted metadata segment (origin · category · used N×);
 * the highlighted row's full description shows on the fixed preview line.
 */
import React from "react"
import { Box, Text } from "ink"

import { useTheme } from "../theme/context"
import { buildMentionView, MENTION_GLYPH, mentionRowMeta } from "./mention-view"
import type { MentionCandidate, MentionKind } from "../mention/types"

const MAX_ROWS = 8

const GROUP_ORDER: MentionKind[] = ["file", "skill", "agent"]

/** Order candidates by group, preserving each group's incoming order. */
export function orderByGroup(candidates: MentionCandidate[]): MentionCandidate[] {
  return GROUP_ORDER.flatMap((kind) => candidates.filter((c) => c.kind === kind))
}

/** Truncate `text` to `width` columns with an ellipsis (cheap, char-based). */
function truncate(text: string, width: number): string {
  if (width <= 1 || text.length <= width) return text
  return text.slice(0, Math.max(0, width - 1)) + "…"
}

export function MentionPalette({
  candidates,
  index,
  maxRows = MAX_ROWS,
  width,
  loading = false,
  loadingLabel = "loading…",
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
  /** Wording for the in-flight affordance (e.g. `loading skills…`). */
  loadingLabel?: string
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
          {"  ↻ "}
          {loadingLabel}
        </Text>
      </Box>
    )
  }

  const view = buildMentionView(candidates, index, maxRows)
  // Width budget for the muted preview line (account for border + padding + " ").
  const numericWidth = typeof width === "number" ? width : 80
  const previewWidth = Math.max(8, numericWidth - 6)

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.borderSubtle}
      paddingX={1}
      width={width}
    >
      {/* Fixed top indicator slot — blank when nothing is hidden above. */}
      <Text color={theme.muted} dimColor>
        {view.above > 0 ? `  ↑ ${view.above} more` : " "}
      </Text>
      {view.rows.map(({ cand, selected }) => {
        const color = selected ? theme.accent : cand.kind === "file" ? theme.info : undefined
        const meta = mentionRowMeta(cand)
        return (
          <Text key={`${cand.kind}:${cand.id}`} color={color} bold={selected}>
            {selected ? "❯ " : "  "}
            {MENTION_GLYPH[cand.kind]}{" "}
            {cand.kind === "skill" ? (
              <Text color={cand.enabled ? theme.success : theme.muted}>
                {cand.enabled ? "●" : "○"}{" "}
              </Text>
            ) : null}
            {cand.warning ? <Text color={theme.warning}>⚠ </Text> : null}
            {cand.label}
            {meta ? <Text color={theme.muted}> · {meta}</Text> : null}
          </Text>
        )
      })}
      {/* Fixed bottom indicator slot — blank when nothing is hidden below. */}
      <Text color={theme.muted} dimColor>
        {view.below > 0 ? `  ↓ ${view.below} more` : " "}
      </Text>
      {/* Fixed preview / loading slot — never changes the popup height. */}
      <Text color={theme.muted} dimColor>
        {loading
          ? `  ↻ ${loadingLabel}`
          : view.preview?.hint
            ? `  ${truncate(view.preview.hint, previewWidth)}`
            : " "}
      </Text>
    </Box>
  )
}
