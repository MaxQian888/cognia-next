/**
 * Online-evaluation transport — the seam that lets a finished production trace
 * become evaluation work.
 *
 * Why a transport and not a hook on the emitter: `setAgentTraceWriter` is a
 * SINGLE slot, not a listener list, so a second subscriber there would displace
 * the one that persists spans. `addTransport` is the registry that already
 * exists for this, and `dispatchSpanToTransports` calls every transport as
 * `void t.log(entry)` — never awaited. That is what keeps this off the user's
 * response path: the work done here is a selector match over cheap fields and
 * one Dexie put, and even that is not awaited by the caller.
 *
 * Three rules the shape enforces:
 *
 *  - Only ROOT spans (no `parentSpanId`) in a terminal status are considered. A
 *    trace is finished when its root closes; enqueueing on every child span
 *    would queue the same trace a dozen times.
 *  - Selection reads ids, surface and model — never message bodies. Reading
 *    content here would put PII handling on the completion path.
 *  - With no enabled policy the transport returns immediately, so an unused
 *    feature costs one map lookup per finished trace.
 */

import type { StructuredLogEntry, Transport, TransportHealthSnapshot } from "@/types/logging"
import { recordDrop, type LogDropCounts, type LogDropReason } from "@cognia/logging/types/transport"
import type { AgentTraceSpan } from "@/types/agent-trace/span"
import { AGENT_TRACE_SPAN_KIND } from "@/types/agent-trace/span"
import {
  matchesOnlineEvalPolicy,
  type OnlineEvalCandidate,
  type OnlineEvalPolicyV1,
} from "@cognia/eval-core"

/** What the transport needs, injected so tests never touch Dexie. */
export interface EvalOnlineTransportDependencies {
  /** Enabled policies for the active workspace. Cached by the caller. */
  loadPolicies: () => readonly OnlineEvalPolicyV1[]
  enqueue: (input: {
    id: string
    policyId: string
    policyVersionId: string
    traceId: string
    now: number
  }) => Promise<unknown>
  now?: () => number
  newId?: (policyVersionId: string, traceId: string) => string
}

/**
 * A root span that ended. `pending` is excluded on purpose: a span still open
 * has no verdict to score, and `incomplete` (the stale-span reaper) means the
 * turn was abandoned rather than answered.
 */
export function isScorableRootSpan(span: AgentTraceSpan): boolean {
  if (span.parentSpanId) return false
  return span.status === "ok" || span.status === "error"
}

/** Cheap fields only — deliberately no message content. */
export function candidateFromSpan(span: AgentTraceSpan): OnlineEvalCandidate {
  return {
    traceId: span.traceId,
    ...(span.projectId !== undefined ? { projectId: span.projectId } : {}),
    surface: span.surface,
    ...((span.responseModel ?? span.requestModel)
      ? { model: span.responseModel ?? span.requestModel }
      : {}),
    operation: span.operationName,
    // An errored turn is the one most worth a judge's attention, so it jumps
    // the sampling rate — while still being held to the budget.
    ...(span.status === "error" ? { priority: true } : {}),
  }
}

export class EvalOnlineTransport implements Transport {
  name = "eval-online"
  private deps: EvalOnlineTransportDependencies
  private enqueued = 0
  private droppedEntries = 0
  private droppedByReason: LogDropCounts = {}
  private lastSuccessAt: string | undefined
  private lastFailureAt: string | undefined
  private lastError: string | undefined

  constructor(deps: EvalOnlineTransportDependencies) {
    this.deps = deps
  }

  private recordDropped(reason: LogDropReason, count: number): void {
    if (!Number.isFinite(count) || count <= 0) return
    this.droppedEntries += count
    recordDrop(this.droppedByReason, reason, count)
  }

  log(entry: StructuredLogEntry): void {
    const span = extractSpan(entry)
    if (!span || !isScorableRootSpan(span)) return

    const policies = this.deps.loadPolicies()
    if (policies.length === 0) return

    const candidate = candidateFromSpan(span)
    const now = this.deps.now?.() ?? Date.now()
    for (const policy of policies) {
      if (!matchesOnlineEvalPolicy(policy, candidate)) continue
      const id = this.deps.newId
        ? this.deps.newId(policy.versionId, span.traceId)
        : `oev_${policy.versionId}_${span.traceId}`
      // Fire and forget: this runs on the trace-completion path, and a slow or
      // failed enqueue must never propagate into the turn that produced it.
      void this.deps
        .enqueue({
          id,
          policyId: policy.id,
          policyVersionId: policy.versionId,
          traceId: span.traceId,
          now,
        })
        .then(() => {
          this.enqueued += 1
          this.lastSuccessAt = new Date().toISOString()
          this.lastError = undefined
        })
        .catch((error: unknown) => {
          this.recordDropped("ship-failed", 1)
          this.lastFailureAt = new Date().toISOString()
          this.lastError = error instanceof Error ? error.message : String(error)
        })
    }
  }

  getHealth(): TransportHealthSnapshot {
    return {
      transport: this.name,
      status: this.lastError ? "degraded" : "healthy",
      queueDepth: 0,
      retryCount: 0,
      droppedEntries: this.droppedEntries,
      droppedByReason: this.droppedByReason,
      ...(this.lastSuccessAt ? { lastSuccessAt: this.lastSuccessAt } : {}),
      ...(this.lastFailureAt ? { lastFailureAt: this.lastFailureAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      updatedAt: new Date().toISOString(),
    }
  }

  /** Enqueued traces since construction. Exposed for the settings surface. */
  getEnqueuedCount(): number {
    return this.enqueued
  }
}

function extractSpan(entry: StructuredLogEntry): AgentTraceSpan | null {
  const data = entry.data as Record<string, unknown> | undefined
  if (!data || data.kind !== AGENT_TRACE_SPAN_KIND) return null
  const span = data.span
  if (!span || typeof span !== "object") return null
  const candidate = span as Record<string, unknown>
  if (typeof candidate.id !== "string" || typeof candidate.traceId !== "string") return null
  return span as AgentTraceSpan
}

export function createEvalOnlineTransport(
  deps: EvalOnlineTransportDependencies
): EvalOnlineTransport {
  return new EvalOnlineTransport(deps)
}
