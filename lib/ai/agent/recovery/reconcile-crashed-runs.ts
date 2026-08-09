// Startup reconciliation for crashed agent runs (ADR-0090 Phase 8).
//
// At bootstrap (alongside `recoverPendingRunInterrupts`), any agent-turn
// execution run still projected `running` has lost its writer — the renderer
// just booted. Each one goes through the recovery state machine:
//
//   candidates ← the run's canonical envelope log (side-effect ambiguity
//                derived from unresolved tool calls)
//   recoverRun ← claims the single-writer lease, plans strict dominance
//     · pause  → a first-class `run.recovery_required` event (human decides)
//     · auto   → the run is parked as `run.paused` with the chosen candidate
//                recorded; NOTHING is replayed automatically — resuming is
//                an explicit operator/run-owner action.
//
// This is deliberately zero-replay: reconciliation only ever narrows a stale
// `running` into an honest terminal-adjacent state.

import { getDb } from "@/lib/db/schema"
import { runEventJournal, semanticRunEvent } from "@/lib/db/execution-runs"
import { releaseRunLease } from "@/lib/workflow/runtime/run-lease"
import type {
  AgentEventEnvelope,
  AgentExecutionSendSpec,
} from "@cognia/agent-config-types/agent-execution"
import type { CanonicalPermissionEvent } from "@cognia/agent-config-types/canonical-session"
import type { ConnectorInboundJobRow } from "@/lib/db/connector-types"

import {
  candidateFromEnvelopes,
  CanonicalLogCorruptionError,
  readCanonicalEnvelopes,
} from "./canonical-log"
import { recoverRun, type RecoverRunOutcome } from "./recover-run"
import { restorePermissionState, type RestoredPermission } from "./permission-restore"
import { planTicketRemint, type TicketRemintSpec } from "./ticket-remint"

export interface AgentRunRecoveryAnchorV1 extends TicketRemintSpec {
  version: 1
  inboundJobId: string
  sessionId: string
  sdkSessionId?: string
  attemptId: string
  executionIdentityRunId?: string
  routeKind: "gateway" | "direct"
  runtimeAdapter: string
  restoredPermissions?: RestoredPermission[]
  partialOutput?: string
}

export interface RecoveryContinuationSpec extends TicketRemintSpec {
  sdkSessionId?: string
}

export function buildAgentRunRecoveryAnchor(input: {
  inboundJobId: string
  sessionId: string
  sdkSessionId?: string
  execution: AgentExecutionSendSpec
  candidateDeploymentIds: string[]
  restoredPermissions?: RestoredPermission[]
  partialOutput?: string
}): AgentRunRecoveryAnchorV1 {
  return {
    version: 1,
    inboundJobId: input.inboundJobId,
    sessionId: input.sessionId,
    ...(input.sdkSessionId ? { sdkSessionId: input.sdkSessionId } : {}),
    attemptId: input.execution.identity.attemptId,
    executionIdentityRunId: input.execution.identity.runId,
    routeKind: input.execution.route.kind,
    executionFingerprint: input.execution.executionFingerprint,
    runtimeAdapter: input.execution.runtimeAdapter,
    candidateDeploymentIds: [...input.candidateDeploymentIds],
    modelBindings: { ...input.execution.modelBindings },
    ...(input.restoredPermissions
      ? { restoredPermissions: input.restoredPermissions.map((permission) => ({ ...permission })) }
      : {}),
    ...(input.partialOutput ? { partialOutput: input.partialOutput } : {}),
  }
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function restoredPermissions(value: unknown): value is RestoredPermission[] {
  return (
    Array.isArray(value) &&
    value.every(
      (permission) =>
        !!permission &&
        typeof permission === "object" &&
        typeof (permission as RestoredPermission).requestId === "string" &&
        typeof (permission as RestoredPermission).toolName === "string" &&
        ((permission as RestoredPermission).state === "pending" ||
          (permission as RestoredPermission).state === "denied") &&
        ((permission as RestoredPermission).downgradedFromAllow === undefined ||
          typeof (permission as RestoredPermission).downgradedFromAllow === "boolean")
    )
  )
}

export function parseAgentRunRecoveryAnchor(value: unknown): AgentRunRecoveryAnchorV1 | undefined {
  if (!value || typeof value !== "object") return undefined
  const anchor = value as Partial<AgentRunRecoveryAnchorV1>
  if (
    anchor.version !== 1 ||
    typeof anchor.inboundJobId !== "string" ||
    typeof anchor.sessionId !== "string" ||
    typeof anchor.attemptId !== "string" ||
    (anchor.executionIdentityRunId !== undefined &&
      typeof anchor.executionIdentityRunId !== "string") ||
    (anchor.routeKind !== "gateway" && anchor.routeKind !== "direct") ||
    typeof anchor.executionFingerprint !== "string" ||
    typeof anchor.runtimeAdapter !== "string" ||
    !stringArray(anchor.candidateDeploymentIds) ||
    !anchor.modelBindings ||
    typeof anchor.modelBindings.primary !== "string" ||
    (anchor.modelBindings.fast !== undefined && typeof anchor.modelBindings.fast !== "string") ||
    (anchor.modelBindings.powerful !== undefined &&
      typeof anchor.modelBindings.powerful !== "string") ||
    (anchor.restoredPermissions !== undefined &&
      !restoredPermissions(anchor.restoredPermissions)) ||
    (anchor.partialOutput !== undefined && typeof anchor.partialOutput !== "string") ||
    (anchor.sdkSessionId !== undefined && typeof anchor.sdkSessionId !== "string")
  ) {
    return undefined
  }
  return anchor as AgentRunRecoveryAnchorV1
}

function latestRecoveryAnchor(
  events: readonly { payload: Record<string, unknown> }[]
): AgentRunRecoveryAnchorV1 | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const anchor = parseAgentRunRecoveryAnchor(events[index].payload.recoveryAnchor)
    if (anchor) return anchor
  }
  return undefined
}

