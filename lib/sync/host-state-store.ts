import {
  HOST_STATE_PROTOCOL_VERSION,
  canonicalHostStateJson,
  createEmptyHostStateSession,
  hostStateDigest,
  hostStateMigrationStageAllowsWrites,
  isHostStateActionV1,
  reduceHostStateMutation,
  sessionIndexChannel,
  sessionStateChannel,
  type HostStateActionOutcomeV1,
  type HostStateActionV1,
  type HostStateAppliedActionV1,
  type HostStateChannelStateV1,
  type HostStateMutationV1,
  type HostStateSnapshotV1,
} from "@cognia/agent-config-types/host-state"

import { getDb } from "@/lib/db/schema"
import type { StoredMessage } from "@cognia/agent-config-types"
import {
  isCanonicalSession,
  type CanonicalSession,
} from "@cognia/agent-config-types/canonical-session"
import { isPlaceholderTitle } from "@/lib/ai/generation/run-title-task"

export const HOST_STATE_META_ID = "singleton" as const
export const HOST_STATE_LEASE_TTL_MS = 30_000
export const HOST_STATE_LEASE_HEARTBEAT_MS = 10_000

export type HostStateMigrationStage =
  | "legacy-authoritative"
  | "shadow"
  | "hoststate-read"
  | "hoststate-authoritative"
  | "legacy-projection-only"
  | "retired"

export interface HostStateChannelRow {
  channel: string
  /** Present on v168+ confirmed replicas; absent only on pre-HostState rows. */
  hostId?: string
  hostGeneration: number
  hostSeq: number
  revision: number
  digest: string
  state: HostStateChannelStateV1
  updatedAt: number
}

export interface HostStateActionRow {
  hostGeneration: number
  actionId: string
  channel: string
  hostSeq: number
  outcome: HostStateActionOutcomeV1
  payloadDigest: string
  /** Retained while dispatch/broadcast recovery is pending; compactable once settled. */
  action?: HostStateActionV1
  event: HostStateAppliedActionV1
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
  migrationStage: HostStateMigrationStage
  updatedAt: number
}

export type HostStateStoreErrorCode =
  | "host_state_invalid_action"
  | "host_state_channel_mismatch"
  | "host_state_lease_missing"
  | "host_state_lease_held"
  | "host_state_lease_expired"
  | "host_state_session_not_found"
  | "host_state_message_not_found"
  | "host_state_not_authoritative"
  | "stale_host_generation"

export class HostStateStoreError extends Error {
  constructor(
    readonly code: HostStateStoreErrorCode,
    message = code
  ) {
    super(message)
    this.name = "HostStateStoreError"
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
  return db.transaction("rw", db.hostStateMeta, db.hostStateChannels, async () => {
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
      migrationStage: current?.migrationStage ?? "legacy-authoritative",
      updatedAt: now,
    }
    await db.hostStateMeta.put(next)
    await db.hostStateChannels.toCollection().modify((row) => {
      row.hostGeneration = hostGeneration
      row.hostSeq = 0
      row.updatedAt = now
    })
    return next
  })
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
  action: HostStateActionV1
  mutation?: HostStateMutationV1
  runtimeDispatchRequired?: boolean
  rejection?: { code: string; message: string; currentRevision?: number }
  now?: number
}

export interface CommitHostStateActionResult {
  event: HostStateAppliedActionV1
  snapshot: HostStateSnapshotV1
  duplicate: boolean
}

export interface CommitHostStateRuntimeProjectionInput {
  hostId: string
  hostGeneration: number
  ownerId: string
  channel: string
  envelopeId: string
  envelopeDigest: string
  mutation: (state: HostStateChannelStateV1) => HostStateMutationV1
  now?: number
}

