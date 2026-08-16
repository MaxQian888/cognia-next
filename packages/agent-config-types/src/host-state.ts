/**
 * HostStateProtocolV1 — deterministic shared-session state above Agent RPC v2.
 *
 * The protocol coordinates clients; it does not replace runtime commands or
 * AgentEventEnvelope. Wire guards are deliberately closed so credentials and
 * device-local fields cannot hitch a ride in otherwise valid actions.
 */

import {
  hasOnlyKeys,
  isNonEmptyString as nonEmptyString,
  isNonNegativeInteger as nonNegativeInteger,
  isRecord,
} from "./ref-safety"

export const HOST_STATE_PROTOCOL_VERSION = 1 as const
export const HOST_STATE_SESSION_CHANNEL_PREFIX = "cognia://target/" as const

export type HostStateActionOutcomeV1 = "applied" | "duplicate" | "rejected" | "conflicted"
export type HostStateSessionStatusV1 =
  "idle" | "queued" | "running" | "awaiting_approval" | "completed" | "aborted" | "error"

export interface HostStateAttachmentRefV1 {
  name: string
  mediaType: string
  size: number
  hash?: string
}

export type AllowedHostStateIntentV1 =
  | { kind: "session.create"; title?: string }
  | { kind: "session.rename"; title: string }
  | { kind: "session.archive"; archived: boolean }
  | { kind: "draft.replace"; text: string; attachments: HostStateAttachmentRefV1[] }
  | {
      kind: "message.enqueue"
      messageId: string
      text: string
      attachments: HostStateAttachmentRefV1[]
    }
  | { kind: "turn.steer"; text: string }
  | { kind: "turn.followup"; text: string }
  | { kind: "turn.abort" }
  | {
      kind: "approval.respond"
      requestId: string
      decision: "allow" | "allow_always" | "deny"
    }
  | { kind: "elicitation.respond"; requestId: string; response: HostStateJsonValue }
  | { kind: "transcript.edit"; messageId: string; text: string }
  | { kind: "transcript.truncate"; afterMessageId?: string }
  | { kind: "session.import"; envelope: HostStateJsonValue }

export interface HostStateActionV1 {
  protocolVersion: typeof HOST_STATE_PROTOCOL_VERSION
  channel: string
  accountId: string
  runtimeTargetId: string
  hostId: string
  hostGeneration: number
  sessionId?: string
  clientId: string
  clientSeq: number
  actionId: string
  baseRevision?: number
  createdAt: number
  action: AllowedHostStateIntentV1
}

export interface HostStateQueuedMessageV1 {
  actionId: string
  messageId: string
  text: string
  attachments: HostStateAttachmentRefV1[]
  clientId: string
}

export interface HostStatePendingDecisionV1 {
  requestId: string
  label?: string
}

export interface HostStateSessionChannelV1 {
  kind: "session"
  channel: string
  sessionId: string
  revision: number
  transcriptRevision: number
  status: HostStateSessionStatusV1
  title?: string
  archived: boolean
  draft: {
    text: string
    attachments: HostStateAttachmentRefV1[]
    revision: number
  }
  queue: HostStateQueuedMessageV1[]
  activeTurn: { turnId: string; startedAt: number } | null
  pendingApprovals: HostStatePendingDecisionV1[]
  pendingElicitations: HostStatePendingDecisionV1[]
  tombstone?: { deletedAt: number; hostSeq: number }
}

export interface HostStateSessionSummaryV1 {
  sessionId: string
  title?: string
  status: HostStateSessionStatusV1
  revision: number
  transcriptRevision: number
  archived: boolean
  tombstone?: { deletedAt: number; hostSeq: number }
}

export interface HostStateSessionIndexChannelV1 {
  kind: "session-index"
  channel: string
  revision: number
  sessions: HostStateSessionSummaryV1[]
}

export type HostStateChannelStateV1 = HostStateSessionChannelV1 | HostStateSessionIndexChannelV1

