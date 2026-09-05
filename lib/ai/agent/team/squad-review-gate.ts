/**
 * Squad human-in-the-loop, on the Action Review contract (ADR-0168).
 *
 * Before this module the six Squad gates blocked on an in-memory approval bus
 * (`lib/runtime/approval-bus.ts`), mirrored into a persisted UI store that
 * marked every gate `interrupted` on reload because the waiter had died with
 * the page. Nothing durable said a run was waiting, nothing durable said what
 * was decided, and a phone could not answer.
 *
 * Now every gate is ONE thing in three layers:
 *
 *   - `ExecutionRunInterrupt` is the sole durable pending record. It is what
 *     the cockpit, the attention panel, IM cards and a paired device list, and
 *     what `allowedActions` turns into Approve/Deny.
 *   - `ActionReviewRequest/Decision/Receipt` is the sole protocol and audit
 *     format. The receipt is written on settlement however the answer arrived.
 *   - `RunControlCommand{approve|deny, reviewDecision}` is the sole way to
 *     answer, validated by `run-control.ts` against the interrupt's kind.
 *
 * Restart-safety, in order: a checkpoint is recorded BEFORE the interrupt is
 * opened, the interrupt id is deterministic per gate instance so a re-armed
 * lifecycle finds the same row, and a decision that already landed while the
 * process was down is returned at once, so a run resumes exactly once after
 * settlement. Expiry denies (the control plane's `recoverPendingRunInterrupts`
 * owns the deadline), except `team_recovery`, whose TTL is a week because
 * expiring it would decide for the person.
 *
 * Free text never enters a run event. Plan feedback is redacted with
 * `@cognia/redact` before it is stored on the interrupt row and before it
 * reaches the lead as the next revision's instruction.
 */

import Dexie from "dexie"
import { redactText } from "@cognia/redact"
import type {
  ActionReviewChannel,
  ActionReviewDecision,
  ActionReviewRequest,
} from "@cognia/agent-config-types/action-review"
import { ACTION_REVIEW_CONTRACT_VERSION } from "@cognia/agent-config-types/action-review"

import { getDb } from "@/lib/db/schema"
import { appendAgentTeamTrajectory, markAgentTeamCheckpoint } from "@/lib/db/agent-team-runtime"
import { agentTeamExecutionRunId } from "@/lib/execution/agent-team-bridge"
import {
  actionReviewInterruptId,
  projectActionReviewOpened,
  projectActionReviewSettled,
} from "@/lib/policy/action-review/projection"
import { getActionReviewChannelAdapter } from "@/lib/policy/action-review/registry"
import {
  squadReviewInterruptType,
  type ExecutionRunInterrupt,
  type RunControlCommand,
  type SquadReviewDecision,
  type SquadReviewKind,
} from "@/types/execution/run"

/** The channel each review kind is audited under. */
export const SQUAD_REVIEW_CHANNELS: Record<SquadReviewKind, ActionReviewChannel> = {
  plan: "agent-team-plan",
  capability_audit: "agent-team-gate",
  budget_extension: "agent-team-budget",
  deadlock: "agent-team-deadlock",
  teammate_repair: "agent-team-teammate-repair",
  replan: "agent-team-replan",
  team_recovery: "agent-team-recovery",
}

export type SquadReviewOutcome = SquadReviewDecision & { outcome: "approve" | "deny" }

export interface OpenSquadReviewInput {
  /** The durable Squad run id (`run_team_…`), not the execution run id. */
  runId: string
  teamId: string
  projectId?: string
  kind: SquadReviewKind
  /**
   * Distinguishes repeated gates of one kind in one run: the plan revision, a
   * teammate id, a budget crossing count. Part of the deterministic request
   * id, so a re-armed lifecycle finds THIS gate and not an earlier one.
   */
  instance: string
  /** Structured, non-sensitive context for the decision form. */
  subject?: Record<string, unknown>
  /** Aborts the wait (the run was stopped or paused). The interrupt stays. */
  signal?: AbortSignal
  /**
   * A surface that can ask directly (an IM card). Raced against the
   * interrupt: whichever answers first settles both.
   */
  delegate?: () => Promise<SquadReviewOutcome>
  /** Override the channel's TTL. */
  ttlMs?: number
  /** Where the receipt says the decision came from. */
  headless?: boolean
  /** The lead id, for the ledger checkpoint. */
  decisionVersion?: number
  trajectorySequence?: number
}

