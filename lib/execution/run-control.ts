import { getDb } from "@/lib/db/schema"
import {
  adoptExecutionRun,
  getExecutionRun,
  listExecutionRunEvents,
  runEventJournal,
  semanticRunEvent,
} from "@/lib/db/execution-runs"
import { reduceRunEvents } from "./run-reducer"
import { getRunRetryHandler } from "./run-retry-registry"
import { validateSquadReviewDecision } from "./squad-review-decision"
import type {
  ExecutionRun,
  ExecutionRunInitiator,
  ExecutionRunInterrupt,
  ExecutionRunKind,
  RunControlCommand,
} from "@/types/execution/run"

/**
 * What a handler can tell the control gate about what it did.
 *
 * `void` keeps every existing handler valid. The one thing a handler needs to
 * report is a steering RECEIPT id — never the steering text, which must not
 * enter the journal (see {@link RunControlCommand.steerMessage}).
 */
export interface RunControlHandlerOutcome {
  steerReceiptIds?: readonly string[]
}

export type RunControlHandler = (
  command: RunControlCommand
) => Promise<void | RunControlHandlerOutcome>

/**
 * Why a steer could not be applied as asked.
 *
 * Named rather than collapsed into a generic refusal because each one implies a
 * different recovery: a caller that knows the run has no live lane can queue
 * the text as an ordinary turn, whereas a caller told only "rejected" has to
 * choose between dropping the user's message and double-sending it.
 */
export type SteerDegradedReason =
  "provider_unsupported" | "not_admitted" | "pii_blocked" | "store_failed" | "no_active_run"

export interface RunControlResult {
  accepted: boolean
  reason?:
    | "run_not_found"
    | "forbidden"
    | "revision_conflict"
    | "unsupported"
    | "interrupt_not_found"
    | "interrupt_expired"
    | "interrupt_resolved"
    | "source_rejected"
    /**
     * The action exists in the vocabulary but this run kind has no way to
     * perform it. Distinct from `unsupported` (nothing handles this kind at
     * all) and from `source_rejected` (the engine refused), so a card can stop
     * offering a button that will always fail instead of reporting a generic
     * refusal the user cannot act on.
     */
    | "unsupported_for_kind"
    /**
     * The run kind CAN steer, but this run could not right now. The message is
     * intact and the caller still owns it — that is the whole point of
     * distinguishing this from a refusal.
     */
    | "steer_degraded"
    /** The command itself is malformed (a `steer` with no message, say). */
    | "invalid_command"
    /**
     * This settled run already handed its work to a replacement.
     *
     * Not the same as a duplicate: the answer is not "you already did that", it
     * is "retry the replacement instead" — which is why `retryRunId` comes back
     * with it. Forking a second replacement off one settled run would give the
     * same commitment two live descendants and no way to say which one is it.
     */
    | "already_retried"
  duplicate?: boolean
  currentRevision?: number
  /**
   * The replacement a `retry` minted, or the one that already existed. Present
   * on an accepted retry, on its duplicate, and on `already_retried`.
   */
  retryRunId?: string
  /** Set with `steer_degraded`. */
  degradedReason?: SteerDegradedReason
  /** Durable receipts a successful steer produced, for correlation. */
  steerReceiptIds?: readonly string[]
}

const handlers = new Map<ExecutionRunKind, RunControlHandler>()
const controlLocks = new Map<string, Promise<void>>()

/**
 * Classify a handler throw into the reason the card shows.
 *
 * One function rather than the same ternary at each catch site: the two sites
 * had drifted apart before, and a refusal the user reads is exactly the place
 * where "the other one also knows about this case" has to be true by
 * construction. Anything unrecognised stays `source_rejected`, so a new engine
 * error is reported as a refusal rather than mislabelled as a known one.
 */
