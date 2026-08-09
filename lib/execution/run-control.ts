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

export type RunControlHandler = (command: RunControlCommand) => Promise<void>

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
  duplicate?: boolean
  currentRevision?: number
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
  try {
    await handler(command)
  } catch {
    return reject(command, "source_rejected", run.currentRevision)
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
  const accepted = await runEventJournal.append(
    run.id,
    semanticRunEvent(
      "control.accepted",
      { action: command.action, actorId: actorId(command.actor) },
      { ts: now, sourceEventId }
    )
  )
  return { accepted: true, currentRevision: accepted.seq }
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