export interface SquadReviewDeps {
  now?: () => number
  redact?: (text: string) => string
  /** Test seam: replace the Dexie live query with a manual notifier. */
  subscribe?: (
    interruptId: string,
    listener: (row: ExecutionRunInterrupt | undefined) => void
  ) => () => void
  checkpoint?: (input: OpenSquadReviewInput) => Promise<void>
}

const defaultRedact = (text: string): string => redactText(text).redacted

/**
 * Backstop poll behind the Dexie live query, in case a change event is missed
 * or unavailable (the same posture `watch-squad-run.ts` takes). Tests lower
 * it through {@link __setSquadReviewTestHooksForTesting}.
 */
let pollIntervalMs = 2_000
let subscribeOverride: SquadReviewDeps["subscribe"] | undefined

/** Test-only: replace the live subscription or the poll cadence. */
export function __setSquadReviewTestHooksForTesting(
  hooks: { subscribe?: SquadReviewDeps["subscribe"]; pollIntervalMs?: number } | null
): void {
  subscribeOverride = hooks?.subscribe
  pollIntervalMs = hooks?.pollIntervalMs ?? 2_000
}

/** Deterministic per gate instance, so a restart re-arms the same row. */
export function squadReviewRequestId(
  runId: string,
  kind: SquadReviewKind,
  instance: string
): string {
  return `squad-review:${runId}:${kind}:${instance}`
}

export function squadReviewInterruptIdFor(
  runId: string,
  kind: SquadReviewKind,
  instance: string
): string {
  return actionReviewInterruptId(squadReviewRequestId(runId, kind, instance))
}

function buildRequest(input: OpenSquadReviewInput, now: number): ActionReviewRequest {
  const channel = SQUAD_REVIEW_CHANNELS[input.kind]
  const adapter = getActionReviewChannelAdapter(channel)
  return {
    contractVersion: ACTION_REVIEW_CONTRACT_VERSION,
    requestId: squadReviewRequestId(input.runId, input.kind, input.instance),
    origin: {
      channel,
      scope: "agent-team",
      id: `${input.runId}:${input.kind}:${input.instance}`,
      runId: agentTeamExecutionRunId(input.runId),
      teamId: input.teamId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.headless ? { headless: true } : {}),
    },
    subject: {
      kind: input.kind === "plan" || input.kind === "replan" ? "plan" : "run-continue",
      ref: input.kind,
      ...(input.subject ? { input: input.subject } : {}),
    },
    verdict: "ask",
    verdictExplicit: true,
    tier: input.kind === "team_recovery" ? "high" : "medium",
    surfaces: [],
    requestedAt: now,
    expiresAt: now + (input.ttlMs ?? adapter.defaultTtlMs),
  }
}

async function defaultCheckpoint(input: OpenSquadReviewInput): Promise<void> {
  // A run-level checkpoint: nothing about a child, everything about "the run
  // is parked here, and here is safe". The trajectory event is what a
  // recovery reads to know a gate was open when the process died.
  const at = Date.now()
  const event = await appendAgentTeamTrajectory({
    runId: input.runId,
    kind: "checkpoint",
    correlationId: squadReviewRequestId(input.runId, input.kind, input.instance),
    payload: { gate: input.kind, instance: input.instance },
    createdAt: at,
  })
  await markAgentTeamCheckpoint({
    runId: input.runId,
    trajectorySequence: input.trajectorySequence ?? event.sequence,
    decisionVersion: input.decisionVersion ?? 0,
    replay: "safe",
    sideEffects: [],
    createdAt: at,
  })
}

