/**
 * CRUD + queue-mechanic helpers for the `mobileOutboundQueue` Dexie table
 * (Wave 2.1, schema v25). Keeps the queue logic out of the runner so tests
 * can exercise individual transitions without spinning up the orchestrator.
 */

import { nanoid } from "nanoid"
import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import {
  hostStateIntentTargetsSessionIndex,
  isHostStateAction,
  sessionIndexChannel,
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
import type { CollabFieldClash } from "@/lib/collab/client"
import {
  getActiveRuntimeTargetContext,
  type RuntimeTargetScope,
} from "@/lib/runtime/runtime-target-context"
import { LEGACY_MIXED_TARGET_ID } from "@/lib/runtime/target-registry"
import type { RuntimeSnapshot } from "@/lib/runtime/operation-availability"

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
  /**
   * The conversation the intent names. Required for every session intent and
   * forbidden for the folder intents, which address the session index (see
   * `hostStateIntentTargetsSessionIndex`); a mismatch throws rather than
   * queueing an action the Host would refuse.
   */
  sessionId?: string
  action: AllowedHostStateIntent
  /** Required only for revision-checked intents; defaults to the confirmed channel revision. */
  baseRevision?: number
  nowMs?: number
  actionId?: string
  clientId?: string
}

/**
 * Whether a session intent for `sessionId` would be queued right now: the
 * active target negotiated HostState and the session's channel has a
 * confirmed Host snapshot. The same checks `enqueueHostStateIntentIfAvailable`
 * makes before it writes, without writing — for a caller that must decide
 * BEFORE building a send whether the send will be handed to the Host (a
 * Router + Fusion seal is never made for a host-state send, ADR-0188). A
 * full outbox still throws at enqueue time; that is an error, not a fallback.
 */
export async function hostStateSessionIntentAvailable(sessionId: string): Promise<boolean> {
  if (!sessionId) return false
  const local = getActiveRuntimeTargetContext()
  if (!local || !(await hostStateSubmitNegotiated())) return false
  const scope = (await negotiatedHostStateScope()) ?? {
    accountId: local.accountId,
    targetId: local.targetId,
  }
  const confirmed = await getDb().hostStateChannels.get(
    sessionStateChannel(scope.targetId, sessionId)
  )
  return Boolean(confirmed?.hostId) && (confirmed?.hostGeneration ?? 0) >= 1
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
  const local = getActiveRuntimeTargetContext()
  if (!local || !(await hostStateSubmitNegotiated())) return null
  // Host-state is addressed in the HOST's namespace. `local` is what this
  // client calls the pairing; the Host writes its channels under the scope it
  // declared in the manifest, and refuses a submit under any other target. A
  // Host too old to declare one still gets the local id, which is what it
  // matched before.
  const scope = (await negotiatedHostStateScope()) ?? {
    accountId: local.accountId,
    targetId: local.targetId,
  }
  const targetsIndex = hostStateIntentTargetsSessionIndex(input.action.kind)
  if (targetsIndex && input.sessionId !== undefined) {
    throw new Error("host_state_index_intent_names_session")
  }
  if (!targetsIndex && !input.sessionId) throw new Error("host_state_session_id_required")
  const channel = targetsIndex
    ? sessionIndexChannel(scope.targetId)
    : sessionStateChannel(scope.targetId, input.sessionId!)
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
          row.accountId === local.accountId &&
          row.targetId === local.targetId
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
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
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
    const row = hostStateQueueRow(action, {
      accountId: local.accountId,
      targetId: local.targetId,
    })
    await db.mobileOutboundQueue.add(row)
    // A new draft makes the drafts still waiting before it moot (see
    // `supersededHostStateDraftIds`), so the queue holds one per conversation
    // instead of one per debounced save while the Host is away.
    const superseded = supersededHostStateDraftIds([...rows, row])
    if (superseded.length > 0) await db.mobileOutboundQueue.bulkDelete(superseded)
    return row
  })
}