/** Commit a canonical runtime-event projection into the same ordered ledger. */
export async function commitHostStateRuntimeProjection(
  input: CommitHostStateRuntimeProjectionInput
): Promise<{ event: HostStateAppliedActionV1; duplicate: boolean }> {
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
      const event: HostStateAppliedActionV1 = {
        protocolVersion: HOST_STATE_PROTOCOL_VERSION,
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
  if (!isHostStateActionV1(input.action)) {
    throw new HostStateStoreError("host_state_invalid_action")
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
      if (!hostStateMigrationStageAllowsWrites(meta.migrationStage)) {
        throw new HostStateStoreError("host_state_not_authoritative")
      }

      const current = await getOrCreateChannel(input.action.channel, meta, db, now)
      const hostSeq = meta.hostSeq + 1
      const conflict =
        requiresMatchingRevision(input.action) && input.action.baseRevision !== current.revision
      const event: HostStateAppliedActionV1 = input.rejection
        ? {
            protocolVersion: HOST_STATE_PROTOCOL_VERSION,
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
              protocolVersion: HOST_STATE_PROTOCOL_VERSION,
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
              protocolVersion: HOST_STATE_PROTOCOL_VERSION,
              channel: input.action.channel,
              hostId: meta.hostId,
              hostGeneration: meta.hostGeneration,
              hostSeq,
              origin: actionOrigin(input.action),
              outcome: "applied",
              ...(input.mutation ? { mutation: input.mutation } : {}),
            }
      const state =
        input.rejection || conflict || !input.mutation
          ? current.state
          : reduceHostStateMutation(current.state, input.mutation)
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
        summaryState:
          event.outcome === "applied" && isSessionStateChannel(input.action.channel)
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
          : [persistBusinessProjection(db, input.action, event, now)]),
      ])
      return {
        event,
        snapshot: snapshotFromRow(nextChannel, nextMeta),
        duplicate: false,
      }
    }
  )
}

