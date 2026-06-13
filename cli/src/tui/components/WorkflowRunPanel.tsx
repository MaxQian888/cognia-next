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
import { windowList } from "./list-window"
import { formatRunDuration } from "../runtime/workflow-doc"
import { stepStatusIcon, type RunStepStatus } from "../runtime/workflow-run-fold"
import type { WorkflowRunState } from "../state/types"

const DEFAULT_MAX_ROWS = 8

export function WorkflowRunPanel({
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

  const colorFor = (status: RunStepStatus): string => {
    if (status === "succeeded") return theme.success
    if (status === "failed") return theme.danger
    if (status === "running") return theme.accent
    return theme.muted
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={theme.accent}>
        ⧖ Running workflow · {run.completed}/{total}
      </Text>
      {win.above > 0 && (
        <Text color={theme.muted} dimColor>
          {"  "}↑ {win.above} done
        </Text>
      )}
      {visible.map((s) => {
        const dur = s.durationMs !== undefined ? ` · ${formatRunDuration(s.durationMs)}` : ""
        const note = s.status === "running" ? " · running…" : ""
        const err = s.status === "failed" && s.error ? ` — ${s.error}` : ""
        return (
          <Text key={s.id} color={colorFor(s.status)}>
            {"  "}
            {stepStatusIcon(s.status)} {s.label}
            {dur}
            {note}
            {err}
          </Text>
        )
      })}
      {win.below > 0 && (
        <Text color={theme.muted} dimColor>
          {"  "}↓ {win.below} pending
        </Text>
      )}
    </Box>
  )
}