export function validateRecoveryContinuation(
  previous: AgentRunRecoveryAnchorV1,
  next: RecoveryContinuationSpec
): { action: "continue" } | { action: "pause"; mismatches: string[] } {
  const remint = planTicketRemint(previous, next)
  const mismatches = remint.action === "pause" ? [...remint.mismatches] : []
  if (!previous.sdkSessionId || previous.sdkSessionId !== next.sdkSessionId) {
    mismatches.unshift("sdkSessionId")
  }
  return mismatches.length > 0 ? { action: "pause", mismatches } : { action: "continue" }
}

function permissionEvents(envelopes: readonly AgentEventEnvelope[]): CanonicalPermissionEvent[] {
  const byRequest = new Map<string, CanonicalPermissionEvent>()
  for (const envelope of envelopes) {
    const event = envelope.event
    if (event.kind === "permission-request") {
      byRequest.set(event.requestId, {
        requestId: event.requestId,
        toolName: event.toolName,
        decision: "pending",
        at: envelope.timestamp,
      })
    } else if (event.kind === "permission-resolved") {
      const current = byRequest.get(event.requestId)
      if (current) {
        byRequest.set(event.requestId, {
          ...current,
          decision: event.behavior === "allow" ? "allow" : "deny",
          at: envelope.timestamp,
        })
      }
    }
  }
  return [...byRequest.values()]
}

type RecoverableInboundJob = Pick<ConnectorInboundJobRow, "id" | "status" | "executionRunId">

export interface ResumeCrashedAgentRunDeps {
  findInboundJob?: (runId: string) => Promise<RecoverableInboundJob | undefined>
  readSdkSessionId?: (sessionId: string) => Promise<string | undefined>
  continueInboundJob?: (
    id: string,
    options: { recoveryAnchor: Record<string, unknown> }
  ) => Promise<boolean>
}

export type ResumeCrashedAgentRunOutcome =
  { resumed: true; inboundJobId: string } | { resumed: false; reason: string }

