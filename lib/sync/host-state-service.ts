import {
  HOST_STATE_PROTOCOL_VERSION,
  canonicalHostStateJson,
  hostStateDigest,
  hostStateMigrationStageAllowsWrites,
  isHostStateActionV1,
  isHostStateAppliedActionV1,
  isHostStateSnapshotV1,
  isHostStateStatusV1,
  reduceHostStateIntent,
  type HostStateActionReceiptV1,
  type HostStateActionV1,
  type HostStateAppliedActionV1,
  type HostStateChannelStateV1,
  type HostStateMutationV1,
  type HostStateSnapshotRequestV1,
  type HostStateSnapshotV1,
  type HostStateStatusV1,
  type HostStateSubmitRequestV1,
  type HostStateSubmitResponseV1,
} from "@cognia/agent-config-types/host-state"
import { reduceHostStateMutation } from "@cognia/agent-config-types/host-state"
import { sessionIndexChannel, sessionStateChannel } from "@cognia/agent-config-types/host-state"
import type { Transport } from "@/lib/tauri/transport-types"
import { loggers } from "@cognia/logging"
import type { AgentEventEnvelope } from "@cognia/agent-config-types/agent-execution"
import { isCanonicalSession } from "@cognia/agent-config-types/canonical-session"
import type { StoredMessage } from "@cognia/agent-config-types"
import { getDb } from "@/lib/db/schema"

import {
  HOST_STATE_LEASE_HEARTBEAT_MS,
  acquireHostStateLease,
  commitHostStateAction,
  commitHostStateRuntimeProjection,
  getHostStateAction,
  getHostStateMeta,
  getHostStateSnapshot,
  hostStateActionPayloadSize,
  listPendingHostStateActions,
  markHostStateBroadcast,
  markHostStateDispatch,
  markHostStateSummary,
  renewHostStateLease,
  setHostStateMigrationStage,
  validateHostStateBusinessAction,
  type HostStateActionRow,
  type HostStateMigrationStage,
} from "./host-state-store"

export const HOST_STATE_ACTION_TOPIC = "host-state://action"
export const MAX_HOST_STATE_SNAPSHOT_BYTES = 512 * 1024
export const MAX_HOST_STATE_ACTION_BATCH = 50
/** Backlog ceiling while a client is not `ready`. See `bufferEvent`. */
export const MAX_BUFFERED_HOST_STATE_EVENTS = 2_000

export interface HostStateRuntimeDispatchResult {
  correlationId?: string
}

export type HostStateRuntimeDispatcher = (
  action: HostStateActionV1
) => Promise<HostStateRuntimeDispatchResult | void>

interface AgentRpcHostStateDispatcherDependencies {
  sendMessage?: (sessionId: string, text: string, actionId: string) => Promise<void>
  steer?: (
    sessionId: string,
    text: string,
    priority: "now" | "next",
    actionId: string
  ) => Promise<void>
  abort?: (sessionId: string, actionId: string) => Promise<void>
  resolveApproval?: (
    sessionId: string,
    requestId: string,
    decision: "allow" | "allow_always" | "deny",
    actionId: string
  ) => Promise<void>
  resolveElicitation?: (sessionId: string, requestId: string, response: unknown) => Promise<void>
}

/**
 * Adapter from HostState intents into the existing Agent RPC v2 command set.
 * The Host action id is always reused as the runtime command id so recovery
 * after a ledger commit cannot execute the same turn or decision twice.
 */
