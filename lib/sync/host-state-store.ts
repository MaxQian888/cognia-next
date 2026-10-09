import { messageMediaRefRows } from "@/lib/db/message-media-refs"
import { canonicalTurnToHandoffMessage } from "@/lib/chat/import-handoff-session"
import {
  canonicalHostStateJson,
  createEmptyHostStateSession,
  hostStateIntentTargetsSessionIndex,
  hostStateDigest,
  isHostStateAction,
  isHostStateMutation,
  reduceHostStateMutation,
  sessionIndexChannel,
  sessionStateChannel,
  type HostStateActionOutcome,
  type HostStateAction,
  type HostStateAppliedAction,
  type HostStateChannelState,
  type HostStateMutation,
  type HostStateSessionSeed,
  type HostStateSessionSummary,
  type HostStateSnapshot,
} from "@cognia/agent-config-types/host-state"

import { getDb } from "@/lib/db/schema"
import type { ChatSession, StoredMessage } from "@cognia/agent-config-types"
import {
  isCanonicalSession,
  type CanonicalSession,
} from "@cognia/agent-config-types/canonical-session"
import { isPlaceholderTitle } from "@/lib/ai/generation/run-title-task"
import { markSessionDirty } from "@/lib/chat/search/indexer"
import { stripPromptPreambleFromParts } from "@/lib/chat/prompt-preamble"
import { stampOrganizationalWrite } from "@/lib/db/session-row-stamps"
import {
  folderWriteTables,
  writeFolderCreate,
  writeFolderDelete,
  writeFolderRename,
  writeFolderReorder,
} from "@/lib/db/session-folders"
import {
  assertSessionWritable,
  SessionHandoffLockedError,
  type SessionWriteOperation,
} from "@/lib/chat/session-write-guard"
import { hostSessionMoveRejection, planHostSessionMove } from "./host-state-session-move"

export const HOST_STATE_META_ID = "singleton" as const
export const HOST_STATE_LEASE_TTL_MS = 30_000
export const HOST_STATE_LEASE_HEARTBEAT_MS = 10_000

export interface HostStateChannelRow {
  channel: string
  /** Present on v168+ confirmed replicas; absent only on pre-HostState rows. */
  hostId?: string
  hostGeneration: number
  hostSeq: number
  revision: number
  digest: string
  state: HostStateChannelState
  updatedAt: number
}

export interface HostStateActionRow {
  hostGeneration: number
  actionId: string
  channel: string
  hostSeq: number
  outcome: HostStateActionOutcome
  payloadDigest: string
  /** Retained while dispatch/broadcast recovery is pending; compactable once settled. */
  action?: HostStateAction
  event: HostStateAppliedAction
  dispatchState: "not-required" | "pending" | "completed" | "failed"
  broadcastState: "pending" | "completed"
  /** Session-channel mutations must also be durably reflected into the session index. */
  summaryState: "not-required" | "pending" | "completed"
  runtimeCorrelation?: string
  lastErrorCode?: string
  createdAt: number
  updatedAt: number
}

export interface HostStateMetaRow {
  id: typeof HOST_STATE_META_ID
  hostId: string
  hostGeneration: number
  hostSeq: number
  leaseOwnerId: string
  leaseExpiresAt: number
  updatedAt: number
}

export type HostStateStoreErrorCode =
  | "host_state_invalid_action"
  | "host_state_invalid_mutation"
  | "host_state_channel_mismatch"
  | "host_state_lease_missing"
  | "host_state_lease_held"
  | "host_state_lease_expired"
  | "host_state_session_not_found"
  | "host_state_message_not_found"
  | "host_state_folder_not_found"
  | "host_state_session_move_refused"
  | "stale_host_generation"

export class HostStateStoreError extends Error {
  constructor(
    readonly code: HostStateStoreErrorCode,
    message: string = code
  ) {
    super(message)
    this.name = "HostStateStoreError"
  }
}

/**
 * A workspace move that was valid at validation and is not at commit: a turn
 * started, the destination was deleted or the folder moved in between. The
 * transaction rolls back; `rejection` is the receipt the service commits in
 * its place, the same one validation would have produced.
 */
export class HostSessionMoveRefusedError extends HostStateStoreError {
  constructor(readonly rejection: { code: string; message: string }) {
    super("host_state_session_move_refused", rejection.message)
    this.name = "HostSessionMoveRefusedError"
  }
}

export interface HostStateLeaseInput {
  hostId: string
  ownerId: string
  now?: number
  ttlMs?: number
}

export async function acquireHostStateLease(input: HostStateLeaseInput): Promise<HostStateMetaRow> {
  const db = getDb()
  const now = input.now ?? Date.now()
  const ttlMs = normalizeTtl(input.ttlMs)
  return db.transaction("rw", db.hostStateMeta, db.hostStateChannels, db.sessions, async () => {
    const current = await db.hostStateMeta.get(HOST_STATE_META_ID)
    if (
      current &&
      current.leaseExpiresAt > now &&
      (current.leaseOwnerId !== input.ownerId || current.hostId !== input.hostId)
    ) {
      throw new HostStateStoreError("host_state_lease_held")
    }
    if (
      current &&
      current.leaseExpiresAt > now &&
      current.leaseOwnerId === input.ownerId &&
      current.hostId === input.hostId
    ) {
      const renewed = { ...current, leaseExpiresAt: now + ttlMs, updatedAt: now }
      await db.hostStateMeta.put(renewed)
      return renewed
    }

    const hostGeneration = (current?.hostGeneration ?? 0) + 1
    const next: HostStateMetaRow = {
      id: HOST_STATE_META_ID,
      hostId: input.hostId,
      hostGeneration,
      hostSeq: 0,
      leaseOwnerId: input.ownerId,
      leaseExpiresAt: now + ttlMs,
      updatedAt: now,
    }
    await db.hostStateMeta.put(next)
    await refreshHostStateGeneration(db, next, now)
    return next
  })
}

