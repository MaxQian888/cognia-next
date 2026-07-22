import type { PlatformKind } from "./platform-kind"
import type { A2UICapabilityMatrix, Capability } from "./capability"
import type {
  ChatMembersInput,
  ChatMembersResult,
  ContactCandidate,
  CreateChatInput,
  CreateChatResult,
  ResolveContactsInput,
  UpdateChatInput,
} from "./chat-management"
import type { ConversationReference, NormalizedInboundEvent } from "./event"
import type { OutboundRequest, OutboundResult } from "./outbound"
import type { PresenceStatusInput } from "./presence"
import type { RunPresentationDriver } from "@/types/execution/run"

export type TransportMode =
  "longpoll" | "webhook" | "reverse-ws" | "forward-ws" | "gateway" | "imap-smtp" | "stub" // tests only

export interface AdapterMeta {
  type: PlatformKind
  displayName: string
  version: string
  capabilities: readonly Capability[]
  transportModes: readonly TransportMode[]
  /** JSON Schema (draft-07) describing the per-instance settings shape. Drives the auto-generated form. */
  configSchema: object
}

export type AdapterHealthState = "starting" | "running" | "degraded" | "down"

export interface AdapterHealth {
  state: AdapterHealthState
  reason?: string
  /** Wall-clock timestamp of the last successful inbound or outbound. */
  lastActivityAt?: number
}

export interface AdapterLogger {
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
}

/** Keyring helpers scoped to one adapter instance. Backed by Tauri keyring on desktop, refused on web. */
export interface AdapterSecrets {
  get(name: string): Promise<string | null>
  set(name: string, value: string): Promise<void>
  delete(name: string): Promise<void>
  list(): Promise<string[]>
}

export interface AdapterAttachmentRef {
  /** Local file URL — the renderer can resolve via a Tauri convertFileSrc. */
  localUrl: string
  /** Original platform-side reference (e.g. Telegram file_id). */
  remoteRef: string
}

export interface AttachmentDescriptor {
  url: string
  name?: string
  mimeType?: string
  sizeBytes?: number
}

export interface HistoryFetchOpts {
  before?: string
  after?: string
  max?: number
}

/**
 * A single incremental reply chunk pushed to the platform while the
 * assistant turn is still generating. Carried by the optional
 * {@link PlatformAdapter.streamReply} method.
 *
 * `conversationRef` is the inbound event's opaque ref (the same one the
 * authoritative final message flows through via `send()`), so the adapter
 * can derive a stable platform-side stream id and correlate the live
 * preview frames with the terminal `send()`. `text` is the accumulated
 * reply so far — adapters that update a single platform-side message in
 * place (WeCom 智能机器人 `aibot_respond_msg` stream frames) replace the
 * content on each call rather than appending.
 */
export interface StreamReplyRequest {
  conversationRef: ConversationReference
  /** Accumulated assistant reply text so far (full text, not a delta). */
  text: string
}

export interface AdapterContext {
  /** Push a normalized inbound event to the bus. */
  emit: (event: NormalizedInboundEvent) => Promise<void>
  /** Reach into Rust-side connectors_* commands. */
  tauri: {
    httpRequest: (req: TauriHttpRequest) => Promise<TauriHttpResponse>
    openWs: (req: TauriWsRequest) => Promise<TauriWsHandle>
    fetchAttachment: (adapterId: string, remoteRef: string) => Promise<AdapterAttachmentRef>
    bindWebhookRoute: (adapterId: string, path: string) => Promise<void>
    unbindWebhookRoute: (adapterId: string, path: string) => Promise<void>
    /** Resolve the public URL prefix the user pasted into the platform. */
    publicBaseUrl: () => Promise<string | null>
  }
  secrets: AdapterSecrets
  logger: AdapterLogger
  /** Aborts when the adapter stops; long-running loops should respect this. */
  signal: AbortSignal
  /** This instance's id; convenience accessor. */
  adapterId: string
}

export interface TauriHttpRequest {
  url: string
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}

export interface TauriHttpResponse {
  status: number
  headers: Record<string, string>
  body: string
}

export interface TauriWsRequest {
  url: string
  headers?: Record<string, string>
}

