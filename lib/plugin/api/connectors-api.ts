/**
 * Plugin Connectors API (`ctx.connectors`) — the full plugin-facing surface
 * of the Platform Connectors / IM subsystem. Lets plugins enumerate the
 * user's connected platforms, observe inbound messages **and** interactive
 * callbacks, drive outbound messaging (send / edit / delete / typing /
 * upload), read history + runtime health, and — behind a separate dangerous
 * permission — manage the adapter instance configuration itself.
 *
 * Wraps the connector `ConnectorBus` (`lib/connectors/bus.ts`), the
 * `adapterInstances` Dexie table (`lib/db/adapter-instances.ts`), and the
 * outbound runner's runtime-state snapshot
 * (`lib/connectors/outbound-runner.ts`).
 *
 * PERMISSION MODEL (three tiers, gated via `createGuardedAPI`):
 *  - `connectors:read`   — read-only: list adapters + instances, observe
 *    inbound/callbacks, fetch history, read runtime health. Returns only
 *    credential-free summaries — never the live `PlatformAdapter` (whose
 *    `start`/`stop`/`refreshCredentials` could be abused) and never the
 *    instance's `credentialsRef` (the OS-keyring pointer).
 *  - `connectors:send`   — DANGEROUS: outbound mutations that reach real
 *    people on real platforms and can't be recalled (send/edit/delete/
 *    typing/upload).
 *  - `connectors:manage` — DANGEROUS: create / reconfigure / enable /
 *    delete the user's adapter instances (changes live delivery routing),
 *    replace dispatch-rule tables, pre-mint conversations, and drive the
 *    capability-gated chat-management surface (create/update chats, manage
 *    members, resolve contacts — the last one deliberately confirm-tier
 *    because directory lookups expose personal data).
 *
 * Multi-bot surfaces: session bindings (`findSessionByConversation` /
 * `listSiblingConversations`), running-adapter enumeration, dispatch-rule
 * read/dry-run/replace, at-gate dry-run, and a durable queue-backed
 * `enqueueSend` (PII-gated, `source: "plugin"`).
 *
 * All observers (`onInbound`/`onCallback`) are passive read-only taps; they
 * run before the authoritative routing/handler and cannot alter it.
 */

import { getBus } from "@/lib/connectors/bus"
import { getDb } from "@/lib/db/schema"
import { newIdempotencyKey } from "@/types/connectors/outbound"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import {
  findSessionByConversationKey,
  listSessionsByConversationKey,
  listSiblingConversations,
  type SiblingConversation,
} from "@/lib/connectors/session-bindings"
import {
  bootstrapConversation,
  type BootstrapConversationInput,
  type BootstrapConversationResult,
} from "@/lib/connectors/conversation-bootstrap"
import { getRunningAdapter, listRunningAdapters } from "@/lib/connectors/lifecycle"
import { matchDispatchRule, type DispatchRuleHit } from "@/lib/connectors/dispatch-rules"
import { shouldRespondToMessage, type AtGateDecision } from "@/lib/connectors/at-gate"
import { waitForOutboundTerminal } from "@/lib/db/outbound-jobs"
import { requireMethod, withScopeCapture } from "@/lib/skills/built-in/im/_helpers"
import { getConnectorDeliveryGateway } from "@/lib/connectors/delivery-gateway"
import { appendAudit } from "@/lib/connectors/audit"
import {
  createA2UIBuilder,
  type PluginConnectorsA2UIBuilder,
} from "@/lib/connectors/a2ui-bridge/surface-builder"
import {
  createAdapterInstance,
  updateAdapterInstance,
  getAdapterInstance,
  listAdapterInstances,
  type AdapterInstanceInput,
} from "@/lib/db/adapter-instances"
import { removeAdapterInstance } from "@/lib/connectors/remove-adapter-instance"
import {
  getAdapterRuntimeStateSnapshot,
  type AdapterRuntimeStateSnapshot,
} from "@/lib/connectors/outbound-runner"
import type { AdapterInstanceRow, DispatchRule, OutboundJobRow } from "@/lib/db/connector-types"
import type { ChatSession } from "@cognia/agent-config-types"
import type {
  OutboundRequest,
  OutboundResult,
  ConversationReference,
  NormalizedInboundEvent,
  ConnectorCallbackEvent,
  PlatformAdapter,
  PlatformKind,
  Capability,
  AdapterHealth,
  TransportMode,
  AttachmentDescriptor,
  AdapterAttachmentRef,
  HistoryFetchOpts,
  StreamReplyRequest,
  A2UICapabilityMatrix,
  ForwardMessageInput,
  ReadReceipt,
  UrgentChannel,
} from "@/types/connectors"
import type {
  CreateChatInput,
  CreateChatResult,
  ChatMembersInput,
  ChatMembersResult,
  UpdateChatInput,
  ResolveContactsInput,
  ContactCandidate,
} from "@/types/connectors/chat-management"
import type { PlatformSkillCapability } from "@/types/connectors/skill-capability"