export type HostStateMutationV1 =
  | { kind: "session.upserted"; session: HostStateSessionSummaryV1; revision: number }
  | { kind: "session.deleted"; sessionId: string; deletedAt: number; revision: number }
  | { kind: "session.renamed"; title: string; revision: number }
  | { kind: "session.archived"; archived: boolean; revision: number }
  | { kind: "session.status-changed"; status: HostStateSessionStatusV1; revision: number }
  | {
      kind: "draft.replaced"
      text: string
      attachments: HostStateAttachmentRefV1[]
      draftRevision: number
      revision: number
    }
  | {
      kind: "message.queued"
      message: HostStateQueuedMessageV1
      transcriptRevision: number
      draftRevision: number
      revision: number
    }
  | { kind: "message.dequeued"; actionId: string; revision: number }
  | { kind: "turn.started"; turnId: string; startedAt: number; revision: number }
  | { kind: "turn.finished"; status: HostStateSessionStatusV1; revision: number }
  | { kind: "approval.requested"; request: HostStatePendingDecisionV1; revision: number }
  | { kind: "approval.resolved"; requestId: string; revision: number }
  | { kind: "elicitation.requested"; request: HostStatePendingDecisionV1; revision: number }
  | { kind: "elicitation.resolved"; requestId: string; revision: number }
  | { kind: "transcript.revised"; transcriptRevision: number; revision: number }
  | {
      kind: "session.imported"
      title: string
      transcriptRevision: number
      revision: number
    }
  | { kind: "session.tombstoned"; deletedAt: number; hostSeq: number; revision: number }

export interface HostStateAppliedActionV1 {
  protocolVersion: typeof HOST_STATE_PROTOCOL_VERSION
  channel: string
  hostId: string
  hostGeneration: number
  hostSeq: number
  origin?: { clientId: string; clientSeq: number; actionId: string }
  outcome: HostStateActionOutcomeV1
  mutation?: HostStateMutationV1
  rejection?: { code: string; message: string; currentRevision?: number }
}

export interface HostStateSnapshotV1<
  TState extends HostStateChannelStateV1 = HostStateChannelStateV1,
> {
  protocolVersion: typeof HOST_STATE_PROTOCOL_VERSION
  channel: string
  hostId: string
  hostGeneration: number
  cutHostSeq: number
  revision: number
  digest: string
  state: TState
}

export interface HostStateSnapshotRequestV1 {
  protocolVersion: typeof HOST_STATE_PROTOCOL_VERSION
  accountId: string
  runtimeTargetId: string
  channel: string
}

export interface HostStateSubmitRequestV1 {
  protocolVersion: typeof HOST_STATE_PROTOCOL_VERSION
  accountId: string
  runtimeTargetId: string
  actions: HostStateActionV1[]
}

export interface HostStateActionReceiptV1 {
  actionId: string
  outcome: HostStateActionOutcomeV1
  hostGeneration: number
  hostSeq: number
  rejection?: HostStateAppliedActionV1["rejection"]
}

export interface HostStateSubmitResponseV1 {
  protocolVersion: typeof HOST_STATE_PROTOCOL_VERSION
  results: HostStateActionReceiptV1[]
}

export interface HostStateStatusV1 {
  protocolVersion: typeof HOST_STATE_PROTOCOL_VERSION
  hostId: string
  hostGeneration: number
  hostSeq: number
  migrationStage:
    | "legacy-authoritative"
    | "shadow"
    | "hoststate-read"
    | "hoststate-authoritative"
    | "legacy-projection-only"
    | "retired"
  leaseExpiresAt: number
  pendingDispatch: number
  pendingBroadcast: number
}

export function hostStateMigrationStageAllowsWrites(
  stage: HostStateStatusV1["migrationStage"]
): boolean {
  return ["hoststate-authoritative", "legacy-projection-only", "retired"].includes(stage)
}

export interface HostStateReplicaV1<TState extends HostStateChannelStateV1> {
  confirmed: TState
  pending: HostStateActionV1[]
  hostGeneration: number
  hostSeq: number
}

