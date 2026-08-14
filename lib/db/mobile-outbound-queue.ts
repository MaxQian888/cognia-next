/**
 * CRUD + queue-mechanic helpers for the `mobileOutboundQueue` Dexie table
 * (Wave 2.1, schema v25). Keeps the queue logic out of the runner so tests
 * can exercise individual transitions without spinning up the orchestrator.
 */

import { nanoid } from "nanoid"
import {
  HOST_STATE_PROTOCOL_VERSION,
  isHostStateActionV1,
  sessionStateChannel,
  type AllowedHostStateIntentV1,
  type HostStateActionOutcomeV1,
  type HostStateActionV1,
} from "@cognia/agent-config-types/host-state"

import type {
  MobileOutboundCommand,
  MobileOutboundJobRow,
  MobileOutboundStatus,
} from "./mobile-outbound-types"
import { decideNextAttempt } from "@/lib/queue/retry-policy"
import { getDb } from "./schema"
import {
  getActiveRuntimeTargetContext,
  type RuntimeTargetScope,
} from "@/lib/runtime/runtime-target-context"
import { LEGACY_MIXED_TARGET_ID } from "@/lib/runtime/target-registry"

export interface EnqueueInput {
  command: MobileOutboundCommand
  payload: Record<string, unknown>
  label?: string
  /** Override the auto-generated id (mainly for tests). */
  id?: string
  /** Override the auto-generated idempotency key (mainly for tests). */
  idempotencyKey?: string
  nowMs?: number
  accountId?: string
  targetId?: string
  protocol?: MobileOutboundJobRow["protocol"]
  channel?: string
  hostGeneration?: number
  clientId?: string
  clientSeq?: number
  actionId?: string
  baseRevision?: number
}

export const MAX_PENDING_HOST_STATE_ACTIONS = 1000
export const HOST_STATE_CLIENT_ID_STORAGE_KEY = "cognia-host-state-client-id"

export interface EnqueueHostStateIntentInput {
  sessionId: string
  action: AllowedHostStateIntentV1
  /** Required only for revision-checked intents; defaults to the confirmed channel revision. */
  baseRevision?: number
  nowMs?: number
  actionId?: string
  clientId?: string
}

/**
 * Persist a client intent against the latest confirmed Host snapshot.
 *
 * Returns null when the active target did not negotiate HostState or its
 * snapshot has not arrived yet, allowing the compatibility caller to keep its
 * legacy path. Once eligible, queue capacity, client sequence allocation and
 * row insertion happen in one transaction so two tabs cannot allocate the
 * same sequence or show optimism before durable storage succeeds.
 */
export async function enqueueHostStateIntentIfAvailable(
  input: EnqueueHostStateIntentInput
): Promise<MobileOutboundJobRow | null> {
  const scope = getActiveRuntimeTargetContext()
  if (!scope || !(await hostStateSubmitNegotiated())) return null
  const channel = sessionStateChannel(scope.targetId, input.sessionId)
  const db = getDb()
  const preferredClientId = input.clientId ?? loadOrCreateHostStateClientId()
  const now = input.nowMs ?? Date.now()
  const actionId = input.actionId ?? randomHostStateId()

  return db.transaction("rw", db.hostStateChannels, db.mobileOutboundQueue, async () => {
    const confirmed = await db.hostStateChannels.get(channel)
    if (!confirmed?.hostId || confirmed.hostGeneration < 1) return null

    const rows = await db.mobileOutboundQueue
      .filter(
        (row) =>
          row.protocol === "host-state-v1" &&
          row.accountId === scope.accountId &&
          row.targetId === scope.targetId
      )
      .toArray()
    const active = rows.filter((row) => ["pending", "sending", "failed"].includes(row.status))
    if (active.length >= MAX_PENDING_HOST_STATE_ACTIONS) {
      throw new Error("host_state_outbox_full")
    }

    const existingClientId = rows.find((row) => row.clientId)?.clientId
    const clientId = existingClientId ?? preferredClientId
    const clientSeq =
      rows.reduce(
        (highest, row) =>
          row.clientId === clientId && typeof row.clientSeq === "number"
            ? Math.max(highest, row.clientSeq)
            : highest,
        0
      ) + 1
    const action: HostStateActionV1 = {
      protocolVersion: HOST_STATE_PROTOCOL_VERSION,
      channel,
      accountId: scope.accountId,
      runtimeTargetId: scope.targetId,
      hostId: confirmed.hostId,
      hostGeneration: confirmed.hostGeneration,
      sessionId: input.sessionId,
      clientId,
      clientSeq,
      actionId,
      ...(requiresHostStateBaseRevision(input.action)
        ? { baseRevision: input.baseRevision ?? confirmed.revision }
        : {}),
      createdAt: now,
      action: input.action,
    }
    if (!isHostStateActionV1(action)) throw new Error("host_state_invalid_action")
    const row = hostStateQueueRow(action)
    await db.mobileOutboundQueue.add(row)
    return row
  })
}