export async function getHostStateSnapshot(channel: string): Promise<HostStateSnapshotV1> {
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
): Promise<HostStateSnapshotV1> {
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

export async function setHostStateMigrationStage(
  migrationStage: HostStateMigrationStage,
  now = Date.now()
): Promise<void> {
  const updated = await getDb().hostStateMeta.update(HOST_STATE_META_ID, {
    migrationStage,
    updatedAt: now,
  })
  if (!updated) throw new HostStateStoreError("host_state_lease_missing")
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

export async function validateHostStateBusinessAction(
  action: HostStateActionV1
): Promise<{ code: string; message: string } | undefined> {
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

function emptyStateForChannel(channel: string): HostStateChannelStateV1 {
  const match = /^cognia:\/\/target\/([^/]+)\/sessions(?:\/([^/]+))?$/.exec(channel)
  if (!match) throw new HostStateStoreError("host_state_channel_mismatch")
  if (!match[2]) return { kind: "session-index", channel, revision: 0, sessions: [] }
  return createEmptyHostStateSession(channel, decodeURIComponent(match[2]))
}

async function materializeInitialState(
  db: ReturnType<typeof getDb>,
  channel: string
): Promise<HostStateChannelStateV1> {
  const base = emptyStateForChannel(channel)
  if (base.kind === "session-index") {
    const sessions = await db.sessions.toArray()
    return {
      ...base,
      sessions: sessions.map((session) => ({
        sessionId: session.id,
        title: session.title,
        status: "idle" as const,
        revision: 0,
        transcriptRevision: 0,
        archived: session.archivedAt !== undefined,
      })),
    }
  }
  const [session, draft] = await Promise.all([
    db.sessions.get(base.sessionId),
    db.chatDrafts.get(base.sessionId),
  ])
  return {
    ...base,
    ...(session?.title ? { title: session.title } : {}),
    transcriptRevision: session?.transcriptRevision ?? 0,
    archived: session?.archivedAt !== undefined,
    draft: {
      text: draft?.text ?? "",
      attachments:
        draft?.attachmentRefs ??
        (draft?.attachments ?? []).map(({ name, mediaType, size }) => ({ name, mediaType, size })),
      revision: draft?.revision ?? 0,
    },
  }
}

async function persistBusinessProjection(
  db: ReturnType<typeof getDb>,
  action: HostStateActionV1,
  event: HostStateAppliedActionV1,
  now: number
): Promise<void> {
  if (event.outcome !== "applied" || !action.sessionId) return
  const session = await db.sessions.get(action.sessionId)
  if (
    !session &&
    action.action.kind !== "session.create" &&
    action.action.kind !== "session.import"
  ) {
    throw new HostStateStoreError("host_state_session_not_found")
  }
  switch (action.action.kind) {
    case "session.create":
      await db.sessions.add({
        id: action.sessionId,
        title: action.action.title?.trim() || "New conversation",
        titleAuto: !action.action.title,
        transcriptRevision: 0,
        createdAt: now,
        updatedAt: now,
      })
      return
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
        parts: [{ type: "text", text: turn.text }],
        createdAt: now + index,
      }))
      const seedTranscript = canonical.turns
        .map(
          (turn) =>
            `${turn.role === "assistant" ? "Assistant" : turn.role === "user" ? "User" : "System"}: ${turn.text}`
        )
        .join("\n\n")
      await db.sessions.add({
        id: action.sessionId,
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
      if (messages.length > 0) await db.messages.bulkAdd(messages)
      await db.agentCanonicalSessions.put({
        canonicalSessionId: canonical.header.canonicalSessionId,
        sourceRuntime: canonical.header.sourceRuntime,
        nativeSessionId: canonical.header.runtimeBinding?.nativeSessionId ?? "",
        ...(canonical.header.title ? { title: canonical.header.title } : {}),
        turnCount: canonical.header.turnCount,
        importFidelity: canonical.header.importFidelity,
        sequenceDigest: canonical.header.sequenceDigest,
        lossCount: 0,
        rebuilt: false,
        createdAt: Date.parse(canonical.header.createdAt) || now,
        updatedAt: Date.parse(canonical.header.updatedAt) || now,
      })
      return
    }
    case "session.rename":
      await db.sessions.update(action.sessionId, { title: action.action.title, updatedAt: now })
      return
    case "session.archive":
      await db.sessions.update(action.sessionId, {
        archivedAt: action.action.archived ? now : undefined,
        updatedAt: now,
      })
      return
    case "draft.replace":
      await db.chatDrafts.put({
        sessionId: action.sessionId,
        text: action.action.text,
        updatedAt: now,
        revision:
          event.mutation?.kind === "draft.replaced" ? event.mutation.draftRevision : undefined,
        originClientId: action.clientId,
        attachmentRefs: action.action.attachments,
        ...(action.action.attachments.length > 0 ? { attachments: action.action.attachments } : {}),
      })
      return
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
      await db.chatDrafts.delete(action.sessionId)
      await db.sessions.update(action.sessionId, {
        ...(instantTitle && isPlaceholderTitle(session?.title)
          ? { title: instantTitle, titleAuto: true }
          : {}),
        transcriptRevision:
          event.mutation?.kind === "message.queued"
            ? event.mutation.transcriptRevision
            : (session?.transcriptRevision ?? 0) + 1,
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
      if (action.action.afterMessageId) {
        keepThrough = messages.findIndex((message) => message.id === action.action.afterMessageId)
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
        ? last.parts
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

function snapshotFromRow(row: HostStateChannelRow, meta: HostStateMetaRow): HostStateSnapshotV1 {
  return {
    protocolVersion: HOST_STATE_PROTOCOL_VERSION,
    channel: row.channel,
    hostId: meta.hostId,
    hostGeneration: meta.hostGeneration,
    cutHostSeq: meta.hostSeq,
    revision: row.revision,
    digest: row.digest,
    state: row.state,
  }
}

function assertActionChannel(action: HostStateActionV1): void {
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

function actionOrigin(action: HostStateActionV1): NonNullable<HostStateAppliedActionV1["origin"]> {
  return { clientId: action.clientId, clientSeq: action.clientSeq, actionId: action.actionId }
}

function requiresMatchingRevision(action: HostStateActionV1): boolean {
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

export function hostStateActionPayloadSize(action: HostStateActionV1): number {
  return new TextEncoder().encode(canonicalHostStateJson(action)).byteLength
}
