/**
 * Message-shortcut import (plan 2026-07-24 P5.1).
 *
 * The browser (our web app opened by Lark's 消息快捷操作) supplies chat +
 * message ids AS A REQUEST — nothing client-side is trusted. The brain:
 *
 *   1. gates on `larkMessageShortcut` + principal resolution (fail closed),
 *   2. verifies the requester is a member of the chat,
 *   3. replays idempotently via `sourceHash` (same selection → same session),
 *   4. re-fetches EVERY message by id from the platform and drops any whose
 *      `chat_id` differs from the claimed chat (id smuggling), any recalled/
 *      deleted message, and any without recoverable content,
 *   5. writes ONE delimited quoted block into a fresh platform-bound session
 *      — marked as an import in message metadata, never impersonating an
 *      organic user turn. Model calls happen later through the normal send
 *      path, so the existing PII gate is unchanged.
 */

import type { NormalizedInboundEvent } from "@/types/connectors/event"
import { buildConversationKey } from "@/types/connectors/event"
import type { StoredMessage } from "@cognia/agent-config-types"
import { appendAudit } from "@/lib/connectors/audit"
import { isLarkFeatureEnabled } from "@/lib/connectors/feature-flags"
import {
  getActiveRuntimeAccountId,
  hashOpenId,
  resolveConnectorPrincipal,
} from "@/lib/connectors/principal/resolve"
import { recordConnectorMetric } from "@/lib/connectors/metrics"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import {
  computeImportSourceHash,
  findImportBySourceHash,
  recordMessageImport,
} from "@/lib/db/lark-message-imports"
import { getDb } from "@/lib/db/schema"
import { createPlatformSession } from "@/lib/connectors/session-bindings"
import { larkTenantRequest, type LarkCredentials } from "./http"
import { parseLarkEventEnvelope, type LarkEventEnvelope } from "./parse"
import { markSessionDirty } from "@/lib/chat/search/indexer"
import { invalidatePersistSnapshot } from "@/lib/db/messages"

export const IMPORT_MAX_MESSAGES = 20

export interface ImportMessagesInput {
  adapterId: string
  chatId: string
  messageIds: string[]
  verifiedIdentity: { openId: string; tenantKey?: string; appId?: string }
  triggerId?: string
}

export type ImportMessagesOutcome =
  | {
      ok: true
      sessionId: string
      conversationKey: string
      imported: number
      skipped: Array<{ messageId: string; reason: string }>
      replay: boolean
    }
  | { ok: false; error: string }

export interface ImportMessagesDependencies {
  tenantRequest: typeof larkTenantRequest
  keyringGet: (adapterId: string, credential: string) => Promise<string | null>
  getAdapter: typeof getAdapterInstance
  isMember: (adapterId: string, chatId: string, openId: string) => Promise<boolean>
  audit: typeof appendAudit
  metric: typeof recordConnectorMetric
  now: () => number
}

async function credsFor(
  deps: ImportMessagesDependencies,
  adapterId: string
): Promise<LarkCredentials | null> {
  const [appId, appSecret] = await Promise.all([
    deps.keyringGet(adapterId, "appId"),
    deps.keyringGet(adapterId, "appSecret"),
  ])
  return appId && appSecret ? { appId, appSecret } : null
}

interface RawLarkHistoryItem {
  message_id?: string
  chat_id?: string
  chat_type?: string
  msg_type?: string
  body?: { content?: string }
  sender?: LarkEventEnvelope["event"]["sender"]
  mentions?: unknown
  create_time?: string
  thread_id?: string | null
  deleted?: boolean
}

/**
 * Fetch one message by id and project it through the live event parser
 * (same live-shape normalisation as `fetchHistory`: `msg_type` →
 * `message_type`, `body.content` → `content`). Returns a skip reason
 * instead of an event when the message cannot be imported.
 */
async function fetchVerifiedMessage(
  deps: ImportMessagesDependencies,
  creds: LarkCredentials,
  adapterId: string,
  chatId: string,
  messageId: string
): Promise<{ event: NormalizedInboundEvent } | { skip: string }> {
  let raw: RawLarkHistoryItem | undefined
  try {
    const parsed = (await deps.tenantRequest(
      creds,
      "GET",
      `/im/v1/messages/${encodeURIComponent(messageId)}`
    )) as { data?: { items?: RawLarkHistoryItem[] } } | null
    raw = parsed?.data?.items?.[0]
  } catch {
    return { skip: "fetch_failed" }
  }
  if (!raw?.message_id) return { skip: "not_found" }
  // The single strongest server-side check: the message must live in the
  // chat the requester claimed (and was membership-verified against).
  if (raw.chat_id !== chatId) return { skip: "chat_mismatch" }
  if (raw.deleted === true) return { skip: "recalled" }
  if (raw.msg_type === "system") return { skip: "unsupported" }

  const envelope: LarkEventEnvelope = {
    schema: "2.0",
    header: { event_id: `import:${raw.message_id}`, event_type: "im.message.receive_v1" },
    event: {
      sender: raw.sender,
      message: {
        message_id: raw.message_id,
        chat_id: raw.chat_id ?? chatId,
        chat_type: (raw.chat_type ?? "group") as "p2p" | "group",
        message_type: raw.msg_type ?? "",
        content: raw.body?.content ?? "",
        mentions: raw.mentions as never,
        create_time: raw.create_time,
        thread_id: raw.thread_id ?? null,
      },
    },
  }
  const event = parseLarkEventEnvelope(adapterId, "", envelope)
  if (!event || !event.plainText.trim()) return { skip: "unsupported" }
  return { event }
}