export async function enqueue(input: EnqueueInput): Promise<MobileOutboundJobRow> {
  const row = buildQueueRow(input)
  await getDb().mobileOutboundQueue.put(row)
  return row
}

function buildQueueRow(input: EnqueueInput): MobileOutboundJobRow {
  const now = input.nowMs ?? Date.now()
  const activeScope = getActiveRuntimeTargetContext()
  const localAccountId = input.accountId ?? activeScope?.accountId
  const targetId = input.targetId ?? activeScope?.targetId
  if (!localAccountId || !targetId) {
    throw new Error("Outbound queue requires an active account and runtime target.")
  }
  return {
    id: input.id ?? nanoid(),
    accountId: localAccountId,
    targetId,
    command: input.command,
    payload: input.payload,
    status: "pending",
    attempts: 0,
    createdAt: now,
    nextAttemptAt: now,
    idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
    label: input.label,
    protocol: input.protocol,
    channel: input.channel,
    hostGeneration: input.hostGeneration,
    clientId: input.clientId,
    clientSeq: input.clientSeq,
    actionId: input.actionId,
    baseRevision: input.baseRevision,
  }
}

export interface EnqueueUnlessQueuedResult {
  /** The row now standing for this action: the new one, or the one already waiting. */
  row: MobileOutboundJobRow
  /** True when an identical action was still on its way and nothing was added. */
  alreadyQueued: boolean
}

/**
 * Enqueue a standalone action unless the very same one is still on its way.
 *
 * For one-shot commands where a second copy is never what the user meant — a
 * manual workflow run tapped again while the Host is away. Each tap used to add
 * a row with a fresh idempotency key, so "Run" pressed three times offline
 * fired the workflow three times the moment the desktop came back, and the
 * banner counted up with nothing saying why.
 *
 * "The same" is: same account, same runtime target, same command, the same
 * payload (compared key-order-insensitively), no conversation channel, and
 * still `pending` or `sending`. Once the earlier one has been sent, refused or
 * given up on, a new tap is a new request and is queued as one. The check and
 * the insert share a transaction, so two quick taps cannot both miss.
 */
export async function enqueueUnlessQueued(input: EnqueueInput): Promise<EnqueueUnlessQueuedResult> {
  if (input.channel) {
    throw new Error("enqueueUnlessQueued is for standalone actions, not conversation sends.")
  }
  const candidate = buildQueueRow(input)
  const fingerprint = payloadFingerprint(candidate.payload)
  const db = getDb()
  return db.transaction("rw", db.mobileOutboundQueue, async () => {
    const existing = await db.mobileOutboundQueue
      .where("status")
      .anyOf(IN_FLIGHT_STATUSES as MobileOutboundStatus[])
      .filter(
        (row) =>
          row.accountId === candidate.accountId &&
          row.targetId === candidate.targetId &&
          row.command === candidate.command &&
          !row.channel &&
          payloadFingerprint(row.payload) === fingerprint
      )
      .sortBy("createdAt")
    const waiting = existing[0]
    if (waiting) return { row: waiting, alreadyQueued: true }
    await db.mobileOutboundQueue.put(candidate)
    return { row: candidate, alreadyQueued: false }
  })
}

/** A payload's identity, independent of the order its keys were written in. */
function payloadFingerprint(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])])
    )
  }
  return value
}

/**
 * Enqueue one collaboration mutation with a stable operation id and per-entity FIFO sequence.
 * The operation id is minted exactly once here and copied into the request body and queue
 * idempotency key; retries never regenerate either value.
 */