/**
 * A new generation starts from the business rows that survived shutdown,
 * including account-sync changes made while no Host owned the live channels.
 * Keep durable runtime/draft state for recovery; only refresh session metadata
 * and index membership. Renewals never rewrite the current ordered stream.
 */
async function refreshHostStateGeneration(
  db: ReturnType<typeof getDb>,
  meta: HostStateMetaRow,
  now: number
): Promise<void> {
  const rows = await db.hostStateChannels.toArray()
  if (rows.length === 0) return
  const sessions = new Map((await db.sessions.toArray()).map((session) => [session.id, session]))
  const channels = new Map(rows.map((row) => [row.channel, row]))
  for (const row of rows) {
    if (row.state.kind !== "session" || row.state.tombstone) continue
    const session = sessions.get(row.state.sessionId)
    row.state = session
      ? { ...row.state, ...sessionProjectionMetadata(session) }
      : reduceHostStateMutation(row.state, {
          kind: "session.tombstoned",
          deletedAt: now,
          hostSeq: 0,
          revision: row.state.revision,
        })
  }
  for (const row of rows) {
    if (row.state.kind === "session-index") {
      const summaries = new Map(row.state.sessions.map((summary) => [summary.sessionId, summary]))
      for (const session of sessions.values()) {
        if (!summaries.has(session.id)) {
          summaries.set(session.id, {
            sessionId: session.id,
            ...sessionProjectionMetadata(session),
            turn: "idle",
            revision: 0,
          })
        }
      }
      row.state = {
        ...row.state,
        sessions: Array.from(summaries.values(), (summary): HostStateSessionSummary => {
          const channel = channels.get(`${row.channel}/${encodeURIComponent(summary.sessionId)}`)
          const state = channel?.state
          // A session channel carries the latest runtime state even if the
          // previous owner stopped before publishing its index summary.
          if (state?.kind === "session") {
            return {
              sessionId: state.sessionId,
              ...(state.title !== undefined ? { title: state.title } : {}),
              conversation: state.conversation,
              turn: state.turn,
              revision: state.revision,
              transcriptRevision: state.transcriptRevision,
              ...(state.tombstone ? { tombstone: state.tombstone } : {}),
            }
          }
          if (summary.tombstone) return summary
          const session = sessions.get(summary.sessionId)
          return session
            ? { ...summary, ...sessionProjectionMetadata(session) }
            : {
                ...summary,
                conversation: "tombstoned",
                turn: "idle",
                tombstone: { deletedAt: now, hostSeq: 0 },
              }
        }),
      }
    }
    row.hostId = meta.hostId
    row.hostGeneration = meta.hostGeneration
    row.hostSeq = 0
    row.digest = hostStateDigest(row.state)
    row.updatedAt = now
  }
  await db.hostStateChannels.bulkPut(rows)
}

function sessionProjectionMetadata(session: ChatSession) {
  return {
    title: session.title,
    conversation: session.archivedAt !== undefined ? ("archived" as const) : ("present" as const),
    transcriptRevision: session.transcriptRevision ?? 0,
  }
}

export async function renewHostStateLease(input: {
  ownerId: string
  hostGeneration: number
  now?: number
  ttlMs?: number
}): Promise<HostStateMetaRow> {
  const db = getDb()
  const now = input.now ?? Date.now()
  const ttlMs = normalizeTtl(input.ttlMs)
  return db.transaction("rw", db.hostStateMeta, async () => {
    const current = await db.hostStateMeta.get(HOST_STATE_META_ID)
    if (!current) throw new HostStateStoreError("host_state_lease_missing")
    if (current.hostGeneration !== input.hostGeneration || current.leaseOwnerId !== input.ownerId) {
      throw new HostStateStoreError("stale_host_generation")
    }
    if (current.leaseExpiresAt <= now) throw new HostStateStoreError("host_state_lease_expired")
    const renewed = { ...current, leaseExpiresAt: now + ttlMs, updatedAt: now }
    await db.hostStateMeta.put(renewed)
    return renewed
  })
}

export interface CommitHostStateActionInput {
  action: HostStateAction
  /**
   * For a `session.create`: the subset of its seed this Host owns
   * ({@link ownedSessionSeed}). The projection writes only this, never the
   * seed as it arrived on the wire; absent means a bare row.
   */
  sessionSeed?: HostStateSessionSeed
  mutation?: HostStateMutation
  runtimeDispatchRequired?: boolean
  rejection?: { code: string; message: string; currentRevision?: number }
  now?: number
}

export interface CommitHostStateActionResult {
  event: HostStateAppliedAction
  snapshot: HostStateSnapshot
  duplicate: boolean
}

export interface CommitHostStateRuntimeProjectionInput {
  hostId: string
  hostGeneration: number
  ownerId: string
  channel: string
  envelopeId: string
  envelopeDigest: string
  mutation: (state: HostStateChannelState) => HostStateMutation
  now?: number
}

