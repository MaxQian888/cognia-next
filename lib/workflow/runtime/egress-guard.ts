import { hasNoLeakingPiiDeep, redactText } from "@cognia/redact"
import type {
  WorkflowEgressSink,
  WorkflowPiiGateMode,
  WorkflowRunSecurityContext,
} from "@/types/workflow/visual"

export class WorkflowPiiBlockedError extends Error {
  readonly code = "pii_blocked" as const
  readonly retryable = false

  constructor(readonly sink: WorkflowEgressSink) {
    super(`Workflow egress policy blocked PII at the ${sink} boundary`)
    this.name = "WorkflowPiiBlockedError"
  }
}

function redactDeep(value: unknown, count: { value: number }): unknown {
  if (typeof value === "string") {
    const result = redactText(value)
    count.value += Object.keys(result.map).length
    return result.redacted
  }
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, count))
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      output[key] = redactDeep(inner, count)
    }
    return output
  }
  return value
}

export interface GuardWorkflowEgressInput<T> {
  securityContext?: WorkflowRunSecurityContext
  sink: WorkflowEgressSink
  value: T
  requestedMode?: WorkflowPiiGateMode
}

export interface GuardWorkflowEgressResult<T> {
  value: T
  mode: WorkflowPiiGateMode
  redacted: boolean
}

/** The single PII decision seam for content leaving a workflow run. */
export function guardWorkflowEgress<T>(
  input: GuardWorkflowEgressInput<T>
): GuardWorkflowEgressResult<T> {
  if (input.sink === "local-tool") {
    return { value: input.value, mode: "off", redacted: false }
  }
  const forced = input.securityContext?.piiEgressRequired === true
  const mode: WorkflowPiiGateMode =
    forced && input.requestedMode !== "redact" ? "block" : (input.requestedMode ?? "block")
  if (mode === "off") return { value: input.value, mode, redacted: false }
  if (mode === "block") {
    if (!hasNoLeakingPiiDeep(input.value)) throw new WorkflowPiiBlockedError(input.sink)
    return { value: input.value, mode, redacted: false }
  }
  const count = { value: 0 }
  const value = redactDeep(input.value, count) as T
  if (!hasNoLeakingPiiDeep(value)) throw new WorkflowPiiBlockedError(input.sink)
  return { value, mode, redacted: count.value > 0 }
}
