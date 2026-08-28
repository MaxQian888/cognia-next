/**
 * CRUD + queue-mechanic helpers for the `mobileOutboundQueue` Dexie table
 * (Wave 2.1, schema v25). Keeps the queue logic out of the runner so tests
 * can exercise individual transitions without spinning up the orchestrator.
 */

import { nanoid } from "nanoid"
import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import {
  isHostStateAction,
  sessionStateChannel,
  type AllowedHostStateIntent,
  type HostStateActionOutcome,
  type HostStateAction,
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

export type CollabOutboundCommand = Extract<MobileOutboundCommand, `collab_${string}`>

export interface EnqueueCollabMutationInput {
  command: CollabOutboundCommand
  orgId: string
  entityType: "issue" | "plan" | "run"
  entityId: string
  payload: Record<string, unknown>
  label?: string
  operationId?: string
  nowMs?: number
  accountId?: string
  targetId?: string
}

export const MAX_PENDING_HOST_STATE_ACTIONS = 1000
export const HOST_STATE_CLIENT_ID_STORAGE_KEY = "cognia-host-state-client-id"

export interface EnqueueHostStateIntentInput {
  sessionId: string
  action: AllowedHostStateIntent
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
          row.protocol === "host-state" &&
          row.accountId === scope.accountId &&
          row.targetId === scope.targetId
      )
      .toArray()
    const active = rows.filter((row) => IN_FLIGHT_STATUSES.includes(row.status))
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
    const action: HostStateAction = {
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
    if (!isHostStateAction(action)) throw new Error("host_state_invalid_action")
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

/**
 * Enqueue one collaboration mutation with a stable operation id and per-entity FIFO sequence.
 * The operation id is minted exactly once here and copied into the request body and queue
 * idempotency key; retries never regenerate either value.
 */
export async function enqueueCollabMutation(
  input: EnqueueCollabMutationInput
): Promise<MobileOutboundJobRow> {
  const accountId = input.accountId ?? getActiveAccountId()
  const targetId = input.targetId ?? "collab-plane"
  if (!accountId) {
    throw new Error("Collaboration queue requires an active account.")
  }
  const now = input.nowMs ?? Date.now()
  const operationId = input.operationId ?? randomHostStateId()
  const channel = `collab:${input.orgId}:${input.entityType}:${input.entityId}`
  const db = getDb()
  return db.transaction("rw", db.mobileOutboundQueue, async () => {
    const rows = await db.mobileOutboundQueue
      .where("status")
      .anyOf(IN_FLIGHT_STATUSES as MobileOutboundStatus[])
      .filter(
        (row) =>
          row.protocol === "collab-v1" &&
          row.accountId === accountId &&
          row.targetId === targetId &&
          row.channel === channel
      )
      .toArray()
    const clientSeq = rows.reduce((highest, row) => Math.max(highest, row.clientSeq ?? 0), 0) + 1
    const row: MobileOutboundJobRow = {
      id: operationId,
      accountId,
      targetId,
      command: input.command,
      payload: { ...input.payload, orgId: input.orgId, operationId },
      status: "pending",
      attempts: 0,
      createdAt: now,
      nextAttemptAt: now,
      idempotencyKey: operationId,
      label: input.label,
      protocol: "collab-v1",
      channel,
      clientSeq,
      actionId: operationId,
    }
    await db.mobileOutboundQueue.add(row)
    return row
  })
}

/** Persist a HostState intent before any optimistic UI is rendered. */
export async function enqueueHostStateAction(
  action: HostStateAction
): Promise<MobileOutboundJobRow> {
  if (!isHostStateAction(action)) throw new Error("host_state_invalid_action")
  const queue = getDb().mobileOutboundQueue
  const pending = await queue
    .where("status")
    .anyOf(IN_FLIGHT_STATUSES as MobileOutboundStatus[])
    .filter(
      (row) =>
        row.protocol === "host-state" &&
        row.accountId === action.accountId &&
        row.targetId === action.runtimeTargetId
    )
    .count()
  if (pending >= MAX_PENDING_HOST_STATE_ACTIONS) {
    throw new Error("host_state_outbox_full")
  }
  return enqueue({ ...hostStateQueueInput(action) })
}

function hostStateQueueInput(action: HostStateAction): EnqueueInput {
  return {
    id: action.actionId,
    idempotencyKey: action.actionId,
    accountId: action.accountId,
    targetId: action.runtimeTargetId,
    command: "host_state_submit",
    payload: { actions: [action] },
    protocol: "host-state",
    channel: action.channel,
    hostGeneration: action.hostGeneration,
    clientId: action.clientId,
    clientSeq: action.clientSeq,
    actionId: action.actionId,
    baseRevision: action.baseRevision,
    nowMs: action.createdAt,
  }
}

function hostStateQueueRow(action: HostStateAction): MobileOutboundJobRow {
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
    protocol: "host-state",
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

function requiresHostStateBaseRevision(action: AllowedHostStateIntent): boolean {
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
 * Statuses that still owe the Host a dispatch. A row in one of these holds its
 * place in its channel's order; anything else has reached an end the user can
 * see and act on, and must not freeze the session behind it.
 *
 * `"failed"` is deliberately absent even though {@link MobileOutboundStatus}
 * still names it: `recordFailure` is the only writer of a post-dispatch status
 * and it stores `decideNextAttempt`'s verdict, which is `"pending"` (retry
 * scheduled) or `"deadlettered"` (out of retries) and never `"failed"`. Listing
 * it here described a lane the queue does not have.
 */
const IN_FLIGHT_STATUSES: readonly MobileOutboundStatus[] = ["pending", "sending"]

/**
 * Atomic claim — returns the next ready row and flips status to "sending"
 * so concurrent runners don't dispatch the same job twice. Returns null
 * when nothing is ready.
 *
 * **Ordered per channel.** Within one session's channel only the lowest
 * outstanding `clientSeq` is claimable: a row that is backing off, already
 * in flight, or failed keeps its successors waiting. Without that, a message
 * whose first attempt hit a flaky link was overtaken by the follow-up typed
 * after it — the Host applied them in the wrong order while the client's own
 * optimistic projection (which *does* sort by `clientSeq`) showed the right
 * one, so the two silently disagreed until a resync.
 *
 * Channels are independent of each other, so one stalled session never blocks
 * another, and rows with no channel (the legacy RPC jobs) are unordered as
 * they always were.
 */
export async function claimNext(
  nowMs: number = Date.now(),
  scope: RuntimeTargetScope,
  excludedIds: ReadonlySet<string> = new Set()
): Promise<MobileOutboundJobRow | null> {
  const db = getDb()
  return db.transaction("rw", db.mobileOutboundQueue, async () => {
    // Through the `status` index, not a table walk: the channel-head rule only
    // needs the in-flight rows, and a `.filter()` over the whole table
    // deserializes every `sent` row still waiting on the 24h vacuum on every
    // poll of a draining queue.
    const outstanding = await db.mobileOutboundQueue
      .where("status")
      .anyOf(IN_FLIGHT_STATUSES as MobileOutboundStatus[])
      .filter((row) => row.accountId === scope.accountId && row.targetId === scope.targetId)
      .toArray()

    // Lowest outstanding sequence per channel — the only row of that channel
    // anyone may dispatch right now.
    const channelHead = new Map<string, number>()
    for (const row of outstanding) {
      if (!row.channel || typeof row.clientSeq !== "number") continue
      const current = channelHead.get(row.channel)
      if (current === undefined || row.clientSeq < current) {
        channelHead.set(row.channel, row.clientSeq)
      }
    }

    const ready = outstanding
      .filter(
        (row) => row.status === "pending" && row.nextAttemptAt <= nowMs && !excludedIds.has(row.id)
      )
      .filter(
        (row) =>
          !row.channel ||
          typeof row.clientSeq !== "number" ||
          channelHead.get(row.channel) === row.clientSeq
      )
      // Oldest first, then by id so two rows created in the same millisecond
      // still claim in a stable order rather than whichever Dexie enumerated.
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))

    const next = ready[0]
    if (!next) return null
    const claimed: MobileOutboundJobRow = { ...next, status: "sending", claimedAt: nowMs }
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
      await db.mobileOutboundQueue.update(id, { status: "pending", claimedAt: undefined })
    }
  })
}