export type { PluginConnectorsA2UIBuilder } from "@/lib/connectors/a2ui-bridge/surface-builder"
export type { SiblingConversation } from "@/lib/connectors/session-bindings"
export type { DispatchRuleHit } from "@/lib/connectors/dispatch-rules"
export type { AtGateDecision } from "@/lib/connectors/at-gate"
export type {
  BootstrapConversationInput,
  BootstrapConversationResult,
} from "@/lib/connectors/conversation-bootstrap"

/** Optional-method support flags so plugins can feature-detect per adapter. */
export interface PluginConnectorAdapterSupport {
  edit: boolean
  delete: boolean
  setTyping: boolean
  uploadFile: boolean
  fetchHistory: boolean
  streamReply: boolean
}

/** Credential-free runtime summary of a connected adapter. */
export interface PluginConnectorAdapterInfo {
  id: string
  type: PlatformKind
  displayName: string
  version: string
  capabilities: readonly Capability[]
  transportModes: readonly TransportMode[]
  health: AdapterHealth
  supports: PluginConnectorAdapterSupport
}

/**
 * Credential-free view of a configured adapter instance row — the persisted
 * configuration (settings / trigger policy / quiet hours / display name / …)
 * minus the `credentialsRef` keyring pointer.
 */
export type PluginAdapterInstanceInfo = Omit<AdapterInstanceRow, "credentialsRef">

/** Patch shape accepted by `updateInstance` (mirrors the DB whitelist). */
export type PluginAdapterInstancePatch = Parameters<typeof updateAdapterInstance>[1]

/** Input shape accepted by `createInstance` (full instance minus id/timestamps). */
export type PluginAdapterInstanceInput = AdapterInstanceInput

/**
 * Trimmed view of a ChatSession bound to an IM conversation — the binding
 * metadata a plugin needs to correlate conversations with sessions, without
 * the full session row.
 */
export interface PluginBoundSessionInfo {
  sessionId: string
  title: string
  conversationKey: string
  characterId?: string
  createdAt: number
  updatedAt: number
}

/** Result of a durable (queue-backed) send: the persisted job's identifiers. */
export interface PluginOutboundJobInfo {
  jobId: string
  adapterId: string
  conversationKey: string
  status: OutboundJobRow["status"]
  nextAttemptAt: number
  idempotencyKey: string
}

/**
 * Delivery-feedback snapshot of a queued outbound job. Extends the enqueue
 * summary with the runner's progress fields so a plugin can follow a send
 * to its terminal state (`sent` / `deadlettered`).
 */
export interface PluginOutboundJobStatus extends PluginOutboundJobInfo {
  attempts: number
  lastError?: string
  lastErrorCode?: string
  /** Platform-assigned message id — set once the job reaches `sent`. */
  platformMessageId?: string
  /**
   * When this job was rerouted to a sibling bot (failover / load-balance),
   * the id of the sibling job that actually carries the delivery. A poller
   * follows this to the sibling's true status; `waitForDelivery` follows it
   * automatically.
   */
  reroutedToJobId?: string
}

function toJobStatus(row: OutboundJobRow): PluginOutboundJobStatus {
  return {
    jobId: row.id,
    adapterId: row.adapterId,
    conversationKey: row.conversationKey,
    status: row.status,
    nextAttemptAt: row.nextAttemptAt,
    idempotencyKey: row.idempotencyKey,
    attempts: row.attempts,
    ...(row.lastError !== undefined ? { lastError: row.lastError } : {}),
    ...(row.lastErrorCode !== undefined ? { lastErrorCode: row.lastErrorCode } : {}),
    ...(row.platformMessageId !== undefined ? { platformMessageId: row.platformMessageId } : {}),
    ...(row.reroutedToJobId !== undefined ? { reroutedToJobId: row.reroutedToJobId } : {}),
  }
}