export type HostStateReplicaViewV1<TState extends HostStateChannelStateV1> =
  HostStateReplicaV1<TState> & { optimistic: TState }

export type HostStateJsonValue =
  null | boolean | number | string | HostStateJsonValue[] | { [key: string]: HostStateJsonValue }

export function sessionIndexChannel(runtimeTargetId: string): string {
  return `cognia://target/${encodeURIComponent(runtimeTargetId)}/sessions`
}

export function sessionStateChannel(runtimeTargetId: string, sessionId: string): string {
  return `${sessionIndexChannel(runtimeTargetId)}/${encodeURIComponent(sessionId)}`
}

export function createEmptyHostStateSession(
  channel: string,
  sessionId: string
): HostStateSessionChannelV1 {
  return {
    kind: "session",
    channel,
    sessionId,
    revision: 0,
    transcriptRevision: 0,
    status: "idle",
    archived: false,
    draft: { text: "", attachments: [], revision: 0 },
    queue: [],
    activeTurn: null,
    pendingApprovals: [],
    pendingElicitations: [],
  }
}

export function reduceHostStateMutation<TState extends HostStateChannelStateV1>(
  state: TState,
  mutation: HostStateMutationV1
): TState {
  if (state.kind === "session-index") {
    if (mutation.kind === "session.upserted") {
      const sessions = state.sessions.filter(
        (item) => item.sessionId !== mutation.session.sessionId
      )
      sessions.push(mutation.session)
      sessions.sort((left, right) => left.sessionId.localeCompare(right.sessionId))
      return { ...state, revision: mutation.revision, sessions } as TState
    }
    if (mutation.kind === "session.deleted") {
      const sessions = state.sessions.map((item) =>
        item.sessionId === mutation.sessionId
          ? {
              ...item,
              revision: mutation.revision,
              tombstone: { deletedAt: mutation.deletedAt, hostSeq: 0 },
            }
          : item
      )
      return { ...state, revision: mutation.revision, sessions } as TState
    }
    return state
  }

  switch (mutation.kind) {
    case "session.renamed":
      return { ...state, title: mutation.title, revision: mutation.revision } as TState
    case "session.archived":
      return { ...state, archived: mutation.archived, revision: mutation.revision } as TState
    case "session.status-changed":
      return { ...state, status: mutation.status, revision: mutation.revision } as TState
    case "draft.replaced":
      return {
        ...state,
        revision: mutation.revision,
        draft: {
          text: mutation.text,
          attachments: mutation.attachments,
          revision: mutation.draftRevision,
        },
      } as TState
    case "message.queued":
      return {
        ...state,
        revision: mutation.revision,
        transcriptRevision: mutation.transcriptRevision,
        draft: { text: "", attachments: [], revision: mutation.draftRevision },
        queue: state.queue.some((item) => item.actionId === mutation.message.actionId)
          ? state.queue
          : [...state.queue, mutation.message],
      } as TState
    case "message.dequeued":
      return {
        ...state,
        revision: mutation.revision,
        queue: state.queue.filter((item) => item.actionId !== mutation.actionId),
      } as TState
    case "turn.started":
      return {
        ...state,
        status: "running",
        revision: mutation.revision,
        activeTurn: { turnId: mutation.turnId, startedAt: mutation.startedAt },
      } as TState
    case "turn.finished":
      return {
        ...state,
        status: mutation.status,
        revision: mutation.revision,
        activeTurn: null,
      } as TState
    case "approval.requested":
      return {
        ...state,
        status: "awaiting_approval",
        revision: mutation.revision,
        pendingApprovals: upsertDecision(state.pendingApprovals, mutation.request),
      } as TState
    case "approval.resolved":
      return {
        ...state,
        revision: mutation.revision,
        pendingApprovals: state.pendingApprovals.filter(
          (item) => item.requestId !== mutation.requestId
        ),
      } as TState
    case "elicitation.requested":
      return {
        ...state,
        revision: mutation.revision,
        pendingElicitations: upsertDecision(state.pendingElicitations, mutation.request),
      } as TState
    case "elicitation.resolved":
      return {
        ...state,
        revision: mutation.revision,
        pendingElicitations: state.pendingElicitations.filter(
          (item) => item.requestId !== mutation.requestId
        ),
      } as TState
    case "transcript.revised":
      return {
        ...state,
        revision: mutation.revision,
        transcriptRevision: mutation.transcriptRevision,
      } as TState
    case "session.imported":
      return {
        ...state,
        title: mutation.title,
        transcriptRevision: mutation.transcriptRevision,
        revision: mutation.revision,
      } as TState
    case "session.tombstoned":
      return {
        ...state,
        revision: mutation.revision,
        tombstone: { deletedAt: mutation.deletedAt, hostSeq: mutation.hostSeq },
      } as TState
    case "session.upserted":
    case "session.deleted":
      return state
  }
}

