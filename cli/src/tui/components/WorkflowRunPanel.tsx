/**
 * Live per-node panel for a `/workflow run` in flight. Rendered above the
 * composer (next to Inflight). Uses `windowList` to keep large graphs from
 * flooding the terminal — the window is centred on the running step and shows
 * compact "N done above / N pending below" hints. Pure presentation; all state
 * comes from the reducer's `workflowRun` slice.
 */
import React from "react"
import { Box, Text } from "ink"

import { useTheme } from "../theme/context"
import type { ThemePalette } from "../theme/palette"
import { windowList } from "./list-window"
import { formatRunDuration } from "../runtime/workflow-doc"
import { stepStatusIcon, type RunStepView } from "../runtime/workflow-run-fold"
import { buildRunSummaryLine } from "../runtime/workflow-run-timeline"
import { formatTokens, formatCost } from "../format/usage"
import type { WorkflowNodeCategory } from "@/types/workflow/visual"
import type { WorkflowRunState } from "../state/types"

const DEFAULT_MAX_ROWS = 8
const PROGRESS_BAR_WIDTH = 5

/** Compact `▰▰▱▱▱ 60%` progress bar for a long-running step. */
function miniBar(progress: number, width = PROGRESS_BAR_WIDTH): string {
  const pct = Math.min(100, Math.max(0, Math.round(progress)))
  const filled = Math.round((pct / 100) * width)
  return `${"▰".repeat(filled)}${"▱".repeat(width - filled)} ${pct}%`
}

/** A tint per node category, used for succeeded/pending rows (status colour wins
 * for running/failed so the live emphasis stays loud). */
function categoryColor(
  category: WorkflowNodeCategory | undefined,
  theme: ThemePalette
): string | undefined {
  switch (category) {
    case "trigger":
      return theme.accent
    case "ai":
      return theme.info
    case "action":
      return theme.userPrompt
    case "flow":
      return theme.warning
    case "data":
    case "io":
      return theme.success
    default:
      return undefined
  }
}

function WorkflowRunPanelImpl({
  run,
  maxRows = DEFAULT_MAX_ROWS,
}: {
  run: WorkflowRunState | undefined
  maxRows?: number
}) {
  const theme = useTheme()
  if (!run || run.steps.length === 0) return null

  const total = run.steps.length
  const currentIndex = run.currentId
    ? run.steps.findIndex((s) => s.id === run.currentId)
    : run.completed
  const focus = currentIndex < 0 ? run.completed : currentIndex
  const win = windowList(total, focus, maxRows)
  const visible = run.steps.slice(win.start, win.end)
  // With concurrency > 1 several steps run at once — surface that in the header
  // so a parallel fan-out reads as parallel rather than looking stuck on one.
  const runningCount = run.steps.filter((s) => s.status === "running").length

  // Status colour wins for the loud states (running/failed); otherwise the node
  // category tints the row so the graph's shape reads at a glance.
  const colorFor = (s: RunStepView): string | undefined => {
    if (s.status === "failed") return theme.danger
    if (s.status === "running") return theme.accent
    if (s.status === "succeeded") return categoryColor(s.category, theme) ?? theme.success
    return categoryColor(s.category, theme) ?? theme.muted
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={theme.accent}>
        ⧖ Running workflow · {run.completed}/{total}
        {runningCount > 1 ? ` · ⇉ ${runningCount} parallel` : ""}
      </Text>
      {win.above > 0 && (
        <Text color={theme.muted} dimColor>
          {"  "}↑ {win.above} done
        </Text>
      )}
      {visible.map((s) => {
        const iter = s.iterations && s.iterations > 1 ? ` ×${s.iterations}` : ""
        const dur = s.durationMs !== undefined ? ` · ${formatRunDuration(s.durationMs)}` : ""
        const retry = s.retryCount ? ` · ⟳${s.retryCount}` : ""
        const usage =
          s.usageTokens !== undefined
            ? ` · ${formatTokens(s.usageTokens)}${s.usageCostUsd !== undefined ? " " + formatCost(s.usageCostUsd) : ""}`
            : ""
        const progress =
          s.status === "running" && typeof s.progress === "number"
            ? ` · ${miniBar(s.progress)}`
            : ""
        // Streaming preview replaces the generic "running…" note when present.
        const note =
          s.status === "running"
            ? s.lastStreamDelta
              ? ` · › ${s.lastStreamDelta}`
              : " · running…"
            : ""
        const err = s.status === "failed" && s.error ? ` — ${s.error}` : ""
        // A succeeded step shows a short preview of what it produced.
        const out = s.status === "succeeded" && s.outputPreview ? ` · ✓ ${s.outputPreview}` : ""
        return (
          <Text key={s.id} color={colorFor(s)}>
            {"  "}
            {stepStatusIcon(s.status)} {s.label}
            {iter}
            {dur}
            {retry}
            {usage}
            {progress}
            {note}
            {out}
            {err}
          </Text>
        )
      })}
      {win.below > 0 && (
        <Text color={theme.muted} dimColor>
          {"  "}↓ {win.below} pending
        </Text>
      )}
      {run.usage && (
        <Text color={theme.muted} dimColor>
          {"  "}Σ {buildRunSummaryLine(run.steps, run.usage)}
        </Text>
      )}
    </Box>
  )
}

// Memoized: `run` keeps its reference between streaming deltas, so the panel
// re-renders only when the workflow-run slice actually changes.
export const WorkflowRunPanel = React.memo(WorkflowRunPanelImpl)
