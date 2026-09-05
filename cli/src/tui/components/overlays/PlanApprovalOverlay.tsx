/** Content-first plan review. The parent still owns decisions and editing. */
import React from "react"
import { Box, Text, type DOMElement } from "ink"
import { useModalInput } from "../../input/input-router"
import { usePanelClick } from "../../input/use-panel-click"
import { useTheme } from "../../theme/context"
import { markdownSpans } from "../../render/cell-terminal-block"
import {
  sanitizeTerminalText,
  terminalStringWidth,
  wrapTerminalSpans,
  type TerminalStyle,
} from "../../render/terminal-block"
import { truncateToWidth } from "../../markdown/width"
import { clampScroll, maxScroll, positionLabel, relocateDocumentScroll } from "../document-view"
import {
  PLAN_APPROVAL_CHOICES,
  planDiffStat,
  planStats,
  type PlanDecision,
} from "../../runtime/plan"

export function PlanApprovalOverlay({
  index,
  savedTo,
  raw,
  prevPlan,
  onMove,
  onSelect,
  onCancel,
  viewportRows = 24,
  columns = 80,
}: {
  index: number
  savedTo?: string
  raw?: string
  prevPlan?: string
  onMove: (delta: number) => void
  onSelect: (decision: PlanDecision) => void
  onCancel: () => void
  /** Available overlay rows, including its compact controls. */
  viewportRows?: number
  /** Root-owned terminal columns, updated on resize. */
  columns?: number
}) {
  const theme = useTheme()
  const boxRef = React.useRef<DOMElement | null>(null)
  const height = Math.max(1, Math.floor(viewportRows))
  // Leave the final terminal column unused to avoid deferred terminal wrapping.
  const width = Math.max(1, Math.floor(columns) - 1)
  const headerRows = height >= 4 ? 1 : 0
  const detailRows = height >= 12 && (savedTo || prevPlan != null) ? 1 : 0
  const footerRows = height >= 3 ? 2 : height >= 2 ? 1 : 0
  const viewport = Math.max(1, height - headerRows - detailRows - footerRows)
  const lines = React.useMemo(
    () =>
      raw?.trim()
        ? wrapTerminalSpans(markdownSpans(raw, true, theme, width), width)
        : wrapTerminalSpans(
            [
              {
                text: "No plan content available. Ctrl+G edit · Esc keep planning",
                style: "muted",
              },
            ],
            width
          ),
    [raw, theme, width]
  )
  const plain = React.useMemo(() => lines.map((line) => line.plain), [lines])
  const [reading, setReading] = React.useState({ plain, raw, scroll: 0, actions: false })
  // Adjust before painting: an inserted section must not flash a stale viewport
  // or leave approval armed for a different revision.
  if (reading.plain !== plain || reading.raw !== raw) {
    setReading({
      plain,
      raw,
      scroll: relocateDocumentScroll(reading.plain, plain, reading.scroll, viewport),
      actions: reading.raw === raw && reading.actions,
    })
  }
  const start = clampScroll(reading.scroll, lines.length, viewport)
  const move = (delta: number) =>
    setReading((state) => ({
      ...state,
      scroll: clampScroll(start + delta, lines.length, viewport),
    }))
  const choiceIndex = Math.max(0, Math.min(index, PLAN_APPROVAL_CHOICES.length - 1))
  const choice = PLAN_APPROVAL_CHOICES[choiceIndex]
  const select = () => {
    if (!reading.actions) return setReading((state) => ({ ...state, actions: true }))
    // Missing content cannot authorize implementation; editing/refining remain available.
    if (raw?.trim() || !choice.id.startsWith("approve-")) onSelect(choice.id)
  }
  const handleMouse = usePanelClick({
    boxRef,
    headerRows: height - 1,
    borderRows: 0,
    hasAboveMore: false,
    visibleCount: footerRows > 0 ? 1 : 0,
    onPick: select,
    onWheel: (dir) => move(dir === "up" ? -3 : 3),
  })
  useModalInput((input, key) => {
    if (key.ctrl && input.toLowerCase() === "g") return onSelect("edit-then-approve")
    if (key.escape) return onCancel()
    if (handleMouse(input)) return
    if (key.tab) return setReading((state) => ({ ...state, actions: !state.actions }))
    if (key.return) return select()
    if (key.upArrow || key.downArrow) {
      const delta = key.upArrow ? -1 : 1
      return reading.actions ? onMove(delta) : move(delta)
    }
    if (key.pageUp || input === "b") return move(-viewport)
    if (key.pageDown || input === " ") return move(viewport)
    if (input === "g") return move(-start)
    if (input === "G") return move(maxScroll(lines.length, viewport) - start)
  })
  const revision = prevPlan != null && raw != null ? planDiffStat(prevPlan, raw) : null
  const stats = planStats(raw ?? "")
  const progress = `${positionLabel(start, viewport, lines.length)} · ${Math.round((Math.min(lines.length, start + viewport) / lines.length) * 100)}%`
  const colors: Record<TerminalStyle, string | undefined> = {
    plain: undefined,
    muted: theme.muted,
    accent: theme.accent,
    success: theme.success,
    warning: theme.warning,
    danger: theme.danger,
    code: theme.secondary,
  }
  const compact = (text: string) => truncateToWidth(sanitizeTerminalText(text), width)
  const metadata = `${stats.steps > 0 ? `${stats.steps} step${stats.steps === 1 ? "" : "s"} · ` : ""}${stats.lines} line${stats.lines === 1 ? "" : "s"}`
  const headerGap = Math.max(
    1,
    width - terminalStringWidth("Review plan") - terminalStringWidth(metadata)
  )
  const navigation = "PgUp/PgDn · g/G"
  const progressRule = Math.max(
    0,
    width - terminalStringWidth(progress) - terminalStringWidth(navigation) - 2
  )
  const actionLabel = `${choiceIndex + 1}/${PLAN_APPROVAL_CHOICES.length} ${choice.label}`
  const primaryKey = reading.actions ? "Enter select" : "Enter actions"
  return (
    <Box ref={boxRef} flexDirection="column" width={width} height={height} overflow="hidden">
      {headerRows > 0 ? (
        <Text wrap="truncate-end">
          <Text bold>{compact("Review plan")}</Text>
          {width >= 40 ? (
            <Text color={theme.muted}>
              {" ".repeat(headerGap)}
              {metadata}
            </Text>
          ) : null}
        </Text>
      ) : null}
      {detailRows > 0 ? (
        <Text color={theme.muted} wrap="truncate-end">
          {compact(
            revision
              ? `Revised plan · +${revision.added} −${revision.removed} lines`
              : `Saved to ${savedTo} · /plan`
          )}
        </Text>
      ) : null}
      <Box flexDirection="column" height={viewport} flexShrink={0}>
        {lines.slice(start, start + viewport).map((line, i) => (
          <Text key={start + i} wrap="truncate-end">
            {line.plain.length === 0
              ? " "
              : line.spans.map((span, j) => (
                  <Text
                    key={j}
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
      {footerRows >= 2 ? (
        <Text color={theme.muted} wrap="truncate-end">
          {reading.actions ? (
            compact(
              width >= 60
                ? (choice.hint ?? "Choose how to continue")
                : "Enter select · ↑/↓ choose · Tab review"
            )
          ) : (
            <>
              {compact(progress)}
              {progressRule > 0 ? (
                <Text color={theme.borderSubtle}>{` ${"─".repeat(progressRule)} `}</Text>
              ) : null}
              {progressRule > 0 ? navigation : null}
            </>
          )}
        </Text>
      ) : null}
      {footerRows > 0 ? (
        <Text wrap="truncate-end">
          <Text color={theme.accent} bold>
            {compact(reading.actions ? actionLabel : primaryKey)}
          </Text>
          <Text color={theme.muted}>
            {compact(
              reading.actions
                ? " · Enter select · ↑/↓ choose · Tab review · Ctrl+G edit · Esc keep"
                : " · ↑/↓ scroll · Ctrl+G edit · Esc keep planning"
            )}
          </Text>
        </Text>
      ) : null}
    </Box>
  )
}