function toBoundSessionInfo(s: ChatSession): PluginBoundSessionInfo {
  return {
    sessionId: s.id,
    title: s.title,
    conversationKey: s.platformConversationKey ?? s.platformBinding?.conversationKey ?? "",
    ...(s.characterId ? { characterId: s.characterId } : {}),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }
}

export interface PluginConnectorsAPI {
  // ── Reads (connectors:read) ──────────────────────────────────────────────
  /** Summaries of every connected adapter instance. */
  listAdapters(): PluginConnectorAdapterInfo[]
  /** Summary of one adapter, or `null` if not connected. */
  getAdapter(adapterId: string): PluginConnectorAdapterInfo | null
  /**
   * The adapter's A2UI component-support matrix (per-component-kind
   * `native`/`simulated`/`fallback`/`unsupported`). Lets a plugin pick a
   * rendering strategy per platform before sending. `null` when the adapter
   * is not connected.
   */
  getA2UICapabilityMatrix(adapterId: string): A2UICapabilityMatrix | null
  /**
   * Which built-in skill families the adapter serves on its channel (e.g.
   * `lark.calendar` read+write). `null` when the adapter is not connected,
   * `[]` when it declares none.
   */
  getSkillCapabilities(adapterId: string): readonly PlatformSkillCapability[] | null
  /** Configured adapter instances (credential-free), from the Dexie table. */
  listInstances(): Promise<PluginAdapterInstanceInfo[]>
  /** One configured instance (credential-free), or `null` if not found. */
  getInstance(id: string): Promise<PluginAdapterInstanceInfo | null>
  /**
   * Live outbound runtime health for an adapter (circuit-breaker + token
   * bucket). `null` when the runner isn't running or the adapter has not
   * produced outbound activity yet.
   */
  getRuntimeState(adapterId: string): AdapterRuntimeStateSnapshot | null
  /**
   * Drain an adapter's platform-side message history (when the platform
   * supports it) into a bounded array. `[]` when unsupported. `opts.max`
   * caps the count (default 100).
   */
  fetchHistory(
    adapterId: string,
    conversationKey: string,
    opts?: HistoryFetchOpts
  ): Promise<NormalizedInboundEvent[]>
  /**
   * Observe every inbound platform event the bus processes (passive,
   * read-only — cannot alter routing). Returns a disposer.
   */
  onInbound(handler: (event: NormalizedInboundEvent) => void): () => void
  /**
   * Observe every resolved interactive callback (button / select / form
   * submit / dismiss) with its bound conversation key. Passive, read-only —
   * fires before the authoritative callback handler. Returns a disposer.
   */
  onCallback(
    handler: (event: ConnectorCallbackEvent, boundConversationKey: string | null) => void
  ): () => void
  /**
   * Summaries of the RUNNING adapters (live transports), as opposed to
   * `listAdapters` (bus-registered) and `listInstances` (persisted config
   * rows). Lets a plugin feature-detect which bots can act right now.
   */
  listRunningAdapters(): PluginConnectorAdapterInfo[]
  /** Configured instances filtered to `enabled: true` (credential-free). */
  listEnabledInstances(): Promise<PluginAdapterInstanceInfo[]>
  /** Configured instances of one platform kind (credential-free). */
  listInstancesByType(type: PlatformKind): Promise<PluginAdapterInstanceInfo[]>
  /**
   * The most-recently-updated ChatSession bound to an IM conversation, or
   * `null` when no session is bound yet.
   */
  findSessionByConversation(conversationKey: string): Promise<PluginBoundSessionInfo | null>
  /** Every ChatSession bound to an IM conversation, newest first. */
  listSessionsByConversation(conversationKey: string): Promise<PluginBoundSessionInfo[]>
  /**
   * Conversations bound to the SAME remote chat through OTHER adapter
   * instances (multi-bot same-group collaboration). Lets a plugin fan
   * activity across sibling bots in one group.
   */
  listSiblingConversations(conversationKey: string): Promise<SiblingConversation[]>
  /** The declarative inbound dispatch-rule table of a configured instance. */
  getDispatchRules(instanceId: string): Promise<DispatchRule[]>
  /**
   * Dry-run the instance's dispatch-rule table against an inbound-shaped
   * event (first enabled hit wins, or `null`). Pure — nothing is routed.
   */
  previewDispatchRules(
    instanceId: string,
    event: Pick<NormalizedInboundEvent, "plainText" | "sender" | "channel">
  ): Promise<DispatchRuleHit | null>
  /**
   * Dry-run the instance's inbound guardrails (allow/blocklist +
   * at-response strategy) against an inbound event. Pure — nothing is gated.
   */
  previewAtGate(instanceId: string, event: NormalizedInboundEvent): Promise<AtGateDecision>
  /**
   * Delivery-feedback snapshot of a queued job (from {@link enqueueSend} or
   * any other queue producer). `null` when the job id is unknown.
   */
  getOutboundJob(jobId: string): Promise<PluginOutboundJobStatus | null>
  /**
   * Resolve when the job reaches a terminal state (`sent` / `deadlettered`),
   * or with the latest snapshot when `timeoutMs` (default 30 s, capped at
   * 5 min) elapses first. Rejects when the job id is unknown.
   */
  waitForDelivery(jobId: string, opts?: { timeoutMs?: number }): Promise<PluginOutboundJobStatus>