export function createAgentRpcHostStateDispatcher(
  dependencies: AgentRpcHostStateDispatcherDependencies = {}
): HostStateRuntimeDispatcher {
  return async (action) => {
    const sessionId = action.sessionId
    if (!sessionId) throw new Error("host_state_session_id_required")
    switch (action.action.kind) {
      case "message.enqueue": {
        if (dependencies.sendMessage) {
          await dependencies.sendMessage(sessionId, action.action.text, action.actionId)
        } else {
          const [{ getSession }, { buildSendOptions }, { sendPrompt }] = await Promise.all([
            import("@/lib/db/sessions"),
            import("@/hooks/chat/claude-chat-send-options"),
            import("@/lib/claude/ipc"),
          ])
          const session = await getSession(sessionId)
          if (!session) throw new Error("host_state_session_not_found")
          const options = await buildSendOptions(session, action.action.text)
          await sendPrompt(sessionId, action.action.text, options, { commandId: action.actionId })
        }
        break
      }
      case "turn.steer":
      case "turn.followup": {
        const priority = action.action.kind === "turn.steer" ? "now" : "next"
        if (dependencies.steer) {
          await dependencies.steer(sessionId, action.action.text, priority, action.actionId)
        } else {
          const { steerSession } = await import("@/lib/claude/ipc")
          await steerSession(sessionId, action.action.text, undefined, {
            priority,
            commandId: action.actionId,
          })
        }
        break
      }
      case "turn.abort":
        if (dependencies.abort) {
          await dependencies.abort(sessionId, action.actionId)
        } else {
          const { interruptSession } = await import("@/lib/claude/ipc")
          await interruptSession(sessionId, { commandId: action.actionId })
        }
        break
      case "approval.respond":
        if (dependencies.resolveApproval) {
          await dependencies.resolveApproval(
            sessionId,
            action.action.requestId,
            action.action.decision,
            action.actionId
          )
        } else {
          const { transport } = await import("@/lib/tauri")
          await transport.call("agent_resolve_permission", {
            sessionId,
            requestId: action.action.requestId,
            decision: action.action.decision,
            commandId: action.actionId,
          })
        }
        break
      case "elicitation.respond":
        if (dependencies.resolveElicitation) {
          await dependencies.resolveElicitation(
            sessionId,
            action.action.requestId,
            action.action.response
          )
        } else {
          const { useAskUserStore } = await import("@/stores/agent/ask-user-store")
          const state = useAskUserStore.getState()
          if (
            !state.active ||
            state.active.id !== action.action.requestId ||
            state.active.sessionId !== sessionId
          ) {
            throw new Error("host_state_elicitation_not_pending")
          }
          state.resolveActive(action.action.response as never)
        }
        break
      default:
        throw new Error("host_state_runtime_action_not_required")
    }
    return { correlationId: action.actionId }
  }
}

export interface HostStateServiceOptions {
  accountId: string
  runtimeTargetId: string
  hostId: string
  ownerId: string
  now?: () => number
  dispatchRuntime?: (action: HostStateActionV1) => Promise<HostStateRuntimeDispatchResult | void>
  publish?: (
    topic: typeof HOST_STATE_ACTION_TOPIC,
    event: HostStateAppliedActionV1
  ) => Promise<void>
  maxSnapshotBytes?: number
  maxActionBatch?: number
}

export interface HostStateService {
  start(options?: {
    now?: number
    heartbeat?: boolean
    migrationStage?: HostStateMigrationStage
  }): Promise<HostStateStatusV1>
  stop(): Promise<void>
  snapshot(request: HostStateSnapshotRequestV1): Promise<HostStateSnapshotV1>
  submit(request: HostStateSubmitRequestV1): Promise<HostStateSubmitResponseV1>
  status(): Promise<HostStateStatusV1>
  recover(): Promise<{ dispatched: number; broadcast: number }>
  projectRuntimeEnvelope(envelope: AgentEventEnvelope): Promise<HostStateAppliedActionV1 | null>
}

export interface InstalledHostStateSync {
  status: HostStateStatusV1
  resync(): Promise<void>
  stop(): void
}

export function hostStateStatusAllowsWrites(status: HostStateStatusV1): boolean {
  return hostStateMigrationStageAllowsWrites(status.migrationStage)
}

/**
 * Existing-Transport client bootstrap. It subscribes before snapshotting,
 * buffers the shared carrier stream, then applies only events newer than the
 * per-channel snapshot cut.
 */
