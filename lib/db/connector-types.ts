// Dexie row shapes for the Platform Connector tables added in schema v18.
//
// Kept minimal here so the Dexie schema bump can land before the full
// lib/connectors/ port: each row carries only the columns its index
// references plus free-form blobs for everything else. The connector
// runtime treats these rows as authoritative; richer domain-specific
// validation is applied at the CRUD layer (lib/db/adapter-instances.ts, etc.)
//
// Why row types live here instead of `types/connectors/`:
//   * matches the convention set by `lib/db/plugin-types.ts`,
//     `lib/db/canvas-types.ts`, and `lib/db/a2ui-types.ts` — Dexie row
//     shapes co-locate with the schema, full domain types live elsewhere.
//   * keeps `lib/db/schema.ts` from depending on `types/connectors/*` until
//     those types are fully stabilised.

import type { PlatformKind } from "@/types/connectors/platform-kind"
import type { OutboundRequest } from "@/types/connectors/outbound"
import type { TriggerPolicy, ConnectorMode } from "@/types/connectors/policy"
import type { TransportMode } from "@/types/connectors/adapter"
import type { A2UICapabilityMatrix } from "@/types/connectors/capability"
import type { ConversationReference, PlatformIdentity } from "@/types/connectors/event"
import type { AuditEntry } from "@/types/connectors/audit"
import type { MessageSegment } from "@/types/connectors/segment"
import type { ConnectorCallbackBindingRow } from "@/types/connectors/interaction"

export type { ConnectorCallbackBindingRow }

/**
 * One row per configured adapter instance (one Telegram bot, one Discord
 * guild connection, etc.). The `credentialsRef` field points into the OS
 * keyring — it never holds the actual secret value.
 */
export interface AdapterInstanceRow {
  id: string
  type: PlatformKind
  displayName: string
  enabled: boolean
  transportMode: TransportMode
  /** Non-secret JSON-Schema-validated settings. */
  settings: Record<string, unknown>
  /** Reference to keyring entries; never holds the secret value. */
  credentialsRef: { keyringService: string; accounts: string[] }
  trigger: TriggerPolicy
  defaultCharacterId?: string
  defaultMode: ConnectorMode
  /** For webhook / reverse-WS: path under the connectors axum app. */
  webhookPath?: string
  /** Resolved public URL (tunnel or user-supplied) for paste into platform settings. */
  publicUrl?: string
  /** Per-adapter quiet hours, optional. */
  quietHours?: { from: string; to: string; tz: string }
  /** Adapter is muted globally (drops outbound). */
  muted?: boolean
  /**
   * Cache of `PlatformAdapter.a2uiCapability()` written at adapter start.
   * `lib/claude/build-options.ts:resolveSendOptions` reads this to inject
   * a capability-aware system prompt without an async fan-out at every
   * send. Rows that pre-date v38 will have `undefined` here; the resolver
   * treats that as "all components fallback" and the runtime refreshes
   * the cache the next time the adapter starts.
   */
  lastKnownCapabilities?: A2UICapabilityMatrix
  createdAt: number
  updatedAt: number
}

/**
 * One row per observed platform user. Extends the canonical PlatformIdentity
 * shape with a `lastSeenAt` timestamp used for stale-identity cleanup.
 */
export interface PlatformIdentityRow extends PlatformIdentity {
  /** Last time we observed this identity; helps cleanup. */
  lastSeenAt: number
}

/**
 * Dedup ledger row. Originally one row per received inbound message; v38
 * widened the table with a `namespace` field so the same dedup machinery
 * can serve any sliding-window dedup case (inbound messages, connector
 * callbacks, future webhook receivers, etc.) without proliferating tables.
 *
 * Rows persisted before v38 carry `namespace === "inbound"` (set by the
 * v38 upgrade hook). Newly-inserted rows always set namespace explicitly.
 *
 * Keyed `${adapterId}:${namespace}:${platformMessageId}` for new rows;
 * pre-v38 rows keep the original `${adapterId}:${platformMessageId}` id
 * — the row is queryable either way via the compound index.
 */
export type InboundLedgerNamespace = "inbound" | "callback"

export interface InboundLedgerRow {
  /** `${adapterId}:${namespace}:${platformMessageId}` (or legacy form). */
  id: string
  adapterId: string
  /** Sliding-window namespace; defaults to `"inbound"` for legacy rows. */
  namespace: InboundLedgerNamespace
  platformMessageId: string
  receivedAt: number
}

export type OutboundJobStatus = "pending" | "sending" | "sent" | "failed" | "deadlettered"

/**
 * One row per outbound delivery job. The runner processes rows in
 * `[conversationKey+createdAt]` order (FIFO per conversation lane).
 */
export interface OutboundJobRow {
  id: string
  adapterId: string
  conversationKey: string
  request: OutboundRequest
  status: OutboundJobStatus
  attempts: number
  lastError?: string
  /** Error code from the last attempt, used by the audit log + breaker. */
  lastErrorCode?: string
  createdAt: number
  /** Wall-clock at which the runner is allowed to retry. */
  nextAttemptAt: number
  idempotencyKey: string
}

/**
 * Per-conversation settings that override the adapter-level defaults.
 * Keyed by `conversationKey` (unique constraint `&conversationKey`).
 */
export interface ConversationOverrideRow {
  id: string
  conversationKey: string
  /** The cognia-next ChatSession this conversation maps to. */
  sessionId: string
  mode?: ConnectorMode
  characterId?: string
  trigger?: Partial<TriggerPolicy>
  pinned?: boolean
  archived?: boolean
  /** Last-read pointer; in tandem with the existing sessionState table. */
  lastReadAt?: number
  /**
   * Per-conversation opt-in for Anthropic native Computer Use tools.
   * G6 default for IM-channel conversations is "no" — operators MUST
   * flip this true explicitly so a Telegram/Discord/Slack reply cannot
   * accidentally fire screenshot / mouse / keyboard actions on the host.
   */
  allowComputerUse?: boolean
  createdAt: number
  updatedAt: number
}

/**
 * Connector audit log row. Aliases `AuditEntry` verbatim; a separate name
 * is used so we can add connector-specific fields in the future without
 * touching the shared type.
 */
export type ConnectorAuditRow = AuditEntry

export type ConnectorDraftStatus = "pending" | "approved" | "rejected" | "expired"

/**
 * One row per outbound draft awaiting human approval (manual mode).
 */
export interface ConnectorDraftRow {
  id: string
  conversationKey: string
  sessionId: string
  segments: MessageSegment[]
  status: ConnectorDraftStatus
  createdAt: number
  expiresAt?: number
  /** The inbound StoredMessage.id this draft is replying to. */
  sourceMessageId?: string
  /** Pre-built OutboundRequest the user can fire on approve (idempotencyKey already issued). */
  outboundPreview?: OutboundRequest
}

/**
 * One row per fetched platform attachment, cached on-disk under
 * `<appData>/cognia/connectors/cache` (encrypted). The `[adapterId+remoteRef]`
 * composite unique index lets the attachment layer do O(1) "do I have it?"
 * checks before issuing a Tauri fetch command.
 */
export interface ConnectorAttachmentRow {
  id: string
  adapterId: string
  remoteRef: string
  /** Path inside <appData>/cognia/connectors/cache (encrypted on disk). */
  localPath: string
  mimeType: string
  sizeBytes: number
  fetchedAt: number
  expiresAt?: number
}

/** Borrowed-shape: same ConversationReference as types/connectors/event.ts. */
export type ConversationReferenceRow = ConversationReference