/** Commit a canonical runtime-event projection into the same ordered ledger. */
export async function commitHostStateRuntimeProjection(
  input: CommitHostStateRuntimeProjectionInput
): Promise<{ event: HostStateAppliedAction; duplicate: boolean }> {
  const db = getDb()
  const now = input.now ?? Date.now()
  const actionId = `runtime:${input.envelopeId}`
  return db.transaction(
    "rw",
    db.hostStateMeta,
    db.hostStateChannels,
    db.hostStateActions,
    db.sessions,
    db.chatDrafts,
    async () => {
      const meta = await db.hostStateMeta.get(HOST_STATE_META_ID)
      if (!meta) throw new HostStateStoreError("host_state_lease_missing")
      if (
        meta.hostId !== input.hostId ||
        meta.hostGeneration !== input.hostGeneration ||
        meta.leaseOwnerId !== input.ownerId
      ) {
        throw new HostStateStoreError("stale_host_generation")
      }
      if (meta.leaseExpiresAt <= now) throw new HostStateStoreError("host_state_lease_expired")
      const existing = await db.hostStateActions.get([meta.hostGeneration, actionId])
      if (existing) return { event: existing.event, duplicate: true }

      const current = await getOrCreateChannel(input.channel, meta, db, now)
      const hostSeq = meta.hostSeq + 1
      const mutation = input.mutation(current.state)
      const state = reduceHostStateMutation(current.state, mutation)
      const event: HostStateAppliedAction = {
        channel: input.channel,
        hostId: meta.hostId,
        hostGeneration: meta.hostGeneration,
        hostSeq,
        outcome: "applied",
        mutation,
      }
      await Promise.all([
        db.hostStateChannels.put({
          channel: input.channel,
          hostId: meta.hostId,
          hostGeneration: meta.hostGeneration,
          hostSeq,
          revision: state.revision,
          digest: hostStateDigest(state),
          state,
          updatedAt: now,
        }),
        db.hostStateActions.put({
          hostGeneration: meta.hostGeneration,
          actionId,
          channel: input.channel,
          hostSeq,
          outcome: "applied",
          payloadDigest: input.envelopeDigest,
          event,
          dispatchState: "not-required",
          broadcastState: "pending",
          summaryState: isSessionStateChannel(input.channel) ? "pending" : "not-required",
          runtimeCorrelation: input.envelopeId,
          createdAt: now,
          updatedAt: now,
        }),
        db.hostStateMeta.put({ ...meta, hostSeq, updatedAt: now }),
      ])
      return { event, duplicate: false }
    }
  )
}

export async function commitHostStateAction(
  input: CommitHostStateActionInput
): Promise<CommitHostStateActionResult> {
  if (!isHostStateAction(input.action)) {
    throw new HostStateStoreError("host_state_invalid_action")
  }
  // The mutation is broadcast verbatim to every replica, so a malformed one
  // poisons all of them at once. The action was already checked here; the
  // mutation was not, and a missing field surfaced only as a canonical-JSON
  // failure from deep inside the write transaction.
  if (input.mutation && !isHostStateMutation(input.mutation)) {
    throw new HostStateStoreError("host_state_invalid_mutation")
  }
  assertActionChannel(input.action)
  const db = getDb()
  const now = input.now ?? Date.now()
  return db.transaction(
    "rw",
    [
      db.hostStateMeta,
      db.hostStateChannels,
      db.hostStateActions,
      db.sessions,
      db.chatDrafts,
      db.messages,
      db.messageMediaRefs,
      db.agentCanonicalSessions,
      db.threadHandoffTickets,
      // A `session.workspace` move re-plans against the destination workspace
      // inside this transaction (and the session's folder, already below).
      db.projects,
      // The folder intents write `sessionFolders`, unfile member sessions and
      // tombstone a deleted folder, all inside this ledger transaction.
      ...folderWriteTables(db),
    ],
    async () => {
      const meta = await db.hostStateMeta.get(HOST_STATE_META_ID)
      if (!meta) throw new HostStateStoreError("host_state_lease_missing")
      if (
        meta.hostGeneration !== input.action.hostGeneration ||
        meta.hostId !== input.action.hostId
      ) {
        throw new HostStateStoreError("stale_host_generation")
      }
      if (meta.leaseExpiresAt <= now) throw new HostStateStoreError("host_state_lease_expired")

      const existing = await db.hostStateActions.get([
        input.action.hostGeneration,
        input.action.actionId,
      ])
      if (existing) {
        const snapshot = await snapshotInTransaction(input.action.channel, meta, db, now)
        return { event: existing.event, snapshot, duplicate: true }
      }
      const current = await getOrCreateChannel(input.action.channel, meta, db, now)
      const hostSeq = meta.hostSeq + 1
      // A tombstone records the ledger position it was written at, and only
      // this transaction knows it: the caller built the mutation from a
      // snapshot, and a runtime projection may have landed in between.
      const mutation =
        input.mutation?.kind === "session.tombstoned"
          ? { ...input.mutation, hostSeq }
          : input.mutation
      const conflict =
        requiresMatchingRevision(input.action) && input.action.baseRevision !== current.revision
      const event: HostStateAppliedAction = input.rejection
        ? {
            channel: input.action.channel,
            hostId: meta.hostId,
            hostGeneration: meta.hostGeneration,
            hostSeq,
            origin: actionOrigin(input.action),
            outcome: "rejected",
            rejection: input.rejection,
          }
        : conflict
          ? {
              channel: input.action.channel,
              hostId: meta.hostId,
              hostGeneration: meta.hostGeneration,
              hostSeq,
              origin: actionOrigin(input.action),
              outcome: "conflicted",
              rejection: {
                code: "host_state_revision_conflict",
                message: "The action base revision does not match the authoritative channel.",
                currentRevision: current.revision,
              },
            }
          : {
              channel: input.action.channel,
              hostId: meta.hostId,
              hostGeneration: meta.hostGeneration,
              hostSeq,
              origin: actionOrigin(input.action),
              outcome: "applied",
              ...(mutation ? { mutation } : {}),
            }
      const state =
        input.rejection || conflict || !mutation
          ? current.state
          : reduceHostStateMutation(current.state, mutation)
      const nextChannel: HostStateChannelRow = {
        channel: current.channel,
        hostId: meta.hostId,
        hostGeneration: meta.hostGeneration,
        hostSeq,
        revision: state.revision,
        digest: hostStateDigest(state),
        state,
        updatedAt: now,
      }
      const nextMeta = { ...meta, hostSeq, updatedAt: now }
      const actionRow: HostStateActionRow = {
        hostGeneration: meta.hostGeneration,
        actionId: input.action.actionId,
        channel: input.action.channel,
        hostSeq,
        outcome: event.outcome,
        payloadDigest: hostStateDigest(input.action),
        action: input.action,
        event,
        dispatchState:
          input.rejection || conflict || !input.runtimeDispatchRequired
            ? "not-required"
            : "pending",
        broadcastState: "pending",
        // Only a change to the channel can change its index summary. The
        // list-organization intents commit with no mutation (their effect is
        // the `sessions` row, which table sync carries), and re-broadcasting an
        // identical summary for each of them would fan one pin out as N writes.
        summaryState:
          event.outcome === "applied" && mutation && isSessionStateChannel(input.action.channel)
            ? "pending"
            : "not-required",
        createdAt: now,
        updatedAt: now,
      }
      await Promise.all([
        db.hostStateChannels.put(nextChannel),
        db.hostStateActions.put(actionRow),
        db.hostStateMeta.put(nextMeta),
        ...(input.rejection || conflict
          ? []
          : [persistBusinessProjection(db, input.action, event, now, input.sessionSeed)]),
      ])
      return {
        event,
        snapshot: snapshotFromRow(nextChannel, nextMeta),
        duplicate: false,
      }
    }
  )
}