/**
 * How long a `sending` claim must have sat untouched before a startup reclaim
 * treats it as abandoned.
 *
 * Comfortably longer than any single dispatch: the point is to separate a claim
 * whose process died from one another live dispatcher is still awaiting, and
 * only the age of the claim can tell them apart.
 */
export const CLAIM_ABANDONED_AFTER_MS = 2 * 60 * 1000

/**
 * Return abandoned `sending` claims to `pending`. Call once before the runner's
 * first drain.
 *
 * A row still holding `sending` at startup usually belongs to a run that was
 * killed mid-dispatch. That used to be harmless — `claimNext` looked at
 * `pending` alone — but a `sending` row is now `IN_FLIGHT`, so it wins its
 * channel's head and is never claimable, and every later message, draft or
 * abort for that session queues up behind a row nothing can move.
 *
 * "Usually", not "always": a second runner for the same scope can be
 * constructed while the first is mid-flight, and a blanket reclaim would hand
 * that row to both at once. `claimedAt` is the discriminator — a claim younger
 * than {@link CLAIM_ABANDONED_AFTER_MS} is presumed live and left alone. Rows
 * predating the field carry no stamp and are treated as abandoned, which is the
 * old behaviour for exactly the rows the old behaviour was written for.
 *
 * No retry is consumed and the idempotency key is untouched: a dispatch that
 * did reach the Host before the process died is recognised as a duplicate.
 */