export async function installHostStateSync(options: {
  transport: Transport
  accountId: string
  runtimeTargetId: string
  channels: () => Promise<string[]>
  onState?: (state: HostStateChannelStateV1) => void
}): Promise<InstalledHostStateSync> {
  let stopped = false
  let ready = false
  let lastHostSeq = 0
  let hostGeneration = 0
  let applying = Promise.resolve()
  const buffered: HostStateAppliedActionV1[] = []
  const cuts = new Map<string, number>()

  const unsubscribe = options.transport.subscribe<unknown>(HOST_STATE_ACTION_TOPIC, (event) => {
    if (stopped) return
    if (!isHostStateAppliedActionV1(event)) {
      applying = applying
        .then(() => Promise.reject(new Error("host_state_event_malformed")))
        .catch(recoverFromApplyFailure)
      return
    }
    if (!ready) {
      bufferEvent(event)
      return
    }
    // The chain must never settle rejected: a rejected `applying` short-
    // circuits every later `.then`, which would silently stop applying
    // events forever AND make `resync()` (which awaits it) rethrow.
    applying = applying.then(() => applyEvent(event)).catch(recoverFromApplyFailure)
  })

  /**
   * While `!ready` the socket keeps producing events. Cap the backlog so a
   * recovery that never succeeds cannot grow it without bound — `takeSnapshots`
   * establishes a fresh cut anyway, so dropping the buffer is always safe.
   */
  function bufferEvent(event: HostStateAppliedActionV1): void {
    if (buffered.length >= MAX_BUFFERED_HOST_STATE_EVENTS) buffered.length = 0
    buffered.push(event)
  }

  const takeSnapshots = async (): Promise<void> => {
    const channels = [...new Set(await options.channels())]
    if (channels.length === 0) return
    const snapshots: HostStateSnapshotV1[] = []
    for (const channel of channels) {
      const snapshot = await takeChannelSnapshot(channel)
      snapshots.push(snapshot)
    }
    hostGeneration = snapshots[0]?.hostGeneration ?? hostGeneration
    lastHostSeq = Math.min(...snapshots.map((snapshot) => snapshot.cutHostSeq))
  }

  const applyEvent = async (event: HostStateAppliedActionV1): Promise<void> => {
    if (event.hostGeneration < hostGeneration) return
    if (event.hostGeneration > hostGeneration) throw new Error("host_state_generation_reset")
    if (event.hostSeq <= lastHostSeq) return
    if (event.hostSeq !== lastHostSeq + 1) throw new Error("host_state_sequence_gap")
    lastHostSeq = event.hostSeq
    const cut = cuts.get(event.channel)
    if (cut === undefined || event.hostSeq <= cut || !event.mutation) return
    const { getDb } = await import("@/lib/db/schema")
    const current = await getDb().hostStateChannels.get(event.channel)
    if (!current) throw new Error("host_state_channel_missing")
    const state = reduceHostStateMutation(current.state, event.mutation)
    const visibleState = await persistConfirmedState(
      state,
      event.hostId,
      event.hostGeneration,
      event.hostSeq
    )
    cuts.set(event.channel, event.hostSeq)
    options.onState?.(visibleState)
    if (event.mutation.kind === "session.upserted" && !event.mutation.session.tombstone) {
      const sessionChannel = sessionStateChannel(
        options.runtimeTargetId,
        event.mutation.session.sessionId
      )
      if (!cuts.has(sessionChannel)) await takeChannelSnapshot(sessionChannel)
    }
  }

  const takeChannelSnapshot = async (channel: string): Promise<HostStateSnapshotV1> => {
    const snapshot = await options.transport.call<HostStateSnapshotV1>("host_state_snapshot", {
      protocolVersion: HOST_STATE_PROTOCOL_VERSION,
      accountId: options.accountId,
      runtimeTargetId: options.runtimeTargetId,
      channel,
    })
    if (!isHostStateSnapshotV1(snapshot)) throw new Error("host_state_snapshot_malformed")
    cuts.set(channel, snapshot.cutHostSeq)
    const visibleState = await persistConfirmedState(
      snapshot.state,
      snapshot.hostId,
      snapshot.hostGeneration,
      snapshot.cutHostSeq
    )
    options.onState?.(visibleState)
    return snapshot
  }

  /** Re-cut from authoritative snapshots, then replay whatever queued up. */
  const resyncNow = async (): Promise<void> => {
    ready = false
    await takeSnapshots()
    ready = true
    const pending = buffered.slice().sort((left, right) => left.hostSeq - right.hostSeq)
    buffered.length = 0
    for (const event of pending) {
      await applyEvent(event)
    }
  }

  /**
   * A sequence gap or a Host generation reset means our projection is no longer
   * trustworthy, not that the stream is over. Drop back to `!ready` and re-cut;
   * if that also fails we stay `!ready` so the caller's `resync()` — or the next
   * reconnect — retries, instead of the stream going permanently silent.
   */
  async function recoverFromApplyFailure(error: unknown): Promise<void> {
    if (stopped) return
    ready = false
    buffered.length = 0
    loggers.sync.warn("[host-state] applying a broadcast event failed; re-snapshotting", {
      error: error instanceof Error ? error.message : String(error),
    })
    try {
      await resyncNow()
    } catch (resyncError) {
      ready = false
      loggers.sync.warn("[host-state] recovery snapshot failed; awaiting the next resync", {
        error: resyncError instanceof Error ? resyncError.message : String(resyncError),
      })
    }
  }

  try {
    await resyncNow()
  } catch (error) {
    stopped = true
    unsubscribe()
    throw error
  }

  let status: HostStateStatusV1
  try {
    const value = await options.transport.call<unknown>("host_state_status", {
      protocolVersion: HOST_STATE_PROTOCOL_VERSION,
      accountId: options.accountId,
      runtimeTargetId: options.runtimeTargetId,
    })
    if (!isHostStateStatusV1(value)) throw new Error("host_state_status_malformed")
    status = value
  } catch (error) {
    stopped = true
    unsubscribe()
    throw error
  }

  return {
    status,
    async resync() {
      if (stopped) return
      ready = false
      // `applying` is rejection-free by construction, so this cannot throw and
      // cannot strand the caller.
      await applying
      await resyncNow()
    },
    stop() {
      if (stopped) return
      stopped = true
      unsubscribe()
    },
  }
}