  // ── Outbound mutations (connectors:send, DANGEROUS) ──────────────────────
  /**
   * Send a fully-formed request directly for one compatibility cycle.
   * @deprecated Use {@link enqueueSend}; this bypasses queue governance and emits a waiver audit.
   */
  send(adapterId: string, req: OutboundRequest): Promise<OutboundResult>
  /**
   * Convenience direct-send retained for one compatibility cycle.
   * @deprecated Use {@link enqueueSend}; this bypasses queue governance and emits a waiver audit.
   */
  sendText(
    adapterId: string,
    conversationRef: ConversationReference,
    text: string
  ): Promise<OutboundResult>
  /** Edit an already-sent message in place (when the platform supports it). */
  editMessage(adapterId: string, messageId: string, patch: OutboundRequest): Promise<OutboundResult>
  /** Delete an already-sent message (when the platform supports it). */
  deleteMessage(adapterId: string, messageId: string): Promise<OutboundResult>
  /**
   * Add an emoji reaction to a message. The result carries the platform
   * `reactionId` (when surfaced) so it can later be removed via
   * {@link removeReaction}. `unsupported` when the platform has no reaction API.
   */
  addReaction(
    adapterId: string,
    messageId: string,
    emojiType: string
  ): Promise<OutboundResult & { reactionId?: string }>
  /** Remove a previously added reaction by its platform reaction id. */
  removeReaction(adapterId: string, messageId: string, reactionId: string): Promise<OutboundResult>
  /**
   * Forward a message (or merge-forward several) to another conversation.
   * `unsupported` when the platform has no forward API.
   */
  forwardMessage(adapterId: string, input: ForwardMessageInput): Promise<OutboundResult>
  /** Pin a message to the top of a conversation (when the platform supports it). */
  pinMessage(adapterId: string, conversationKey: string, messageId: string): Promise<OutboundResult>
  /** Unpin a previously pinned message. */
  unpinMessage(adapterId: string, messageId: string): Promise<OutboundResult>
  /**
   * Escalate a message to users via an urgent channel (加急: in-app / SMS /
   * phone). Requires an elevated platform scope many bots lack — a missing
   * scope surfaces as a failed result.
   */
  sendUrgent(
    adapterId: string,
    messageId: string,
    userIds: string[],
    via?: UrgentChannel
  ): Promise<OutboundResult>
  /**
   * Query who has read a message (read receipts). `null` when the adapter is
   * missing or the platform has no read-user surface. Read-only — gated by
   * `connectors:read`, not `connectors:send`.
   */
  getReadReceipt(adapterId: string, messageId: string): Promise<ReadReceipt | null>
  /**
   * Toggle a typing indicator. Resolves `true` when delivered, `false` when
   * the adapter is missing or the platform has no typing surface.
   */
  setTyping(adapterId: string, conversationKey: string, on: boolean): Promise<boolean>
  /**
   * Upload an attachment, returning the platform reference. `null` when the
   * adapter is missing or the platform has no upload surface.
   */
  uploadFile(adapterId: string, file: AttachmentDescriptor): Promise<AdapterAttachmentRef | null>
  /**
   * Push an incremental assistant reply through an adapter that supports
   * platform-side streaming (e.g. WeCom). `req.text` is the full accumulated
   * reply so far, not a delta. Resolves `true` when streamed, `false` when
   * the adapter is missing or the platform has no streaming surface — so the
   * plugin can fall back to {@link send}.
   */
  streamReply(adapterId: string, req: StreamReplyRequest): Promise<boolean>
  /**
   * Durable send through the outbound queue (per-adapter rate limit,
   * circuit breaker, quiet hours, per-conversation FIFO, retry — everything
   * the direct {@link send} bypasses). The payload MUST pass the PII gate
   * (`hasNoLeakingPiiDeep`) — the queue path is not otherwise scanned;
   * rejected payloads throw. Jobs are tagged `source: "plugin"` for the
   * inbox provenance badge / audit trail.
   */
  enqueueSend(
    adapterId: string,
    conversationKey: string,
    req: OutboundRequest,
    opts?: { nextAttemptAt?: number }
  ): Promise<PluginOutboundJobInfo>

