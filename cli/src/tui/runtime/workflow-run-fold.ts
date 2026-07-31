/**
 * Pure event-fold for the TUI workflow run panel. Turns the durable
 * `workflowRunEvents` stream into a stable, in-place-updated list of per-node
 * step views. No Dexie, no Ink — re-runnable on every emit.
 *
 * Step durations are derived from event `ts` deltas because step events carry
 * no duration in their payload (see `lib/workflow/runtime/event-log.ts`).
 */
import {
  workflowNodeCategory,
  type WorkflowNodeCategory,
  type WorkflowNodeKind,
  type WorkflowRunEventRow,
} from "@/types/workflow/visual"

export type RunStepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped"

export interface RunStepView {
  id: string
  label: string
  status: RunStepStatus
  startedAt?: number
  durationMs?: number
  error?: string
  /** Distinct loop iterations observed for this node (≥2 ⇒ it ran in a loop
   * body). Undefined for a plain, once-run step. */
  iterations?: number
  /** Node category (drives the panel's per-row tint). */
  category?: WorkflowNodeCategory
  /** Total tokens reported by the latest `step_usage` for this step. */
  usageTokens?: number
  /** USD cost from the latest `step_usage`, when priced. */
  usageCostUsd?: number
  /** Retry attempts observed via `step_retrying` (1 ⇒ one retry). */
  retryCount?: number
  /** Long-running progress 0–100 from `step.long_running.progress`. */
  progress?: number
  /** Newest streamed output chunk (truncated) for a live preview. */
  lastStreamDelta?: string
  /** Short preview of the step's completed output payload (truncated). */
  outputPreview?: string
}

const STREAM_PREVIEW_MAX = 60

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s
}

/** Run-level token/cost totals folded from the `step_usage` events. */
export interface RunUsageTotals {
  totalTokens: number
  /** Summed USD cost; undefined when no step reported a priced cost. */
  costUsd?: number
}

export interface RunFoldState {
  steps: RunStepView[]
  /** succeeded + failed + skipped */
  completed: number
  /** id of the last step that entered `running` and hasn't finished */
  currentId?: string
  /** Aggregated usage across every `step_usage` event; undefined ⇒ none seen. */
  usage?: RunUsageTotals
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
    category: workflowNodeCategory(n.type as WorkflowNodeKind),
  }))
}

function errMessage(payload: unknown): string | undefined {
  if (payload && typeof payload === "object" && "message" in payload) {
    const m = (payload as { message?: unknown }).message
    if (typeof m === "string") return m
  }
  return undefined
}

/** Compact one-line preview of a completed step's output payload. */
function previewOutput(payload: unknown): string | undefined {
  if (payload == null) return undefined
  try {
    const s = typeof payload === "string" ? payload : JSON.stringify(payload)
    const flat = s.replace(/\s+/g, " ").trim()
    return flat ? truncate(flat, STREAM_PREVIEW_MAX) : undefined
  } catch {
    return undefined
  }
}

/** Total tokens from a `step_usage` payload, preferring the explicit total. */
function usageTokens(payload: unknown): number {
  const u = payload as { totalTokens?: number; inputTokens?: number; outputTokens?: number } | null
  if (!u || typeof u !== "object") return 0
  if (typeof u.totalTokens === "number") return u.totalTokens
  return (u.inputTokens ?? 0) + (u.outputTokens ?? 0)
}

/** Fold the full event list into step views (stable order, status in place). */
export function foldRunEvents(initial: RunStepView[], events: WorkflowRunEventRow[]): RunFoldState {
  const byId = new Map<string, RunStepView>()
  const steps = initial.map((s) => {
    const copy = { ...s }
    byId.set(copy.id, copy)
    return copy
  })

  let totalTokens = 0
  let costUsd = 0
  let sawUsage = false
  let sawCost = false

  for (const e of events) {
    const step = e.stepId ? byId.get(e.stepId) : undefined
    switch (e.type) {
      case "step_started":
        if (step) {
          step.status = "running"
          step.startedAt = e.ts
          // Loop bodies re-emit `step_started` per iteration with an index in
          // the payload — track how many ran so the timeline can show `×N`.
          const idx = (e.payload as { iterationIndex?: number } | undefined)?.iterationIndex
          if (typeof idx === "number") step.iterations = Math.max(step.iterations ?? 0, idx + 1)
        }
        break
      case "step_usage": {
        sawUsage = true
        totalTokens += usageTokens(e.payload)
        const c = (e.payload as { costUsd?: number } | undefined)?.costUsd
        if (typeof c === "number") {
          costUsd += c
          sawCost = true
        }
        // Attribute usage to the step too (latest snapshot wins, matching the
        // desktop's per-step aggregation under retries).
        if (step) {
          step.usageTokens = usageTokens(e.payload)
          if (typeof c === "number") step.usageCostUsd = c
        }
        break
      }
      case "step_retrying":
        if (step) {
          const attempt = (e.payload as { attempt?: number } | undefined)?.attempt
          step.retryCount = Math.max(
            step.retryCount ?? 0,
            typeof attempt === "number" ? attempt : (step.retryCount ?? 0) + 1
          )
        }
        break
      case "step.long_running.progress":
        if (step) {
          const p = (e.payload as { progress?: number } | undefined)?.progress
          if (typeof p === "number") step.progress = clamp(p, 0, 100)
        }
        break
      case "step_stream":
        if (step) {
          const d = (e.payload as { delta?: string } | undefined)?.delta
          if (typeof d === "string" && d.length > 0) {
            step.lastStreamDelta = truncate(d, STREAM_PREVIEW_MAX)
          }
        }
        break
      case "step_completed":
        if (step) {
          step.status = "succeeded"
          if (step.startedAt !== undefined) step.durationMs = e.ts - step.startedAt
          const preview = previewOutput(e.payload)
          if (preview) step.outputPreview = preview
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
  const usage: RunUsageTotals | undefined = sawUsage
    ? { totalTokens, ...(sawCost ? { costUsd } : {}) }
    : undefined
  return { steps, completed, currentId, ...(usage ? { usage } : {}) }
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