export interface TauriWsHandle {
  /** Stable handle id. Renderer subscribes to `connectors://ws/<id>` events. */
  id: string
  send: (data: string) => Promise<void>
  close: () => Promise<void>
}

/**
 * Reference to a platform reaction, returned by `addReaction` so the same
 * reaction can later be removed. `reactionId` is absent when the platform's
 * reaction API doesn't surface a handle.
 */
export interface ReactionRef {
  reactionId?: string
}

/** One reader of a message, from `getReadReceipt`. */
export interface MessageReader {
  /** Platform user id (open_id on Lark). */
  userId: string
  /** Unix ms when the user read the message, when the platform reports it. */
  readAt?: number
}

/** Read-receipt snapshot for a single message. */
export interface ReadReceipt {
  readers: MessageReader[]
  /** True when the platform paginated and more readers exist beyond this page. */
  hasMore: boolean
}

/** Urgent (加急) escalation channel for {@link PlatformAdapter.sendUrgent}. */
export type UrgentChannel = "app" | "sms" | "phone"

/**
 * Input for {@link PlatformAdapter.forwardMessage}. Provide EITHER a single
 * `messageId` (plain forward) OR `messageIds` (merge-forward several messages
 * into one combined card). `target` is a conversation key
 * (`platform:adapterId:channelId`) or a raw platform receive id.
 */
export interface ForwardMessageInput {
  messageId?: string
  messageIds?: string[]
  target: string
}

export interface PlatformAdapter {
  readonly meta: AdapterMeta
  readonly id: string

  start(ctx: AdapterContext): Promise<void>
  stop(): Promise<void>
  health(): AdapterHealth

  /** Native projection for durable execution runs. Absence selects the generic A2UI/edit fallback. */
  readonly runPresentation?: RunPresentationDriver
  /** Native cursor domain expected by the legacy history stream. */
  readonly historyCursorKind?: "message_id" | "timestamp"