  // ── A2UI rich-content builder (pure, ungated) ────────────────────────────
  /**
   * Construct rich, interactive A2UI surfaces (cards / buttons / forms) for
   * outbound messages. Pure local construction — no permission needed; the
   * `send()` that delivers the result is what's gated by `connectors:send`.
   */
  a2ui: PluginConnectorsA2UIBuilder
  /**
   * Mint a fresh idempotency key for an {@link OutboundRequest} built by hand
   * (the `a2ui.message` / `sendText` helpers already do this internally).
   * Pure; no permission required.
   */
  newIdempotencyKey(): string

  // ── Instance management (connectors:manage, DANGEROUS) ───────────────────
  /** Create a new adapter instance configuration; returns its summary. */
  createInstance(input: PluginAdapterInstanceInput): Promise<PluginAdapterInstanceInfo>
  /** Patch a configured instance (whitelisted fields only). */
  updateInstance(id: string, patch: PluginAdapterInstancePatch): Promise<void>
  /** Enable or disable a configured instance. */
  setInstanceEnabled(id: string, enabled: boolean): Promise<void>
  /**
   * Delete a configured instance. Goes through the shared removal path
   * (`lib/connectors/remove-adapter-instance.ts`): keyring secrets are purged
   * (desktop, best-effort), the attachment cache is pruned, then the row and
   * its heartbeat rows are deleted — the same seam the Settings UI uses.
   */
  deleteInstance(id: string): Promise<void>
  /**
   * Replace an instance's inbound dispatch-rule table (declarative routing:
   * keyword / pattern / sender / channel-kind conditions → team / workflow /
   * character targets).
   */
  setDispatchRules(instanceId: string, rules: DispatchRule[]): Promise<void>
  /**
   * Pre-mint the ChatSession for a chat that exists platform-side before
   * any inbound arrives (agent/plugin-created chats) so it appears in the
   * Inbox and future inbound converges on the same session. Idempotent.
   */
  bootstrapConversation(
    input: Omit<BootstrapConversationInput, "source">
  ): Promise<BootstrapConversationResult>

  // ── Chat management (connectors:manage, DANGEROUS; capability-gated) ─────
  /**
   * Create a platform chat through a RUNNING adapter that declares
   * `chat.create`. Member ids are canonical platform ids from
   * {@link resolveContacts} on the SAME adapter.
   */
  createChat(adapterId: string, input: CreateChatInput): Promise<CreateChatResult>
  /** Rename / re-describe a chat (`chat.update`). */
  updateChat(adapterId: string, input: UpdateChatInput): Promise<void>
  /** Invite members to a chat (`chat.members`). */
  addChatMembers(adapterId: string, input: ChatMembersInput): Promise<ChatMembersResult>
  /** Remove members from a chat (`chat.members`). */
  removeChatMembers(adapterId: string, input: ChatMembersInput): Promise<ChatMembersResult>
  /**
   * Resolve emails / phones / a free-text name query to canonical platform
   * member ids (`contact.resolve`). Gated `connectors:manage` (confirm
   * tier) because directory lookups expose personal contact data.
   */
  resolveContacts(adapterId: string, input: ResolveContactsInput): Promise<ContactCandidate[]>
}

function toInfo(a: PlatformAdapter): PluginConnectorAdapterInfo {
  return {
    id: a.id,
    type: a.meta.type,
    displayName: a.meta.displayName,
    version: a.meta.version,
    capabilities: a.meta.capabilities,
    transportModes: a.meta.transportModes,
    health: a.health(),
    supports: {
      edit: typeof a.edit === "function",
      delete: typeof a.delete === "function",
      setTyping: typeof a.setTyping === "function",
      uploadFile: typeof a.uploadFile === "function",
      fetchHistory: typeof a.fetchHistory === "function",
      streamReply: typeof a.streamReply === "function",
    },
  }
}

