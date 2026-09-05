/**
 * Squad telemetry on the existing agent-trace substrate (ADR-0169).
 *
 * One root span per Squad run, under which the per-teammate `invoke_agent`
 * spans `dispatch-teammate.ts` already emits nest (they reuse the run's
 * `traceId`). Reviews and recovery are child spans and events on that root:
 *
 *   squad.review        a child span from "interrupt raised" to "settled",
 *                       carrying the review kind and the outcome
 *   squad.dispatch      an event with the queue-to-start latency of a child
 *   squad.recovery      an event with the choice and whether it applied
 *   squad.duplicate     an event for a control the gate recognised as a replay
 *   terminal reason     closes the root span, with token totals when known
 *
 * Nothing here carries a prompt, an argument, a file path or a secret. Ids,
 * codes, counts and durations only: every attribute is something the run
 * journal already projects onto a phone.
 *
 * Spans are kept in a module map keyed by run id, because the review gate
 * and the recovery module have the run id and nothing else in common with
 * the lifecycle that opened the trace. A process that did not open the root
 * (a review answered after a restart) still emits a self-contained span.
 */

import { endSpan, recordEvent, startSpan } from "@cognia/agent-trace/emitter"
import type { SpanUsage } from "@/types/agent-trace/span"
import type { SquadReviewKind, TeamRecoveryChoice } from "@/types/execution/run"

interface RootSpan {
  spanId: string
  traceId: string
  startedAt: number
}

const roots = new Map<string, RootSpan>()
const reviews = new Map<string, { spanId: string; startedAt: number }>()

export interface SquadRunSpanInput {
  runId: string
  teamId: string
  projectId?: string
  origin?: string
  /** Reuse a caller's trace (an eval target, a parent workflow). */
  traceId?: string
  now?: () => number
}

/** Open the run's root span. Idempotent per run id. Returns its trace id. */
export function startSquadRunSpan(input: SquadRunSpanInput): { traceId: string; spanId: string } {
  const existing = roots.get(input.runId)
  if (existing) return { traceId: existing.traceId, spanId: existing.spanId }
  const handle = startSpan({
    operationName: "invoke_agent",
    providerName: "cognia.team",
    surface: "agent-team",
    sessionId: input.runId,
    runId: input.runId,
    agentId: input.teamId,
    agentName: "squad",
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.traceId ? { traceId: input.traceId } : {}),
    metadata: {
      role: "squad-run",
      teamId: input.teamId,
      ...(input.origin ? { origin: input.origin } : {}),
    },
  })
  roots.set(input.runId, {
    spanId: handle.spanId,
    traceId: handle.traceId,
    startedAt: (input.now ?? Date.now)(),
  })
  return handle
}

export function squadRunTraceId(runId: string): string | undefined {
  return roots.get(runId)?.traceId
}

export interface EndSquadRunSpanInput {
  runId: string
  /** `completed` / `failed` / `cancelled` / `needs_input` / `paused`. */
  terminalStatus: string
  /** A reason CODE (`recovery_required`, `delivery_failed`, `operator_stop`). */
  terminalReason?: string
  usage?: SpanUsage
  costUsdEstimate?: number
  /** How many controls the gate answered as duplicates during the run. */
  duplicateControls?: number
}

/** Close the root span. No-op when this process never opened it. */
export function endSquadRunSpan(input: EndSquadRunSpanInput): void {
  const root = roots.get(input.runId)
  if (!root) return
  roots.delete(input.runId)
  endSpan(root.spanId, {
    ...(input.usage ? { usage: input.usage } : {}),
    ...(input.costUsdEstimate !== undefined ? { costUsdEstimate: input.costUsdEstimate } : {}),
    finishReasons: [input.terminalStatus],
    ...(input.terminalStatus === "failed" && input.terminalReason
      ? { errorType: input.terminalReason }
      : {}),
    metadata: {
      terminalStatus: input.terminalStatus,
      ...(input.terminalReason ? { terminalReason: input.terminalReason } : {}),
      ...(input.duplicateControls !== undefined
        ? { duplicateControls: input.duplicateControls }
        : {}),
    },
  })
}