function defaultSubscribe(
  interruptId: string,
  listener: (row: ExecutionRunInterrupt | undefined) => void
): () => void {
  // `Dexie.liveQuery`, not a named import: dexie's CJS build makes it
  // non-enumerable and the wildcard interop drops it (see execution-runs.ts).
  const subscription = Dexie.liveQuery(() =>
    getDb().executionRunInterrupts.get(interruptId)
  ).subscribe({ next: listener, error: () => listener(undefined) })
  return () => subscription.unsubscribe()
}

function outcomeFromRow(row: ExecutionRunInterrupt, kind: SquadReviewKind): SquadReviewOutcome {
  if (row.decision) return row.decision
  // A row settled without a typed payload (expired, denied without a body,
  // resolved from a source that predates the payload). The outcome is what
  // the status says. `approve` without a payload is only legal for the two
  // kinds that need none, which `validateSquadReviewDecision` guarantees.
  const outcome = row.status === "approved" ? "approve" : "deny"
  return { ...(defaultDecisionFor(kind) as SquadReviewDecision), outcome }
}

function defaultDecisionFor(kind: SquadReviewKind): SquadReviewDecision {
  switch (kind) {
    case "plan":
      return { kind: "plan" }
    case "capability_audit":
      return { kind: "capability_audit" }
    case "budget_extension":
      return { kind: "budget_extension", extraTokens: 0 }
    case "deadlock":
      return { kind: "deadlock", resetAll: true }
    case "teammate_repair":
      return { kind: "teammate_repair", action: "skip" }
    case "replan":
      return { kind: "replan" }
    case "team_recovery":
      return { kind: "team_recovery", choice: "terminate" }
  }
}

/**
 * Open (or re-arm) a Squad review and wait for its decision.
 *
 * Idempotent per `(runId, kind, instance)`: if the interrupt already exists
 * and is settled, the stored decision is returned without waiting. If it
 * exists and is pending, the wait attaches to it. Otherwise it is created.
 */
export async function openSquadReview(
  input: OpenSquadReviewInput,
  deps: SquadReviewDeps = {}
): Promise<SquadReviewOutcome> {
  const now = deps.now ?? Date.now
  const interruptId = squadReviewInterruptIdFor(input.runId, input.kind, input.instance)
  const request = buildRequest(input, now())

  const existing = await getDb().executionRunInterrupts.get(interruptId)
  if (existing && existing.status !== "pending") {
    return outcomeFromRow(existing, input.kind)
  }
  if (!existing) {
    await (deps.checkpoint ?? defaultCheckpoint)(input).catch(() => undefined)
    const projected = await projectActionReviewOpened(request, now())
    if (!projected) {
      // No execution run to park on. That is a programming error under
      // ADR-0168 (records exist before dispatch), and a silent auto-approve
      // would be the worst possible reading of it.
      throw new Error(`squad_review_unprojectable:${input.kind}`)
    }
    await getDb().executionRunInterrupts.update(interruptId, {
      reviewKind: input.kind,
      ...(input.subject ? { subject: input.subject } : {}),
    })
  }

  return new Promise<SquadReviewOutcome>((resolve, reject) => {
    let settled = false
    let unsubscribe: () => void = () => {}
    const finish = (value: SquadReviewOutcome) => {
      if (settled) return
      settled = true
      unsubscribe()
      input.signal?.removeEventListener("abort", onAbort)
      resolve(value)
    }
    const onAbort = () => {
      if (settled) return
      settled = true
      unsubscribe()
      reject(input.signal?.reason ?? new Error("Aborted"))
    }
    if (input.signal?.aborted) {
      onAbort()
      return
    }
    input.signal?.addEventListener("abort", onAbort, { once: true })

    const onRow = (row: ExecutionRunInterrupt | undefined) => {
      if (!row || row.status === "pending") return
      finish(outcomeFromRow(row, input.kind))
    }
    const stopLive = (deps.subscribe ?? subscribeOverride ?? defaultSubscribe)(interruptId, onRow)
    const poll = setInterval(() => {
      void getDb()
        .executionRunInterrupts.get(interruptId)
        .then(onRow)
        .catch(() => undefined)
    }, pollIntervalMs)
    unsubscribe = () => {
      clearInterval(poll)
      stopLive()
    }

    if (input.delegate) {
      void input
        .delegate()
        .then(async (outcome) => {
          if (settled) return
          await settleSquadReview(
            { runId: input.runId, kind: input.kind, instance: input.instance },
            outcome,
            { authority: "human", actorKind: "connector-user" },
            deps
          ).catch(() => undefined)
          finish(outcome)
        })
        .catch(() => {
          // A delegate that failed is not a decision. The interrupt stays.
        })
    }
  })
}