export async function releaseStaleClaims(
  scope: RuntimeTargetScope,
  nowMs: number = Date.now(),
  abandonedAfterMs: number = CLAIM_ABANDONED_AFTER_MS
): Promise<number> {
  const db = getDb()
  return db.transaction("rw", db.mobileOutboundQueue, async () => {
    const stale = await db.mobileOutboundQueue
      .where("status")
      .equals("sending")
      .filter(
        (row) =>
          row.accountId === scope.accountId &&
          row.targetId === scope.targetId &&
          (row.claimedAt === undefined || nowMs - row.claimedAt >= abandonedAfterMs)
      )
      .toArray()
    for (const row of stale) {
      await db.mobileOutboundQueue.update(row.id, { status: "pending", claimedAt: undefined })
    }
    return stale.length
  })
}

export async function markHostStateResult(
  id: string,
  result: {
    outcome: HostStateActionOutcome
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

export async function markCollabConflict(
  id: string,
  error: string,
  authoritative: unknown
): Promise<void> {
  const currentRevision =
    typeof authoritative === "object" &&
    authoritative !== null &&
    typeof (authoritative as { revision?: unknown }).revision === "number"
      ? (authoritative as { revision: number }).revision
      : undefined
  await getDb().mobileOutboundQueue.update(id, {
    status: "conflicted",
    lastError: error,
    conflictAuthoritative: authoritative,
    currentRevision,
    claimedAt: undefined,
  })
}

export async function discardCollabConflict(id: string): Promise<void> {
  const row = await getDb().mobileOutboundQueue.get(id)
  if (row?.protocol !== "collab-v1" || row.status !== "conflicted") return
  await getDb().mobileOutboundQueue.delete(id)
}

export async function rebaseCollabConflict(id: string): Promise<MobileOutboundJobRow> {
  const row = await getDb().mobileOutboundQueue.get(id)
  if (row?.protocol !== "collab-v1" || row.status !== "conflicted") {
    throw new Error("Collaboration conflict no longer exists.")
  }
  // A create has no base revision to move forward and carries no entity id, so
  // it can only be discarded or retried as a new create. Say that, rather than
  // falling through to the payload-shape check and calling the row corrupt.
  if (row.command.endsWith("_create")) {
    throw new Error("A create cannot be rebased — discard it, or retry it as a new create.")
  }
  if (!Number.isSafeInteger(row.currentRevision) || (row.currentRevision ?? 0) < 1) {
    throw new Error("Collaboration conflict has no authoritative revision.")
  }
  const payload = { ...row.payload, baseRevision: row.currentRevision }
  delete payload.operationId
  const entityType = row.command.includes("_issue_")
    ? "issue"
    : row.command.includes("_plan_")
      ? "plan"
      : "run"
  const entityId =
    entityType === "issue"
      ? payload.issueId
      : entityType === "plan"
        ? payload.planId
        : payload.runId
  if (typeof payload.orgId !== "string" || typeof entityId !== "string") {
    throw new Error("Collaboration conflict payload is malformed.")
  }
  const replacement = await enqueueCollabMutation({
    accountId: row.accountId,
    targetId: row.targetId,
    command: row.command as CollabOutboundCommand,
    orgId: payload.orgId,
    entityType,
    entityId,
    payload,
    label: row.label,
  })
  await getDb().mobileOutboundQueue.delete(id)
  return replacement
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

/**
 * Reset a terminal row back to pending so the user can retry manually.
 *
 * The retry keeps its `actionId` — and therefore its idempotency key — so a
 * dispatch that actually reached the Host before the client gave up is
 * recognised as a duplicate instead of applied twice.
 *
 * Its `clientSeq`, though, is re-stamped to the tail of its channel. It has to
 * be: the row stopped blocking the channel the moment it went terminal, so
 * everything behind it has already been sent, and re-entering at the old
 * sequence would put it permanently at the head of a queue whose work is done —
 * blocking every future action on that session behind a row the Host will never
 * be asked for again.
 */
export async function retryDeadletter(id: string, nowMs: number = Date.now()): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.mobileOutboundQueue, async () => {
    const row = await db.mobileOutboundQueue.get(id)
    if (!row) return
    if (row.targetId === LEGACY_MIXED_TARGET_ID) {
      throw new Error(
        "A legacy outbound action without an original runtime target cannot be retried."
      )
    }
    const clientSeq = row.channel ? await nextClientSeqForChannel(row) : row.clientSeq
    await db.mobileOutboundQueue.put({
      ...row,
      status: "pending",
      attempts: 0,
      nextAttemptAt: nowMs,
      lastError: undefined,
      rejectionCode: undefined,
      currentRevision: undefined,
      ...(clientSeq === undefined ? {} : { clientSeq }),
    })
  })
}

/**
 * One past the highest sequence still outstanding on the channel.
 *
 * Read through the `status` index, not a table walk. Only OUTSTANDING rows
 * matter: ordering exists so nothing overtakes a row the Host has not seen yet,
 * and a `sent` row has no successors waiting on it. Scanning them anyway meant
 * deserializing every row in the table — a day's worth of `sent` rows awaiting
 * the 24h vacuum included — while holding the retry's write transaction. It is
 * also the same basis `enqueueHostStateIntentIfAvailable` stamps a fresh
 * sequence from, so a retry and a new send now agree on where the tail is.
 */
async function nextClientSeqForChannel(row: MobileOutboundJobRow): Promise<number | undefined> {
  if (typeof row.clientSeq !== "number") return undefined
  const outstanding = await getDb()
    .mobileOutboundQueue.where("status")
    .anyOf(IN_FLIGHT_STATUSES as MobileOutboundStatus[])
    .filter((candidate) => candidate.channel === row.channel && candidate.clientId === row.clientId)
    .toArray()
  const highest = outstanding.reduce(
    (best, candidate) =>
      typeof candidate.clientSeq === "number" ? Math.max(best, candidate.clientSeq) : best,
    // The row being retried is terminal, so it is not in `outstanding`; seeding
    // with its own sequence keeps the result strictly increasing even when the
    // channel has drained completely.
    row.clientSeq
  )
  return highest + 1
}
