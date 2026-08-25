import {
  canonicalHostStateJson,
  hostStateDigest,
  isHostStateAction,
  isHostStateAppliedAction,
  isHostStateSnapshot,
  isHostStateStatus,
  reduceHostStateIntent,
  intentRequiresRuntimeDispatch,
  OPEN_DECISION_STATUSES,
  callerMaySubmitHostStateIntent,
  hostStateIntentCapability,
  type HostStateActionReceipt,
  type HostStateAction,
  type HostStateAttachmentRef,
  type HostStateAppliedAction,
  type HostStateChannelState,
  type HostStateDecision,
  type HostStateDecisionKind,
  type HostStateMutation,
  type HostStateOperation,
  type HostStateRecoveryStatus,
  type HostStateSnapshotRequest,
  type HostStateSnapshot,
  type HostStateStatus,
  type HostStateSubmitCaller,
  type HostStateSubmitRequest,
  type HostStateSubmitResponse,
} from "@cognia/agent-config-types/host-state"
import {
  hostStateIntentRequiresLiveControl,
  reduceHostStateMutation,
} from "@cognia/agent-config-types/host-state"
import { effectiveController } from "@/lib/companion/device-presence-registry"
import { sessionIndexChannel, sessionStateChannel } from "@cognia/agent-config-types/host-state"
import type { Transport } from "@/lib/tauri/transport-types"
import { loggers } from "@cognia/logging"
import type { AgentEventEnvelope } from "@cognia/agent-config-types/agent-execution"
import { isCanonicalSession } from "@cognia/agent-config-types/canonical-session"
import type { SendContent, StoredMessage } from "@cognia/agent-config-types"
import type { SubmittedFile } from "@/lib/chat/attachments/dispatch"
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
  listHostStateSessionChannels,
  listPendingHostStateActions,
  markHostStateBroadcast,
  markHostStateDispatch,
  markHostStateSummary,
  renewHostStateLease,
  validateHostStateBusinessAction,
  type HostStateActionRow,
} from "./host-state-store"
import { markSessionDirty } from "@/lib/chat/search/indexer"

export const HOST_STATE_ACTION_TOPIC = "host-state://action"
export const MAX_HOST_STATE_SNAPSHOT_BYTES = 512 * 1024
export const MAX_HOST_STATE_ACTION_BATCH = 50
/** Backlog ceiling while a client is not `ready`. See `bufferEvent`. */
export const MAX_BUFFERED_HOST_STATE_EVENTS = 2_000

export interface HostStateRuntimeDispatchResult {
  correlationId?: string
}

