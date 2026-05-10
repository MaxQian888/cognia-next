"use client"

/**
 * Gantt-style horizontal timeline of a single run's steps. Each step gets
 * a horizontal bar from `step_started` to `step_completed`/`step_failed`,
 * positioned and sized proportionally to the run's wall-clock window.
 *
 * Clicking a row selects the step and surfaces its input/output/log payload
 * in the inspector pane on the right.
 */

import { useMemo } from "react"
import { CheckCircle2Icon, CircleAlertIcon, CircleSlashIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import type { VisualWorkflow, WorkflowRunEventRow } from "@/types/workflow/visual"
import { workflowNodeCategory } from "@/types/workflow/visual"
import { formatDurationMs } from "./format"

const CATEGORY_COLORS = {
  trigger: "bg-wf-trigger/70",
  action: "bg-wf-action/70",
  ai: "bg-wf-ai/70",
  flow: "bg-wf-flow/70",
  data: "bg-wf-data/70",
  io: "bg-wf-io/70",
  annotation: "bg-wf-annotation/70",
} as const

const CATEGORY_RAILS = {
  trigger: "bg-wf-trigger/15",
  action: "bg-wf-action/15",
  ai: "bg-wf-ai/15",
  flow: "bg-wf-flow/15",
  data: "bg-wf-data/15",
  io: "bg-wf-io/15",
  annotation: "bg-wf-annotation/15",
} as const

interface StepSpan {
  stepId: string
  startTs: number
  endTs: number
  status: "running" | "succeeded" | "failed" | "skipped"
  attemptCount: number
}

export function RunTimeline({
  events,
  workflow,
  startedAt,
  completedAt,
  selectedStepId,
  onSelectStep,
}: {
  events: WorkflowRunEventRow[]
  workflow: VisualWorkflow
  startedAt: number
  completedAt: number | undefined
  selectedStepId: string | null
  onSelectStep: (stepId: string) => void
}) {
  const t = useTranslations("workflows.runs.timeline")
  // For running steps we need an end-of-window. Use the latest event ts so the
  // computation is pure (deterministic from props) and the timeline still
  // grows as fresh events arrive.
  const fallbackEnd = useMemo(() => {
    if (completedAt !== undefined) return completedAt
    let max = startedAt
    for (const e of events) if (e.ts > max) max = e.ts
    return max
  }, [events, completedAt, startedAt])
  const spans = useMemo(() => buildSpans(events, fallbackEnd), [events, fallbackEnd])
  const total = fallbackEnd - startedAt
  const totalSafe = total > 0 ? total : 1

  if (spans.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
        {t("waiting")}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5" aria-label="Run timeline">
      {spans.map((span) => {
        const node = workflow.nodes.find((n) => n.id === span.stepId)
        const label = node?.data.label ?? span.stepId
        const kind = node?.type
        const category = kind ? workflowNodeCategory(kind) : "annotation"
        const left = ((span.startTs - startedAt) / totalSafe) * 100
        const widthRaw = ((span.endTs - span.startTs) / totalSafe) * 100
        const width = Math.max(widthRaw, 0.5) // ensure tiny spans are still visible
        const StatusIcon =
          span.status === "succeeded"
            ? CheckCircle2Icon
            : span.status === "failed"
              ? CircleAlertIcon
              : span.status === "skipped"
                ? CircleSlashIcon
                : null
        const isSelected = selectedStepId === span.stepId
        return (
          <button
            key={span.stepId}
            type="button"
            onClick={() => onSelectStep(span.stepId)}
            className={cn(
              "group relative flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
              isSelected ? "bg-accent" : "hover:bg-accent/60"
            )}
            data-testid={`timeline-row-${span.stepId}`}
          >
            <div className="flex w-44 shrink-0 items-center gap-1.5">
              <span
                className={cn("size-2 rounded-full", CATEGORY_COLORS[category])}
                aria-hidden="true"
              />
              <span className="truncate text-xs font-medium" title={label}>
                {label}
              </span>
            </div>
            <div className={cn("relative h-5 flex-1 rounded-sm", CATEGORY_RAILS[category])}>
              <div
                className={cn(
                  "absolute top-0 bottom-0 rounded-sm",
                  CATEGORY_COLORS[category],
                  span.status === "running" && "animate-pulse",
                  span.status === "failed" && "bg-wf-status-failed/80",
                  span.status === "skipped" && "bg-wf-status-skipped/40"
                )}
                style={{
                  left: `${left}%`,
                  width: `${width}%`,
                  minWidth: 4,
                }}
                aria-hidden="true"
              />
            </div>
            <div className="flex w-32 shrink-0 items-center justify-end gap-1.5 text-xs text-muted-foreground tabular-nums">
              {StatusIcon ? (
                <StatusIcon
                  className={cn(
                    "size-3.5",
                    span.status === "succeeded" && "text-wf-status-succeeded",
                    span.status === "failed" && "text-wf-status-failed",
                    span.status === "skipped" && "text-wf-status-skipped"
                  )}
                  aria-hidden="true"
                />
              ) : null}
              {formatDurationMs(span.endTs - span.startTs)}
              {span.attemptCount > 1 ? (
                <span title={t("retried", { count: span.attemptCount - 1 })}>
                  ×{span.attemptCount}
                </span>
              ) : null}
            </div>
          </button>
        )
      })}
    </div>
  )
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