/**
 * Every session channel this Host holds durable state for.
 *
 * Used by recovery to find turns a previous owner left in flight. Returns the
 * channels, not the states, so the caller reads each through the same snapshot
 * path everything else uses rather than trusting a raw row.
 */
export async function listHostStateSessionChannels(): Promise<string[]> {
  const rows = await getDb().hostStateChannels.toArray()
  return rows.map((row) => row.channel).filter(isSessionStateChannel)
}

export async function getHostStateSnapshot(channel: string): Promise<HostStateSnapshot> {
  const db = getDb()
  const now = Date.now()
  return db.transaction(
    "rw",
    db.hostStateMeta,
    db.hostStateChannels,
    db.sessions,
    db.chatDrafts,
    async () => {
      const meta = await db.hostStateMeta.get(HOST_STATE_META_ID)
      if (!meta) throw new HostStateStoreError("host_state_lease_missing")
      return snapshotInTransaction(channel, meta, db, now)
    }
  )
}

async function snapshotInTransaction(
  channel: string,
  meta: HostStateMetaRow,
  db: ReturnType<typeof getDb>,
  now: number
): Promise<HostStateSnapshot> {
  const row = await getOrCreateChannel(channel, meta, db, now)
  return snapshotFromRow(row, meta)
}

async function getOrCreateChannel(
  channel: string,
  meta: HostStateMetaRow,
  db: ReturnType<typeof getDb>,
  now: number
): Promise<HostStateChannelRow> {
  const existing = await db.hostStateChannels.get(channel)
  if (existing) return existing
  const state = await materializeInitialState(db, channel)
  const row: HostStateChannelRow = {
    channel,
    hostId: meta.hostId,
    hostGeneration: meta.hostGeneration,
    hostSeq: meta.hostSeq,
    revision: state.revision,
    digest: hostStateDigest(state),
    state,
    updatedAt: now,
  }
  await db.hostStateChannels.put(row)
  return row
}

export async function getHostStateMeta(): Promise<HostStateMetaRow> {
  const meta = await getDb().hostStateMeta.get(HOST_STATE_META_ID)
  if (!meta) throw new HostStateStoreError("host_state_lease_missing")
  return meta
}

export async function listPendingHostStateActions(): Promise<HostStateActionRow[]> {
  return getDb()
    .hostStateActions.filter(
      (row) =>
        row.dispatchState === "pending" ||
        row.dispatchState === "failed" ||
        row.broadcastState === "pending" ||
        row.summaryState === "pending"
    )
    .sortBy("hostSeq")
}

export async function getHostStateAction(
  hostGeneration: number,
  actionId: string
): Promise<HostStateActionRow | undefined> {
  return getDb().hostStateActions.get([hostGeneration, actionId])
}

/**
 * The part of a `session.create` seed this Host owns.
 *
 * A paired client's workspaces and agents are often its own (a fresh headless
 * Host has none at all), so an id the Host does not have is normal, not an
 * error: refusing it would refuse every new chat. The conversation is created
 * without that attribution instead, so a Host row never points at nothing.
 * The composer picks (model, provider) name nothing the Host stores and are
 * kept. Resolved before the ledger transaction, because agents also resolve
 * through plugin overlay packs outside Dexie.
 */
export async function ownedSessionSeed(
  seed: HostStateSessionSeed | undefined
): Promise<HostStateSessionSeed | undefined> {
  if (!seed) return undefined
  const projectOwned = seed.projectId ? Boolean(await getDb().projects.get(seed.projectId)) : false
  let characterOwned = false
  if (seed.characterId) {
    const { resolveCharacterById } = await import("@/lib/db/characters")
    characterOwned = Boolean(await resolveCharacterById(seed.characterId))
  }
  const owned: HostStateSessionSeed = {
    ...(projectOwned ? { projectId: seed.projectId } : {}),
    ...(characterOwned ? { characterId: seed.characterId } : {}),
    ...(seed.model ? { model: seed.model } : {}),
    ...(seed.provider ? { provider: seed.provider } : {}),
  }
  return Object.keys(owned).length > 0 ? owned : undefined
}