/** Delimited quoted block — explicitly an import, not an organic turn. */
export function buildImportedContextBlock(
  events: NormalizedInboundEvent[],
  meta: { chatId: string; importedAt: number }
): string {
  const lines = events.map((event) => {
    const sender = event.sender.displayName ?? event.sender.remoteUserId
    return `${sender}: ${event.plainText}`
  })
  return [
    `[Imported from Feishu / 从飞书导入 · ${events.length} message(s) · chat ${meta.chatId}]`,
    "-----",
    ...lines,
    "-----",
    "[End of imported messages / 导入结束]",
  ].join("\n")
}

function defaults(overrides: Partial<ImportMessagesDependencies>): ImportMessagesDependencies {
  return {
    tenantRequest: larkTenantRequest,
    keyringGet: () => Promise.resolve(null),
    getAdapter: getAdapterInstance,
    isMember: () => Promise.reject(new Error("isMember dependency not wired")),
    audit: appendAudit,
    metric: recordConnectorMetric,
    now: Date.now,
    ...overrides,
  }
}

export async function importLarkMessages(
  input: ImportMessagesInput,
  overrides: Partial<ImportMessagesDependencies> = {}
): Promise<ImportMessagesOutcome> {
  const deps = defaults(overrides)
  const now = deps.now()
  const openIdHash = await hashOpenId(input.verifiedIdentity.openId)

  const deny = async (error: string): Promise<ImportMessagesOutcome> => {
    deps.metric("lark_message_import_denied_total")
    await deps
      .audit({
        adapterId: input.adapterId,
        kind: "shortcut.import_denied",
        at: now,
        reason: error,
        fields: { chatId: input.chatId, openIdHash, requested: input.messageIds.length },
      })
      .catch(() => undefined)
    return { ok: false, error }
  }

  const adapterRow = await deps.getAdapter(input.adapterId).catch(() => undefined)
  if (!isLarkFeatureEnabled("larkMessageShortcut", adapterRow)) {
    return deny("feature_disabled")
  }

  const ids = [...new Set(input.messageIds)].filter(Boolean)
  if (ids.length === 0 || ids.length > IMPORT_MAX_MESSAGES) {
    return deny("message_count_invalid")
  }

  // Fail-closed principal gate (legacy passes through when the registry
  // flag is off — same contract as the inbound pipeline).
  const resolution = await resolveConnectorPrincipal({
    platform: "lark",
    adapterRow: adapterRow ?? { settings: {} },
    remoteUserId: input.verifiedIdentity.openId,
    identityScope: {
      tenantKey: input.verifiedIdentity.tenantKey,
      appId: input.verifiedIdentity.appId,
    },
    activeAccountId: getActiveRuntimeAccountId(),
  })
  if (resolution.status !== "resolved" && resolution.status !== "legacy") {
    return deny(`principal_${resolution.status}`)
  }

  try {
    if (!(await deps.isMember(input.adapterId, input.chatId, input.verifiedIdentity.openId))) {
      return deny("membership_denied")
    }
  } catch {
    return deny("membership_check_failed")
  }

  // Idempotent replay: the same selection always answers with the session
  // it originally produced.
  const sourceHash = await computeImportSourceHash(input.adapterId, input.chatId, ids)
  const existing = await findImportBySourceHash(sourceHash)
  if (existing) {
    return {
      ok: true,
      sessionId: existing.sessionId,
      conversationKey: existing.conversationKey,
      imported: existing.messageIds.length,
      skipped: existing.skipped ?? [],
      replay: true,
    }
  }

  const creds = await credsFor(deps, input.adapterId)
  if (!creds) return deny("credentials_unavailable")

  const events: NormalizedInboundEvent[] = []
  const skipped: Array<{ messageId: string; reason: string }> = []
  for (const messageId of ids) {
    const result = await fetchVerifiedMessage(deps, creds, input.adapterId, input.chatId, messageId)
    if ("event" in result) events.push(result.event)
    else skipped.push({ messageId, reason: result.skip })
  }
  if (events.length === 0) return deny("no_importable_messages")

  const conversationKey = buildConversationKey("lark", input.adapterId, input.chatId)
  const sessionSeed: NormalizedInboundEvent = {
    ...events[0],
    adapterId: input.adapterId,
    conversationKey,
    channel: { ...events[0].channel, id: conversationKey },
  }
  const session = await createPlatformSession(sessionSeed, undefined)

  const block = buildImportedContextBlock(events, { chatId: input.chatId, importedAt: now })
  const message: StoredMessage = {
    id: crypto.randomUUID(),
    sessionId: session.id,
    role: "user",
    parts: [{ type: "text", text: block }],
    metadata: {
      larkImport: {
        sourceHash,
        chatId: input.chatId,
        messageIds: ids,
        ...(input.triggerId ? { triggerId: input.triggerId } : {}),
        importedAt: now,
      },
    },
    createdAt: now,
  }
  await getDb().messages.add(message)
  markSessionDirty(session.id)
  invalidatePersistSnapshot(session.id)

  await recordMessageImport({
    sourceHash,
    adapterId: input.adapterId,
    chatId: input.chatId,
    conversationKey,
    sessionId: session.id,
    messageIds: events.map((event) => event.messageId),
    skipped: skipped.length > 0 ? skipped : undefined,
    now,
  })
  deps.metric("lark_message_imports_total")
  await deps
    .audit({
      adapterId: input.adapterId,
      kind: "shortcut.import",
      at: now,
      conversationKey,
      fields: {
        chatId: input.chatId,
        openIdHash,
        imported: events.length,
        skipped: skipped.length,
        sessionId: session.id,
      },
    })
    .catch(() => undefined)

  return {
    ok: true,
    sessionId: session.id,
    conversationKey,
    imported: events.length,
    skipped,
    replay: false,
  }
}
