import { getDb } from "@/lib/db/schema"
import {
  getExecutionRun,
  listExecutionRunEvents,
  runEventJournal,
  semanticRunEvent,
} from "@/lib/db/execution-runs"
import type {
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
  duplicate?: boolean
  currentRevision?: number
  /** Set with `steer_degraded`. */
  degradedReason?: SteerDegradedReason
  /** Durable receipts a successful steer produced, for correlation. */
  steerReceiptIds?: readonly string[]
}

const handlers = new Map<ExecutionRunKind, RunControlHandler>()
const controlLocks = new Map<string, Promise<void>>()

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
  await runEventJournal.append(
    runId,
    semanticRunEvent(
      "interrupt.expired",
      { interruptId },
      { ts: now, sourceEventId: `interrupt:${interruptId}:expired` }
    )
  )
}

/** Reconcile durable approvals after startup without replaying privileged work. */
export async function recoverPendingRunInterrupts(now: number = Date.now()): Promise<void> {
  const pending = await getDb().executionRunInterrupts.where("status").equals("pending").toArray()
  for (const interrupt of pending) {
    if (interrupt.expiresAt <= now) {
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

  // `retry` is still structurally unreachable, and deliberately left so.
  //
  // Its whole point is a terminal run, but the event journal closes on a
  // settled run (`appendInsideTransaction` refuses every event once a run is
  // completed/failed/cancelled) — a sound invariant, and accepting a control
  // event past it would weaken the guarantee that a settled run's history is
  // final. The correct shape is the one the recovery policy already uses: mint
  // a NEW run linked by `parentRunId` and journal there, leaving the failed row
  // untouched. That needs the `parentRunId` index, so retry stays declared and
  // unimplemented rather than half-wired — and `allowedActions` never offers
  // it, so no surface renders a button that cannot work.
  if (["completed", "failed", "cancelled"].includes(run.status)) {
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
    const reason =
      error instanceof Error && error.name === "UnsupportedForKindError"
        ? "unsupported_for_kind"
        : "source_rejected"
    return reject(command, reason, run.currentRevision)
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
  const accepted = await runEventJournal.append(
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