export async function installHostStateSyncForTarget(options: {
  transport: Transport
  accountId: string
  runtimeTargetId: string
  onState?: (state: HostStateChannelStateV1) => void
}): Promise<InstalledHostStateSync> {
  return installHostStateSync({
    ...options,
    channels: async () => {
      const { getDb } = await import("@/lib/db/schema")
      const sessionIds = await getDb().sessions.toCollection().primaryKeys()
      return [
        sessionIndexChannel(options.runtimeTargetId),
        ...sessionIds.map((sessionId) =>
          sessionStateChannel(options.runtimeTargetId, String(sessionId))
        ),
      ]
    },
  })
}

async function persistConfirmedState(
  state: HostStateChannelStateV1,
  hostId: string,
  hostGeneration: number,
  hostSeq: number
): Promise<HostStateChannelStateV1> {
  const { getDb } = await import("@/lib/db/schema")
  const db = getDb()
  await db.hostStateChannels.put({
    channel: state.channel,
    hostId,
    hostGeneration,
    hostSeq,
    revision: state.revision,
    digest: hostStateDigest(state),
    state,
    updatedAt: Date.now(),
  })
  if (state.kind === "session-index") {
    for (const summary of state.sessions) {
      if (summary.tombstone) {
        await Promise.all([
          db.sessions.delete(summary.sessionId),
          db.messages.where("sessionId").equals(summary.sessionId).delete(),
          db.chatDrafts.delete(summary.sessionId),
        ])
        continue
      }
      const existing = await db.sessions.get(summary.sessionId)
      await db.sessions.put({
        ...(existing ?? {
          id: summary.sessionId,
          title: summary.title ?? "New conversation",
          titleAuto: !summary.title,
          createdAt: Date.now(),
        }),
        ...(summary.title ? { title: summary.title } : {}),
        transcriptRevision: summary.transcriptRevision,
        archivedAt: summary.archived ? (existing?.archivedAt ?? Date.now()) : undefined,
        updatedAt: Date.now(),
      })
    }
    return state
  }
  const optimisticState = await projectPendingHostStateActions(state)
  const existingDraft = await db.chatDrafts.get(state.sessionId)
  const attachments = optimisticState.draft.attachments.map((reference) => {
    const local = existingDraft?.attachments?.find(
      (candidate) =>
        candidate.name === reference.name &&
        candidate.mediaType === reference.mediaType &&
        candidate.size === reference.size
    )
    return local ? { ...reference, ...local } : reference
  })
  await Promise.all([
    db.sessions.update(state.sessionId, {
      ...(optimisticState.title ? { title: optimisticState.title } : {}),
      archivedAt: optimisticState.archived ? Date.now() : undefined,
      updatedAt: Date.now(),
    }),
    db.chatDrafts.put({
      sessionId: state.sessionId,
      text: optimisticState.draft.text,
      updatedAt: Date.now(),
      revision: optimisticState.draft.revision,
      attachmentRefs: optimisticState.draft.attachments,
      ...(attachments.length > 0 ? { attachments } : {}),
    }),
  ])
  await materializeOptimisticMessages(optimisticState)
  const { useChatStore } = await import("@/stores/chat/chat-store")
  const status =
    optimisticState.status === "running" || optimisticState.status === "queued"
      ? "streaming"
      : optimisticState.status === "awaiting_approval"
        ? "awaiting_approval"
        : optimisticState.status === "error"
          ? "error"
          : "idle"
  useChatStore.getState().setSessionStatus(state.sessionId, status)
  return optimisticState
}