export function reduceHostStateIntent<TState extends HostStateChannelStateV1>(
  state: TState,
  envelope: HostStateActionV1
): TState {
  if (state.kind !== "session") return state
  const revision = state.revision + 1
  switch (envelope.action.kind) {
    case "session.rename":
      return { ...state, title: envelope.action.title, revision } as TState
    case "session.archive":
      return { ...state, archived: envelope.action.archived, revision } as TState
    case "draft.replace":
      return {
        ...state,
        revision,
        draft: {
          text: envelope.action.text,
          attachments: envelope.action.attachments,
          revision: state.draft.revision + 1,
        },
      } as TState
    case "message.enqueue":
      return {
        ...state,
        status: state.status === "idle" ? "queued" : state.status,
        revision,
        queue: state.queue.some((item) => item.actionId === envelope.actionId)
          ? state.queue
          : [
              ...state.queue,
              {
                actionId: envelope.actionId,
                messageId: envelope.action.messageId,
                text: envelope.action.text,
                attachments: envelope.action.attachments,
                clientId: envelope.clientId,
              },
            ],
      } as TState
    case "turn.abort":
      return { ...state, status: "aborted", activeTurn: null, revision } as TState
    case "session.create":
    case "turn.steer":
    case "turn.followup":
    case "approval.respond":
    case "elicitation.respond":
    case "transcript.edit":
    case "transcript.truncate":
    case "session.import":
      return state
  }
}

export function reconcileHostStateReplica<TState extends HostStateChannelStateV1>(
  replica: HostStateReplicaV1<TState>,
  event: HostStateAppliedActionV1
): HostStateReplicaViewV1<TState> {
  if (event.hostGeneration < replica.hostGeneration) throw new Error("stale_host_generation")
  if (event.hostGeneration > replica.hostGeneration) throw new Error("host_state_resync_required")
  if (event.hostSeq !== replica.hostSeq + 1) throw new Error("host_state_sequence_gap")
  if (event.channel !== replica.confirmed.channel) throw new Error("host_state_channel_mismatch")

  const confirmed = event.mutation
    ? reduceHostStateMutation(replica.confirmed, event.mutation)
    : replica.confirmed
  const pending = event.origin
    ? replica.pending.filter((item) => item.actionId !== event.origin?.actionId)
    : replica.pending
  const optimistic = pending.reduce(
    (state, pendingAction) => reduceHostStateIntent(state, pendingAction),
    confirmed
  )
  return {
    confirmed,
    pending,
    optimistic,
    hostGeneration: replica.hostGeneration,
    hostSeq: event.hostSeq,
  }
}

export function canonicalHostStateJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function hostStateDigest(value: unknown): string {
  const bytes = new TextEncoder().encode(canonicalHostStateJson(value))
  let hash = BigInt("14695981039346656037")
  for (const byte of bytes) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * BigInt("1099511628211"))
  }
  return `hsv1-${hash.toString(16).padStart(16, "0")}`
}