export interface SettleSquadReviewTarget {
  runId: string
  kind: SquadReviewKind
  instance: string
}

export interface SettleSquadReviewSource {
  authority: ActionReviewDecision["authority"]
  actorKind: "local-user" | "device" | "connector-user"
  actorId?: string
  actorLabel?: string
}

/**
 * Settle a review from a source other than the control plane (an IM delegate,
 * a headless policy). Writes the decision onto the row, resolves the interrupt
 * and records the receipt. Idempotent on an already-settled row.
 */
export async function settleSquadReview(
  target: SettleSquadReviewTarget,
  outcome: SquadReviewOutcome,
  source: SettleSquadReviewSource,
  deps: SquadReviewDeps = {}
): Promise<void> {
  const now = deps.now ?? Date.now
  const interruptId = squadReviewInterruptIdFor(target.runId, target.kind, target.instance)
  const row = await getDb().executionRunInterrupts.get(interruptId)
  if (!row || row.status !== "pending") return
  const decision = sanitizeDecision(outcome, deps.redact ?? defaultRedact)
  await getDb().executionRunInterrupts.update(interruptId, { decision })
  const request = buildRequest(
    {
      runId: target.runId,
      teamId: (await teamIdForRun(target.runId)) ?? "",
      kind: target.kind,
      instance: target.instance,
      ...(row.subject ? { subject: row.subject } : {}),
    },
    row.createdAt
  )
  await projectActionReviewSettled(request, {
    contractVersion: ACTION_REVIEW_CONTRACT_VERSION,
    requestId: request.requestId,
    outcome: outcome.outcome === "approve" ? "allow" : "deny",
    authority: source.authority,
    actor: {
      kind: source.actorKind,
      ...(source.actorId ? { id: source.actorId } : {}),
      ...(source.actorLabel ? { label: source.actorLabel } : {}),
    },
    decidedAt: now(),
  })
}

async function teamIdForRun(runId: string): Promise<string | undefined> {
  const run = await getDb().agentTeamRuns.get(runId)
  return run?.teamId
}

/**
 * Strip and redact before anything is persisted. Only `feedback` is free
 * text. Everything else is ids, numbers and closed-vocabulary codes.
 */
export function sanitizeDecision(
  outcome: SquadReviewOutcome,
  redact: (text: string) => string
): SquadReviewOutcome {
  if (outcome.kind === "plan" && typeof outcome.feedback === "string") {
    const trimmed = outcome.feedback.trim()
    return {
      kind: "plan",
      outcome: outcome.outcome,
      ...(trimmed ? { feedback: redact(trimmed) } : {}),
    }
  }
  return outcome
}

/**
 * The control plane's half: called by the `team` run-control handler on
 * `approve` / `deny`, after `run-control.ts` validated the command against
 * the interrupt. Persists the typed decision so a waiter (live, or re-armed
 * after a restart) reads it, records the receipt, and leaves a note in the
 * conversation the run belongs to.
 */