export async function enqueue(input: EnqueueInput): Promise<MobileOutboundJobRow> {
  const now = input.nowMs ?? Date.now()
  const activeScope = getActiveRuntimeTargetContext()
  const accountId = input.accountId ?? activeScope?.accountId
  const targetId = input.targetId ?? activeScope?.targetId
  if (!accountId || !targetId) {
    throw new Error("Outbound queue requires an active account and runtime target.")
  }
  const row: MobileOutboundJobRow = {
    id: input.id ?? nanoid(),
    accountId,
    targetId,
    command: input.command,
    payload: input.payload,
    status: "pending",
    attempts: 0,
    createdAt: now,
    nextAttemptAt: now,
    idempotencyKey: input.idempotencyKey ?? nanoid(),
    label: input.label,
    protocol: input.protocol,
    channel: input.channel,
    hostGeneration: input.hostGeneration,
    clientId: input.clientId,
    clientSeq: input.clientSeq,
    actionId: input.actionId,
    baseRevision: input.baseRevision,
  }
  await getDb().mobileOutboundQueue.put(row)
  return row
}

/** Persist a HostState intent before any optimistic UI is rendered. */
export async function enqueueHostStateAction(
  action: HostStateActionV1
): Promise<MobileOutboundJobRow> {
  if (!isHostStateActionV1(action)) throw new Error("host_state_invalid_action")
  const queue = getDb().mobileOutboundQueue
  const pending = await queue
    .where("status")
    .anyOf("pending", "sending", "failed")
    .filter(
      (row) =>
        row.protocol === "host-state-v1" &&
        row.accountId === action.accountId &&
        row.targetId === action.runtimeTargetId
    )
    .count()
  if (pending >= MAX_PENDING_HOST_STATE_ACTIONS) {
    throw new Error("host_state_outbox_full")
  }
  return enqueue({ ...hostStateQueueInput(action) })
}

function hostStateQueueInput(action: HostStateActionV1): EnqueueInput {
  return {
    id: action.actionId,
    idempotencyKey: action.actionId,
    accountId: action.accountId,
    targetId: action.runtimeTargetId,
    command: "host_state_submit",
    payload: { protocolVersion: HOST_STATE_PROTOCOL_VERSION, actions: [action] },
    protocol: "host-state-v1",
    channel: action.channel,
    hostGeneration: action.hostGeneration,
    clientId: action.clientId,
    clientSeq: action.clientSeq,
    actionId: action.actionId,
    baseRevision: action.baseRevision,
    nowMs: action.createdAt,
  }
}

function hostStateQueueRow(action: HostStateActionV1): MobileOutboundJobRow {
  const input = hostStateQueueInput(action)
  return {
    id: action.actionId,
    accountId: action.accountId,
    targetId: action.runtimeTargetId,
    command: "host_state_submit",
    payload: input.payload,
    status: "pending",
    attempts: 0,
    createdAt: action.createdAt,
    nextAttemptAt: action.createdAt,
    idempotencyKey: action.actionId,
    protocol: "host-state-v1",
    channel: action.channel,
    hostGeneration: action.hostGeneration,
    clientId: action.clientId,
    clientSeq: action.clientSeq,
    actionId: action.actionId,
    baseRevision: action.baseRevision,
  }
}

async function hostStateSubmitNegotiated(): Promise<boolean> {
  const { getRuntimeSnapshot } = await import("@/lib/runtime/runtime-snapshot-store")
  const snapshot = getRuntimeSnapshot()
  if (!snapshot.target) {
    return (
      snapshot.host?.compatible === true && snapshot.host.operations.includes("host_state_submit")
    )
  }
  if (snapshot.target.kind !== "companion") return false
  return (
    snapshot.host?.compatible === true && snapshot.host.operations.includes("host_state_submit")
  )
}

function requiresHostStateBaseRevision(action: AllowedHostStateIntentV1): boolean {
  return [
    "session.rename",
    "session.archive",
    "draft.replace",
    "transcript.edit",
    "transcript.truncate",
  ].includes(action.kind)
}

function loadOrCreateHostStateClientId(): string {
  const generated = randomHostStateId()
  if (typeof localStorage === "undefined") return generated
  try {
    const existing = localStorage.getItem(HOST_STATE_CLIENT_ID_STORAGE_KEY)
    if (existing) return existing
    localStorage.setItem(HOST_STATE_CLIENT_ID_STORAGE_KEY, generated)
  } catch {
    return generated
  }
  return generated
}

function randomHostStateId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : nanoid()
}

