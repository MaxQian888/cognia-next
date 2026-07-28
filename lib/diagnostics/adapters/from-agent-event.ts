/**
 * `CanonicalAgentEvent` failure/warning/capability-error → diagnostic inputs.
 *
 * ADR-0090's event stream already carries structured failures — `{ kind:
 * "failure", code, message, retryable }` — wrapped in an envelope that knows
 * the session, run, turn and attempt. All of that reached the renderer and was
 * flattened to a string. This adapter keeps it.
 *
 * `code` on a failure event is a free-form runtime string, so it is matched
 * against the registry and otherwise degrades to `unknown` rather than being
 * invented.
 */

import { isDiagnosticCode } from "@cognia/diagnostics"
import type { DiagnosticCode, DiagnosticMeta, DiagnosticSeverity } from "@cognia/diagnostics"
import type {
  AgentEventEnvelope,
  CanonicalAgentEvent,
} from "@cognia/agent-config-types/agent-execution"

export interface AgentEventDiagnosis {
  code: DiagnosticCode
  severity: DiagnosticSeverity
  message: string
  retryable?: boolean
  meta: DiagnosticMeta
}

/** Envelope fields worth keeping — everything here is already secret-free. */
function metaFromEnvelope(envelope?: AgentEventEnvelope): DiagnosticMeta {
  if (!envelope) return {}
  const meta: DiagnosticMeta = {}
  if (envelope.sessionId) meta.sessionId = envelope.sessionId
  const extras = envelope as unknown as Record<string, unknown>
  if (typeof extras.runId === "string") meta.runId = extras.runId
  if (typeof extras.turnId === "string") meta.turnId = extras.turnId
  if (typeof extras.attemptId === "string") meta.extra = { attemptId: extras.attemptId }
  return meta
}

/**
 * Diagnose a canonical event. Returns `null` for every event kind that isn't a
 * problem — the vast majority of the stream — so callers can pass the whole
 * stream through without pre-filtering.
 */
export function diagnoseAgentEvent(
  event: CanonicalAgentEvent,
  envelope?: AgentEventEnvelope
): AgentEventDiagnosis | null {
  const meta = metaFromEnvelope(envelope)

  if (event.kind === "failure") {
    return {
      code: isDiagnosticCode(event.code) ? event.code : "unknown",
      severity: "error",
      message: event.message,
      ...(event.retryable !== undefined ? { retryable: event.retryable } : {}),
      meta,
    }
  }

  if (event.kind === "warning") {
    return {
      code: isDiagnosticCode(event.code) ? event.code : "unknown",
      severity: "warning",
      message: event.message,
      meta,
    }
  }

  if (event.kind === "capability-error") {
    return {
      code: "capabilityUnsatisfied",
      severity: "error",
      message: event.command
        ? `${event.capability} is not supported by this runtime (${event.command})`
        : `${event.capability} is not supported by this runtime`,
      meta: { ...meta, extra: { ...(meta.extra ?? {}), capability: event.capability } },
    }
  }

  return null
}