async function projectPendingHostStateActions(
  confirmed: Extract<HostStateChannelStateV1, { kind: "session" }>
): Promise<Extract<HostStateChannelStateV1, { kind: "session" }>> {
  const rows = await getDb()
    .mobileOutboundQueue.filter(
      (row) =>
        row.protocol === "host-state-v1" &&
        row.channel === confirmed.channel &&
        ["pending", "sending", "failed"].includes(row.status)
    )
    .toArray()
  const actions = rows
    .sort((left, right) => (left.clientSeq ?? 0) - (right.clientSeq ?? 0))
    .flatMap((row) => {
      const payloadActions = (row.payload as { actions?: unknown }).actions
      if (!Array.isArray(payloadActions) || payloadActions.length !== 1) return []
      return isHostStateActionV1(payloadActions[0]) ? [payloadActions[0]] : []
    })
  return actions.reduce((projected, action) => reduceHostStateIntent(projected, action), confirmed)
}

async function materializeOptimisticMessages(
  state: Extract<HostStateChannelStateV1, { kind: "session" }>
): Promise<void> {
  const db = getDb()
  for (const queued of state.queue) {
    if (await db.messages.get(queued.messageId)) continue
    const session = await db.sessions.get(state.sessionId)
    const message: StoredMessage = {
      id: queued.messageId,
      sessionId: state.sessionId,
      ...(session?.projectId ? { projectId: session.projectId } : {}),
      role: "user",
      parts: [{ type: "text", text: queued.text }],
      metadata: {
        hostState: {
          actionId: queued.actionId,
          clientId: queued.clientId,
          attachmentRefs: queued.attachments,
          optimistic: true,
        },
      },
      createdAt: Date.now(),
    }
    await db.messages.put(message)
  }

  const terminalRows = await db.mobileOutboundQueue
    .where("status")
    .anyOf("rejected", "conflicted")
    .filter((row) => row.protocol === "host-state-v1" && row.channel === state.channel)
    .toArray()
  for (const row of terminalRows) {
    const actions = (row.payload as { actions?: unknown }).actions
    const action = Array.isArray(actions) && actions.length === 1 ? actions[0] : undefined
    if (!isHostStateActionV1(action) || action.action.kind !== "message.enqueue") continue
    const message = await db.messages.get(action.action.messageId)
    const metadata = message?.metadata?.hostState as
      { actionId?: unknown; optimistic?: unknown } | undefined
    if (metadata?.actionId === action.actionId && metadata.optimistic === true) {
      await db.messages.delete(action.action.messageId)
    }
  }
}