export async function validateHostStateBusinessAction(
  action: HostStateAction
): Promise<{ code: string; message: string } | undefined> {
  if (hostStateIntentTargetsSessionIndex(action.action.kind)) {
    return validateFolderAction(action)
  }
  if (!action.sessionId) {
    return { code: "host_state_session_id_required", message: "The action requires a session id." }
  }
  const db = getDb()
  const session = await db.sessions.get(action.sessionId)
  if (action.action.kind === "session.create" || action.action.kind === "session.import") {
    return session
      ? {
          code: "host_state_session_exists",
          message: "The continuation session id already exists.",
        }
      : undefined
  }
  if (!session) {
    return { code: "session_not_found", message: "The session does not exist on this Host." }
  }
  const writeOperation = sessionWriteOperationFor(action.action.kind)
  if (writeOperation) {
    // The same gate every desktop writer passes (`assertSessionsWritable` in
    // `lib/db/sessions.ts`): a conversation frozen for a cross-host handoff is
    // read-only, and a remote device must not be the way around that.
    try {
      assertSessionWritable(session, writeOperation)
    } catch (error) {
      if (error instanceof SessionHandoffLockedError) {
        return { code: error.code, message: "The session is read-only during a handoff." }
      }
      throw error
    }
  }
  if (action.action.kind === "session.workspace") {
    // The Host's own rows decide, not the client's view of them: the same
    // planner a desktop move runs, against this session, this workspace and
    // this folder, with the channel's turn standing in for "running" when the
    // turn was started by a client rather than on this desktop.
    const channel = await db.hostStateChannels.get(action.channel)
    const plan = await planHostSessionMove(db, {
      session,
      projectId: action.action.projectId,
      ...(channel?.state.kind === "session" ? { turn: channel.state.turn } : {}),
      now: Date.now(),
    })
    return plan.ok ? undefined : hostSessionMoveRejection(plan.reason)
  }
  if (action.action.kind === "message.enqueue") {
    const existing = await db.messages.get(action.action.messageId)
    const existingActionId = (existing?.metadata?.hostState as { actionId?: unknown } | undefined)
      ?.actionId
    return existing && existingActionId !== action.actionId
      ? { code: "host_state_message_id_exists", message: "The message id already exists." }
      : undefined
  }
  if (action.action.kind === "transcript.edit") {
    const message = await db.messages.get(action.action.messageId)
    return !message || message.sessionId !== action.sessionId
      ? { code: "host_state_message_not_found", message: "The transcript message was not found." }
      : undefined
  }
  if (action.action.kind === "transcript.truncate" && action.action.afterMessageId) {
    const message = await db.messages.get(action.action.afterMessageId)
    return !message || message.sessionId !== action.sessionId
      ? { code: "host_state_message_not_found", message: "The transcript boundary was not found." }
      : undefined
  }
  return undefined
}

/**
 * Preconditions of the folder intents, which name no session.
 *
 * A `folder.create` must mint a new id (a second create under the same id is a
 * different folder colliding, not a retry — a retry is the same action id and
 * the ledger answers it before this runs). A rename or delete must name a
 * folder the Host holds. A delete also passes every member through the same
 * handoff gate the desktop's `deleteFolder` does: unfiling a conversation
 * frozen for a handoff is a write to it. A reorder has none — ids the Host
 * does not hold are ignored by the writer.
 */
async function validateFolderAction(
  action: HostStateAction
): Promise<{ code: string; message: string } | undefined> {
  if (action.sessionId !== undefined) {
    return {
      code: "host_state_session_id_forbidden",
      message: "A folder action names no session.",
    }
  }
  const db = getDb()
  const intent = action.action
  switch (intent.kind) {
    case "folder.create":
      return (await db.sessionFolders.get(intent.folderId))
        ? { code: "host_state_folder_exists", message: "The folder id already exists." }
        : undefined
    case "folder.rename":
      return (await db.sessionFolders.get(intent.folderId))
        ? undefined
        : {
            code: "host_state_folder_not_found",
            message: "The folder does not exist on this Host.",
          }
    case "folder.delete": {
      if (!(await db.sessionFolders.get(intent.folderId))) {
        return {
          code: "host_state_folder_not_found",
          message: "The folder does not exist on this Host.",
        }
      }
      const members = await db.sessions.where("folderId").equals(intent.folderId).toArray()
      try {
        for (const member of members) assertSessionWritable(member, "metadata")
      } catch (error) {
        if (error instanceof SessionHandoffLockedError) {
          return {
            code: error.code,
            message: "A conversation in the folder is read-only during a handoff.",
          }
        }
        throw error
      }
      return undefined
    }
    default:
      return undefined
  }
}

/**
 * The handoff-lock operation an intent performs on its session row, or null
 * for intents that do not write it through the product write gate.
 */
function sessionWriteOperationFor(
  kind: HostStateAction["action"]["kind"]
): SessionWriteOperation | null {
  switch (kind) {
    case "session.rename":
      return "title"
    case "session.archive":
    case "session.pin":
    case "session.folder":
    case "session.order":
    case "session.workspace":
      return "metadata"
    case "session.delete":
      return "delete"
    default:
      return null
  }
}

export async function markHostStateDispatch(
  hostGeneration: number,
  actionId: string,
  result: { state: "completed" | "failed"; runtimeCorrelation?: string; errorCode?: string },
  now = Date.now()
): Promise<void> {
  await getDb().hostStateActions.update([hostGeneration, actionId], {
    dispatchState: result.state,
    runtimeCorrelation: result.runtimeCorrelation,
    lastErrorCode: result.errorCode,
    updatedAt: now,
  })
}

export async function markHostStateBroadcast(
  hostGeneration: number,
  actionId: string,
  now = Date.now()
): Promise<void> {
  await getDb().hostStateActions.update([hostGeneration, actionId], {
    broadcastState: "completed",
    updatedAt: now,
  })
}

export async function markHostStateSummary(
  hostGeneration: number,
  actionId: string,
  now = Date.now()
): Promise<void> {
  await getDb().hostStateActions.update([hostGeneration, actionId], {
    summaryState: "completed",
    updatedAt: now,
  })
}