/** Strip the keyring pointer before any instance row crosses the plugin boundary. */
function toInstanceInfo(row: AdapterInstanceRow): PluginAdapterInstanceInfo {
  const copy: Partial<AdapterInstanceRow> = { ...row }
  delete copy.credentialsRef
  return copy as PluginAdapterInstanceInfo
}

/** Load a configured instance row or throw an actionable error. */
async function requireInstance(instanceId: string): Promise<AdapterInstanceRow> {
  const row = await getAdapterInstance(instanceId)
  if (!row) {
    throw new Error(`ctx.connectors: adapter instance ${instanceId} not found`)
  }
  return row
}

/**
 * Resolve a RUNNING, healthy adapter that declares every required
 * chat-management capability. Mirrors the `im.*` skills'
 * `resolveChatCapableAdapter`, minus the session-binding fallback — the
 * plugin always names the adapter explicitly.
 */
function resolveChatAdapter(adapterId: string, requiredCaps: readonly Capability[]) {
  const entry = getRunningAdapter(adapterId)
  if (!entry) {
    throw new Error(
      `ctx.connectors: adapter ${adapterId} is not running — reconnect it from Settings → Connections → Health.`
    )
  }
  const adapter = entry.adapter
  if (adapter.health().state !== "running") {
    throw new Error(
      `ctx.connectors: adapter ${adapterId} is not healthy (${adapter.health().state}).`
    )
  }
  const missing = requiredCaps.filter((cap) => !adapter.meta.capabilities.includes(cap))
  if (missing.length > 0) {
    throw new Error(
      `ctx.connectors: adapter ${adapterId} (${adapter.meta.type}) does not declare the required capabilities: ${missing.join(", ")}.`
    )
  }
  return { adapter, adapterId, platform: adapter.meta.type }
}

/**
 * Create the Connectors API for a plugin. See the permission model in the
 * file header: reads need `connectors:read`, outbound mutations need
 * `connectors:send`, instance management needs `connectors:manage`.
 */