  send(req: OutboundRequest): Promise<OutboundResult>
  /**
   * Stream an incremental reply chunk to the platform while the assistant
   * turn is still generating (e.g. WeCom 智能机器人 `aibot_respond_msg`
   * stream frames with `finish:false`). Optional — only adapters whose
   * platform supports updating a message in place implement it.
   *
   * The connector runtime calls this from `runAndCapture`'s `onPartial`
   * callback ONLY when (a) the target adapter implements `streamReply` and
   * (b) the turn is a live reply (the inbound `conversationRef` is still
   * correlatable). The authoritative final message ALWAYS flows through the
   * durable outbound queue via `send()`; `streamReply` is a best-effort live
   * preview that shares the same platform-side stream id, so `send()`
   * finalises the stream (`finish:true`) without duplicating the message.
   * A throwing `streamReply` must never break the turn — callers swallow it.
   */
  streamReply?(req: StreamReplyRequest): Promise<void>
  edit?(messageId: string, patch: OutboundRequest): Promise<OutboundResult>
  delete?(messageId: string): Promise<void>
  /**
   * Add an emoji reaction to an existing platform message. `emojiType` is
   * the platform's reaction code (Lark reaction type like "THUMBSUP") or a
   * unicode emoji, adapter-interpreted. Optional — only platforms with a
   * reaction API implement it; callers treat absence as unsupported.
   *
   * Returns a {@link ReactionRef} carrying the platform reaction id (when the
   * platform surfaces one) so the same reaction can later be removed via
   * {@link removeReaction}. Legacy callers that ignore the return value are
   * unaffected.
   */
  addReaction?(messageId: string, emojiType: string): Promise<ReactionRef | void>
  /**
   * Remove a previously added reaction by its platform reaction id (obtained
   * from {@link addReaction}). Optional; paired with the same `send.reaction`
   * capability. Callers treat absence as unsupported.
   */
  removeReaction?(messageId: string, reactionId: string): Promise<void>
  /**
   * Forward an existing message (`input.messageId`) — or merge-forward several
   * (`input.messageIds`) as one combined card — into another conversation.
   * Optional; declared alongside the `forward` capability. Returns the same
   * `{ ok, platformMessageId, error }` shape as {@link send}.
   */
  forwardMessage?(input: ForwardMessageInput): Promise<OutboundResult>
  /**
   * Escalate an already-sent message to the given users via an urgent channel
   * (Feishu 加急: in-app / SMS / phone). Optional; declared alongside the
   * `urgent` capability. NOTE: requires an elevated platform scope
   * (`im:message.urgent*` on Lark) that many bots lack — callers surface a
   * scope error to the operator.
   */
  sendUrgent?(messageId: string, userIds: string[], via?: UrgentChannel): Promise<void>
  /**
   * Query who has read an already-sent message (read receipts). Optional
   * feedback surface — only platforms with a read-user API implement it
   * (Feishu `GET /im/v1/messages/:id/read_users`). Callers treat absence as
   * "read state unknown".
   */
  getReadReceipt?(messageId: string): Promise<ReadReceipt>
  setTyping?(conversationKey: string, on: boolean): Promise<void>
  uploadFile?(file: AttachmentDescriptor): Promise<AdapterAttachmentRef>
  fetchHistory?(
    conversationKey: string,
    opts: HistoryFetchOpts
  ): AsyncIterable<NormalizedInboundEvent>
  refreshCredentials?(): Promise<void>
  /**
   * Surface a short, periodically refreshed status text on the platform
   * (Lark 系统状态 badge, Slack `users.profile.set`, Discord gateway
   * presence). Optional — only adapters whose platform exposes a status
   * API implement it; they must also declare the `presence.status`
   * capability. Callers treat a throw as a soft failure (audited, retried
   * on the next refresh tick) — it must never break another flow.
   */
  setPresenceStatus?(input: PresenceStatusInput): Promise<void>
  /**
   * Pin a platform message so a periodically edited card stays visible at
   * the top of a conversation. Optional; paired with the `pin` capability.
   */
  pinMessage?(conversationKey: string, messageId: string): Promise<void>
  /**
   * Remove a previously pinned message. Optional; paired with the same `pin`
   * capability. Callers treat absence as unsupported.
   */
  unpinMessage?(messageId: string): Promise<void>
  /**
   * Chat management (W2 multi-bot) — all optional, each paired with a
   * capability flag the adapter must also declare:
   *   `createChat` ↔ `chat.create`, `addChatMembers`/`removeChatMembers` ↔
   *   `chat.members`, `updateChat` ↔ `chat.update`, `resolveContacts` ↔
   *   `contact.resolve`.
   * Consumed by the platform-neutral `im.*` built-in skills through
   * `getRunningAdapter(adapterId)` — never through platform-specific paths.
   * Permission failures throw `ChatManagementScopeError` so callers can
   * surface the missing console scope to the operator.
   */
  createChat?(input: CreateChatInput): Promise<CreateChatResult>
  addChatMembers?(input: ChatMembersInput): Promise<ChatMembersResult>
  removeChatMembers?(input: ChatMembersInput): Promise<ChatMembersResult>
  updateChat?(input: UpdateChatInput): Promise<void>
  resolveContacts?(input: ResolveContactsInput): Promise<ContactCandidate[]>
  /**
   * Per-adapter A2UI projection matrix. Returned synchronously so
   * `build-options.ts:resolveSendOptions` can inject a capability-aware
   * system prompt without an async fan-out at every send.
   *
   * Adapters that do not implement any native A2UI projection should still
   * return a matrix where everything defaults to `"fallback"` — the
   * assistant remains free to emit A2UI, but every component will degrade
   * to `plainTextMirror`. Returning `undefined` is reserved for the `stub`
   * adapter used in tests.
   */
  a2uiCapability(): A2UICapabilityMatrix
  /**
   * Declare which built-in skill families this adapter can serve in v1
   * (ADR-0026). Read at adapter start and cached on
   * `AdapterInstanceRow.lastKnownSkillCapabilities` so the hot send
   * path (build-options) doesn't pay for a registry walk per turn.
   *
   * Adapters that don't expose any built-in skill family return `[]`.
   * The return shape lives in `types/connectors/skill-capability.ts`.
   *
   * Optional for backward compat — adapters that haven't been updated
   * are treated as "no built-in skill capabilities" by the resolver.
   */
  platformSkillCapabilities?(): readonly import("./skill-capability").PlatformSkillCapability[]
}