function emptyStateForChannel(channel: string): HostStateChannelState {
  const match = /^cognia:\/\/target\/([^/]+)\/sessions(?:\/([^/]+))?$/.exec(channel)
  if (!match) throw new HostStateStoreError("host_state_channel_mismatch")
  if (!match[2]) return { kind: "session-index", channel, revision: 0, sessions: [] }
  return createEmptyHostStateSession(channel, decodeURIComponent(match[2]))
}

async function materializeInitialState(
  db: ReturnType<typeof getDb>,
  channel: string
): Promise<HostStateChannelState> {
  const base = emptyStateForChannel(channel)
  if (base.kind === "session-index") {
    const sessions = await db.sessions.toArray()
    return {
      ...base,
      sessions: sessions.map((session) => ({
        sessionId: session.id,
        title: session.title,
        conversation:
          session.archivedAt !== undefined ? ("archived" as const) : ("present" as const),
        // A freshly materialized index knows nothing about turns in flight —
        // the runtime tells the Host that, and until it does `idle` is the
        // only honest answer.
        turn: "idle" as const,
        revision: 0,
        transcriptRevision: 0,
      })),
    }
  }
  // Both rows require WebCrypto decryption. Resolve each hold before starting
  // the next: overlapping Dexie.waitFor holds in one transaction can deadlock
  // when both the session and draft already contain encrypted content.
  const session = await db.sessions.get(base.sessionId)
  const draft = await db.chatDrafts.get(base.sessionId)
  return {
    ...base,
    ...(session?.title ? { title: session.title } : {}),
    transcriptRevision: session?.transcriptRevision ?? 0,
    conversation: session?.archivedAt !== undefined ? ("archived" as const) : ("present" as const),
    draft: {
      text: draft?.text ?? "",
      attachments:
        draft?.attachmentRefs ??
        (draft?.attachments ?? []).map(({ name, mediaType, size }) => ({ name, mediaType, size })),
      revision: draft?.revision ?? 0,
    },
  }
}

/**
 * Apply a folder intent through the same repository the desktop writes with
 * (`lib/db/session-folders.ts`), inside the ledger transaction — its tables
 * are part of it (`folderWriteTables`). A lock or a vanished folder that lands
 * between validation and commit throws here and rolls the ledger back.
 */
async function persistFolderProjection(action: HostStateAction, now: number): Promise<void> {
  const intent = action.action
  switch (intent.kind) {
    case "folder.create":
      await writeFolderCreate({
        id: intent.folderId,
        projectId: intent.projectId,
        name: intent.name,
        now,
      })
      return
    case "folder.rename":
      if (!(await writeFolderRename(intent.folderId, intent.name, now))) {
        throw new HostStateStoreError("host_state_folder_not_found")
      }
      return
    case "folder.reorder":
      await writeFolderReorder(intent.projectId, intent.orderedIds, now)
      return
    case "folder.delete":
      await writeFolderDelete(intent.folderId, now)
      return
    default:
      return
  }
}