/** Single validated entrance shared by Inbox and agent-turn resume controls. */
export async function resumeCrashedAgentRun(
  runId: string,
  deps: ResumeCrashedAgentRunDeps = {}
): Promise<ResumeCrashedAgentRunOutcome> {
  if (!runId) return { resumed: false, reason: "missing-run-id" }
  const events = await runEventJournal.replay(runId)
  if (
    events.some(
      (event) =>
        event.type === "run.recovery_required" &&
        event.payload.reason === "canonical-log-write-failed"
    )
  ) {
    return { resumed: false, reason: "canonical-log-corrupt" }
  }
  const anchor = latestRecoveryAnchor(events)
  if (!anchor) return { resumed: false, reason: "missing-recovery-anchor" }

  const envelopes = await readCanonicalEnvelopes(runId).catch(() => undefined)
  if (!envelopes) return { resumed: false, reason: "canonical-log-corrupt" }
  const candidate = candidateFromEnvelopes(envelopes)
  const recovery = await recoverRun(runId, candidate ? [candidate] : [])
  if (recovery.status !== "recovered") {
    return {
      resumed: false,
      reason: recovery.status === "recovery_required" ? recovery.reason : "lease-held",
    }
  }
  if (!candidate) return { resumed: false, reason: "no-candidates" }

  try {
    const findInboundJob =
      deps.findInboundJob ??
      (async (id: string) =>
        getDb()
          .connectorInboundJobs.filter((job) => job.executionRunId === id)
          .first())
    const job = await findInboundJob(runId)
    if (!job || job.id !== anchor.inboundJobId || job.status !== "recovery_required") {
      return { resumed: false, reason: "inbound-job-not-recoverable" }
    }
    const readSdkSessionId =
      deps.readSdkSessionId ??
      (async (sessionId: string) => (await getDb().sessions.get(sessionId))?.sdkSessionId)
    const sdkSessionId = await readSdkSessionId(anchor.sessionId)
    if (!anchor.sdkSessionId || sdkSessionId !== anchor.sdkSessionId) {
      return { resumed: false, reason: "sdk-session-drift" }
    }

    const restored = restorePermissionState(permissionEvents(envelopes))
    const partialOutput = candidate.turns.map((turn) => turn.text).join("")
    const nextAnchor: AgentRunRecoveryAnchorV1 = {
      ...anchor,
      attemptId: `recovery-${crypto.randomUUID()}`,
      restoredPermissions: restored,
      ...(partialOutput ? { partialOutput } : {}),
    }
    const continueInboundJob =
      deps.continueInboundJob ??
      (async (id: string, options: { recoveryAnchor: Record<string, unknown> }) => {
        const { continueConnectorInboundJobSafely } =
          await import("@/lib/db/connector-inbound-jobs")
        return continueConnectorInboundJobSafely(id, options)
      })
    const changed = await continueInboundJob(job.id, { recoveryAnchor: { ...nextAnchor } })
    if (!changed) {
      return { resumed: false, reason: "inbound-job-not-recoverable" }
    }
    await runEventJournal.append(
      runId,
      semanticRunEvent(
        "run.resumed",
        {
          candidateId: recovery.candidateId,
          attemptId: nextAnchor.attemptId,
          restoredPermissionCount: restored.length,
        },
        { sourceEventId: `recovery-resume:${nextAnchor.attemptId}` }
      )
    )
    return { resumed: true, inboundJobId: job.id }
  } finally {
    await releaseRunLease(runId)
  }
}

export interface ReconcileOutcome {
  runId: string
  outcome: RecoverRunOutcome
}

/**
 * Reconcile every stale-`running` agent-turn run. Best-effort per run — one
 * failing run never blocks the rest. Returns what happened for observability
 * and tests.
 */
export async function reconcileCrashedAgentRuns(
  now: number = Date.now()
): Promise<ReconcileOutcome[]> {
  const runs = await getDb().executionRuns.toArray()
  const crashed = runs.filter(
    (run) => run.kind === "agent-turn" && (run.latestSnapshot?.status ?? run.status) === "running"
  )

  const outcomes: ReconcileOutcome[] = []
  for (const run of crashed) {
    try {
      const events = await runEventJournal.replay(run.id)
      if (!latestRecoveryAnchor(events)) {
        const outcome: RecoverRunOutcome = {
          status: "recovery_required",
          reason: "missing-recovery-anchor",
          detail: [],
        }
        await runEventJournal.append(
          run.id,
          semanticRunEvent(
            "run.recovery_required",
            { reason: outcome.reason, detail: outcome.detail },
            { ts: now, sourceEventId: `crash-reconcile:${run.id}:missing-anchor` }
          )
        )
        outcomes.push({ runId: run.id, outcome })
        continue
      }
      const envelopes = await readCanonicalEnvelopes(run.id)
      const candidate = candidateFromEnvelopes(envelopes)
      const outcome = await recoverRun(run.id, candidate ? [candidate] : [])
      if (outcome.status === "recovered") {
        // Park — never replay. The chosen candidate is recorded so a resume
        // action knows what state it continues from.
        await runEventJournal.append(
          run.id,
          semanticRunEvent(
            "run.paused",
            { reason: "crash-reconciled", candidateId: outcome.candidateId },
            { ts: now, sourceEventId: `crash-reconcile:${run.id}` }
          )
        )
        await releaseRunLease(run.id)
      }
      outcomes.push({ runId: run.id, outcome })
    } catch (error) {
      if (error instanceof CanonicalLogCorruptionError) {
        const outcome: RecoverRunOutcome = {
          status: "recovery_required",
          reason: "canonical-log-corrupt",
          detail: [],
        }
        await runEventJournal
          .append(
            run.id,
            semanticRunEvent("run.recovery_required", {
              reason: outcome.reason,
              detail: outcome.detail,
            })
          )
          .catch(() => undefined)
        outcomes.push({ runId: run.id, outcome })
      }
      // Other reconciliation failures stay best-effort and leave the run untouched.
    }
  }
  return outcomes
}