export interface SquadReviewSpanInput {
  runId: string
  teamId?: string
  interruptId: string
  kind: SquadReviewKind
  now?: () => number
}

/** A review was raised. Opens the gate-wait span under the run's root. */
export function beginSquadReviewSpan(input: SquadReviewSpanInput): void {
  if (reviews.has(input.interruptId)) return
  const root = roots.get(input.runId)
  const handle = startSpan({
    operationName: "invoke_agent",
    providerName: "cognia.team",
    surface: "agent-team",
    sessionId: input.runId,
    runId: input.runId,
    ...(input.teamId ? { agentId: input.teamId } : {}),
    agentName: "squad-review",
    ...(root ? { traceId: root.traceId, parentSpanId: root.spanId } : {}),
    metadata: { role: "squad-review", reviewKind: input.kind, interruptId: input.interruptId },
  })
  reviews.set(input.interruptId, { spanId: handle.spanId, startedAt: (input.now ?? Date.now)() })
}

/** The review settled. Closes its span with the outcome and the wait. */
export function endSquadReviewSpan(input: {
  interruptId: string
  outcome: "approve" | "deny" | "expired"
  /** Where the answer came from: `cockpit`, `device`, `connector`, `expiry`. */
  source?: string
  now?: () => number
}): number | undefined {
  const open = reviews.get(input.interruptId)
  if (!open) return undefined
  reviews.delete(input.interruptId)
  const waitMs = Math.max(0, (input.now ?? Date.now)() - open.startedAt)
  endSpan(open.spanId, {
    finishReasons: [input.outcome],
    metadata: {
      outcome: input.outcome,
      gateWaitMs: waitMs,
      ...(input.source ? { source: input.source } : {}),
    },
  })
  return waitMs
}

/** Queue-to-start latency of one child dispatch. */
export function recordSquadDispatchLatency(input: {
  runId: string
  childRunId: string
  latencyMs: number
  hostRef?: string
  now?: () => number
}): boolean {
  const root = roots.get(input.runId)
  if (!root) return false
  return recordEvent(root.spanId, {
    name: "squad.dispatch",
    at: (input.now ?? Date.now)(),
    attributes: {
      childRunId: input.childRunId,
      latencyMs: input.latencyMs,
      ...(input.hostRef ? { hostRef: input.hostRef } : {}),
    },
  })
}

/** A recovery decision was applied (or refused). */
export function recordSquadRecoveryOutcome(input: {
  runId: string
  choice: TeamRecoveryChoice
  applied: boolean
  reason?: string
  now?: () => number
}): boolean {
  const root = roots.get(input.runId)
  const at = (input.now ?? Date.now)()
  const attributes = {
    choice: input.choice,
    applied: input.applied,
    ...(input.reason ? { reason: input.reason } : {}),
  }
  if (root) return recordEvent(root.spanId, { name: "squad.recovery", at, attributes })
  // The run's lifecycle is not alive in this process (that is what recovery
  // means). Emit a self-contained span so the outcome is still traceable.
  const handle = startSpan({
    operationName: "invoke_agent",
    providerName: "cognia.team",
    surface: "agent-team",
    sessionId: input.runId,
    runId: input.runId,
    agentName: "squad-recovery",
    metadata: { role: "squad-recovery", ...attributes },
  })
  endSpan(handle.spanId, { finishReasons: [input.applied ? "applied" : "refused"] })
  return true
}

const duplicateCounts = new Map<string, number>()

/** A control command the gate recognised as a replay of one it already took. */
export function recordSquadDuplicateControl(input: {
  runId: string
  action: string
  now?: () => number
}): number {
  const count = (duplicateCounts.get(input.runId) ?? 0) + 1
  duplicateCounts.set(input.runId, count)
  const root = roots.get(input.runId)
  if (root) {
    recordEvent(root.spanId, {
      name: "squad.duplicate_control",
      at: (input.now ?? Date.now)(),
      attributes: { action: input.action, count },
    })
  }
  return count
}

export function squadDuplicateControlCount(runId: string): number {
  return duplicateCounts.get(runId) ?? 0
}

export function __resetSquadTelemetryForTesting(): void {
  roots.clear()
  reviews.clear()
  duplicateCounts.clear()
}
