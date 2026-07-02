/**
 * The plan-approval prompt shown after a plan-mode turn proposes a plan. The
 * full plan markdown is rendered INSIDE this overlay as a scrollable region (so
 * the user can read/scroll it while the approve menu is up — Claude Code parity)
 * and the transcript's `PlanCell` is only a compact reference. Mirrors OpenCode's
 * `plan_exit` confirmation: approve (switch to a build mode and implement) or keep
 * planning to refine.
 *
 * Key arbitration: the `SelectList` owns ↑/↓ (move selection) only; the plan body
 * owns everything used to read it — the wheel plus the keys the list ignores
 * (PgUp/PgDn, Space/b, g/G) — handled by this overlay's own `useInput`, so
 * scrolling works even while a choice is highlighted (the bug this fixes). The
 * wheel scrolls the plan (not the menu) because the plan is the tall content the
 * user is reading; the short choice list is arrow-driven. Scroll state lives
 * here; the decisions are delegated to the parent so the App stays a thin
 * interpreter.
 */
import React from "react"
import { Box, Text, useInput, useStdout } from "ink"

import { SelectList } from "../SelectList"
import { MarkdownLine } from "../Markdown"
import { parseMouseEvent } from "../../input/mouse"
import { useTheme } from "../../theme/context"
import {
  clampScroll,
  lineCount,
  maxScroll,
  positionLabel,
  prepareDocumentLines,
} from "../document-view"
import {
  PLAN_APPROVAL_CHOICES,
  planDiffStat,
  planStats,
  planTitle,
  type PlanDecision,
} from "../../runtime/plan"

/** Rows reserved for the header block, the choice list, and footer chrome — the
 * plan body gets whatever height is left. Generous so the 5-row list + header
 * always fit; the body clamps to a `MIN_BODY_ROWS` floor on short terminals. */
const CHROME_ROWS = 16
const MIN_BODY_ROWS = 4
/** Lines the plan body scrolls per wheel notch — a small step so the wheel feels
 * like a nudge, while PgUp/PgDn still jump a full viewport. */
const WHEEL_STEP = 3

export function PlanApprovalOverlay({
  index,
  savedTo,
  raw,
  prevPlan,
  onMove,
  onSelect,
  onCancel,
  viewportRows,
}: {
  index: number
  /** Where the plan was persisted, shown so the user knows `/plan` can re-open it. */
  savedTo?: string
  /** The proposed plan markdown — rendered as the scrollable body + revision badge. */
  raw?: string
  /** The plan this one supersedes, when this is a revision; drives a `+A −R` badge. */
  prevPlan?: string
  onMove: (delta: number) => void
  onSelect: (decision: PlanDecision) => void
  onCancel: () => void
  /** Test seam: plan-body viewport height in rows (defaults to terminal height). */
  viewportRows?: number
}) {
  const theme = useTheme()
  const { stdout } = useStdout()
  const [scroll, setScroll] = React.useState(0)

  // When this plan revises an earlier one, show how many lines changed.
  const revision = prevPlan != null && raw != null ? planDiffStat(prevPlan, raw) : null
  const stats = raw != null ? planStats(raw) : null
  const title = raw != null ? planTitle(raw) : null

  const prepared = React.useMemo(
    () => (raw != null ? prepareDocumentLines(raw, "markdown") : null),
    [raw]
  )
  const total = prepared ? lineCount(prepared) : 0
  const viewport =
    viewportRows ??
    Math.max(MIN_BODY_ROWS, ((stdout?.rows as number | undefined) ?? 24) - CHROME_ROWS)

  const move = React.useCallback(
    (delta: number) => setScroll((s) => clampScroll(s + delta, total, viewport)),
    [total, viewport]
  )

  // Ctrl+G opens the plan in $EDITOR (Claude Code parity); the wheel and the
  // remaining keys scroll the plan body. ↑/↓, Enter and Esc are left to the
  // SelectList below so the highlight and the body scroll never fight over a key.
  useInput((input, key) => {
    if (key.ctrl && (input === "g" || input === "G")) {
      onSelect("edit-then-approve")
      return
    }
    if (total === 0) return
    const mouse = parseMouseEvent(input)
    if (mouse?.kind === "wheel") return move(mouse.dir === "up" ? -WHEEL_STEP : WHEEL_STEP)
    if (key.pageUp || input === "b") return move(-viewport)
    if (key.pageDown || input === " ") return move(viewport)
    if (input === "g") return setScroll(0)
    if (input === "G") return setScroll(maxScroll(total, viewport))
  })

  const start = clampScroll(scroll, total, viewport)
  const end = Math.min(total, start + viewport)

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" paddingX={1}>
        <Text color={theme.accent} bold>
          Ready to code?
        </Text>
        {title ? <Text color={theme.accent}>{title}</Text> : null}
        {stats ? (
          <Text color={theme.muted} dimColor>
            {stats.steps > 0 ? `${stats.steps} step${stats.steps === 1 ? "" : "s"}` : "plan"} ·{" "}
            {stats.lines} lines
          </Text>
        ) : null}
        {revision ? (
          <Text color={theme.warning}>
            Revised plan · +{revision.added} −{revision.removed} lines vs the previous version
          </Text>
        ) : null}
        {savedTo ? (
          <Text color={theme.muted} dimColor>
            Saved to {savedTo} — reopen anytime with /plan
          </Text>
        ) : null}
      </Box>
      {prepared && total > 0 ? (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
          {prepared.kind === "markdown"
            ? prepared.lines
                .slice(start, end)
                .map((line, i) => <MarkdownLine key={start + i} line={line} />)
            : prepared.lines
                .slice(start, end)
                .map((line, i) => <Text key={start + i}>{line.length > 0 ? line : " "}</Text>)}
          <Text color={theme.muted} dimColor>
            {`${positionLabel(start, viewport, total)} · PgUp/PgDn·Space scroll · g/G top/bottom`}
          </Text>
        </Box>
      ) : null}
      <SelectList
        items={PLAN_APPROVAL_CHOICES}
        index={index}
        onMove={onMove}
        onSelect={(i) => onSelect(PLAN_APPROVAL_CHOICES[i].id)}
        onCancel={onCancel}
        disableWheel
        footerHint="↑/↓ select · wheel/PgUp/PgDn scroll plan · Enter approve · Ctrl+G edit · Esc keep planning"
      />
    </Box>
  )
}