export function isHostStateActionV1(value: unknown): value is HostStateActionV1 {
  if (!isRecord(value)) return false
  if (
    !hasOnlyKeys(value, [
      "protocolVersion",
      "channel",
      "accountId",
      "runtimeTargetId",
      "hostId",
      "hostGeneration",
      "sessionId",
      "clientId",
      "clientSeq",
      "actionId",
      "baseRevision",
      "createdAt",
      "action",
    ]) ||
    value.protocolVersion !== HOST_STATE_PROTOCOL_VERSION ||
    !nonEmptyString(value.channel) ||
    !nonEmptyString(value.accountId) ||
    !nonEmptyString(value.runtimeTargetId) ||
    !nonEmptyString(value.hostId) ||
    !nonNegativeInteger(value.hostGeneration) ||
    (value.sessionId !== undefined && !nonEmptyString(value.sessionId)) ||
    !nonEmptyString(value.clientId) ||
    !nonNegativeInteger(value.clientSeq) ||
    !nonEmptyString(value.actionId) ||
    (value.baseRevision !== undefined && !nonNegativeInteger(value.baseRevision)) ||
    !nonNegativeInteger(value.createdAt)
  ) {
    return false
  }
  return isAllowedIntent(value.action)
}

export function isHostStateAppliedActionV1(value: unknown): value is HostStateAppliedActionV1 {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "protocolVersion",
      "channel",
      "hostId",
      "hostGeneration",
      "hostSeq",
      "origin",
      "outcome",
      "mutation",
      "rejection",
    ]) ||
    value.protocolVersion !== HOST_STATE_PROTOCOL_VERSION ||
    !nonEmptyString(value.channel) ||
    !nonEmptyString(value.hostId) ||
    !nonNegativeInteger(value.hostGeneration) ||
    !nonNegativeInteger(value.hostSeq) ||
    !["applied", "duplicate", "rejected", "conflicted"].includes(String(value.outcome))
  ) {
    return false
  }
  if (
    value.origin !== undefined &&
    (!isRecord(value.origin) ||
      !hasOnlyKeys(value.origin, ["clientId", "clientSeq", "actionId"]) ||
      !nonEmptyString(value.origin.clientId) ||
      !nonNegativeInteger(value.origin.clientSeq) ||
      !nonEmptyString(value.origin.actionId))
  ) {
    return false
  }
  if (value.mutation !== undefined && !isHostStateMutationV1(value.mutation)) return false
  return value.rejection === undefined || isHostStateRejection(value.rejection)
}

export function isHostStateSnapshotV1(value: unknown): value is HostStateSnapshotV1 {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "protocolVersion",
      "channel",
      "hostId",
      "hostGeneration",
      "cutHostSeq",
      "revision",
      "digest",
      "state",
    ]) &&
    value.protocolVersion === HOST_STATE_PROTOCOL_VERSION &&
    nonEmptyString(value.channel) &&
    nonEmptyString(value.hostId) &&
    nonNegativeInteger(value.hostGeneration) &&
    nonNegativeInteger(value.cutHostSeq) &&
    nonNegativeInteger(value.revision) &&
    nonEmptyString(value.digest) &&
    isHostStateChannelStateV1(value.state) &&
    value.state.channel === value.channel &&
    value.state.revision === value.revision &&
    value.digest === hostStateDigest(value.state)
  )
}

export function isHostStateSubmitResponseV1(value: unknown): value is HostStateSubmitResponseV1 {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["protocolVersion", "results"]) &&
    value.protocolVersion === HOST_STATE_PROTOCOL_VERSION &&
    Array.isArray(value.results) &&
    value.results.every(isHostStateReceipt)
  )
}

