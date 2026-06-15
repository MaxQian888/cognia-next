/**
 * Per-step performance + cost breakdown for one run. Pure (no React/Dexie):
 * joins the timeline spans (`buildSpans`, the same roll-up the Gantt uses, so
 * durations + attempt counts match exactly) with per-step token/cost usage
 * (`aggregateRunUsage`) and the workflow definition (for labels/kinds).
 */

import type {
  StepUsage,
  VisualWorkflow,
  WorkflowNodeCategory,
  WorkflowRunEventRow,
} from "@/types/workflow/visual"
import { workflowNodeCategory } from "@/types/workflow/visual"
import { buildSpans } from "@/components/workflow/runs/run-timeline"
import { aggregateRunUsage } from "./usage-aggregate"

export interface StepBreakdownRow {
  stepId: string
  label: string
  kind: string | undefined
  category: WorkflowNodeCategory
  status: "running" | "succeeded" | "failed" | "skipped"
  /** Wall-clock ms for the step (partial for still-running steps). */
  durationMs: number
  /** Execution attempts (1 = ran once, >1 = retried). 0 for pure skips. */
  attempts: number
  usage?: StepUsage
}

export interface StepBreakdown {
  rows: StepBreakdownRow[]
  /** Step id with the largest duration among ran steps, for highlighting. */
  slowestStepId: string | null
  /** Total wall-clock of all rows (for percentage bars). */
  totalDurationMs: number
}

/**
 * Compute the breakdown for a run. `completedAt` lets running steps measure to
 * the run end; when absent the latest event ts is used (matches the timeline).
 */
export function computeStepBreakdown(
  workflow: VisualWorkflow,
  events: WorkflowRunEventRow[],
  completedAt: number | undefined,
  startedAt: number
): StepBreakdown {
  let fallbackEnd = completedAt ?? startedAt
  if (completedAt === undefined) {
    for (const e of events) if (e.ts > fallbackEnd) fallbackEnd = e.ts
  }
  const spans = buildSpans(events, fallbackEnd)
  const usage = aggregateRunUsage(events)

  let slowestStepId: string | null = null
  let slowestDuration = -1
  let totalDurationMs = 0

  const rows: StepBreakdownRow[] = spans.map((span) => {
    const node = workflow.nodes.find((n) => n.id === span.stepId)
    const kind = node?.type
    const durationMs = Math.max(span.endTs - span.startTs, 0)
    totalDurationMs += durationMs
    // Only count actually-run steps toward "slowest" (skips have no work).
    if (span.status !== "skipped" && durationMs > slowestDuration) {
      slowestDuration = durationMs
      slowestStepId = span.stepId
    }
    return {
      stepId: span.stepId,
      label: node?.data.label ?? span.stepId,
      kind,
      category: kind ? workflowNodeCategory(kind) : "annotation",
      status: span.status,
      durationMs,
      attempts: span.attemptCount,
      usage: usage.perStep[span.stepId],
    }
  })

  return { rows, slowestStepId, totalDurationMs }
}
