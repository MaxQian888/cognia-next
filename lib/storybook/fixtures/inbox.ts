// Fixture builders for inbox stories (connector conversations, drafts, …).
// Spread `over` to vary a single field; all required columns get realistic
// defaults so the row is valid to `bulkPut` into Dexie via `seedDb`.
import type {
  AdapterInstanceRow,
  ConnectorDraftRow,
  ConnectorHeartbeatRow,
  ConversationOverrideRow,
  OutboundJobRow,
} from "@/lib/db/connector-types"
import type { ConversationLabelRow } from "@/lib/db/crm-types"
import type { AuditEntry } from "@/types/connectors/audit"
import type { ChatSession, StoredMessage } from "@/lib/claude/types"
import type { PlatformKind } from "@/types/connectors/platform-kind"

let draftSeq = 0

export function makeConnectorDraft(over: Partial<ConnectorDraftRow> = {}): ConnectorDraftRow {
  draftSeq += 1
  return {
    id: `draft-${draftSeq}`,
    conversationKey: "story:conversation",
    sessionId: "story-session",
    segments: [{ type: "text", text: "Drafted reply awaiting review." }],
    status: "pending",
    createdAt: draftSeq,
    sourceMessageId: `msg-${draftSeq}`,
    ...over,
  }
}

let adapterSeq = 0

/** A configured platform adapter row (the source of the policy chips). */
export function makeAdapterInstance(over: Partial<AdapterInstanceRow> = {}): AdapterInstanceRow {
  adapterSeq += 1
  const now = Date.now()
  return {
    id: `adapter-${adapterSeq}`,
    type: "slack",
    displayName: "Acme Slack",
    enabled: true,
    transportMode: "webhook",
    settings: {},
    credentialsRef: { keyringService: "com.cognia.platforms", accounts: [] },
    trigger: {
      rules: [{ kind: "private-default" }],
      blockers: [],
      storeUnmatchedInDraftMode: false,
    },
    defaultMode: "auto",
    createdAt: now,
    updatedAt: now,
    ...over,
  }
}

let overrideSeq = 0

/** A per-conversation override row (mode, computer-use, status, labels …). */
export function makeConversationOverride(
  over: Partial<ConversationOverrideRow> = {}
): ConversationOverrideRow {
  overrideSeq += 1
  const now = Date.now()
  return {
    id: `override-${overrideSeq}`,
    conversationKey: "slack:adapter-1:C1",
    sessionId: "story-session",
    createdAt: now,
    updatedAt: now,
    ...over,
  }
}

let outboundSeq = 0

/** An outbound delivery job (drives `OutboundStatusPill`). */
export function makeOutboundJob(over: Partial<OutboundJobRow> = {}): OutboundJobRow {
  outboundSeq += 1
  const now = Date.now()
  return {
    id: `job-${outboundSeq}`,
    adapterId: "adapter-1",
    conversationKey: "slack:adapter-1:C1",
    request: {
      conversationRef: {
        adapterId: "adapter-1",
        conversationKey: "slack:adapter-1:C1",
        platform: "slack",
      } as OutboundJobRow["request"]["conversationRef"],
      segments: [{ type: "text", text: "Outbound reply" }],
      metadata: { idempotencyKey: `idem-${outboundSeq}` },
    },
    status: "pending",
    attempts: 0,
    createdAt: now,
    nextAttemptAt: now,
    idempotencyKey: `idem-${outboundSeq}`,
    source: "ai-run",
    ...over,
  }
}

let labelSeq = 0

/** A conversation label/tag catalog row. */
export function makeConversationLabel(
  over: Partial<ConversationLabelRow> = {}
): ConversationLabelRow {
  labelSeq += 1
  const now = Date.now()
  return {
    id: `label-${labelSeq}`,
    name: "follow-up",
    color: "#f59e0b",
    sortOrder: labelSeq,
    createdAt: now,
    updatedAt: now,
    ...over,
  }
}

let heartbeatSeq = 0

/** A connector heartbeat snapshot (drives the connection-loss banner). */
export function makeHeartbeat(over: Partial<ConnectorHeartbeatRow> = {}): ConnectorHeartbeatRow {
  heartbeatSeq += 1
  return {
    id: `hb-${heartbeatSeq}`,
    adapterId: "adapter-1",
    kind: "adapter.heartbeat",
    at: Date.now(),
    fields: { state: "running" },
    ...over,
  }
}

let auditSeq = 0

/** A connector-audit row (e.g. `outbound.queue_capped` for saturation). */
export function makeAuditEntry(over: Partial<AuditEntry> = {}): AuditEntry {
  auditSeq += 1
  return {
    id: `audit-${auditSeq}`,
    adapterId: "adapter-1",
    kind: "outbound.queue_capped",
    at: Date.now(),
    ...over,
  }
}

let sessionSeq = 0

/**
 * A platform-bound `ChatSession` (drives the conversation list / command
 * palette). Pass `platform` + `conversationKey` to control the binding.
 */
export function makeInboxSession(
  over: {
    id?: string
    title?: string
    platform?: PlatformKind
    adapterId?: string
    conversationKey?: string
    updatedAt?: number
    createdAt?: number
  } = {}
): ChatSession {
  sessionSeq += 1
  const id = over.id ?? `session-${sessionSeq}`
  const platform = over.platform ?? "slack"
  const adapterId = over.adapterId ?? "adapter-1"
  const conversationKey = over.conversationKey ?? `${platform}:${adapterId}:C${sessionSeq}`
  const now = over.updatedAt ?? Date.now()
  return {
    id,
    title: over.title ?? "Acme Corp · #support",
    kind: "direct",
    platformBinding: { platform, adapterId, conversationKey },
    createdAt: over.createdAt ?? now,
    updatedAt: now,
  } as unknown as ChatSession
}

let messageSeq = 0

/** A stored message row for a session (drives unread counts + previews). */
export function makeInboxMessage(over: Partial<StoredMessage> = {}): StoredMessage {
  messageSeq += 1
  return {
    id: `msg-${messageSeq}`,
    sessionId: "session-1",
    role: "user",
    parts: [{ type: "text", text: "Hi, I need help with my order." }],
    createdAt: Date.now() - messageSeq * 1000,
    ...over,
  } as unknown as StoredMessage
}