export function isHostStateStatusV1(value: unknown): value is HostStateStatusV1 {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "protocolVersion",
      "hostId",
      "hostGeneration",
      "hostSeq",
      "migrationStage",
      "leaseExpiresAt",
      "pendingDispatch",
      "pendingBroadcast",
    ]) &&
    value.protocolVersion === HOST_STATE_PROTOCOL_VERSION &&
    nonEmptyString(value.hostId) &&
    nonNegativeInteger(value.hostGeneration) &&
    nonNegativeInteger(value.hostSeq) &&
    [
      "legacy-authoritative",
      "shadow",
      "hoststate-read",
      "hoststate-authoritative",
      "legacy-projection-only",
      "retired",
    ].includes(String(value.migrationStage)) &&
    nonNegativeInteger(value.leaseExpiresAt) &&
    nonNegativeInteger(value.pendingDispatch) &&
    nonNegativeInteger(value.pendingBroadcast)
  )
}

function isHostStateChannelStateV1(value: unknown): value is HostStateChannelStateV1 {
  if (!isRecord(value) || !nonEmptyString(value.kind)) return false
  if (value.kind === "session-index") {
    return (
      hasOnlyKeys(value, ["kind", "channel", "revision", "sessions"]) &&
      nonEmptyString(value.channel) &&
      nonNegativeInteger(value.revision) &&
      Array.isArray(value.sessions) &&
      value.sessions.every(isSessionSummary)
    )
  }
  return (
    value.kind === "session" &&
    hasOnlyKeys(value, [
      "kind",
      "channel",
      "sessionId",
      "revision",
      "transcriptRevision",
      "status",
      "title",
      "archived",
      "draft",
      "queue",
      "activeTurn",
      "pendingApprovals",
      "pendingElicitations",
      "tombstone",
    ]) &&
    nonEmptyString(value.channel) &&
    nonEmptyString(value.sessionId) &&
    nonNegativeInteger(value.revision) &&
    nonNegativeInteger(value.transcriptRevision) &&
    isSessionStatus(value.status) &&
    (value.title === undefined || typeof value.title === "string") &&
    typeof value.archived === "boolean" &&
    isRecord(value.draft) &&
    hasOnlyKeys(value.draft, ["text", "attachments", "revision"]) &&
    typeof value.draft.text === "string" &&
    isAttachmentList(value.draft.attachments) &&
    nonNegativeInteger(value.draft.revision) &&
    Array.isArray(value.queue) &&
    value.queue.every(isQueuedMessage) &&
    (value.activeTurn === null || isActiveTurn(value.activeTurn)) &&
    Array.isArray(value.pendingApprovals) &&
    value.pendingApprovals.every(isPendingDecision) &&
    Array.isArray(value.pendingElicitations) &&
    value.pendingElicitations.every(isPendingDecision) &&
    (value.tombstone === undefined || isTombstone(value.tombstone))
  )
}