function handlerRefusalReason(error: unknown): "unsupported_for_kind" | "source_rejected" {
  if (!(error instanceof Error)) return "source_rejected"
  if (error.name === "UnsupportedForKindError") return "unsupported_for_kind"
  return "source_rejected"
}

export function registerRunControlHandler(
  kind: ExecutionRunKind,
  handler: RunControlHandler
): () => void {
  handlers.set(kind, handler)
  return () => {
    if (handlers.get(kind) === handler) handlers.delete(kind)
  }
}

export async function createRunInterrupt(
  interrupt: ExecutionRunInterrupt
): Promise<ExecutionRunInterrupt> {
  const db = getDb()
  await db.transaction(
    "rw",
    db.executionRunInterrupts,
    db.executionRuns,
    db.executionRunEvents,
    async () => {
      await db.executionRunInterrupts.add(interrupt)
      await runEventJournal.append(
        interrupt.runId,
        semanticRunEvent(
          "interrupt.requested",
          {
            interruptId: interrupt.id,
            title: interrupt.title,
            type: interrupt.type,
            expiresAt: interrupt.expiresAt,
          },
          { ts: interrupt.createdAt, sourceEventId: `interrupt:${interrupt.id}:requested` }
        )
      )
    }
  )
  return interrupt
}

export async function resolveRunInterruptFromSource(
  runId: string,
  interruptId: string,
  resolution: "approve" | "deny",
  actor?: ExecutionRunInitiator,
  now: number = Date.now()
): Promise<void> {
  const interrupt = await getDb().executionRunInterrupts.get(interruptId)
  if (!interrupt || interrupt.runId !== runId || interrupt.status !== "pending") return
  await getDb().executionRunInterrupts.update(interruptId, {
    status: resolution === "approve" ? "approved" : "denied",
    resolvedAt: now,
    ...(actor ? { resolvedBy: actor } : {}),
  })
  await runEventJournal.append(
    runId,
    semanticRunEvent(
      "interrupt.resolved",
      { interruptId, resolution },
      { ts: now, sourceEventId: `interrupt:${interruptId}:resolved` }
    )
  )
}

export async function expireRunInterruptFromSource(
  runId: string,
  interruptId: string,
  now: number = Date.now()
): Promise<void> {
  const interrupt = await getDb().executionRunInterrupts.get(interruptId)
  if (!interrupt || interrupt.runId !== runId || interrupt.status !== "pending") return
  await getDb().executionRunInterrupts.update(interruptId, { status: "expired", resolvedAt: now })
  if (interrupt.reviewKind) {
    const { endSquadReviewSpan } = await import("@/lib/ai/agent/team/squad-telemetry")
    endSquadReviewSpan({ interruptId, outcome: "expired", source: "expiry" })
  }
  await runEventJournal.append(
    runId,
    semanticRunEvent(
      "interrupt.expired",
      { interruptId },
      { ts: now, sourceEventId: `interrupt:${interruptId}:expired` }
    )
  )
}

/**
 * Reconcile durable approvals after startup without replaying privileged work.
 *
 * Branches on the interrupt TYPE at the deadline, because "nobody answered in
 * time" does not mean the same thing for all of them. For a tool approval it
 * means deny and move on. For a `human_handoff` it means a person is late —
 * expiring it would silently un-assign work they still own and resume an agent
 * on a task somebody else is mid-way through. That one is marked overdue and
 * left pending; see `delegation-handoff.ts`.
 */
export async function recoverPendingRunInterrupts(now: number = Date.now()): Promise<void> {
  const pending = await getDb().executionRunInterrupts.where("status").equals("pending").toArray()
  for (const interrupt of pending) {
    if (interrupt.expiresAt <= now) {
      if (interrupt.type === "human_handoff") {
        const { markOverdueHandoffs } = await import("./delegation-handoff")
        await markOverdueHandoffs(now).catch(() => undefined)
        continue
      }
      await expireRunInterruptFromSource(interrupt.runId, interrupt.id, now)
      continue
    }
    const run = await getExecutionRun(interrupt.runId)
    if (run?.kind !== "agent-turn") continue
    await runEventJournal.append(
      run.id,
      semanticRunEvent(
        "run.recovery_required",
        { interruptId: interrupt.id, reason: "Permission approval requires a safe continuation" },
        { ts: now, sourceEventId: `recovery:${interrupt.id}` }
      )
    )
  }
}