export async function settleSquadReviewFromControl(
  command: RunControlCommand,
  deps: SquadReviewDeps = {}
): Promise<void> {
  if (!command.interruptId) throw new Error("interrupt_not_found")
  const row = await getDb().executionRunInterrupts.get(command.interruptId)
  if (!row || row.runId !== command.runId) throw new Error("interrupt_not_found")
  const kind = row.reviewKind
  if (!kind) throw new Error("not_a_squad_review")
  const outcome: SquadReviewOutcome = {
    ...((command.reviewDecision ?? defaultDecisionFor(kind)) as SquadReviewDecision),
    outcome: command.action === "approve" ? "approve" : "deny",
  }
  const decision = sanitizeDecision(outcome, deps.redact ?? defaultRedact)
  // The control gate flips `status` and journals `interrupt.resolved` AFTER
  // the handler returns. Writing the decision first means a waiter that wakes
  // on the status flip always finds the payload beside it.
  await getDb().executionRunInterrupts.update(row.id, { decision })

  const requestId = squadReviewRequestIdFromInterrupt(row)
  if (requestId) {
    const { recordActionReviewReceipt, ACTION_REVIEW_RETENTION_DAYS } =
      await import("@/lib/db/action-review-receipts")
    const now = (deps.now ?? Date.now)()
    const request = buildRequest(
      {
        runId: requestId.runId,
        teamId: (await teamIdForRun(requestId.runId)) ?? "",
        kind,
        instance: requestId.instance,
        ...(row.subject ? { subject: row.subject } : {}),
      },
      row.createdAt
    )
    await recordActionReviewReceipt({
      contractVersion: ACTION_REVIEW_CONTRACT_VERSION,
      id: request.requestId,
      request,
      decision: {
        contractVersion: ACTION_REVIEW_CONTRACT_VERSION,
        requestId: request.requestId,
        outcome: command.action === "approve" ? "allow" : "deny",
        authority: "human",
        actor: {
          kind: command.actor.remoteUserId ? "device" : "local-user",
          ...(command.actor.remoteUserId
            ? { id: command.actor.remoteUserId }
            : command.actor.platformIdentityId
              ? { id: command.actor.platformIdentityId }
              : {}),
          ...(command.actor.displayName ? { label: command.actor.displayName } : {}),
        },
        decidedAt: now,
      },
      expiresAt: now + ACTION_REVIEW_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    }).catch(() => undefined)

    // The note in the conversation. Best-effort, like every record of an answer.
    void import("./record-gate-answer")
      .then(({ recordSquadGateAnswer }) =>
        recordSquadGateAnswer({
          runId: requestId.runId,
          gateType: kind,
          decision: command.action === "approve" ? "approved" : "rejected",
          title: row.title,
        })
      )
      .catch(() => undefined)
  }
}

/** Parse `(runId, kind, instance)` back out of an interrupt row. */
export function squadReviewRequestIdFromInterrupt(
  row: Pick<ExecutionRunInterrupt, "id">
): { runId: string; kind: SquadReviewKind; instance: string } | undefined {
  const prefix = actionReviewInterruptId("squad-review:")
  if (!row.id.startsWith(prefix)) return undefined
  const rest = row.id.slice(prefix.length)
  const first = rest.indexOf(":")
  const second = rest.indexOf(":", first + 1)
  if (first < 0 || second < 0) return undefined
  const kind = rest.slice(first + 1, second) as SquadReviewKind
  if (!(kind in SQUAD_REVIEW_CHANNELS)) return undefined
  return { runId: rest.slice(0, first), kind, instance: rest.slice(second + 1) }
}

/** Every pending Squad review on one run, newest first. */
export async function listPendingSquadReviews(runId: string): Promise<ExecutionRunInterrupt[]> {
  const rows = await getDb()
    .executionRunInterrupts.where("[runId+status]")
    .equals([agentTeamExecutionRunId(runId), "pending"])
    .toArray()
  return rows
    .filter((row) => row.reviewKind !== undefined)
    .sort((a, b) => b.createdAt - a.createdAt)
}

/** The interrupt type a review kind opens, re-exported for callers building UI. */
export { squadReviewInterruptType }