export function createHostStateService(options: HostStateServiceOptions): HostStateService {
  const now = options.now ?? Date.now
  const maxSnapshotBytes = options.maxSnapshotBytes ?? MAX_HOST_STATE_SNAPSHOT_BYTES
  const maxActionBatch = options.maxActionBatch ?? MAX_HOST_STATE_ACTION_BATCH
  let generation: number | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null

  const assertRequestScope = (accountId: string, runtimeTargetId: string): void => {
    if (accountId !== options.accountId || runtimeTargetId !== options.runtimeTargetId) {
      throw new Error("host_state_scope_mismatch")
    }
  }

  const service: HostStateService = {
    async start(startOptions = {}) {
      const acquired = await acquireHostStateLease({
        hostId: options.hostId,
        ownerId: options.ownerId,
        now: startOptions.now ?? now(),
      })
      generation = acquired.hostGeneration
      if (startOptions.migrationStage) {
        await setHostStateMigrationStage(startOptions.migrationStage, startOptions.now ?? now())
      }
      if (startOptions.heartbeat !== false && !heartbeat) {
        heartbeat = setInterval(() => {
          if (generation === null) return
          void renewHostStateLease({
            ownerId: options.ownerId,
            hostGeneration: generation,
            now: now(),
          }).catch(() => undefined)
        }, HOST_STATE_LEASE_HEARTBEAT_MS)
      }
      return service.status()
    },

    async stop() {
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = null
      generation = null
    },

    async snapshot(request) {
      assertClosedSnapshotRequest(request)
      assertRequestScope(request.accountId, request.runtimeTargetId)
      const snapshot = await getHostStateSnapshot(request.channel)
      const bytes = new TextEncoder().encode(canonicalHostStateJson(snapshot)).byteLength
      if (bytes > maxSnapshotBytes) throw new Error("host_state_snapshot_too_large")
      return snapshot
    },

    async submit(request) {
      assertClosedSubmitRequest(request, maxActionBatch)
      assertRequestScope(request.accountId, request.runtimeTargetId)
      const results: HostStateActionReceiptV1[] = []
      for (const action of request.actions) {
        assertRequestScope(action.accountId, action.runtimeTargetId)
        if (action.hostId !== options.hostId) throw new Error("stale_host_generation")
        if (hostStateActionPayloadSize(action) > maxSnapshotBytes) {
          throw new Error("host_state_action_too_large")
        }
        const snapshot = await getHostStateSnapshot(action.channel)
        const precondition = await validateHostStateBusinessAction(action)
        const decision = precondition
          ? {
              rejection: {
                ...precondition,
                currentRevision: snapshot.revision,
              },
            }
          : mutationForAction(snapshot.state, action)
        const committed = await commitHostStateAction({
          action,
          mutation: decision.mutation,
          rejection: decision.rejection,
          runtimeDispatchRequired: requiresRuntimeDispatch(action),
          now: now(),
        })
        const row = await getHostStateAction(action.hostGeneration, action.actionId)
        if (!row) throw new Error("host_state_ledger_missing")
        await processRow(row)
        results.push(receiptFromEvent(committed.event, committed.duplicate))
      }
      return { protocolVersion: HOST_STATE_PROTOCOL_VERSION, results }
    },

    async status() {
      const [meta, pending] = await Promise.all([getHostStateMeta(), listPendingHostStateActions()])
      return {
        protocolVersion: HOST_STATE_PROTOCOL_VERSION,
        hostId: meta.hostId,
        hostGeneration: meta.hostGeneration,
        hostSeq: meta.hostSeq,
        migrationStage: meta.migrationStage,
        leaseExpiresAt: meta.leaseExpiresAt,
        pendingDispatch: pending.filter(
          (row) => row.dispatchState === "pending" || row.dispatchState === "failed"
        ).length,
        pendingBroadcast: pending.filter(
          (row) => row.broadcastState === "pending" || row.summaryState === "pending"
        ).length,
      }
    },

    async recover() {
      const pending = await listPendingHostStateActions()
      let dispatched = 0
      let broadcast = 0
      for (const row of pending) {
        const beforeDispatch = row.dispatchState
        const beforeBroadcast = row.broadcastState
        await processRow(row)
        if (beforeDispatch === "pending" || beforeDispatch === "failed") dispatched += 1
        if (beforeBroadcast === "pending") broadcast += 1
      }
      return { dispatched, broadcast }
    },

    async projectRuntimeEnvelope(envelope) {
      if (generation === null) throw new Error("host_state_lease_missing")
      if (!isProjectableRuntimeEvent(envelope)) return null
      const committed = await commitHostStateRuntimeProjection({
        hostId: options.hostId,
        hostGeneration: generation,
        ownerId: options.ownerId,
        channel: sessionStateChannel(options.runtimeTargetId, envelope.sessionId),
        envelopeId: envelope.eventId,
        envelopeDigest: hostStateDigest(envelope),
        mutation: (state) => mutationForRuntimeEnvelope(state, envelope),
        now: now(),
      })
      const row = await getHostStateAction(generation, `runtime:${envelope.eventId}`)
      if (!row) throw new Error("host_state_ledger_missing")
      await processRow(row)
      return committed.event
    },
  }

  async function processRow(row: HostStateActionRow): Promise<void> {
    if (row.dispatchState === "pending" || row.dispatchState === "failed") {
      if (!row.action) throw new Error("host_state_recovery_payload_missing")
      if (!options.dispatchRuntime) throw new Error("host_state_runtime_dispatch_unavailable")
      try {
        const result = await options.dispatchRuntime(row.action)
        await markHostStateDispatch(row.hostGeneration, row.actionId, {
          state: "completed",
          runtimeCorrelation: result?.correlationId,
        })
        row.dispatchState = "completed"
      } catch (error) {
        await markHostStateDispatch(row.hostGeneration, row.actionId, {
          state: "failed",
          errorCode: error instanceof Error ? error.name : "runtime_dispatch_failed",
        })
        throw error
      }
    }
    if (row.broadcastState === "pending") {
      if (!options.publish) throw new Error("host_state_event_publisher_unavailable")
      await options.publish(HOST_STATE_ACTION_TOPIC, row.event)
      await markHostStateBroadcast(row.hostGeneration, row.actionId)
      row.broadcastState = "completed"
    }
    if (row.summaryState === "pending") {
      await projectSessionSummary(row)
      await markHostStateSummary(row.hostGeneration, row.actionId)
      row.summaryState = "completed"
    }
  }

  async function projectSessionSummary(source: HostStateActionRow): Promise<void> {
    if (generation === null) throw new Error("host_state_lease_missing")
    const snapshot = await getHostStateSnapshot(source.channel)
    if (snapshot.state.kind !== "session") return
    const session = snapshot.state
    const indexChannel = sessionIndexChannel(options.runtimeTargetId)
    const envelopeId = `session-index:${source.actionId}`
    await commitHostStateRuntimeProjection({
      hostId: options.hostId,
      hostGeneration: generation,
      ownerId: options.ownerId,
      channel: indexChannel,
      envelopeId,
      envelopeDigest: hostStateDigest({
        source: source.payloadDigest,
        sessionId: session.sessionId,
      }),
      mutation: (state) => {
        if (state.kind !== "session-index") throw new Error("host_state_channel_mismatch")
        return {
          kind: "session.upserted",
          revision: state.revision + 1,
          session: {
            sessionId: session.sessionId,
            ...(session.title ? { title: session.title } : {}),
            status: session.status,
            revision: session.revision,
            transcriptRevision: session.transcriptRevision,
            archived: session.archived,
            ...(session.tombstone ? { tombstone: session.tombstone } : {}),
          },
        }
      },
      now: now(),
    })
    const indexRow = await getHostStateAction(generation, `runtime:${envelopeId}`)
    if (!indexRow) throw new Error("host_state_ledger_missing")
    await processRow(indexRow)
  }

  return service
}