function actorId(actor: ExecutionRunInitiator): string | undefined {
  return actor.remoteUserId ?? actor.platformIdentityId
}

function authorized(
  initiator: ExecutionRunInitiator | undefined,
  actor: ExecutionRunInitiator,
  operatorIds: readonly string[]
): boolean {
  const id = actorId(actor)
  return Boolean(id && (id === actorId(initiator ?? {}) || operatorIds.includes(id)))
}

async function reject(
  command: RunControlCommand,
  reason: NonNullable<RunControlResult["reason"]>,
  currentRevision: number
): Promise<RunControlResult> {
  await runEventJournal.append(
    command.runId,
    semanticRunEvent(
      "control.rejected",
      { action: command.action, reason, actorId: actorId(command.actor) },
      { sourceEventId: `control:${command.idempotencyKey}` }
    )
  )
  return { accepted: false, reason, currentRevision }
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"])

/**
 * Re-dispatch a settled run as a NEW run linked back to it.
 *
 * Nothing here touches the settled journal. The refusals return directly
 * instead of going through {@link reject}, because `reject` appends
 * `control.rejected` — which a terminal journal correctly refuses, and which
 * would turn every refusal into a thrown error instead of an answer.
 *
 * The provenance the settled run keeps is a ROW stamp, not an event: it is what
 * makes a redelivered press idempotent, and what lets a card point at the run
 * that took the work over instead of silently forking a second one.
 */
async function executeRetry(
  run: ExecutionRun,
  command: RunControlCommand,
  options: { operatorIds?: readonly string[]; now?: number }
): Promise<RunControlResult> {
  if (run.retry) {
    const duplicate = run.retry.idempotencyKey === command.idempotencyKey
    return {
      accepted: duplicate,
      ...(duplicate ? { duplicate: true } : { reason: "already_retried" as const }),
      currentRevision: run.currentRevision,
      retryRunId: run.retry.runId,
    }
  }
  if (!authorized(run.initiator, command.actor, options.operatorIds ?? [])) {
    return { accepted: false, reason: "forbidden", currentRevision: run.currentRevision }
  }
  if (command.expectedRevision !== run.currentRevision) {
    return { accepted: false, reason: "revision_conflict", currentRevision: run.currentRevision }
  }
  const handler = getRunRetryHandler(run.kind)
  if (!handler) {
    return { accepted: false, reason: "unsupported_for_kind", currentRevision: run.currentRevision }
  }

  let replacement: string
  try {
    replacement = (await handler({ run, command })).runId
  } catch (error) {
    const reason = handlerRefusalReason(error)
    return { accepted: false, reason, currentRevision: run.currentRevision }
  }

  // Link first, stamp second. A replacement that exists but is unlinked is a
  // recoverable orphan; a stamp pointing at a run nothing claims is a lie the
  // next press would believe.
  await adoptExecutionRun(replacement, run.id).catch(() => undefined)
  await stampRetry(run, {
    idempotencyKey: command.idempotencyKey,
    runId: replacement,
    at: options.now ?? Date.now(),
  })
  return { accepted: true, currentRevision: run.currentRevision, retryRunId: replacement }
}

/**
 * Write the retry stamp and re-derive `latestSnapshot` from it.
 *
 * The snapshot has to be re-derived rather than left alone: `allowedActions`
 * reads the stamp, so a stale snapshot keeps offering Retry on a run that has
 * already been replaced. The revision deliberately does NOT move — no event was
 * appended, and bumping it would make the presentation runner re-project a card
 * whose content did not change.
 */
async function stampRetry(
  run: ExecutionRun,
  retry: NonNullable<ExecutionRun["retry"]>
): Promise<void> {
  const events = await listExecutionRunEvents(run.id)
  const stamped = { ...run, retry }
  const snapshot = reduceRunEvents({ ...stamped, currentRevision: 0 }, events)
  await getDb().executionRuns.update(run.id, {
    retry,
    latestSnapshot: snapshot,
    updatedAt: retry.at,
  })
}

async function executeRunControlCommandUnlocked(
  command: RunControlCommand,
  options: { operatorIds?: readonly string[]; now?: number } = {}
): Promise<RunControlResult> {
  const run = await getExecutionRun(command.runId)
  if (!run) return { accepted: false, reason: "run_not_found" }

  const sourceEventId = `control:${command.idempotencyKey}`
  const existing = (await listExecutionRunEvents(command.runId)).find(
    (event) => event.sourceEventId === sourceEventId
  )
  if (existing) {
    if (run.kind === "team") {
      const { recordSquadDuplicateControl } = await import("@/lib/ai/agent/team/squad-telemetry")
      recordSquadDuplicateControl({ runId: run.sourceId, action: command.action })
    }
    return {
      accepted: existing.type === "control.accepted",
      reason:
        existing.type === "control.rejected"
          ? (existing.payload.reason as RunControlResult["reason"])
          : undefined,
      duplicate: true,
      currentRevision: run.currentRevision,
    }
  }

  // `retry` is the one action whose whole point is a terminal run, so it is
  // answered before the terminal refusal below — and entirely off the settled
  // journal, which stays final. See `executeRetry`.
  if (command.action === "retry" && TERMINAL_STATUSES.has(run.status)) {
    return executeRetry(run, command, options)
  }

  if (TERMINAL_STATUSES.has(run.status)) {
    return {
      accepted: false,
      reason: "source_rejected",
      currentRevision: run.currentRevision,
    }
  }

  if (!authorized(run.initiator, command.actor, options.operatorIds ?? [])) {
    return reject(command, "forbidden", run.currentRevision)
  }
  if (command.expectedRevision !== run.currentRevision) {
    return reject(command, "revision_conflict", run.currentRevision)
  }
  if (command.action === "steer" && !command.steerMessage?.trim()) {
    return reject(command, "invalid_command", run.currentRevision)
  }

  let interrupt: ExecutionRunInterrupt | undefined
  if (command.action === "approve" || command.action === "deny") {
    if (!command.interruptId) return reject(command, "interrupt_not_found", run.currentRevision)
    interrupt = await getDb().executionRunInterrupts.get(command.interruptId)
    if (!interrupt || interrupt.runId !== run.id) {
      return reject(command, "interrupt_not_found", run.currentRevision)
    }
    if (interrupt.status !== "pending") {
      return reject(command, "interrupt_resolved", run.currentRevision)
    }
    // A Squad review is answered with a typed decision that must match the
    // interrupt's kind (ADR-0169). A budget amount delivered to a deadlock gate
    // is refused here, before any handler could act on it.
    const validation = validateSquadReviewDecision(
      interrupt,
      command.action,
      command.reviewDecision
    )
    if (!validation.ok) {
      return reject(command, "invalid_command", run.currentRevision)
    }
    const now = options.now ?? Date.now()
    if (interrupt.expiresAt <= now) {
      await getDb().executionRunInterrupts.update(interrupt.id, {
        status: "expired",
        resolvedAt: now,
      })
      await runEventJournal.append(
        run.id,
        semanticRunEvent(
          "interrupt.expired",
          { interruptId: interrupt.id },
          { ts: now, sourceEventId: `interrupt:${interrupt.id}:expired` }
        )
      )
      return reject(
        command,
        "interrupt_expired",
        (await getExecutionRun(run.id))?.currentRevision ?? run.currentRevision
      )
    }
  }

  const handler = handlers.get(run.kind)
  if (!handler) return reject(command, "unsupported", run.currentRevision)
  let outcome: void | RunControlHandlerOutcome
  try {
    outcome = await handler(command)
  } catch (error) {
    // A handler that refuses because the KIND cannot do this action says so,
    // instead of every throw collapsing into a generic engine refusal the user
    // has no way to act on.
    if (error instanceof Error && error.name === "SteerDegradedError") {
      const degradedReason = (error as { reason?: SteerDegradedReason }).reason ?? "no_active_run"
      // `run.degraded` — not `control.rejected` alone — because the card's own
      // lifecycle vocabulary already knows how to say "this happened, in a
      // reduced form"; a silent downgrade is what this replaces.
      await runEventJournal
        .append(
          command.runId,
          semanticRunEvent(
            "run.degraded",
            { action: command.action, reason: degradedReason },
            { sourceEventId: `control:${command.idempotencyKey}:degraded` }
          )
        )
        .catch(() => undefined)
      return { ...(await reject(command, "steer_degraded", run.currentRevision)), degradedReason }
    }
    return reject(command, handlerRefusalReason(error), run.currentRevision)
  }

  const now = options.now ?? Date.now()
  if (interrupt) {
    await getDb().executionRunInterrupts.update(interrupt.id, {
      status: command.action === "approve" ? "approved" : "denied",
      resolvedAt: now,
      resolvedBy: command.actor,
    })
    await runEventJournal.append(
      run.id,
      semanticRunEvent(
        "interrupt.resolved",
        { interruptId: interrupt.id, resolution: command.action },
        { ts: now, sourceEventId: `interrupt:${interrupt.id}:resolved` }
      )
    )
  }
  const steerReceiptIds = outcome?.steerReceiptIds ?? []
  let accepted: Awaited<ReturnType<typeof runEventJournal.append>>
  try {
    accepted = await runEventJournal.append(
      run.id,
      semanticRunEvent(
        "control.accepted",
        {
          action: command.action,
          actorId: actorId(command.actor),
          // Receipt ids only. `command.steerMessage` is free user text and the
          // journal is projected onto twelve platforms' cards — putting it here
          // would be one redaction hole in all of them at once.
          ...(steerReceiptIds.length > 0 ? { steerReceiptIds: [...steerReceiptIds] } : {}),
        },
        { ts: now, sourceEventId }
      )
    )
  } catch (error) {
    // A stop handler with no live lifecycle to abort settles the journal
    // itself (a Squad run after a restart journals `run.cancelled` directly),
    // and a settled journal refuses further events. The stop did exactly what
    // was asked: answer accepted at the revision the journal reached, rather
    // than throwing a "terminal" error at the person who pressed Stop.
    const latest = command.action === "stop" ? await getExecutionRun(run.id) : undefined
    if (!latest || !TERMINAL_STATUSES.has(latest.status)) throw error
    return {
      accepted: true,
      currentRevision: latest.currentRevision,
      ...(steerReceiptIds.length > 0 ? { steerReceiptIds: [...steerReceiptIds] } : {}),
    }
  }
  return {
    accepted: true,
    currentRevision: accepted.seq,
    ...(steerReceiptIds.length > 0 ? { steerReceiptIds } : {}),
  }
}

export async function executeRunControlCommand(
  command: RunControlCommand,
  options: { operatorIds?: readonly string[]; now?: number } = {}
): Promise<RunControlResult> {
  const previous = controlLocks.get(command.runId) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const queued = previous.catch(() => undefined).then(() => gate)
  controlLocks.set(command.runId, queued)
  await previous.catch(() => undefined)
  try {
    return await executeRunControlCommandUnlocked(command, options)
  } finally {
    release()
    if (controlLocks.get(command.runId) === queued) controlLocks.delete(command.runId)
  }
}