/**
 * Atomic claim — returns the next ready row and flips status to "sending"
 * so concurrent runners don't dispatch the same job twice. Returns null
 * when nothing is ready.
 */
export async function claimNext(
  nowMs: number = Date.now(),
  scope: RuntimeTargetScope,
  excludedIds: ReadonlySet<string> = new Set()
): Promise<MobileOutboundJobRow | null> {
  const db = getDb()
  return db.transaction("rw", db.mobileOutboundQueue, async () => {
    const ready = await db.mobileOutboundQueue
      .where("status")
      .equals("pending")
      .filter(
        (row) =>
          row.accountId === scope.accountId &&
          row.targetId === scope.targetId &&
          row.nextAttemptAt <= nowMs &&
          !excludedIds.has(row.id)
      )
      .first()
    if (!ready) return null
    const claimed: MobileOutboundJobRow = { ...ready, status: "sending" }
    await db.mobileOutboundQueue.put(claimed)
    return claimed
  })
}

export async function markSent(id: string): Promise<void> {
  await getDb().mobileOutboundQueue.update(id, { status: "sent" })
}

/** Return an undispatched claim to the durable queue without consuming a retry. */
export async function releaseClaim(id: string): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.mobileOutboundQueue, async () => {
    const row = await db.mobileOutboundQueue.get(id)
    if (row?.status === "sending") {
      await db.mobileOutboundQueue.update(id, { status: "pending" })
    }
  })
}

export async function markHostStateResult(
  id: string,
  result: {
    outcome: HostStateActionOutcomeV1
    rejection?: { code: string; currentRevision?: number }
  }
): Promise<void> {
  const status: MobileOutboundStatus =
    result.outcome === "conflicted"
      ? "conflicted"
      : result.outcome === "rejected"
        ? "rejected"
        : "sent"
  await getDb().mobileOutboundQueue.update(id, {
    status,
    rejectionCode: result.rejection?.code,
    currentRevision: result.rejection?.currentRevision,
  })
}

export async function recordFailure(opts: {
  id: string
  error: unknown
  nowMs?: number
  random?: () => number
}): Promise<MobileOutboundStatus> {
  const db = getDb()
  return db.transaction("rw", db.mobileOutboundQueue, async () => {
    const row = await db.mobileOutboundQueue.get(opts.id)
    if (!row) return "deadlettered"
    const decision = decideNextAttempt({
      attempts: row.attempts,
      error: opts.error,
      nowMs: opts.nowMs,
      random: opts.random,
    })
    await db.mobileOutboundQueue.put({
      ...row,
      status: decision.status,
      attempts: decision.attempts,
      nextAttemptAt: decision.nextAttemptAt,
      lastError: decision.lastError,
    })
    return decision.status
  })
}

export async function listByStatus(
  status: MobileOutboundStatus,
  scope = getActiveRuntimeTargetContext()
): Promise<MobileOutboundJobRow[]> {
  const collection = getDb().mobileOutboundQueue.where("status").equals(status)
  if (!scope) return collection.sortBy("createdAt")
  return collection
    .filter(
      (row) =>
        row.accountId === scope.accountId &&
        (row.targetId === scope.targetId ||
          (status === "deadlettered" && row.targetId === LEGACY_MIXED_TARGET_ID))
    )
    .sortBy("createdAt")
}

export async function listAll(): Promise<MobileOutboundJobRow[]> {
  return getDb().mobileOutboundQueue.orderBy("createdAt").toArray()
}

export async function deleteRow(id: string): Promise<void> {
  await getDb().mobileOutboundQueue.delete(id)
}

/**
 * Vacuum sent rows older than `keepMs`. Default: prune sent rows older than
 * 24 h. Deadletters stay for audit until manually cleared.
 */
export async function vacuumSent(keepMs: number = 24 * 60 * 60 * 1000): Promise<number> {
  const cutoff = Date.now() - keepMs
  const db = getDb()
  return db.transaction("rw", db.mobileOutboundQueue, async () => {
    const stale = await db.mobileOutboundQueue
      .where("status")
      .equals("sent")
      .filter((r) => r.createdAt < cutoff)
      .toArray()
    for (const row of stale) {
      await db.mobileOutboundQueue.delete(row.id)
    }
    return stale.length
  })
}

/** Reset a deadlettered row back to pending so the user can retry manually. */
export async function retryDeadletter(id: string, nowMs: number = Date.now()): Promise<void> {
  const queue = getDb().mobileOutboundQueue
  const row = await queue.get(id)
  if (row?.targetId === LEGACY_MIXED_TARGET_ID) {
    throw new Error(
      "A legacy outbound action without an original runtime target cannot be retried."
    )
  }
  await queue.update(id, {
    status: "pending",
    attempts: 0,
    nextAttemptAt: nowMs,
    lastError: undefined,
  })
}