export function createConnectorsAPI(pluginId: string): PluginConnectorsAPI {
  const api: PluginConnectorsAPI = {
    // ── reads ──────────────────────────────────────────────────────────────
    listAdapters: () => getBus().listAdapters().map(toInfo),
    getAdapter: (adapterId) => {
      const a = getBus().getAdapter(adapterId)
      return a ? toInfo(a) : null
    },
    getA2UICapabilityMatrix: (adapterId) => getBus().getAdapterA2UICapability(adapterId),
    getSkillCapabilities: (adapterId) => getBus().getAdapterSkillCapabilities(adapterId),
    listInstances: async () => (await listAdapterInstances()).map(toInstanceInfo),
    getInstance: async (id) => {
      const row = await getAdapterInstance(id)
      return row ? toInstanceInfo(row) : null
    },
    getRuntimeState: (adapterId) => getAdapterRuntimeStateSnapshot(adapterId),
    fetchHistory: (adapterId, conversationKey, opts) =>
      getBus().fetchHistoryAll(adapterId, conversationKey, opts),
    onInbound: (handler) => getBus().subscribeInbound(handler),
    onCallback: (handler) => getBus().subscribeCallback(handler),
    listRunningAdapters: () => listRunningAdapters().map((e) => toInfo(e.adapter)),
    listEnabledInstances: async () =>
      (await listAdapterInstances()).filter((r) => r.enabled).map(toInstanceInfo),
    listInstancesByType: async (type) =>
      (await listAdapterInstances()).filter((r) => r.type === type).map(toInstanceInfo),
    findSessionByConversation: async (conversationKey) => {
      const session = await findSessionByConversationKey(conversationKey)
      return session ? toBoundSessionInfo(session) : null
    },
    listSessionsByConversation: async (conversationKey) =>
      (await listSessionsByConversationKey(conversationKey)).map(toBoundSessionInfo),
    listSiblingConversations: (conversationKey) => listSiblingConversations(conversationKey),
    getDispatchRules: async (instanceId) => (await requireInstance(instanceId)).dispatchRules ?? [],
    previewDispatchRules: async (instanceId, event) =>
      matchDispatchRule((await requireInstance(instanceId)).dispatchRules, event),
    previewAtGate: async (instanceId, event) =>
      shouldRespondToMessage(event, await requireInstance(instanceId)),
    getOutboundJob: async (jobId) => {
      const row = await getDb().outboundQueue.get(jobId)
      return row ? toJobStatus(row) : null
    },
    waitForDelivery: async (jobId, opts) => {
      const timeoutMs = Math.min(Math.max(opts?.timeoutMs ?? 30_000, 100), 5 * 60_000)
      // Shared event-driven wait (Dexie liveQuery — no polling loop; also
      // used by the `action.connector.send` workflow node). The timeout
      // path resolves with the latest snapshot instead of rejecting so
      // callers can distinguish "still retrying" from "failed terminally"
      // by inspecting `status`.
      const row = await waitForOutboundTerminal(jobId, timeoutMs)
      if (!row) {
        throw new Error(`ctx.connectors.waitForDelivery: unknown job '${jobId}'`)
      }
      return toJobStatus(row)
    },

    // ── outbound mutations ───────────────────────────────────────────────────
    send: (adapterId, req) => legacyDirectSend(pluginId, adapterId, req),
    sendText: (adapterId, conversationRef, text) =>
      legacyDirectSend(pluginId, adapterId, {
        conversationRef,
        segments: [{ type: "text", text }],
        metadata: { idempotencyKey: newIdempotencyKey() },
      }),
    editMessage: (adapterId, messageId, patch) =>
      getBus().editOutbound(adapterId, messageId, patch),
    deleteMessage: (adapterId, messageId) => getBus().deleteOutbound(adapterId, messageId),
    addReaction: (adapterId, messageId, emojiType) =>
      getBus().addReactionOutbound(adapterId, messageId, emojiType),
    removeReaction: (adapterId, messageId, reactionId) =>
      getBus().removeReactionOutbound(adapterId, messageId, reactionId),
    forwardMessage: (adapterId, input) => getBus().forwardOutbound(adapterId, input),
    pinMessage: (adapterId, conversationKey, messageId) =>
      getBus().pinOutbound(adapterId, conversationKey, messageId),
    unpinMessage: (adapterId, messageId) => getBus().unpinOutbound(adapterId, messageId),
    sendUrgent: (adapterId, messageId, userIds, via) =>
      getBus().sendUrgentOutbound(adapterId, messageId, userIds, via),
    getReadReceipt: (adapterId, messageId) => getBus().getReadReceiptOutbound(adapterId, messageId),
    setTyping: (adapterId, conversationKey, on) =>
      getBus().setTypingOutbound(adapterId, conversationKey, on),
    uploadFile: (adapterId, file) => getBus().uploadFileOutbound(adapterId, file),
    streamReply: (adapterId, req) => getBus().streamReplyOutbound(adapterId, req),
    enqueueSend: async (adapterId, conversationKey, req, opts) => {
      const row = await getConnectorDeliveryGateway().enqueue({
        adapterId,
        conversationKey,
        request: req,
        source: "plugin",
        ...(opts?.nextAttemptAt !== undefined ? { nextAttemptAt: opts.nextAttemptAt } : {}),
      })
      return {
        jobId: row.id,
        adapterId: row.adapterId,
        conversationKey: row.conversationKey,
        status: row.status,
        nextAttemptAt: row.nextAttemptAt,
        idempotencyKey: row.idempotencyKey,
      }
    },

    // ── a2ui builder (pure) ──────────────────────────────────────────────────
    a2ui: createA2UIBuilder(),
    newIdempotencyKey: () => newIdempotencyKey(),

    // ── instance management ──────────────────────────────────────────────────
    createInstance: async (input) => toInstanceInfo(await createAdapterInstance(input)),
    updateInstance: (id, patch) => updateAdapterInstance(id, patch),
    setInstanceEnabled: (id, enabled) => updateAdapterInstance(id, { enabled }),
    deleteInstance: async (id) => {
      // Resolve the row so the keyring purge knows which accounts to drop;
      // an unknown id still runs the delete (idempotent no-op) so a plugin
      // retrying a removal never errors on the second attempt.
      const row = await getAdapterInstance(id)
      await removeAdapterInstance(row ?? { id })
    },
    setDispatchRules: async (instanceId, rules) => {
      await requireInstance(instanceId)
      await updateAdapterInstance(instanceId, { dispatchRules: rules })
    },
    bootstrapConversation: (input) =>
      bootstrapConversation({ ...input, source: `plugin:${pluginId}` }),

    // ── chat management (capability-gated, running adapter required) ────────
    createChat: async (adapterId, input) => {
      const resolved = resolveChatAdapter(adapterId, ["chat.create"])
      const fn = requireMethod(resolved, "createChat")
      return withScopeCapture(adapterId, () => fn.call(resolved.adapter, input))
    },
    updateChat: async (adapterId, input) => {
      const resolved = resolveChatAdapter(adapterId, ["chat.update"])
      const fn = requireMethod(resolved, "updateChat")
      return withScopeCapture(adapterId, () => fn.call(resolved.adapter, input))
    },
    addChatMembers: async (adapterId, input) => {
      const resolved = resolveChatAdapter(adapterId, ["chat.members"])
      const fn = requireMethod(resolved, "addChatMembers")
      return withScopeCapture(adapterId, () => fn.call(resolved.adapter, input))
    },
    removeChatMembers: async (adapterId, input) => {
      const resolved = resolveChatAdapter(adapterId, ["chat.members"])
      const fn = requireMethod(resolved, "removeChatMembers")
      return withScopeCapture(adapterId, () => fn.call(resolved.adapter, input))
    },
    resolveContacts: async (adapterId, input) => {
      const resolved = resolveChatAdapter(adapterId, ["contact.resolve"])
      const fn = requireMethod(resolved, "resolveContacts")
      return withScopeCapture(adapterId, () => fn.call(resolved.adapter, input))
    },
  }

  return createGuardedAPI(
    pluginId,
    api,
    {
      listAdapters: "connectors:read",
      getAdapter: "connectors:read",
      getA2UICapabilityMatrix: "connectors:read",
      getSkillCapabilities: "connectors:read",
      listInstances: "connectors:read",
      getInstance: "connectors:read",
      getRuntimeState: "connectors:read",
      fetchHistory: "connectors:read",
      onInbound: "connectors:read",
      onCallback: "connectors:read",
      listRunningAdapters: "connectors:read",
      listEnabledInstances: "connectors:read",
      listInstancesByType: "connectors:read",
      findSessionByConversation: "connectors:read",
      listSessionsByConversation: "connectors:read",
      listSiblingConversations: "connectors:read",
      getDispatchRules: "connectors:read",
      previewDispatchRules: "connectors:read",
      previewAtGate: "connectors:read",
      getOutboundJob: "connectors:read",
      waitForDelivery: "connectors:read",
      getReadReceipt: "connectors:read",
      send: "connectors:send",
      sendText: "connectors:send",
      editMessage: "connectors:send",
      deleteMessage: "connectors:send",
      addReaction: "connectors:send",
      removeReaction: "connectors:send",
      forwardMessage: "connectors:send",
      pinMessage: "connectors:send",
      unpinMessage: "connectors:send",
      sendUrgent: "connectors:send",
      setTyping: "connectors:send",
      uploadFile: "connectors:send",
      streamReply: "connectors:send",
      enqueueSend: "connectors:send",
      createInstance: "connectors:manage",
      updateInstance: "connectors:manage",
      setInstanceEnabled: "connectors:manage",
      deleteInstance: "connectors:manage",
      setDispatchRules: "connectors:manage",
      bootstrapConversation: "connectors:manage",
      createChat: "connectors:manage",
      updateChat: "connectors:manage",
      addChatMembers: "connectors:manage",
      removeChatMembers: "connectors:manage",
      resolveContacts: "connectors:manage",
    },
    {
      // Pure, ungated helper (mints a client-side idempotency key). The `a2ui`
      // builder is a non-function property and passes through unchanged.
      unguarded: ["newIdempotencyKey"],
    }
  )
}

async function legacyDirectSend(
  pluginId: string,
  adapterId: string,
  request: OutboundRequest
): Promise<OutboundResult> {
  console.warn(
    `[connectors-api] plugin ${pluginId} used deprecated direct send; migrate to ctx.connectors.enqueueSend`
  )
  await appendAudit({
    adapterId,
    kind: "delivery.legacy_direct",
    at: Date.now(),
    idempotencyKey: request.metadata.idempotencyKey,
    reason: "plugin_compatibility_waiver",
    fields: { pluginId, migrationTarget: "ctx.connectors.enqueueSend" },
  }).catch(() => undefined)
  return getBus().sendOutbound(adapterId, request)
}
