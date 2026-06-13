/**
 * Pure event-fold for the TUI workflow run panel. Turns the durable
 * `workflowRunEvents` stream into a stable, in-place-updated list of per-node
 * step views. No Dexie, no Ink — re-runnable on every emit.
 *
 * Step durations are derived from event `ts` deltas because step events carry
 * no duration in their payload (see `lib/workflow/runtime/event-log.ts`).
 */
import type { WorkflowRunEventRow } from "@/types/workflow/visual"

export type RunStepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped"

export interface RunStepView {
  id: string
  label: string
  status: RunStepStatus
  startedAt?: number
  durationMs?: number
  error?: string
}

export interface RunFoldState {
  steps: RunStepView[]
  /** succeeded + failed + skipped */
  completed: number
  /** id of the last step that entered `running` and hasn't finished */
  currentId?: string
}

/** Minimal node shape the panel needs (subset of `WorkflowNode`). */
interface NodeLike {
  id: string
  type: string
  data?: { label?: string }
}

/** One pending step per node, in declaration order, label-or-id. */
export function buildInitialSteps(nodes: NodeLike[]): RunStepView[] {
  return nodes.map((n) => ({
    id: n.id,
    label: n.data?.label?.trim() ? n.data.label.trim() : n.id,
    status: "pending" as RunStepStatus,
  }))
}

function errMessage(payload: unknown): string | undefined {
  if (payload && typeof payload === "object" && "message" in payload) {
    const m = (payload as { message?: unknown }).message
    if (typeof m === "string") return m
  }
  return undefined
}

/** Fold the full event list into step views (stable order, status in place). */
export function foldRunEvents(initial: RunStepView[], events: WorkflowRunEventRow[]): RunFoldState {
  const byId = new Map<string, RunStepView>()
  const steps = initial.map((s) => {
    const copy = { ...s }
    byId.set(copy.id, copy)
    return copy
  })

  for (const e of events) {
    const step = e.stepId ? byId.get(e.stepId) : undefined
    switch (e.type) {
      case "step_started":
        if (step) {
          step.status = "running"
          step.startedAt = e.ts
        }
        break
      case "step_completed":
        if (step) {
          step.status = "succeeded"
          if (step.startedAt !== undefined) step.durationMs = e.ts - step.startedAt
        }
        break
      case "step_failed":
        if (step) {
          step.status = "failed"
          if (step.startedAt !== undefined) step.durationMs = e.ts - step.startedAt
          step.error = errMessage(e.payload)
        }
        break
      case "step_skipped":
        if (step) step.status = "skipped"
        break
      case "run_failed": {
        const nodeId = (e.payload as { nodeId?: string } | undefined)?.nodeId
        const target = nodeId ? byId.get(nodeId) : steps.find((s) => s.status === "running")
        if (target) {
          target.status = "failed"
          target.error = errMessage(e.payload) ?? target.error
        }
        break
      }
      default:
        break
    }
  }

  let completed = 0
  let currentId: string | undefined
  for (const s of steps) {
    if (s.status === "succeeded" || s.status === "failed" || s.status === "skipped") completed += 1
    if (s.status === "running") currentId = s.id
  }
  return { steps, completed, currentId }
}

const ICONS: Record<RunStepStatus, string> = {
  pending: "·",
  running: "⏳",
  succeeded: "✓",
  failed: "✗",
  skipped: "⊘",
}

export function stepStatusIcon(status: RunStepStatus): string {
  return ICONS[status]
}