export async function enqueueCollabMutation(
  input: EnqueueCollabMutationInput
): Promise<MobileOutboundJobRow> {
  const localAccountId = input.accountId ?? getActiveAccountId()
  const targetId = input.targetId ?? "collab-plane"
  if (!localAccountId) {
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
          row.accountId === localAccountId &&
          row.targetId === targetId &&
          row.channel === channel
      )
      .toArray()
    const clientSeq = rows.reduce((highest, row) => Math.max(highest, row.clientSeq ?? 0), 0) + 1
    const row: MobileOutboundJobRow = {
      id: operationId,
      accountId: localAccountId,
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
    // The scope the Host revalidates the batch against
    // (`host-state-service.ts:assertRequestScope`), and a required part of the
    // wire body. Sending only `actions` meant every submission from a paired
    // client was refused as a contract violation, which is how a chat turn's
    // user message disappeared with no error: the queue records a delivery
    // failure rather than surfacing one.
    payload: {
      accountId: action.accountId,
      runtimeTargetId: action.runtimeTargetId,
      actions: [action],
    },
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

/**
 * `delivery` is the LOCAL scope that owns this row — the pair the outbound
 * runner filters on. It is deliberately not `action.accountId` /
 * `action.runtimeTargetId`: those are the Host's namespace for the state being
 * written, and a row filed under them is invisible to the runner that has to
 * send it.
 */
function hostStateQueueRow(
  action: HostStateAction,
  delivery: { accountId: string; targetId: string }
): MobileOutboundJobRow {
  const input = hostStateQueueInput(action)
  return {
    id: action.actionId,
    accountId: delivery.accountId,
    targetId: delivery.targetId,
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

/**
 * The host-state scope the active Host declared, or null when it declared
 * none. Read from the runtime snapshot — the same place `hostStateSubmitNegotiated`
 * reads the negotiated operation list, so the two can never disagree about
 * which Host they are describing.
 */
async function negotiatedHostStateScope(): Promise<{
  accountId: string
  targetId: string
} | null> {
  const { getRuntimeSnapshot } = await import("@/lib/runtime/runtime-snapshot-store")
  const declared = getRuntimeSnapshot().host?.hostStateScope
  if (!declared) return null
  return { accountId: declared.accountId, targetId: declared.runtimeTargetId }
}

function hostStateSubmitNegotiatedIn(snapshot: RuntimeSnapshot): boolean {
  if (snapshot.target && snapshot.target.kind !== "companion") return false
  return (
    snapshot.host?.compatible === true && snapshot.host.operations.includes("host_state_submit")
  )
}

async function hostStateSubmitNegotiated(): Promise<boolean> {
  const { getRuntimeSnapshot } = await import("@/lib/runtime/runtime-snapshot-store")
  return hostStateSubmitNegotiatedIn(getRuntimeSnapshot())
}

/**
 * True when this device is a paired client whose Host owns the session rows:
 * there is an active runtime target and the Host negotiated HostState submit.
 * The same two checks {@link enqueueHostStateIntentIfAvailable} makes before
 * it routes a session write, without the per-session snapshot check, for a
 * caller deciding about the device rather than one conversation: a session
 * policy (auto-archive) the Host runs for its own rows, and the setting that
 * drives it. Synchronous and pure over `snapshot`, so a React subscriber to
 * the runtime snapshot and the scheduler get the same answer.
 */
export function hostOwnsSessionState(
  snapshot: RuntimeSnapshot,
  local: RuntimeTargetScope | null = getActiveRuntimeTargetContext()
): boolean {
  return local !== null && hostStateSubmitNegotiatedIn(snapshot)
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
    const loaded = await db.mobileOutboundQueue
      .where("status")
      .anyOf(IN_FLIGHT_STATUSES as MobileOutboundStatus[])
      .filter((row) => row.accountId === scope.accountId && row.targetId === scope.targetId)
      .toArray()
    // Drafts a later draft of the same conversation made moot never go out.
    // Done here as well as at enqueue so a backlog queued by a build that did
    // not collapse them still drains as one draft per conversation.
    const superseded = new Set(supersededHostStateDraftIds(loaded))
    if (superseded.size > 0) await db.mobileOutboundQueue.bulkDelete([...superseded])
    const outstanding = loaded.filter((row) => !superseded.has(row.id))

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

/** The single HostState action a queued row carries, or null for any other row. */
function queuedHostStateAction(row: MobileOutboundJobRow): HostStateAction | null {
  if (row.protocol !== "host-state") return null
  const actions = (row.payload as { actions?: unknown }).actions
  const action = Array.isArray(actions) && actions.length === 1 ? actions[0] : undefined
  return isHostStateAction(action) ? action : null
}

/**
 * Queued `draft.replace` rows that a later draft of the same conversation, from
 * the same client, has made moot.
 *
 * `draft.replace` carries the whole draft, so of two drafts no Host has seen
 * only the later one says anything. Sending both did harm, not just extra
 * work: every queued draft is stamped with the channel revision confirmed when
 * it was typed, so the Host applied the first, moved the revision, and refused
 * each one after it as a revision conflict. A composer typed into while the
 * queue was stalled came back as one conflict per debounced save, each one a
 * row the user had to clear by hand.
 *
 * Only `pending` rows that were never offered are candidates. A row a Host may
 * already hold (`offeredHostGeneration`) still owes its receipt, and a
 * `sending` row is on the wire.
 */
export function supersededHostStateDraftIds(rows: readonly MobileOutboundJobRow[]): string[] {
  const latest = new Map<string, MobileOutboundJobRow>()
  const candidates: MobileOutboundJobRow[] = []
  for (const row of rows) {
    if (
      row.status !== "pending" ||
      row.offeredHostGeneration !== undefined ||
      !row.channel ||
      typeof row.clientSeq !== "number" ||
      queuedHostStateAction(row)?.action.kind !== "draft.replace"
    ) {
      continue
    }
    candidates.push(row)
    const key = `${row.channel}\u0000${row.clientId ?? ""}`
    const current = latest.get(key)
    if (!current || row.clientSeq > (current.clientSeq as number)) latest.set(key, row)
  }
  const keep = new Set([...latest.values()].map((row) => row.id))
  return candidates.filter((row) => !keep.has(row.id)).map((row) => row.id)
}

/** What {@link offerHostStateRow} handed back for dispatch. */
export interface HostStateOffer {
  /** The row as it must be sent, re-based when that was safe. */
  row: MobileOutboundJobRow
  /**
   * True when no earlier offer of this row is outstanding, so a Host refusing
   * this one as stale proves it was never applied anywhere.
   */
  firstOffer: boolean
}

/**
 * Record that a HostState row is about to be handed to the Host, re-basing it
 * onto the Host's current generation first when that is safe.
 *
 * A Host bumps its generation every time it restarts, and refuses an action
 * stamped with an older one (`stale_host_generation`). A row queued before the
 * restart therefore could never be delivered: it was refused as soon as it was
 * finally sent, and a manual retry re-sent the same stale stamp. The Host's
 * ledger deduplicates per `(hostGeneration, actionId)`, so re-stamping is only
 * safe for a row no Host has been offered yet: that is the row's own
 * `offeredHostGeneration`, written here, in the same transaction, before any
 * byte leaves the device. A row already offered keeps the generation it was
 * offered under, so a Host that did apply it answers `duplicate` instead of
 * applying it again.
 *
 * Re-based only onto the same Host (`hostId`) and only forward, to the
 * generation of this client's confirmed mirror of the row's channel — the
 * stamp the Host itself last published. A different `hostId` is a different
 * Host, and its refusal stands.
 *
 * Returns null when the row is gone (withdrawn, superseded or settled).
 */
export async function offerHostStateRow(id: string): Promise<HostStateOffer | null> {
  const db = getDb()
  return db.transaction("rw", db.mobileOutboundQueue, db.hostStateChannels, async () => {
    const row = await db.mobileOutboundQueue.get(id)
    if (!row) return null
    const action = queuedHostStateAction(row)
    if (!action) return { row, firstOffer: false }
    const firstOffer = row.offeredHostGeneration === undefined
    let offered = action
    if (firstOffer) {
      const confirmed = await db.hostStateChannels.get(action.channel)
      if (
        confirmed &&
        confirmed.hostId === action.hostId &&
        confirmed.hostGeneration > action.hostGeneration
      ) {
        offered = { ...action, hostGeneration: confirmed.hostGeneration }
      }
    }
    const next: MobileOutboundJobRow = {
      ...row,
      payload: offered === action ? row.payload : { ...row.payload, actions: [offered] },
      hostGeneration: offered.hostGeneration,
      offeredHostGeneration: offered.hostGeneration,
    }
    await db.mobileOutboundQueue.put(next)
    return { row: next, firstOffer }
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
 * How long a `sending` claim must have gone unrenewed before it is treated as
 * abandoned.
 *
 * A live dispatcher renews its claim every {@link CLAIM_RENEW_INTERVAL_MS} for
 * as long as it holds it (`renewClaim`), however long the command itself is
 * allowed to run, so a claim this stale belongs to a process that died — or to
 * a build that never renewed — and nothing is going to finish it. Four missed
 * renewals, so a slow event loop on a backgrounded phone is not mistaken for a
 * dead one.
 */
export const CLAIM_ABANDONED_AFTER_MS = 2 * 60 * 1000

/** How often a live dispatcher re-stamps `claimedAt` on the row it holds. */
export const CLAIM_RENEW_INTERVAL_MS = 30 * 1000

/**
 * Whether a `sending` row's claim has been abandoned: no stamp at all (claimed
 * by a build that predates it), or not renewed for {@link CLAIM_ABANDONED_AFTER_MS}.
 * Always false for a row that is not `sending`.
 */
export function isAbandonedClaim(
  row: Pick<MobileOutboundJobRow, "status" | "claimedAt">,
  nowMs: number = Date.now(),
  abandonedAfterMs: number = CLAIM_ABANDONED_AFTER_MS
): boolean {
  if (row.status !== "sending") return false
  return row.claimedAt === undefined || nowMs - row.claimedAt >= abandonedAfterMs
}

/**
 * Re-stamp a claim the caller is still working on, so no sweep mistakes it for
 * an abandoned one. A no-op once the row has left `sending` (completed,
 * withdrawn or reclaimed): renewing must never resurrect a claim.
 */
export async function renewClaim(id: string, nowMs: number = Date.now()): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.mobileOutboundQueue, async () => {
    const row = await db.mobileOutboundQueue.get(id)
    if (row?.status === "sending") {
      await db.mobileOutboundQueue.update(id, { claimedAt: nowMs })
    }
  })
}

/**
 * Return abandoned `sending` claims to `pending`. The runner calls this at the
 * start of every drain, not only the first: a claim left by a process that was
 * killed moments before the app restarted is still young at the first drain,
 * and used to be left `sending` — "Sending" on screen, never retried, never
 * withdrawable — for as long as the app stayed open.
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
          isAbandonedClaim(row, nowMs, abandonedAfterMs)
      )
      .toArray()
    for (const row of stale) {
      await db.mobileOutboundQueue.update(row.id, { status: "pending", claimedAt: undefined })
    }
    return stale.length
  })
}

/**
 * The earliest moment something in this scope becomes actionable without any
 * write to announce it, or null when nothing is waiting on the clock.
 *
 * Two things only time can move: a `pending` row backing off until its
 * `nextAttemptAt`, and a `sending` claim that will count as abandoned once it
 * goes unrenewed for {@link CLAIM_ABANDONED_AFTER_MS}. Nothing woke the runner
 * for either — it drained on writes, network changes and runtime snapshots —
 * so a retry scheduled for later, or a claim a killed process left behind,
 * waited for an unrelated event that might never come.
 */
export async function nextQueueWakeAt(
  scope: RuntimeTargetScope,
  nowMs: number = Date.now()
): Promise<number | null> {
  const rows = await getDb()
    .mobileOutboundQueue.where("status")
    .anyOf(IN_FLIGHT_STATUSES as MobileOutboundStatus[])
    .filter((row) => row.accountId === scope.accountId && row.targetId === scope.targetId)
    .toArray()
  let earliest: number | null = null
  for (const row of rows) {
    const at =
      row.status === "pending"
        ? row.nextAttemptAt > nowMs
          ? row.nextAttemptAt
          : null
        : (row.claimedAt ?? nowMs) + CLAIM_ABANDONED_AFTER_MS
    if (at !== null && (earliest === null || at < earliest)) earliest = at
  }
  return earliest
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
  authoritative: unknown,
  fields?: Record<string, CollabFieldClash>
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
    conflictFields: fields,
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
  const payload: Record<string, unknown> = { ...row.payload, baseRevision: row.currentRevision }
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
  /**
   * The Host proved this offer was never applied (it refused it before its
   * ledger), and no earlier offer is outstanding: forget the offer so the next
   * one may be re-based (see `offerHostStateRow`).
   */
  forgetOffer?: boolean
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
    const next: MobileOutboundJobRow = {
      ...row,
      status: decision.status,
      attempts: decision.attempts,
      nextAttemptAt: decision.nextAttemptAt,
      lastError: decision.lastError,
    }
    if (opts.forgetOffer) delete next.offeredHostGeneration
    await db.mobileOutboundQueue.put(next)
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
 * What {@link withdrawQueuedAction} did.
 *
 *   - `withdrawn`: removed before any attempt to send it; it will not run.
 *   - `withdrawn-unconfirmed`: removed, but an earlier attempt may have reached
 *     the Host before it went quiet (a retry that was backing off, or a claim
 *     whose dispatcher died), so the Host could still run it.
 *   - `in-flight`: a live dispatch holds it right now; the Host may already
 *     have it, so it was left alone.
 *   - `not-withdrawable`: a conversation send, or a row already past sending.
 *   - `gone`: nothing by that id is queued any more.
 */
export type WithdrawOutcome =
  "withdrawn" | "withdrawn-unconfirmed" | "in-flight" | "not-withdrawable" | "gone"

/**
 * Take back an action the user no longer wants sent.
 *
 * A `pending` row is always withdrawable. So is a `sending` row whose claim was
 * abandoned ({@link isAbandonedClaim}): its dispatcher is gone, and refusing
 * left the user staring at "Sending" with no way out. Only a claim a live
 * dispatcher is still renewing is refused. The read and the delete share a
 * transaction, so a runner that claims the row in between wins and this
 * answers `in-flight`.
 *
 * Channel rows (a conversation's sends) are refused. Their optimistic copy is
 * already on screen in order, so dropping one would leave a message the Host
 * never gets, sitting between ones it does. Standalone actions — a workflow
 * trigger, an approval — have no such shadow.
 */
export async function withdrawQueuedAction(
  id: string,
  nowMs: number = Date.now()
): Promise<WithdrawOutcome> {
  const db = getDb()
  return db.transaction("rw", db.mobileOutboundQueue, async (): Promise<WithdrawOutcome> => {
    const row = await db.mobileOutboundQueue.get(id)
    if (!row) return "gone"
    if (row.channel) return "not-withdrawable"
    if (row.status === "sending") {
      if (!isAbandonedClaim(row, nowMs)) return "in-flight"
      await db.mobileOutboundQueue.delete(id)
      return "withdrawn-unconfirmed"
    }
    if (row.status !== "pending") return "not-withdrawable"
    await db.mobileOutboundQueue.delete(id)
    return row.attempts > 0 ? "withdrawn-unconfirmed" : "withdrawn"
  })
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
    const next: MobileOutboundJobRow = {
      ...row,
      status: "pending",
      attempts: 0,
      nextAttemptAt: nowMs,
      lastError: undefined,
      rejectionCode: undefined,
      currentRevision: undefined,
      ...(clientSeq === undefined ? {} : { clientSeq }),
    }
    // A retry is the user re-sending on purpose. Forgetting the earlier offer
    // lets it be re-based onto the Host's current generation; without that a
    // row refused as `stale_host_generation` was re-sent with the same stale
    // stamp and refused again, forever.
    delete next.offeredHostGeneration
    await db.mobileOutboundQueue.put(next)
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