function isHostStateMutationV1(value: unknown): value is HostStateMutationV1 {
  if (!isRecord(value) || !nonEmptyString(value.kind) || !nonNegativeInteger(value.revision)) {
    return false
  }
  switch (value.kind) {
    case "session.upserted":
      return hasOnlyKeys(value, ["kind", "session", "revision"]) && isSessionSummary(value.session)
    case "session.deleted":
      return (
        hasOnlyKeys(value, ["kind", "sessionId", "deletedAt", "revision"]) &&
        nonEmptyString(value.sessionId) &&
        nonNegativeInteger(value.deletedAt)
      )
    case "session.renamed":
      return hasOnlyKeys(value, ["kind", "title", "revision"]) && typeof value.title === "string"
    case "session.archived":
      return (
        hasOnlyKeys(value, ["kind", "archived", "revision"]) && typeof value.archived === "boolean"
      )
    case "session.status-changed":
      return hasOnlyKeys(value, ["kind", "status", "revision"]) && isSessionStatus(value.status)
    case "draft.replaced":
      return (
        hasOnlyKeys(value, ["kind", "text", "attachments", "draftRevision", "revision"]) &&
        typeof value.text === "string" &&
        isAttachmentList(value.attachments) &&
        nonNegativeInteger(value.draftRevision)
      )
    case "message.queued":
      return (
        hasOnlyKeys(value, [
          "kind",
          "message",
          "transcriptRevision",
          "draftRevision",
          "revision",
        ]) &&
        isQueuedMessage(value.message) &&
        nonNegativeInteger(value.transcriptRevision) &&
        nonNegativeInteger(value.draftRevision)
      )
    case "message.dequeued":
      return hasOnlyKeys(value, ["kind", "actionId", "revision"]) && nonEmptyString(value.actionId)
    case "turn.started":
      return (
        hasOnlyKeys(value, ["kind", "turnId", "startedAt", "revision"]) &&
        nonEmptyString(value.turnId) &&
        nonNegativeInteger(value.startedAt)
      )
    case "turn.finished":
      return hasOnlyKeys(value, ["kind", "status", "revision"]) && isSessionStatus(value.status)
    case "approval.requested":
    case "elicitation.requested":
      return hasOnlyKeys(value, ["kind", "request", "revision"]) && isPendingDecision(value.request)
    case "approval.resolved":
    case "elicitation.resolved":
      return (
        hasOnlyKeys(value, ["kind", "requestId", "revision"]) && nonEmptyString(value.requestId)
      )
    case "transcript.revised":
      return (
        hasOnlyKeys(value, ["kind", "transcriptRevision", "revision"]) &&
        nonNegativeInteger(value.transcriptRevision)
      )
    case "session.imported":
      return (
        hasOnlyKeys(value, ["kind", "title", "transcriptRevision", "revision"]) &&
        typeof value.title === "string" &&
        nonNegativeInteger(value.transcriptRevision)
      )
    case "session.tombstoned":
      return (
        hasOnlyKeys(value, ["kind", "deletedAt", "hostSeq", "revision"]) &&
        nonNegativeInteger(value.deletedAt) &&
        nonNegativeInteger(value.hostSeq)
      )
    default:
      return false
  }
}

function isAllowedIntent(value: unknown): value is AllowedHostStateIntentV1 {
  if (!isRecord(value) || !nonEmptyString(value.kind)) return false
  switch (value.kind) {
    case "session.create":
      return (
        hasOnlyKeys(value, ["kind", "title"]) &&
        (value.title === undefined || typeof value.title === "string")
      )
    case "session.rename":
      return hasOnlyKeys(value, ["kind", "title"]) && typeof value.title === "string"
    case "session.archive":
      return hasOnlyKeys(value, ["kind", "archived"]) && typeof value.archived === "boolean"
    case "draft.replace":
      return (
        hasOnlyKeys(value, ["kind", "text", "attachments"]) &&
        typeof value.text === "string" &&
        isAttachmentList(value.attachments)
      )
    case "message.enqueue":
      return (
        hasOnlyKeys(value, ["kind", "messageId", "text", "attachments"]) &&
        nonEmptyString(value.messageId) &&
        typeof value.text === "string" &&
        isAttachmentList(value.attachments)
      )
    case "turn.steer":
    case "turn.followup":
      return hasOnlyKeys(value, ["kind", "text"]) && typeof value.text === "string"
    case "turn.abort":
      return hasOnlyKeys(value, ["kind"])
    case "approval.respond":
      return (
        hasOnlyKeys(value, ["kind", "requestId", "decision"]) &&
        nonEmptyString(value.requestId) &&
        ["allow", "allow_always", "deny"].includes(String(value.decision))
      )
    case "elicitation.respond":
      return (
        hasOnlyKeys(value, ["kind", "requestId", "response"]) &&
        nonEmptyString(value.requestId) &&
        isJsonValue(value.response)
      )
    case "transcript.edit":
      return (
        hasOnlyKeys(value, ["kind", "messageId", "text"]) &&
        nonEmptyString(value.messageId) &&
        typeof value.text === "string"
      )
    case "transcript.truncate":
      return (
        hasOnlyKeys(value, ["kind", "afterMessageId"]) &&
        (value.afterMessageId === undefined || nonEmptyString(value.afterMessageId))
      )
    case "session.import":
      return hasOnlyKeys(value, ["kind", "envelope"]) && isJsonValue(value.envelope)
    default:
      return false
  }
}

