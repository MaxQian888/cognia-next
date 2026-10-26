/**
 * The plugin contract's share of `lib/plugin/api/connectors-api.ts`, which re-exports these.
 */
import type {
  A2UICapabilityMatrix,
  AdapterAttachmentRef,
  AdapterHealth,
  AttachmentDescriptor,
  Capability,
  ConnectorCallbackEvent,
  ConversationReference,
  ForwardMessageInput,
  HistoryFetchOpts,
  NormalizedInboundEvent,
  OutboundRequest,
  OutboundResult,
  PlatformKind,
  ReadReceipt,
  StreamReplyRequest,
  TransportMode,
  UrgentChannel,
} from "../../../types/connectors"
import type { AdapterInstanceInput, AdapterInstancePatch } from "../../db/adapter-instances"
import type { AdapterInstanceRow, DispatchRule, OutboundJobRow } from "../../db/connector-types"
import type { AdapterRuntimeStateSnapshot } from "../../connectors/outbound-runner"
import type { AtGateDecision } from "../../connectors/at-gate"
import type {
  BootstrapConversationInput,
  BootstrapConversationResult,
} from "../../connectors/conversation-bootstrap"
import type {
  ChatMembersInput,
  ChatMembersResult,
  ContactCandidate,
  CreateChatInput,
  CreateChatResult,
  ResolveContactsInput,
  UpdateChatInput,
} from "../../../types/connectors/chat-management"
import type { DispatchRuleHit } from "../../connectors/dispatch-rules"
import type { PlatformSkillCapability } from "../../../types/connectors/skill-capability"
import type { PluginConnectorsA2UIBuilder } from "../../connectors/a2ui-bridge/surface-builder"
import type { SiblingConversation } from "../../connectors/session-bindings"

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
/**
 * An instance as a plugin sees it: no credential names, and no recipient list
 * (ADR-0239), which is a person's grant a plugin neither reads nor writes.
 */
export type PluginAdapterInstanceInfo = Omit<
  AdapterInstanceRow,
  "credentialsRef" | "outboundRecipients"
>

/** Patch shape accepted by `updateInstance` (mirrors the DB whitelist). */
export type PluginAdapterInstancePatch = AdapterInstancePatch

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
   * Dry-run the instance's inbound guardrails — the chat allow/blocklist plus
   * the group-admission policy — against an inbound event. Pure; nothing is
   * gated, stored or sent.
   *
   * The conversation's own override is read when the event names a
   * conversation the host knows, so the answer reflects the layer that
   * actually decides. One case it predicts conservatively: a
   * `mention_activates` thread also admits follow-ups inside an already-open
   * activation window, which is stored state a dry run must not consume.
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
   *
   * The outbound policy (ADR-0239) plans it first, and it is sent at once or
   * not at all: there is no draft to hold it in. A request whose
   * `deliveryTarget` names its conversation goes to the target the host
   * stored for that conversation, whatever its `conversationRef` says. One
   * that names only a `conversationRef` has a recipient nobody can check:
   * under enforcement it is refused. A refusal, a destination the host
   * cannot send to, and a PII rejection are failed results
   * (`connector_delivery_denied`, `connector_delivery_destination`,
   * `connector_delivery_pii_rejected`).
   * @deprecated Use {@link enqueueSend}; this bypasses the queue and emits a waiver audit.
   */
  send(adapterId: string, req: OutboundRequest): Promise<OutboundResult>
  /**
   * Convenience direct-send retained for one compatibility cycle. It names
   * only a reference, so under enforcement it is refused (see {@link send}).
   * @deprecated Use {@link enqueueSend}; this bypasses the queue and emits a waiver audit.
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
  /** Delete a Lark recipient-only card sent with enqueueSend metadata.larkEphemeral. */
  deleteEphemeralCard(adapterId: string, messageId: string): Promise<OutboundResult>
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
   * `input.target` is a conversation key of this adapter or a bare platform
   * chat id. `unsupported` when the platform has no forward API.
   *
   * The outbound policy (ADR-0239) plans it as a delivery to the target, and
   * it cannot wait for a person: under enforcement a forward nothing
   * authorized is a failed result with `code: "connector_delivery_denied"`.
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
   * plugin can fall back to {@link enqueueSend}.
   *
   * A stream cannot be planned by the outbound policy (ADR-0239), so while
   * messaging is enforced it always resolves `false` and the fallback send is
   * what is planned.
   */
  streamReply(adapterId: string, req: StreamReplyRequest): Promise<boolean>
  /**
   * Durable send through the outbound queue (per-adapter rate limit,
   * circuit breaker, quiet hours, per-conversation FIFO, retry — everything
   * the direct {@link send} bypasses). The payload MUST pass the PII gate
   * (`hasNoLeakingPiiDeep`) — the queue path is not otherwise scanned;
   * rejected payloads throw. Jobs are tagged `source: "plugin"` for the
   * inbox provenance badge / audit trail.
   *
   * It is sent to the delivery target the host stored for `conversationKey`
   * (refreshed by its inbound messages, or minted by
   * {@link bootstrapConversation}), never to `req.conversationRef` or
   * `req.deliveryTarget`; a `replyTo` or `editTargetMessageId` must name a
   * message of the same conversation. Otherwise the call rejects with
   * `code: "connector_delivery_destination"` and nothing is queued.
   *
   * The host's outbound policy (ADR-0239) plans the delivery first. It goes
   * when a tool call of this plugin that a person or policy allowed covers
   * the recipient, or when the recipient is otherwise authorized; otherwise,
   * under enforcement, it is held as a draft for a person to approve and the
   * call rejects with `code: "connector_delivery_held"` (and `draftId`), or is
   * refused with `code: "connector_delivery_denied"`.
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