export type HostStateRuntimeDispatcher = (
  action: HostStateAction
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
 * Turn a queued message's attachment refs into the content the runtime is sent.
 *
 * Reuses `buildSendContent`, the same dispatcher the desktop composer runs, so
 * a phone-uploaded PDF is extracted, redacted and token-counted exactly the way
 * a dragged-in one is — a second path here would mean a remote image was
 * downscaled differently, or a remote document skipped the PII gate.
 *
 * A ref that no longer resolves throws rather than degrading to a text-only
 * prompt. The dispatch is retried and eventually surfaces as a failed action
 * the user can see; silently sending "have a look at this screenshot" with no
 * screenshot attached is the one outcome nobody can debug.
 */
async function resolveOutboundAttachments(
  sessionId: string,
  text: string,
  attachments: readonly HostStateAttachmentRef[]
): Promise<SendContent> {
  const refs = attachments.filter(
    (attachment) => typeof attachment.ref === "string" && attachment.ref.length > 0
  )
  if (refs.length === 0) return text
  const [{ resolveAttachmentRef }, { buildSendContent }, { bytesToDataUrl }] = await Promise.all([
    import("@/lib/db/session-attachment-uploads"),
    import("@/lib/chat/attachments/dispatch"),
    import("@/lib/ocr/image-prep"),
  ])
  const files: SubmittedFile[] = []
  for (const attachment of refs) {
    const row = await resolveAttachmentRef(attachment.ref!, { sessionId })
    if (!row?.bytes) throw new Error("host_state_attachment_unavailable")
    files.push({
      url: bytesToDataUrl(row.bytes, row.mediaType),
      mediaType: row.mediaType,
      filename: row.name,
    })
  }
  const built = await buildSendContent(text, files)
  return built.content
}

/** Release the staged bytes behind refs the runtime has now received. */
async function consumeAttachmentRefs(
  attachments: readonly HostStateAttachmentRef[]
): Promise<void> {
  const refs = attachments
    .map((attachment) => attachment.ref)
    .filter((ref): ref is string => typeof ref === "string" && ref.length > 0)
  if (refs.length === 0) return
  const store = await import("@/lib/db/session-attachment-uploads")
  await store.consumeAttachmentRefs(refs)
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
        // Durably accept before dispatching (ADR-0123). An attached client does
        // not run the chat controller, so this is the only point at which its
        // turn becomes recoverable. Non-fatal by construction: a ledger failure
        // must not swallow a message the user already sent.
        const workSubmissionAdapter = await import("@/lib/work-submission/host-adapter")
        const receipt = await workSubmissionAdapter
          .acceptHostStateChatTurn(action)
          .catch((error) => {
            console.error("acceptHostStateChatTurn failed", error)
            return null
          })
        let stopAssemblyHeartbeat = () => {}
        let durableLeaseLost = false
        if (receipt) {
          const claim = await workSubmissionAdapter.claimHostStateChatTurnForDispatch(
            action.actionId
          )
          if (claim === "owned_elsewhere") return
          if (claim === "claimed") {
            const { startWorkSubmissionLeaseHeartbeat } =
              await import("@/lib/work-submission/lease-heartbeat")
            stopAssemblyHeartbeat = startWorkSubmissionLeaseHeartbeat(
              receipt.submissionId,
              "host-state",
              {
                onError: (error) => console.error("HostState work lease renewal failed", error),
                onLeaseLost: () => {
                  durableLeaseLost = true
                },
              }
            )
          }
        }
        let handedOff = false
        try {
          if (durableLeaseLost) return
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
            if (receipt) {
              await workSubmissionAdapter.bindHostStateChatTurnContext(action, options)
            }
            // Attachments become content here, not in the intent: the intent
            // carries refs so a 10 MB screenshot never rides the action ledger
            // (or the replay stream, or a queue row that gets retried). This is
            // the last point at which the bytes are still on the Host and the
            // prompt has not been built.
            const prompt = await resolveOutboundAttachments(
              sessionId,
              action.action.text,
              action.action.attachments
            )
            await sendPrompt(sessionId, prompt, options, { commandId: action.actionId })
            // Only now: the runtime has the file, so the staging copy is dead
            // weight and the per-session staging slot should be freed. Before
            // the send it is the only copy that exists.
            await consumeAttachmentRefs(action.action.attachments)
          }
          if (durableLeaseLost) return
          if (receipt) {
            await workSubmissionAdapter.markHostStateChatTurnStarted(action.actionId)
          }
          handedOff = true
        } finally {
          if (!handedOff) stopAssemblyHeartbeat()
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
  dispatchRuntime?: (action: HostStateAction) => Promise<HostStateRuntimeDispatchResult | void>
  publish?: (topic: typeof HOST_STATE_ACTION_TOPIC, event: HostStateAppliedAction) => Promise<void>
  maxSnapshotBytes?: number
  maxActionBatch?: number
}

export interface HostStateService {
  /**
   * `recover: false` skips the ledger redrive and the orphan-turn settle. Only
   * for tests that assert on a pristine ledger; production must never pass it,
   * because skipping recovery is exactly the bug this replaced.
   */
  start(options?: {
    now?: number
    heartbeat?: boolean
    recover?: boolean
  }): Promise<HostStateStatus>
  stop(): Promise<void>
  snapshot(request: HostStateSnapshotRequest): Promise<HostStateSnapshot>
  /**
   * Apply a batch of client intents. `caller` is the server-verified device
   * identity and its current capabilities; every action is authorized against
   * it individually (see {@link hostStateIntentCapability}).
   */
  submit(
    request: HostStateSubmitRequest,
    caller: HostStateSubmitCaller
  ): Promise<HostStateSubmitResponse>
  status(): Promise<HostStateStatus>
  recover(): Promise<{ dispatched: number; broadcast: number }>
  projectRuntimeEnvelope(envelope: AgentEventEnvelope): Promise<HostStateAppliedAction | null>
}

export interface InstalledHostStateSync {
  status: HostStateStatus
  resync(): Promise<void>
  stop(): void
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
  onState?: (state: HostStateChannelState) => void
}): Promise<InstalledHostStateSync> {
  let stopped = false
  let ready = false
  let lastHostSeq = 0
  let hostGeneration = 0
  let applying = Promise.resolve()
  const buffered: HostStateAppliedAction[] = []
  const cuts = new Map<string, number>()

  const unsubscribe = options.transport.subscribe<unknown>(HOST_STATE_ACTION_TOPIC, (event) => {
    if (stopped) return
    if (!isHostStateAppliedAction(event)) {
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
  function bufferEvent(event: HostStateAppliedAction): void {
    if (buffered.length >= MAX_BUFFERED_HOST_STATE_EVENTS) buffered.length = 0
    buffered.push(event)
  }

  const takeSnapshots = async (): Promise<void> => {
    const channels = [...new Set(await options.channels())]
    if (channels.length === 0) return
    const snapshots: HostStateSnapshot[] = []
    for (const channel of channels) {
      const snapshot = await takeChannelSnapshot(channel)
      snapshots.push(snapshot)
    }
    hostGeneration = snapshots[0]?.hostGeneration ?? hostGeneration
    lastHostSeq = Math.min(...snapshots.map((snapshot) => snapshot.cutHostSeq))
  }

  const applyEvent = async (event: HostStateAppliedAction): Promise<void> => {
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

  const takeChannelSnapshot = async (channel: string): Promise<HostStateSnapshot> => {
    const snapshot = await options.transport.call<HostStateSnapshot>("host_state_snapshot", {
      accountId: options.accountId,
      runtimeTargetId: options.runtimeTargetId,
      channel,
    })
    if (!isHostStateSnapshot(snapshot)) throw new Error("host_state_snapshot_malformed")
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

  let status: HostStateStatus
  try {
    const value = await options.transport.call<unknown>("host_state_status", {
      accountId: options.accountId,
      runtimeTargetId: options.runtimeTargetId,
    })
    if (!isHostStateStatus(value)) throw new Error("host_state_status_malformed")
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
  onState?: (state: HostStateChannelState) => void
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
  state: HostStateChannelState,
  hostId: string,
  hostGeneration: number,
  hostSeq: number
): Promise<HostStateChannelState> {
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
        archivedAt:
          summary.conversation === "archived" ? (existing?.archivedAt ?? Date.now()) : undefined,
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
      archivedAt: optimisticState.conversation === "archived" ? Date.now() : undefined,
      updatedAt: Date.now(),
    }),
    db.chatDrafts.put({
      sessionId: state.sessionId,
      text: optimisticState.draft.text,
      updatedAt: Date.now(),
      revision: optimisticState.draft.revision,
      attachmentRefs: optimisticState.draft.attachments,
      ...(attachments.length > 0 ? { attachments } : {}),
      // `put` replaces the whole row, and the wire format carries text and
      // attachments only — so without this the arriving snapshot would silently
      // erase the `{{parameter}}` values held on THIS device. Preserving is
      // also the right merge: an orphaned value is pruned when its token is
      // gone from the text, so keeping one can never resurrect a stale answer.
      ...(existingDraft?.templateBinding ? { templateBinding: existingDraft.templateBinding } : {}),
    }),
  ])
  await materializeOptimisticMessages(optimisticState)
  const { useChatStore } = await import("@/stores/chat/chat-store")
  useChatStore.getState().setSessionStatus(state.sessionId, chatStoreStatusForTurn(optimisticState))
  return optimisticState
}

async function projectPendingHostStateActions(
  confirmed: Extract<HostStateChannelState, { kind: "session" }>
): Promise<Extract<HostStateChannelState, { kind: "session" }>> {
  const rows = await getDb()
    .mobileOutboundQueue.filter(
      (row) =>
        row.protocol === "host-state" &&
        row.channel === confirmed.channel &&
        (row.status === "pending" || row.status === "sending")
    )
    .toArray()
  const actions = rows
    .sort((left, right) => (left.clientSeq ?? 0) - (right.clientSeq ?? 0))
    .flatMap((row) => {
      const payloadActions = (row.payload as { actions?: unknown }).actions
      if (!Array.isArray(payloadActions) || payloadActions.length !== 1) return []
      return isHostStateAction(payloadActions[0]) ? [payloadActions[0]] : []
    })
  return actions.reduce((projected, action) => reduceHostStateIntent(projected, action), confirmed)
}

async function materializeOptimisticMessages(
  state: Extract<HostStateChannelState, { kind: "session" }>
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
    markSessionDirty(message.sessionId)
  }

  const terminalRows = await db.mobileOutboundQueue
    .where("status")
    .anyOf("rejected", "conflicted")
    .filter((row) => row.protocol === "host-state" && row.channel === state.channel)
    .toArray()
  for (const row of terminalRows) {
    const actions = (row.payload as { actions?: unknown }).actions
    const action = Array.isArray(actions) && actions.length === 1 ? actions[0] : undefined
    if (!isHostStateAction(action) || action.action.kind !== "message.enqueue") continue
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
  let recovery: HostStateRecoveryStatus = "recovering"

  const assertRequestScope = (accountId: string, runtimeTargetId: string): void => {
    if (accountId !== options.accountId || runtimeTargetId !== options.runtimeTargetId) {
      throw new Error("host_state_scope_mismatch")
    }
  }

  const service: HostStateService = {
    /**
     * Bring the Host back up, in an order that never reports state it has not
     * yet checked.
     *
     * 1. Take the lease — winning it is what proves the previous owner is gone.
     * 2. Redrive the ledger: actions left mid-dispatch or mid-broadcast by that
     *    owner. This is the step production never took. `recover()` existed and
     *    was exercised only by tests, so after a restart a half-dispatched send
     *    simply sat in the ledger forever, and the client that submitted it
     *    waited on a receipt that was never coming.
     * 3. Settle turns the previous owner left in flight. Nothing is running any
     *    more — the runtime went with it — so a channel still reading `running`
     *    is lying to every replica that reads it.
     * 4. Only then start the heartbeat and report `ready`.
     *
     * A failure in 2 or 3 lands on `degraded` rather than throwing: the Host is
     * still the only writer and refusing to start would strand every client,
     * but it must say that what it holds may be stale instead of presenting it
     * as fresh.
     */
    async start(startOptions = {}) {
      const acquired = await acquireHostStateLease({
        hostId: options.hostId,
        ownerId: options.ownerId,
        now: startOptions.now ?? now(),
      })
      generation = acquired.hostGeneration
      recovery = "recovering"

      if (startOptions.recover !== false) {
        try {
          await service.recover()
          await settleOrphanedTurns()
          recovery = "ready"
        } catch (error) {
          recovery = "degraded"
          loggers.sync.error("[host-state] recovery failed; serving degraded", {
            hostId: options.hostId,
            hostGeneration: acquired.hostGeneration,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      } else {
        recovery = "ready"
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
      recovery = "recovering"
    },

    async snapshot(request) {
      assertClosedSnapshotRequest(request)
      assertRequestScope(request.accountId, request.runtimeTargetId)
      const snapshot = await getHostStateSnapshot(request.channel)
      const bytes = new TextEncoder().encode(canonicalHostStateJson(snapshot)).byteLength
      if (bytes > maxSnapshotBytes) throw new Error("host_state_snapshot_too_large")
      return snapshot
    },

    async submit(request, caller) {
      assertClosedSubmitRequest(request, maxActionBatch)
      assertRequestScope(request.accountId, request.runtimeTargetId)
      assertCaller(caller)
      const results: HostStateActionReceipt[] = []
      for (const action of request.actions) {
        assertRequestScope(action.accountId, action.runtimeTargetId)
        if (action.hostId !== options.hostId) throw new Error("stale_host_generation")
        if (hostStateActionPayloadSize(action) > maxSnapshotBytes) {
          throw new Error("host_state_action_too_large")
        }
        // Authorize BEFORE the ledger. A precondition failure is a legitimate
        // client racing the Host, so it is committed as a rejected row and
        // broadcast; an authorization failure is a device reaching for
        // something it may never do, and must not be able to append to durable
        // Host state or fan an event out to every replica at all.
        if (!callerMaySubmitHostStateIntent(caller, action.action)) {
          results.push(await forbiddenReceipt(action, caller))
          continue
        }
        // Holding the grant is not the same as being the one driving. While a
        // device is the effective controller of a session, a live-only intent
        // from anyone else is refused: those intents name state the runtime is
        // holding open right now, and a second client acting on its own view of
        // "what is the run waiting for" aborts turns the controller started or
        // answers prompts it is already looking at.
        if (isSecondClaimant(action, caller, now())) {
          results.push(await notControllerReceipt(action, caller))
          continue
        }
        // A message may only carry attachments this caller actually uploaded
        // into this session. Checked here rather than at dispatch alone
        // because a ref that will never resolve should be refused while the
        // client is still holding the composer open and can re-stage the file
        // — discovering it minutes later, from a failed dispatch, means the
        // user sees a sent message that never carried its screenshot.
        const badRef = await unresolvableAttachmentRef(action, caller)
        if (badRef) {
          results.push(await attachmentRefReceipt(action, caller, badRef))
          continue
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
          : mutationForAction(snapshot.state, action, now())
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
      return { results }
    },

    async status() {
      const [meta, pending] = await Promise.all([getHostStateMeta(), listPendingHostStateActions()])
      return {
        recovery,
        hostId: meta.hostId,
        hostGeneration: meta.hostGeneration,
        hostSeq: meta.hostSeq,
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
        // Only an enqueue gets a second word from the runtime — its
        // `queue`/`accepted` event, keyed by the submitting action id — so only
        // an enqueue waits on `dispatching`. Everything else (an abort, a
        // steer, a decision answer) is confirmed by the dispatch call itself
        // returning; parking those on `dispatching` meant they could only ever
        // end up `expired` when the turn settled, so a stop that was honoured
        // was indistinguishable from one that was lost.
        await commitOperationStatus(row, {
          status: row.action.action.kind === "message.enqueue" ? "dispatching" : "acknowledged",
          ...(result?.correlationId ? { correlationId: result.correlationId } : {}),
        })
      } catch (error) {
        const errorCode = error instanceof Error ? error.name : "runtime_dispatch_failed"
        await markHostStateDispatch(row.hostGeneration, row.actionId, {
          state: "failed",
          errorCode,
        })
        // Publish the failure before rethrowing. Without this the client is
        // left with an operation stuck on `accepted` — and, for an abort or a
        // decision answer, with the asking-state it took still held. The
        // reducer gives both back when it sees `failed`.
        await commitOperationStatus(row, { status: "failed", errorCode }).catch(() => undefined)
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

  /**
   * Record where a submitted intent got to, as its own confirmed mutation.
   *
   * Separate from the ledger's `dispatchState`, which is the Host's private
   * retry bookkeeping and never reaches a client. Only intents that go to the
   * runtime have an operation to move; everything else was already settled when
   * it was written.
   */
  async function commitOperationStatus(
    row: HostStateActionRow,
    change: { status: HostStateOperation["status"]; errorCode?: string; correlationId?: string }
  ): Promise<void> {
    if (generation === null) throw new Error("host_state_lease_missing")
    if (!row.action || !intentRequiresRuntimeDispatch(row.action.action.kind)) return
    const envelopeId = `operation:${row.actionId}:${change.status}`
    const at = now()
    await commitHostStateRuntimeProjection({
      hostId: options.hostId,
      hostGeneration: generation,
      ownerId: options.ownerId,
      channel: row.channel,
      envelopeId,
      envelopeDigest: hostStateDigest({ actionId: row.actionId, ...change }),
      mutation: (state) => ({
        kind: "operation.changed",
        actionId: row.actionId,
        status: change.status,
        ...(change.errorCode ? { errorCode: change.errorCode } : {}),
        ...(change.correlationId ? { correlationId: change.correlationId } : {}),
        // The reducer has no clock; this is the one it stamps `updatedAt` with.
        at,
        revision: state.revision + 1,
      }),
      now: at,
    })
    const operationRow = await getHostStateAction(generation, `runtime:${envelopeId}`)
    if (operationRow) await processRow(operationRow)
  }

  /**
   * Close out turns a previous owner left running.
   *
   * Winning the lease means that owner is gone, and its runtime went with it —
   * so any channel still reading `queued` / `running` / `awaiting-decision` /
   * `stopping` describes work that stopped without ever saying so. Projecting a
   * lost runtime is exactly the right shape for it: the reducer interrupts the
   * open decisions, expires the operations that can no longer be acknowledged,
   * and lands the turn on `retryable-error` — resumable, because the
   * conversation itself survived.
   */
  async function settleOrphanedTurns(): Promise<void> {
    if (generation === null) throw new Error("host_state_lease_missing")
    const channels = await listHostStateSessionChannels()
    for (const channel of channels) {
      const snapshot = await getHostStateSnapshot(channel)
      if (snapshot.state.kind !== "session") continue
      const { turn } = snapshot.state
      if (
        turn !== "queued" &&
        turn !== "running" &&
        turn !== "awaiting-decision" &&
        turn !== "stopping"
      ) {
        continue
      }
      const envelopeId = `recovery:${generation}:${channel}`
      await commitHostStateRuntimeProjection({
        hostId: options.hostId,
        hostGeneration: generation,
        ownerId: options.ownerId,
        channel,
        envelopeId,
        envelopeDigest: hostStateDigest({ recovery: generation, channel }),
        mutation: (state) => ({
          kind: "runtime.changed",
          runtime: "unavailable",
          revision: state.revision + 1,
        }),
        now: now(),
      })
      const row = await getHostStateAction(generation, `runtime:${envelopeId}`)
      if (row) await processRow(row)
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
            conversation: session.conversation,
            turn: session.turn,
            revision: session.revision,
            transcriptRevision: session.transcriptRevision,
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
  const event = envelope.event
  // `requires-action` says a decision is blocking without naming it. The
  // decision events carry the request itself, and projecting the bare hint
  // would set `awaiting-decision` over an empty decision list — a turn frozen
  // on a prompt no client can render or answer.
  if (event.kind === "session-state" && event.state === "requires-action") return false
  return [
    "lifecycle",
    "permission-request",
    "permission-resolved",
    "elicitation-request",
    "elicitation-resolved",
    "queue",
    "session-state",
    "failure",
  ].includes(event.kind)
}

/**
 * Provenance for a decision raised by a subagent rather than the main loop.
 *
 * `parentRunId` is the only signal the envelope carries: a run with a parent is
 * a subagent run. Surfacing it matters because the prompt a user is asked to
 * approve may come from work they never directly started, and the answer still
 * goes back to the real ephemeral request — the origin is provenance, not a
 * routing hint.
 */
function decisionOrigin(envelope: AgentEventEnvelope): HostStateDecision["origin"] {
  return envelope.parentRunId ? { subagentId: envelope.runId } : undefined
}

/**
 * The one place a runtime event becomes confirmed HostState.
 *
 * Everything here is an observation, never a request. That asymmetry with
 * {@link mutationForAction} is the point: a client asks, and only what the
 * runtime reports moves the turn, the decisions or the transcript.
 */
function mutationForRuntimeEnvelope(
  state: HostStateChannelState,
  envelope: AgentEventEnvelope
): HostStateMutation {
  if (state.kind !== "session") throw new Error("host_state_channel_mismatch")
  const revision = state.revision + 1
  const event = envelope.event
  const at = parseRuntimeTimestamp(envelope.timestamp)
  switch (event.kind) {
    case "lifecycle":
      if (event.phase === "started") {
        return { kind: "turn.started", turnId: envelope.turnId, startedAt: at, revision }
      }
      // `ended` AND `interrupted` both close exactly one turn, and neither ends
      // the conversation — that is `conversation`'s axis. Treating this as the
      // end of the conversation is what locked a composer the user could
      // legitimately keep typing into.
      //
      // They are still two different outcomes. The `turn.abort` operation is
      // not a substitute: a desktop Stop and a killed sidecar interrupt the
      // turn without any client having submitted one, so collapsing this into
      // `completed` reported work that was cut short as having finished
      // normally, on every replica.
      return {
        kind: "turn.settled",
        turn: event.phase === "interrupted" ? "aborted" : "completed",
        revision,
      }
    case "permission-request":
      return {
        kind: "decision.requested",
        decision: {
          requestId: event.requestId,
          kind: "tool-approval",
          status: "pending",
          label: event.toolName,
          requestedAt: at,
          ...(decisionOrigin(envelope) ? { origin: decisionOrigin(envelope) } : {}),
        },
        revision,
      }
    case "permission-resolved":
      return { kind: "decision.settled", requestId: event.requestId, status: "resolved", revision }
    case "elicitation-request":
      return {
        kind: "decision.requested",
        decision: {
          requestId: event.requestId,
          kind: "elicitation",
          status: "pending",
          label: event.prompt,
          requestedAt: at,
          ...(decisionOrigin(envelope) ? { origin: decisionOrigin(envelope) } : {}),
        },
        revision,
      }
    case "elicitation-resolved":
      return { kind: "decision.settled", requestId: event.requestId, status: "resolved", revision }
    case "queue":
      // `queueId` is the submitting action's id — the dispatcher passes it
      // through — so a queue event is the runtime acknowledging that exact
      // operation. `dropped` is the case that used to vanish: the message left
      // the queue with the session still reading "queued" and nothing to say it
      // was never delivered.
      if (event.phase === "accepted") {
        return {
          kind: "operation.changed",
          actionId: event.queueId,
          status: "acknowledged",
          at,
          revision,
        }
      }
      if (event.phase === "delivered") {
        return { kind: "message.dequeued", actionId: event.queueId, revision }
      }
      // `dropped` leaves the queue too. Marking only the operation `failed`
      // left the message itself in `queue` forever — every replica kept showing
      // a send that would never happen, `materializeOptimisticMessages` kept
      // rewriting it into the transcript, and the turn stayed `queued` behind
      // it. `message.dropped` does both halves in one mutation: the reason is
      // recorded on the operation AND the row leaves the queue.
      return {
        kind: "message.dropped",
        actionId: event.queueId,
        errorCode: event.reason ?? "host_state_queue_dropped",
        at,
        revision,
      }
    case "session-state":
      // `requires-action` never reaches here (see `isProjectableRuntimeEvent`).
      return event.state === "running"
        ? { kind: "turn.started", turnId: envelope.turnId, startedAt: at, revision }
        : { kind: "turn.settled", turn: "completed", revision }
    case "failure":
      // The runtime already knows whether trying again could work. Collapsing
      // both into one error state made every failure look permanent, so a
      // client could not honestly offer "retry".
      return {
        kind: "turn.settled",
        turn: event.retryable === true ? "retryable-error" : "fatal-error",
        revision,
      }
    default:
      throw new Error("host_state_runtime_event_not_projectable")
  }
}

function parseRuntimeTimestamp(value: string): number {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new Error("host_state_runtime_timestamp_invalid")
  return timestamp
}

/**
 * Reject a submit whose caller identity never reached the Host.
 *
 * The Rust RPC layer injects it on every `host_state_submit`, so an absent
 * caller means the request arrived through a path that skipped
 * `bind_authority` — which is exactly the path an attacker would want. Failing
 * the whole batch is deliberate: silently treating it as "no grants" would
 * return per-action receipts that read like an ordinary permission denial and
 * hide a routing bug.
 */
function assertCaller(caller: HostStateSubmitCaller | undefined): asserts caller {
  if (!caller || typeof caller.deviceId !== "string" || !caller.deviceId) {
    throw new Error("host_state_caller_unbound")
  }
  // The adapter passes a non-array through untouched precisely so this can
  // fire; coercing it to `[]` there made the whole check unreachable.
  if (!Array.isArray(caller.grants)) throw new Error("host_state_caller_unbound")
  if (caller.grants.some((grant) => typeof grant !== "string")) {
    throw new Error("host_state_caller_unbound")
  }
}

/**
 * Receipt for an action the caller is not authorized to submit. Reports the
 * capability that was missing so the client can explain *which* grant to ask
 * for rather than showing an undifferentiated "forbidden".
 */
async function forbiddenReceipt(
  action: HostStateAction,
  caller: HostStateSubmitCaller
): Promise<HostStateActionReceipt> {
  const meta = await getHostStateMeta()
  const capability = hostStateIntentCapability(action.action)
  loggers.sync.warn("[host-state] refusing an action the device is not granted", {
    deviceId: caller.deviceId,
    intent: action.action.kind,
    capability,
  })
  return {
    actionId: action.actionId,
    outcome: "rejected",
    hostGeneration: meta.hostGeneration,
    hostSeq: meta.hostSeq,
    rejection: {
      code: "host_state_forbidden",
      message: `the device is not authorized for ${action.action.kind}`,
    },
  }
}

/**
 * True when a live-only intent arrives from someone other than the device
 * currently driving the session.
 *
 * Deliberately NOT a grant check — that already happened — and deliberately not
 * "is the caller attached". Requiring an attachment would refuse every client
 * that drives a companion host through the ordinary chat surface
 * (`use-claude-chat-controller`), which submits `turn.abort` and
 * `approval.respond` and never calls `session_attach`; making them all attach
 * belongs with the shared composer, not with this gate. What this DOES refuse
 * is the case the attach lease exists to decide: somebody is already holding
 * the wheel, so nobody else may steer, abort, or answer.
 *
 * Safe intents skip it entirely — a draft, a queued message and a follow-up
 * describe work to do next, and the queue decides when it runs.
 */
function isSecondClaimant(
  action: HostStateAction,
  caller: HostStateSubmitCaller,
  at: number
): boolean {
  if (!hostStateIntentRequiresLiveControl(action.action.kind)) return false
  const sessionId = action.sessionId
  // A live-only intent with no session names no live state; there is nothing to
  // be the controller OF, and refusing it would be refusing on a technicality.
  if (!sessionId) return false
  const controller = effectiveController(sessionId, at)
  return controller !== null && controller !== caller.deviceId
}

/**
 * The first attachment ref on a `message.enqueue` that this caller cannot use
 * here, or null when every ref checks out (including when there are none).
 *
 * Three ways a ref fails, and all three are the same answer to the client:
 * it names an upload that never committed, one that belongs to another device,
 * or one staged against a different session. Naming which would tell a device
 * whether an id it guessed exists.
 */
async function unresolvableAttachmentRef(
  action: HostStateAction,
  caller: HostStateSubmitCaller
): Promise<string | null> {
  if (action.action.kind !== "message.enqueue") return null
  const refs = action.action.attachments
    .map((attachment) => attachment.ref)
    .filter((ref): ref is string => typeof ref === "string" && ref.length > 0)
  if (refs.length === 0) return null
  const sessionId = action.sessionId
  if (!sessionId) return refs[0] ?? null
  const { resolveAttachmentRef } = await import("@/lib/db/session-attachment-uploads")
  for (const ref of refs) {
    const row = await resolveAttachmentRef(ref, { sessionId, deviceId: caller.deviceId })
    if (!row) return ref
  }
  return null
}

/** Receipt for a message whose attachment the Host cannot hand to the runtime. */
async function attachmentRefReceipt(
  action: HostStateAction,
  caller: HostStateSubmitCaller,
  ref: string
): Promise<HostStateActionReceipt> {
  const meta = await getHostStateMeta()
  loggers.sync.warn("[host-state] refusing a message whose attachment ref does not resolve", {
    deviceId: caller.deviceId,
    ref,
  })
  return {
    actionId: action.actionId,
    outcome: "rejected",
    hostGeneration: meta.hostGeneration,
    hostSeq: meta.hostSeq,
    rejection: {
      code: "host_state_attachment_unavailable",
      message: "an attachment on this message is no longer available on the host",
    },
  }
}

/**
 * Receipt for a live-only intent from a device that is not the one driving the
 * session. Distinct from {@link forbiddenReceipt}: the grant is fine and
 * nothing needs to be re-authorized — the client refreshes and sees who holds
 * the session, or takes over once that lease lapses.
 */
async function notControllerReceipt(
  action: HostStateAction,
  caller: HostStateSubmitCaller
): Promise<HostStateActionReceipt> {
  const meta = await getHostStateMeta()
  loggers.sync.warn("[host-state] refusing a live-only intent from a non-controller", {
    deviceId: caller.deviceId,
    intent: action.action.kind,
  })
  return {
    actionId: action.actionId,
    outcome: "rejected",
    hostGeneration: meta.hostGeneration,
    hostSeq: meta.hostSeq,
    rejection: {
      code: "host_state_not_controller",
      message: "another device is currently controlling the session",
    },
  }
}

function receiptFromEvent(
  event: HostStateAppliedAction,
  duplicate: boolean
): HostStateActionReceipt {
  return {
    actionId: event.origin?.actionId ?? "server",
    outcome: duplicate ? "duplicate" : event.outcome,
    hostGeneration: event.hostGeneration,
    hostSeq: event.hostSeq,
    ...(event.rejection ? { rejection: event.rejection } : {}),
  }
}

/**
 * What one client-submitted intent does to confirmed HostState.
 *
 * The rule: an intent may record that something was *asked for* and may never
 * record it *done*. Anything the runtime has to carry out becomes an
 * {@link HostStateOperation}; the effect arrives later, from
 * {@link mutationForRuntimeEnvelope}. Intents that are pure Host bookkeeping —
 * rename, archive, draft, transcript surgery — have no runtime step and apply
 * in full.
 */
function mutationForAction(
  state: HostStateChannelState,
  action: HostStateAction,
  now: number
): {
  mutation?: HostStateMutation
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
  const operation = (targetRequestId?: string): HostStateOperation => ({
    actionId: action.actionId,
    kind: action.action.kind,
    status: "accepted",
    clientId: action.clientId,
    createdAt: now,
    updatedAt: now,
    ...(targetRequestId ? { targetRequestId } : {}),
  })

  switch (action.action.kind) {
    case "session.rename":
      return { mutation: { kind: "session.renamed", title: action.action.title, revision } }
    case "session.archive":
      return {
        mutation: {
          kind: "conversation.changed",
          conversation: action.action.archived ? "archived" : "present",
          revision,
        },
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
          draftRevision: state.draft.revision + 1,
          message: {
            actionId: action.actionId,
            messageId: action.action.messageId,
            text: action.action.text,
            attachments: action.action.attachments,
            clientId: action.clientId,
          },
          operation: operation(),
          revision,
        },
      }
    case "turn.steer":
    case "turn.followup":
    case "turn.abort":
      // No status change of its own. A steer that fails to dispatch used to
      // leave the session reading "queued" forever; an abort that failed used
      // to leave it reading "aborted" while the run kept producing. The
      // operation is the whole of what the Host can honestly assert.
      return { mutation: { kind: "operation.accepted", operation: operation(), revision } }
    case "approval.respond":
    case "elicitation.respond": {
      // Bound to a local before the callbacks below: narrowing does not survive
      // into a function expression, so `action.action.requestId` read as the
      // un-narrowed union inside them.
      const intent = action.action
      const decision = state.decisions.find((item) => item.requestId === intent.requestId)
      if (!decision || !OPEN_DECISION_STATUSES.includes(decision.status)) {
        return alreadyResolved(state.revision)
      }
      if (!decisionAcceptsIntent(decision.kind, intent.kind)) {
        return {
          rejection: {
            code: "host_state_decision_kind_mismatch",
            message: "That answer does not fit the request.",
            currentRevision: state.revision,
          },
        }
      }
      // First valid writer wins. A second client answering the same prompt is
      // told so and refreshes, rather than silently overwriting an answer that
      // is already on its way to the runtime.
      if (decision.status === "responding" && decision.respondingActionId !== action.actionId) {
        return {
          rejection: {
            code: "host_state_decision_conflicted",
            message: "Another device is already answering this request.",
            currentRevision: state.revision,
          },
        }
      }
      if (decision.hostOnly) {
        return {
          rejection: {
            code: "host_state_decision_host_only",
            message: "This request is too large to answer remotely.",
            currentRevision: state.revision,
          },
        }
      }
      return {
        mutation: {
          kind: "operation.accepted",
          operation: operation(intent.requestId),
          revision,
        },
      }
    }
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

/**
 * Whether an answer of this intent kind fits a decision of that kind.
 *
 * A locked computer-use consent is an approval in shape, so it accepts
 * `approval.respond`; an elicitation carries a structured answer and accepts
 * only `elicitation.respond`. Without this a malformed client could resolve a
 * tool approval by submitting free-form JSON to it.
 */
function decisionAcceptsIntent(
  decisionKind: HostStateDecisionKind,
  intentKind: "approval.respond" | "elicitation.respond"
): boolean {
  return decisionKind === "elicitation"
    ? intentKind === "elicitation.respond"
    : intentKind === "approval.respond"
}

/**
 * Turn state projected onto the desktop chat store's coarser vocabulary.
 *
 * The store has no notion of a turn that is stopping or one that failed
 * retryably; `stopping` reads as still streaming (because it is), and both
 * error turns read as errors.
 */
function chatStoreStatusForTurn(
  state: Extract<HostStateChannelState, { kind: "session" }>
): "streaming" | "awaiting_approval" | "error" | "idle" {
  switch (state.turn) {
    case "running":
    case "queued":
    case "stopping":
      return "streaming"
    case "awaiting-decision":
      return "awaiting_approval"
    case "retryable-error":
    case "fatal-error":
      return "error"
    case "idle":
    case "completed":
    // An aborted turn is over and not an error: the composer unlocks, the same
    // as a clean finish. The distinction lives in `turn`, which surfaces stop
    // separately from success.
    case "aborted":
      return "idle"
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

function requiresRuntimeDispatch(action: HostStateAction): boolean {
  return intentRequiresRuntimeDispatch(action.action.kind)
}

function assertClosedSnapshotRequest(value: HostStateSnapshotRequest): void {
  if (
    !value ||
    typeof value !== "object" ||
    !hasOnlyKeys(value, ["accountId", "runtimeTargetId", "channel"]) ||
    typeof value.accountId !== "string" ||
    typeof value.runtimeTargetId !== "string" ||
    typeof value.channel !== "string"
  ) {
    throw new Error("host_state_invalid_snapshot_request")
  }
}

function assertClosedSubmitRequest(value: HostStateSubmitRequest, maxBatch: number): void {
  if (
    !value ||
    typeof value !== "object" ||
    !hasOnlyKeys(value, ["accountId", "runtimeTargetId", "actions"]) ||
    typeof value.accountId !== "string" ||
    typeof value.runtimeTargetId !== "string" ||
    !Array.isArray(value.actions) ||
    value.actions.length === 0 ||
    value.actions.length > maxBatch ||
    !value.actions.every(isHostStateAction)
  ) {
    throw new Error("host_state_invalid_submit_request")
  }
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}