function isProjectableRuntimeEvent(envelope: AgentEventEnvelope): boolean {
  return [
    "lifecycle",
    "permission-request",
    "permission-resolved",
    "elicitation-request",
    "elicitation-resolved",
    "queue",
    "session-state",
    "failure",
  ].includes(envelope.event.kind)
}

function mutationForRuntimeEnvelope(
  state: HostStateChannelStateV1,
  envelope: AgentEventEnvelope
): HostStateMutationV1 {
  if (state.kind !== "session") throw new Error("host_state_channel_mismatch")
  const revision = state.revision + 1
  const event = envelope.event
  switch (event.kind) {
    case "lifecycle":
      return event.phase === "started"
        ? {
            kind: "turn.started",
            turnId: envelope.turnId,
            startedAt: parseRuntimeTimestamp(envelope.timestamp),
            revision,
          }
        : {
            kind: "turn.finished",
            status: event.phase === "interrupted" ? "aborted" : "completed",
            revision,
          }
    case "permission-request":
      return {
        kind: "approval.requested",
        request: { requestId: event.requestId, label: event.toolName },
        revision,
      }
    case "permission-resolved":
      return { kind: "approval.resolved", requestId: event.requestId, revision }
    case "elicitation-request":
      return {
        kind: "elicitation.requested",
        request: { requestId: event.requestId, label: event.prompt },
        revision,
      }
    case "elicitation-resolved":
      return { kind: "elicitation.resolved", requestId: event.requestId, revision }
    case "queue":
      return event.phase === "accepted"
        ? { kind: "session.status-changed", status: "queued", revision }
        : { kind: "message.dequeued", actionId: event.queueId, revision }
    case "session-state":
      return {
        kind: "session.status-changed",
        status:
          event.state === "running"
            ? "running"
            : event.state === "requires-action"
              ? "awaiting_approval"
              : "idle",
        revision,
      }
    case "failure":
      return { kind: "session.status-changed", status: "error", revision }
    default:
      throw new Error("host_state_runtime_event_not_projectable")
  }
}

function parseRuntimeTimestamp(value: string): number {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new Error("host_state_runtime_timestamp_invalid")
  return timestamp
}

function receiptFromEvent(
  event: HostStateAppliedActionV1,
  duplicate: boolean
): HostStateActionReceiptV1 {
  return {
    actionId: event.origin?.actionId ?? "server",
    outcome: duplicate ? "duplicate" : event.outcome,
    hostGeneration: event.hostGeneration,
    hostSeq: event.hostSeq,
    ...(event.rejection ? { rejection: event.rejection } : {}),
  }
}

