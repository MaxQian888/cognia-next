/**
 * Display helpers shared by every Runs UI surface. Pure functions with no
 * React dependency so the orchestrator can also use them in toast strings.
 */

import type { WorkflowRunRow, WorkflowRunEventRow } from "@/types/workflow/visual"

export function formatRunStartedAt(ts: number): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return "—"
  // Use a locale-aware short form. The user's locale is whatever the
  // browser picked; for the runs list we don't pull from next-intl since
  // the result is just informational text.
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

export function formatRunDuration(
  run: Pick<WorkflowRunRow, "startedAt" | "completedAt" | "status">
): string {
  if (run.status === "running" || run.status === "waiting" || run.status === "paused") {
    return "running"
  }
  if (typeof run.completedAt !== "number") return "—"
  return formatDurationMs(run.completedAt - run.startedAt)
}

export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—"
  if (ms < 1000) return `${ms} ms`
  const totalSec = ms / 1000
  if (totalSec < 60) return `${totalSec.toFixed(totalSec < 10 ? 2 : 1)} s`
  const minutes = Math.floor(totalSec / 60)
  const seconds = Math.round(totalSec % 60)
  if (minutes < 60) return `${minutes}m ${seconds}s`
  const hours = Math.floor(minutes / 60)
  const remMin = minutes % 60
  return `${hours}h ${remMin}m`
}

interface StepSpan {
  stepId: string
  startTs: number
  endTs: number
  status: "running" | "succeeded" | "failed" | "skipped"
  attemptCount: number
}

/**
 * Roll the per-event log into one span per stepId. A span tracks the FIRST
 * `step_started` and the LAST terminal event — retries collapse into a
 * single bar with an attempt counter.
 */
export function buildSpans(events: WorkflowRunEventRow[], fallbackEnd: number): StepSpan[] {
  const byStep = new Map<string, StepSpan>()
  for (const e of events) {
    if (!e.stepId) continue
    const existing = byStep.get(e.stepId)
    if (e.type === "step_started") {
      if (existing) {
        // A retry — bump the attempt count but keep the original startTs.
        existing.attemptCount += 1
        existing.status = "running"
        existing.endTs = fallbackEnd
      } else {
        byStep.set(e.stepId, {
          stepId: e.stepId,
          startTs: e.ts,
          endTs: fallbackEnd,
          status: "running",
          attemptCount: 1,
        })
      }
    } else if (e.type === "step_completed" && existing) {
      existing.endTs = e.ts
      existing.status = "succeeded"
    } else if (e.type === "step_failed" && existing) {
      existing.endTs = e.ts
      existing.status = "failed"
    } else if (e.type === "step_skipped") {
      // Skips can arrive without a prior step_started.
      if (existing) {
        existing.endTs = e.ts
        existing.status = "skipped"
      } else {
        byStep.set(e.stepId, {
          stepId: e.stepId,
          startTs: e.ts,
          endTs: e.ts,
          status: "skipped",
          attemptCount: 0,
        })
      }
    }
  }
  return [...byStep.values()].sort((a, b) => a.startTs - b.startTs)
}

export type { StepSpan }
