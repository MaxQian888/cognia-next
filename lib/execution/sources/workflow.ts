import type { AppendRunEventInput } from "@/lib/db/execution-runs"
import type { WorkflowRunEventRow } from "@/types/workflow/visual"

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

function errorMessage(payload: unknown): string {
  const row = record(payload)
  const error = row.error
  if (typeof error === "string") return error
  const nested = record(error)
  return text(nested.message) ?? text(row.message) ?? "Workflow failed"
}

/** Map the durable workflow event log into the shared semantic journal. */
export function mapWorkflowRunEvent(
  event: WorkflowRunEventRow,
  options: { stepTitle?: string } = {}
): AppendRunEventInput | null {
  const payload = record(event.payload)
  const base = {
    ts: event.ts,
    visibility: "summary" as const,
    sourceEventId: event.id,
  }
  const stepPayload = () => ({
    stepId: event.stepId ?? "unknown-step",
    title: options.stepTitle ?? text(payload.title) ?? event.stepId ?? "Step",
    ...(text(payload.summary) ? { summary: text(payload.summary) } : {}),
  })

  switch (event.type) {
    case "run_started":
      return { ...base, type: "run.started", payload: {} }
    case "run_completed":
      return {
        ...base,
        type: "run.completed",
        payload: text(payload.summary) ? { summary: text(payload.summary) } : {},
      }
    case "run_failed":
      return { ...base, type: "run.failed", payload: { error: errorMessage(event.payload) } }
    case "run_cancelled":
      return { ...base, type: "run.cancelled", payload: {} }
    case "step_started":
      return { ...base, type: "step.started", payload: stepPayload() }
    case "step_completed":
      return { ...base, type: "step.completed", payload: stepPayload() }
    case "step_failed":
      return {
        ...base,
        type: "step.failed",
        payload: { ...stepPayload(), summary: errorMessage(event.payload) },
      }
    case "step_skipped":
      return { ...base, type: "step.skipped", payload: stepPayload() }
    case "step_retrying":
      return {
        ...base,
        type: "milestone.created",
        payload: {
          summary: `Retrying ${options.stepTitle ?? event.stepId ?? "step"}`,
          stepId: event.stepId,
        },
      }
    case "step.long_running.checkpoint":
    case "step.long_running.progress":
    case "run_progress":
      return {
        ...base,
        type: "step.progress",
        payload: {
          ...stepPayload(),
          ...(typeof payload.progress === "number" ? { progress: payload.progress } : {}),
        },
      }
    case "step_commentary": {
      const commentary = text(payload.delta)
      if (!commentary) return null
      return {
        ...base,
        type: "step.progress",
        payload: {
          ...stepPayload(),
          title: commentary,
          safeTitle: true,
          category: "status",
        },
      }
    }
    case "step_stream":
    case "step_usage":
    case "run_log":
      return null
    default:
      return null
  }
}