function mutationForAction(
  state: HostStateChannelStateV1,
  action: HostStateActionV1
): {
  mutation?: HostStateMutationV1
  rejection?: { code: string; message: string; currentRevision?: number }
} {
  if (state.kind !== "session") return {}
  if (state.tombstone) {
    return {
      rejection: {
        code: "session_deleted",
        message: "The session has been deleted.",
        currentRevision: state.revision,
      },
    }
  }
  const revision = state.revision + 1
  switch (action.action.kind) {
    case "session.rename":
      return { mutation: { kind: "session.renamed", title: action.action.title, revision } }
    case "session.archive":
      return {
        mutation: { kind: "session.archived", archived: action.action.archived, revision },
      }
    case "draft.replace":
      return {
        mutation: {
          kind: "draft.replaced",
          text: action.action.text,
          attachments: action.action.attachments,
          draftRevision: state.draft.revision + 1,
          revision,
        },
      }
    case "message.enqueue":
      return {
        mutation: {
          kind: "message.queued",
          transcriptRevision: state.transcriptRevision + 1,
          draftRevision: state.draft.revision + 1,
          message: {
            actionId: action.actionId,
            messageId: action.action.messageId,
            text: action.action.text,
            attachments: action.action.attachments,
            clientId: action.clientId,
          },
          revision,
        },
      }
    case "turn.steer":
    case "turn.followup":
      return { mutation: { kind: "session.status-changed", status: "queued", revision } }
    case "turn.abort":
      return { mutation: { kind: "turn.finished", status: "aborted", revision } }
    case "approval.respond":
      if (action.action.kind !== "approval.respond") return {}
      return state.pendingApprovals.some((item) => item.requestId === action.action.requestId)
        ? { mutation: { kind: "approval.resolved", requestId: action.action.requestId, revision } }
        : alreadyResolved(state.revision)
    case "elicitation.respond":
      if (action.action.kind !== "elicitation.respond") return {}
      return state.pendingElicitations.some((item) => item.requestId === action.action.requestId)
        ? {
            mutation: {
              kind: "elicitation.resolved",
              requestId: action.action.requestId,
              revision,
            },
          }
        : alreadyResolved(state.revision)
    case "transcript.edit":
    case "transcript.truncate":
      return {
        mutation: {
          kind: "transcript.revised",
          transcriptRevision: state.transcriptRevision + 1,
          revision,
        },
      }
    case "session.create":
      return {
        mutation: {
          kind: "session.renamed",
          title: action.action.title?.trim() || "New conversation",
          revision,
        },
      }
    case "session.import":
      return isCanonicalSession(action.action.envelope)
        ? {
            mutation: {
              kind: "session.imported",
              title: action.action.envelope.header.title?.trim() || "Imported conversation",
              transcriptRevision: action.action.envelope.turns.length,
              revision,
            },
          }
        : {
            rejection: {
              code: "host_state_invalid_canonical_session",
              message: "The import envelope is not a valid canonical session.",
              currentRevision: state.revision,
            },
          }
  }
}

function alreadyResolved(currentRevision: number) {
  return {
    rejection: {
      code: "already_resolved",
      message: "The request has already been resolved.",
      currentRevision,
    },
  }
}

function requiresRuntimeDispatch(action: HostStateActionV1): boolean {
  return [
    "message.enqueue",
    "turn.steer",
    "turn.followup",
    "turn.abort",
    "approval.respond",
    "elicitation.respond",
  ].includes(action.action.kind)
}

function assertClosedSnapshotRequest(value: HostStateSnapshotRequestV1): void {
  if (
    !value ||
    typeof value !== "object" ||
    !hasOnlyKeys(value, ["protocolVersion", "accountId", "runtimeTargetId", "channel"]) ||
    value.protocolVersion !== HOST_STATE_PROTOCOL_VERSION ||
    typeof value.accountId !== "string" ||
    typeof value.runtimeTargetId !== "string" ||
    typeof value.channel !== "string"
  ) {
    throw new Error("host_state_invalid_snapshot_request")
  }
}

function assertClosedSubmitRequest(value: HostStateSubmitRequestV1, maxBatch: number): void {
  if (
    !value ||
    typeof value !== "object" ||
    !hasOnlyKeys(value, ["protocolVersion", "accountId", "runtimeTargetId", "actions"]) ||
    value.protocolVersion !== HOST_STATE_PROTOCOL_VERSION ||
    typeof value.accountId !== "string" ||
    typeof value.runtimeTargetId !== "string" ||
    !Array.isArray(value.actions) ||
    value.actions.length === 0 ||
    value.actions.length > maxBatch ||
    !value.actions.every(isHostStateActionV1)
  ) {
    throw new Error("host_state_invalid_submit_request")
  }
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}