async function persistBusinessProjection(
  db: ReturnType<typeof getDb>,
  action: HostStateAction,
  event: HostStateAppliedAction,
  now: number,
  sessionSeed?: HostStateSessionSeed
): Promise<void> {
  if (event.outcome !== "applied") return
  if (hostStateIntentTargetsSessionIndex(action.action.kind)) {
    await persistFolderProjection(action, now)
    return
  }
  if (!action.sessionId) return
  // A delete is carried out BEFORE its ledger row is committed (see
  // `createHostStateService().submit`): the cascade spans tables and external
  // teardown no single ledger transaction can hold, and the row being gone is
  // the fact the tombstone then records.
  if (action.action.kind === "session.delete") return
  const session = await db.sessions.get(action.sessionId)
  if (
    !session &&
    action.action.kind !== "session.create" &&
    action.action.kind !== "session.import"
  ) {
    throw new HostStateStoreError("host_state_session_not_found")
  }
  switch (action.action.kind) {
    case "session.create": {
      const seed = sessionSeed
      await db.sessions.add({
        id: action.sessionId,
        title: action.action.title?.trim() || "New conversation",
        titleAuto: !action.action.title,
        transcriptRevision: 0,
        createdAt: now,
        updatedAt: now,
        ...(seed?.projectId ? { projectId: seed.projectId } : {}),
        ...(seed?.characterId ? { characterId: seed.characterId } : {}),
        ...(seed?.model ? { model: seed.model } : {}),
        ...(seed?.provider ? { providerOverride: seed.provider } : {}),
      })
      return
    }
    case "session.import": {
      if (!isCanonicalSession(action.action.envelope)) {
        throw new HostStateStoreError("host_state_invalid_action")
      }
      const canonical = action.action.envelope as CanonicalSession
      const title = canonical.header.title?.trim() || "Imported conversation"
      const messages: StoredMessage[] = canonical.turns.map((turn, index) => ({
        id: `${action.sessionId}:${turn.turnId}`,
        sessionId: action.sessionId!,
        role: turn.role,
        parts: canonicalTurnToHandoffMessage(turn).parts!,
        createdAt: now + index,
      }))
      const seedTranscript = canonical.turns
        .map(
          (turn) =>
            `${turn.role === "assistant" ? "Assistant" : turn.role === "user" ? "User" : "System"}: ${turn.text}`
        )
        .join("\n\n")
      const handoff =
        action.actionId.startsWith("thread-handoff:") && action.actionId.endsWith(":import")
          ? await db.threadHandoffTickets.get([
              action.actionId.slice("thread-handoff:".length, -":import".length),
              "target",
            ])
          : undefined
      if (
        handoff &&
        (handoff.target.sessionId !== action.sessionId ||
          handoff.continuation.sequenceDigest !== canonical.header.sequenceDigest ||
          handoff.state !== "preparing")
      ) {
        throw new HostStateStoreError("host_state_invalid_action")
      }
      await db.sessions.add({
        id: action.sessionId,
        ...(handoff
          ? {
              handoffLock: {
                ticketId: handoff.ticketId,
                state: "frozen" as const,
                targetHostRef: handoff.target.hostRef,
                targetSessionId: action.sessionId,
                at: now,
              },
            }
          : {}),
        title,
        titleAuto: false,
        kind: "direct",
        handoffSource: "thread-handoff",
        transcriptRevision: canonical.turns.length,
        branchKind: "direct",
        ...(seedTranscript
          ? { branchSeed: { kind: "transcript" as const, content: seedTranscript } }
          : {}),
        lastMessagePreview: canonical.turns.at(-1)?.text.replace(/\s+/g, " ").trim().slice(0, 120),
        lastMessageAt: messages.at(-1)?.createdAt,
        createdAt: now,
        updatedAt: now,
      })
      if (messages.length > 0) {
        await db.messages.bulkAdd(messages)
        const refs = messages.flatMap((message) =>
          messageMediaRefRows(message.id, message.sessionId, message.parts)
        )
        if (refs.length > 0) await db.messageMediaRefs.bulkPut(refs)
      }
      if (messages.length > 0) markSessionDirty(messages[0].sessionId)
      await db.agentCanonicalSessions.put({
        canonicalSessionId: canonical.header.canonicalSessionId,
        sourceRuntime: canonical.header.sourceRuntime,
        nativeSessionId: canonical.header.runtimeBinding?.nativeSessionId ?? "",
        ...(canonical.header.title ? { title: canonical.header.title } : {}),
        turnCount: canonical.header.turnCount,
        importFidelity: canonical.header.importFidelity,
        sequenceDigest: canonical.header.sequenceDigest,
        lossCount: 0,
        losses: [],
        rebuilt: false,
        createdAt: Date.parse(canonical.header.createdAt) || now,
        updatedAt: Date.parse(canonical.header.updatedAt) || now,
      })
      return
    }
    // Rename and archive re-apply the handoff gate here as well as in
    // validation, like the list-organization writes below: a lock taken
    // between the two must still refuse the write (and roll the ledger back).
    case "session.rename":
      assertSessionWritable(session, "title")
      await db.sessions.update(action.sessionId, { title: action.action.title, updatedAt: now })
      return
    case "session.archive":
      assertSessionWritable(session, "metadata")
      await db.sessions.update(action.sessionId, {
        archivedAt: action.action.archived ? now : undefined,
        updatedAt: now,
      })
      return
    // The three list-organization writes below mirror their desktop
    // repositories in `lib/db/sessions.ts` field for field
    // (`bulkSetSessionsPinned`, `assignSessionToFolder`, `setSessionOrder`),
    // and stamp the row through the same `stampOrganizationalWrite`.
    // They cannot call them: those open their own transactions and this one
    // already holds the ledger. The handoff gate is re-applied here so a lock
    // taken between validation and commit still refuses the write.
    case "session.pin": {
      assertSessionWritable(session, "metadata")
      const pinned = action.action.pinned
      await db.sessions
        .where("id")
        .equals(action.sessionId)
        .modify((row) => {
          row.pinned = pinned
          stampOrganizationalWrite(row, now)
        })
      return
    }
    case "session.folder": {
      assertSessionWritable(session, "metadata")
      const folderId = action.action.folderId
      await db.sessions
        .where("id")
        .equals(action.sessionId)
        .modify((row) => {
          if (folderId === null) delete row.folderId
          else row.folderId = folderId
          stampOrganizationalWrite(row, now)
        })
      return
    }
    case "session.order": {
      assertSessionWritable(session, "metadata")
      const { manualOrder, sectionKey } = action.action
      await db.sessions
        .where("id")
        .equals(action.sessionId)
        .modify((row) => {
          row.manualOrder = manualOrder
          row.manualOrderSection = sectionKey
          stampOrganizationalWrite(row, now)
        })
      return
    }
    // A workspace move, re-planned here against the rows this transaction
    // holds: a turn that started, a workspace that was deleted or a lock that
    // was taken since validation refuses the write and rolls the ledger back.
    // Field for field the write a desktop move makes through `updateSession`
    // (`hooks/workspace/use-move-session-workspace.ts`). The rosters are
    // relinked by the service once this commits (`relinkMovedSessionRoster`).
    case "session.workspace": {
      assertSessionWritable(session, "metadata")
      const channel = await db.hostStateChannels.get(action.channel)
      const plan = await planHostSessionMove(db, {
        session: session!,
        projectId: action.action.projectId,
        ...(channel?.state.kind === "session" ? { turn: channel.state.turn } : {}),
        now,
      })
      if (!plan.ok) {
        throw new HostSessionMoveRefusedError(hostSessionMoveRejection(plan.reason))
      }
      await db.sessions.update(action.sessionId, {
        projectId: plan.projectId,
        executionContext: plan.executionContext,
        // A folder of the old workspace cannot hold it any more.
        ...(plan.clearFolder ? { folderId: undefined } : {}),
        updatedAt: now,
      })
      return
    }
    case "draft.replace": {
      // `put` replaces the whole row and the wire format carries text and
      // attachments only, so the `{{parameter}}` values held on this device
      // have to be read back and re-attached — otherwise a remote draft edit
      // silently empties a half-filled template.
      const existing = await db.chatDrafts.get(action.sessionId)
      await db.chatDrafts.put({
        sessionId: action.sessionId,
        text: action.action.text,
        updatedAt: now,
        revision:
          event.mutation?.kind === "draft.replaced" ? event.mutation.draftRevision : undefined,
        originClientId: action.clientId,
        attachmentRefs: action.action.attachments,
        ...(action.action.attachments.length > 0 ? { attachments: action.action.attachments } : {}),
        ...(existing?.templateBinding ? { templateBinding: existing.templateBinding } : {}),
      })
      return
    }
    case "message.enqueue": {
      const instantTitle = action.action.text.replace(/\s+/g, " ").trim().slice(0, 40)
      const message: StoredMessage = {
        id: action.action.messageId,
        sessionId: action.sessionId,
        ...(session?.projectId ? { projectId: session.projectId } : {}),
        role: "user",
        parts: [{ type: "text", text: action.action.text }],
        metadata: {
          hostState: {
            actionId: action.actionId,
            clientId: action.clientId,
            attachmentRefs: action.action.attachments,
          },
        },
        createdAt: now,
      }
      await db.messages.put(message)
      markSessionDirty(action.sessionId)
      await db.chatDrafts.delete(action.sessionId)
      // `transcriptRevision` deliberately does NOT move here, and the channel's
      // `message.queued` mutation carries none either. It is the key clients
      // reconcile on, and a queued message whose dispatch later fails would
      // have invited every replica to refetch a page that gained a user turn
      // and no answer, with nothing to say the send never left. The message row
      // exists (the queue carries it); the fate of the send is reported by its
      // operation, and the revision moves when the runtime confirms transcript
      // content.
      await db.sessions.update(action.sessionId, {
        ...(instantTitle && isPlaceholderTitle(session?.title)
          ? { title: instantTitle, titleAuto: true }
          : {}),
        lastMessagePreview: action.action.text.replace(/\s+/g, " ").trim().slice(0, 120),
        lastMessageAt: now,
        updatedAt: now,
      })
      return
    }
    case "transcript.edit": {
      const message = await db.messages.get(action.action.messageId)
      if (!message || message.sessionId !== action.sessionId) {
        throw new HostStateStoreError("host_state_message_not_found")
      }
      const nonTextParts = message.parts.filter(
        (part) => !part || typeof part !== "object" || part.type !== "text"
      )
      await db.messages.update(message.id, {
        parts: [{ type: "text", text: action.action.text }, ...nonTextParts],
      })
      await db.sessions.update(action.sessionId, {
        transcriptRevision:
          event.mutation?.kind === "transcript.revised"
            ? event.mutation.transcriptRevision
            : (session?.transcriptRevision ?? 0) + 1,
        updatedAt: now,
        ...(session?.lastMessageAt === message.createdAt
          ? {
              lastMessagePreview: action.action.text.replace(/\s+/g, " ").trim().slice(0, 120),
            }
          : {}),
      })
      return
    }
    case "transcript.truncate": {
      if (action.action.kind !== "transcript.truncate") return
      const messages = await db.messages
        .where("[sessionId+createdAt]")
        .between([action.sessionId, 0], [action.sessionId, Number.MAX_SAFE_INTEGER])
        .sortBy("createdAt")
      let keepThrough = -1
      // Bound to a local: narrowing does not survive into the `findIndex`
      // callback, so the read there saw the un-narrowed intent union.
      const afterMessageId =
        action.action.kind === "transcript.truncate" ? action.action.afterMessageId : undefined
      if (afterMessageId) {
        keepThrough = messages.findIndex((message) => message.id === afterMessageId)
        if (keepThrough < 0) throw new HostStateStoreError("host_state_message_not_found")
      }
      const removed = messages.slice(keepThrough + 1)
      if (removed.length > 0) {
        const removedIds = removed.map((message) => message.id)
        await Promise.all([
          db.messages.bulkDelete(removedIds),
          db.messageMediaRefs.where("messageId").anyOf(removedIds).delete(),
        ])
      }
      const last = keepThrough >= 0 ? messages[keepThrough] : undefined
      const lastText = last
        ? stripPromptPreambleFromParts(last.parts)
            .filter((part) => part && typeof part === "object" && part.type === "text")
            .map((part) => (part as { text?: unknown }).text)
            .filter((value): value is string => typeof value === "string")
            .join(" ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 120)
        : undefined
      await db.sessions.update(action.sessionId, {
        transcriptRevision:
          event.mutation?.kind === "transcript.revised"
            ? event.mutation.transcriptRevision
            : (session?.transcriptRevision ?? 0) + 1,
        lastMessagePreview: lastText,
        lastMessageAt: last?.createdAt,
        updatedAt: now,
      })
      return
    }
    default:
      return
  }
}

function snapshotFromRow(row: HostStateChannelRow, meta: HostStateMetaRow): HostStateSnapshot {
  return {
    channel: row.channel,
    hostId: meta.hostId,
    hostGeneration: meta.hostGeneration,
    cutHostSeq: meta.hostSeq,
    revision: row.revision,
    digest: row.digest,
    state: row.state,
  }
}

function assertActionChannel(action: HostStateAction): void {
  const expected = action.sessionId
    ? sessionStateChannel(action.runtimeTargetId, action.sessionId)
    : sessionIndexChannel(action.runtimeTargetId)
  if (expected !== action.channel) {
    throw new HostStateStoreError("host_state_channel_mismatch")
  }
}

function isSessionStateChannel(channel: string): boolean {
  return /^cognia:\/\/target\/[^/]+\/sessions\/[^/]+$/.test(channel)
}

function actionOrigin(action: HostStateAction): NonNullable<HostStateAppliedAction["origin"]> {
  return { clientId: action.clientId, clientSeq: action.clientSeq, actionId: action.actionId }
}

function requiresMatchingRevision(action: HostStateAction): boolean {
  return [
    "session.rename",
    "session.archive",
    "draft.replace",
    "transcript.edit",
    "transcript.truncate",
  ].includes(action.action.kind)
}

function normalizeTtl(value: number | undefined): number {
  const ttl = value ?? HOST_STATE_LEASE_TTL_MS
  if (!Number.isSafeInteger(ttl) || ttl <= 0)
    throw new Error("HostState lease TTL must be positive")
  return ttl
}

export function hostStateActionPayloadSize(action: HostStateAction): number {
  return new TextEncoder().encode(canonicalHostStateJson(action)).byteLength
}