function isHostStateReceipt(value: unknown): value is HostStateActionReceiptV1 {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["actionId", "outcome", "hostGeneration", "hostSeq", "rejection"]) &&
    nonEmptyString(value.actionId) &&
    ["applied", "duplicate", "rejected", "conflicted"].includes(String(value.outcome)) &&
    nonNegativeInteger(value.hostGeneration) &&
    nonNegativeInteger(value.hostSeq) &&
    (value.rejection === undefined || isHostStateRejection(value.rejection))
  )
}

function isHostStateRejection(
  value: unknown
): value is NonNullable<HostStateAppliedActionV1["rejection"]> {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["code", "message", "currentRevision"]) &&
    nonEmptyString(value.code) &&
    typeof value.message === "string" &&
    (value.currentRevision === undefined || nonNegativeInteger(value.currentRevision))
  )
}

function isSessionStatus(value: unknown): value is HostStateSessionStatusV1 {
  return [
    "idle",
    "queued",
    "running",
    "awaiting_approval",
    "completed",
    "aborted",
    "error",
  ].includes(String(value))
}

function isQueuedMessage(value: unknown): value is HostStateQueuedMessageV1 {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["actionId", "messageId", "text", "attachments", "clientId"]) &&
    nonEmptyString(value.actionId) &&
    nonEmptyString(value.messageId) &&
    typeof value.text === "string" &&
    isAttachmentList(value.attachments) &&
    nonEmptyString(value.clientId)
  )
}

function isPendingDecision(value: unknown): value is HostStatePendingDecisionV1 {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["requestId", "label"]) &&
    nonEmptyString(value.requestId) &&
    (value.label === undefined || typeof value.label === "string")
  )
}

function isSessionSummary(value: unknown): value is HostStateSessionSummaryV1 {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "sessionId",
      "title",
      "status",
      "revision",
      "transcriptRevision",
      "archived",
      "tombstone",
    ]) &&
    nonEmptyString(value.sessionId) &&
    (value.title === undefined || typeof value.title === "string") &&
    isSessionStatus(value.status) &&
    nonNegativeInteger(value.revision) &&
    nonNegativeInteger(value.transcriptRevision) &&
    typeof value.archived === "boolean" &&
    (value.tombstone === undefined || isTombstone(value.tombstone))
  )
}

function isTombstone(value: unknown): value is { deletedAt: number; hostSeq: number } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["deletedAt", "hostSeq"]) &&
    nonNegativeInteger(value.deletedAt) &&
    nonNegativeInteger(value.hostSeq)
  )
}

function isActiveTurn(value: unknown): value is { turnId: string; startedAt: number } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["turnId", "startedAt"]) &&
    nonEmptyString(value.turnId) &&
    nonNegativeInteger(value.startedAt)
  )
}

function isAttachmentList(value: unknown): value is HostStateAttachmentRefV1[] {
  return Array.isArray(value) && value.every(isAttachment)
}

function isAttachment(value: unknown): value is HostStateAttachmentRefV1 {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["name", "mediaType", "size", "hash"]) &&
    nonEmptyString(value.name) &&
    nonEmptyString(value.mediaType) &&
    nonNegativeInteger(value.size) &&
    (value.hash === undefined || nonEmptyString(value.hash))
  )
}

function isJsonValue(value: unknown): value is HostStateJsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true
  }
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

function canonicalize(value: unknown): HostStateJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("HostState canonical JSON requires finite numbers")
    return Object.is(value, -0) ? 0 : value
  }
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!isRecord(value)) throw new Error("HostState canonical JSON accepts JSON values only")
  return Object.keys(value)
    .sort()
    .reduce<Record<string, HostStateJsonValue>>((result, key) => {
      const item = value[key]
      if (item !== undefined) result[key] = canonicalize(item)
      return result
    }, {})
}

function upsertDecision(
  decisions: HostStatePendingDecisionV1[],
  request: HostStatePendingDecisionV1
): HostStatePendingDecisionV1[] {
  return [...decisions.filter((item) => item.requestId !== request.requestId), request]
}
