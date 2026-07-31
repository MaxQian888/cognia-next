/**
 * ADR-0090 execution-layer errors → diagnostic inputs.
 *
 * These are the four typed errors the unified execution layer throws *before*
 * spending anything, plus the `degradedReason` it reports when a turn succeeded
 * on a lesser rail than the one the user configured. The first four were
 * surfaced as bare `error.message`; the fifth was never surfaced at all, which
 * is why a silently degraded run looked identical to a normal one.
 */

import type { DiagnosticCode, DiagnosticMeta } from "@cognia/diagnostics"
import {
  AgentCapabilityUnsatisfiedError,
  AgentHostUnavailableError,
  type AgentExecutionServiceResult,
} from "@/lib/ai/agent/execution/agent-execution-service"
import {
  AgentCapabilityError,
  FrozenModelBindingError,
} from "@/lib/ai/agent/execution/agent-execution-handle"

export interface ExecutionDiagnosis {
  code: DiagnosticCode
  message: string
  meta: DiagnosticMeta
}

type DegradedReason = NonNullable<AgentExecutionServiceResult["degradedReason"]>

const DEGRADED_TO_CODE: Readonly<Record<DegradedReason, DiagnosticCode>> = {
  "sidecar-unavailable": "sidecarUnreachable",
  "host-unavailable": "hostUnavailable",
  "legacy-completion-fallback": "degradedFallback",
  "external-agent-unavailable": "agentUnavailable",
}

/**
 * Diagnose a thrown execution error. Returns `null` for anything that isn't one
 * of the layer's own typed errors, so the caller keeps looking.
 */
export function diagnoseExecutionError(err: unknown): ExecutionDiagnosis | null {
  if (err instanceof AgentCapabilityUnsatisfiedError) {
    return {
      code: "capabilityUnsatisfied",
      message: err.message,
      meta: { extra: { missing: err.missing.join(", ") } },
    }
  }
  if (err instanceof AgentCapabilityError) {
    return {
      code: "capabilityUnsatisfied",
      message: err.message,
      meta: { extra: { capability: err.capability } },
    }
  }
  if (err instanceof AgentHostUnavailableError) {
    return { code: "hostUnavailable", message: err.message, meta: {} }
  }
  if (err instanceof FrozenModelBindingError) {
    return { code: "frozenModelBinding", message: err.message, meta: {} }
  }
  return null
}

/**
 * Diagnose a *successful* run that quietly took a lesser path.
 *
 * Disclosure, not a failure: the turn produced output, but not on the runtime
 * the user chose, and that changes cost and quality. Returns `null` when the
 * run took the path it was asked to.
 */
export function diagnoseDegradedReason(
  reason: AgentExecutionServiceResult["degradedReason"]
): ExecutionDiagnosis | null {
  if (!reason) return null
  return {
    code: DEGRADED_TO_CODE[reason],
    message: `agent execution degraded: ${reason}`,
    meta: { extra: { degradedReason: reason } },
  }
}
