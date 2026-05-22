/**
 * MCP tool handlers — Inbox connectors (v49).
 *
 * Six tools, scoped behind two `BridgeScope` values:
 *
 *   • `inbox:connectors:read` — list adapters / conversations / drafts,
 *     fetch audit, export audit as CSV/JSON. Mirrors the operator-facing
 *     Inbox surface so external scripts can build dashboards / digest
 *     summaries without a separate API.
 *   • `inbox:connectors:send` — `connectors_send_message` is the single
 *     write tool. It delegates to `runConnectorDigestTurn` so the existing
 *     PII gate, policy resolver, idempotency cache, and outbound runner
 *     all stay in path. We do NOT re-implement the pipeline here.
 *
 * Pure handlers — input validation + Dexie reads + (for send) a delegated
 * call. The MCP server layer (`lib/external-bridge/mcp-server`) owns the
 * permission gate and protocol envelope.
 */

import { getDb } from "@/lib/db/schema"
import { listRecent as listAuditRecent } from "@/lib/db/connector-audit"
import { toCsv as auditToCsv, toJson as auditToJson } from "@/lib/connectors/audit-export"
import {
  runConnectorDigestTurn,
  type RunDigestInput,
  type RunDigestResult,
} from "@/lib/connectors/scheduled-outbound"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

// ─────────────────────────────────────────────────────────────────────────────
// connectors_list_adapters
// ─────────────────────────────────────────────────────────────────────────────

export interface ConnectorAdapterSummary {
  id: string
  type: string
  displayName: string
  enabled: boolean
  defaultMode: string | undefined
  muted: boolean | undefined
  /** ISO-formatted timestamp of the last whoami / status probe, if known. */
  lastWhoamiAt: number | undefined
}

export async function connectorsListAdapters(): Promise<{
  adapters: ConnectorAdapterSummary[]
}> {
  const rows = (await getDb().adapterInstances.toArray()) as AdapterInstanceRow[]
  return {
    adapters: rows.map((row) => ({
      id: row.id,
      type: row.type,
      displayName: row.displayName,
      enabled: row.enabled,
      defaultMode: row.defaultMode,
      muted: row.muted,
      lastWhoamiAt: row.lastWhoamiAt,
    })),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// connectors_list_conversations
// ─────────────────────────────────────────────────────────────────────────────

export interface ConnectorConversationSummary {
  conversationKey: string
  sessionId: string
  title: string
  platform: string
  adapterId: string
  pinned: boolean
  archived: boolean
  unread: boolean
  lastReadAt: number | undefined
  updatedAt: number
}

export interface ListConversationsInput {
  adapterId?: string
  pinnedOnly?: boolean
  archived?: boolean
  unreadOnly?: boolean
  /** Defaults to 50; clamped to [1, 200]. */
  limit?: number
}

const MAX_CONVERSATIONS = 200
const DEFAULT_CONVERSATIONS = 50

export async function connectorsListConversations(
  input: ListConversationsInput = {}
): Promise<{ conversations: ConnectorConversationSummary[] }> {
  const limit = clamp(input.limit ?? DEFAULT_CONVERSATIONS, 1, MAX_CONVERSATIONS)
  const db = getDb()
  const sessions = await db.sessions.filter((s) => s.platformBinding != null).toArray()
  const overrides = await db.conversationOverrides.toArray()
  const overrideMap = new Map(overrides.map((o) => [o.conversationKey, o]))

  let result: ConnectorConversationSummary[] = sessions
    .map((session) => {
      const binding = session.platformBinding!
      const override = overrideMap.get(binding.conversationKey)
      const lastReadAt = override?.lastReadAt ?? 0
      const unread = lastReadAt < session.updatedAt
      return {
        conversationKey: binding.conversationKey,
        sessionId: session.id,
        title: session.title,
        platform: binding.platform,
        adapterId: binding.adapterId,
        pinned: override?.pinned === true,
        archived: override?.archived === true,
        unread,
        lastReadAt: override?.lastReadAt,
        updatedAt: session.updatedAt,
      }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)

  if (input.adapterId) {
    result = result.filter((row) => row.adapterId === input.adapterId)
  }
  if (input.pinnedOnly) {
    result = result.filter((row) => row.pinned)
  }
  if (input.unreadOnly) {
    result = result.filter((row) => row.unread)
  }
  if (input.archived === true) {
    result = result.filter((row) => row.archived)
  } else if (input.archived === false) {
    result = result.filter((row) => !row.archived)
  }

  return { conversations: result.slice(0, limit) }
}

// ─────────────────────────────────────────────────────────────────────────────
// connectors_get_audit
// ─────────────────────────────────────────────────────────────────────────────

export interface GetAuditInput {
  adapterId?: string
  /** Filter to a single conversation. Applied after the adapterId index. */
  conversationKey?: string
  /** Defaults to 100; clamped to [1, 500]. */
  limit?: number
}

const MAX_AUDIT_LIMIT = 500
const DEFAULT_AUDIT_LIMIT = 100

export async function connectorsGetAudit(input: GetAuditInput = {}): Promise<{
  rows: Awaited<ReturnType<typeof listAuditRecent>>
}> {
  const limit = clamp(input.limit ?? DEFAULT_AUDIT_LIMIT, 1, MAX_AUDIT_LIMIT)
  const rows = await listAuditRecent(input.adapterId, limit)
  const filtered = input.conversationKey
    ? rows.filter((r) => r.conversationKey === input.conversationKey)
    : rows
  return { rows: filtered }
}

// ─────────────────────────────────────────────────────────────────────────────
// connectors_export_audit
// ─────────────────────────────────────────────────────────────────────────────

export interface ExportAuditInput {
  format: "csv" | "json"
  adapterId?: string
  conversationKey?: string
  /** Defaults to 500; clamped to [1, 5000] (matches the cap on the table). */
  limit?: number
}

const MAX_EXPORT_LIMIT = 5000
const DEFAULT_EXPORT_LIMIT = 500

export async function connectorsExportAudit(input: ExportAuditInput): Promise<{
  format: "csv" | "json"
  body: string
  rowCount: number
}> {
  const limit = clamp(input.limit ?? DEFAULT_EXPORT_LIMIT, 1, MAX_EXPORT_LIMIT)
  const rows = await listAuditRecent(input.adapterId, limit)
  const scoped = input.conversationKey
    ? rows.filter((r) => r.conversationKey === input.conversationKey)
    : rows
  const body = input.format === "csv" ? auditToCsv(scoped) : auditToJson(scoped)
  return { format: input.format, body, rowCount: scoped.length }
}

// ─────────────────────────────────────────────────────────────────────────────
// connectors_list_drafts
// ─────────────────────────────────────────────────────────────────────────────

export interface ConnectorDraftSummary {
  id: string
  conversationKey: string
  sessionId: string
  status: string
  createdAt: number
  textPreview: string
}

export async function connectorsListDrafts(): Promise<{
  drafts: ConnectorDraftSummary[]
}> {
  const rows = await getDb().connectorDrafts.toArray()
  return {
    drafts: rows
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((row) => ({
        id: row.id,
        conversationKey: row.conversationKey,
        sessionId: row.sessionId,
        status: row.status,
        createdAt: row.createdAt,
        textPreview: extractTextPreview(row.segments).slice(0, 240),
      })),
  }
}

function extractTextPreview(segments: unknown): string {
  if (!Array.isArray(segments)) return ""
  const buf: string[] = []
  for (const seg of segments) {
    if (!seg || typeof seg !== "object") continue
    const s = seg as { type?: unknown; text?: unknown; md?: unknown }
    if (s.type === "text" && typeof s.text === "string") buf.push(s.text)
    else if (s.type === "markdown" && typeof s.md === "string") buf.push(s.md)
  }
  return buf.join(" ").replace(/\s+/g, " ").trim()
}

// ─────────────────────────────────────────────────────────────────────────────
// connectors_send_message
// ─────────────────────────────────────────────────────────────────────────────

export interface SendMessageInput {
  adapterId: string
  conversationKey: string
  /**
   * The user-visible prompt the assistant should respond to. PII redaction
   * (`safeSendPrompt`) runs on this string inside `runConnectorDigestTurn`
   * and rejects the call if the redacted version differs from the input.
   */
  prompt: string
  /** Optional character override; falls back to the conversation default. */
  characterId?: string
  /** Audit source tag — defaults to `"external-bridge"`. */
  sourceTaskId?: string
}

export interface SendMessageOutput {
  ok: boolean
  /** Surface-level reason when `ok === false`. */
  reason?: string
  /** Set when `ok === true` and the AI loop produced any output. */
  detail?: RunDigestResult["output"]
}

export async function connectorsSendMessage(input: SendMessageInput): Promise<SendMessageOutput> {
  // Pre-flight: confirm the conversation has a bound ChatSession. The
  // digest turn errors out without one, but surfacing the constraint as a
  // typed reason gives the MCP caller a deterministic shape to handle.
  const db = getDb()
  const sessions = await db.sessions
    .filter((s) => s.platformBinding?.conversationKey === input.conversationKey)
    .toArray()
  if (sessions.length === 0) {
    return { ok: false, reason: "session_missing" }
  }
  const digestInput: RunDigestInput = {
    adapterId: input.adapterId,
    conversationKey: input.conversationKey,
    characterId: input.characterId,
    prompt: input.prompt,
    sourceTaskId: input.sourceTaskId ?? "external-bridge",
  }
  const result = await runConnectorDigestTurn(digestInput)
  if (!result.success) {
    return { ok: false, reason: result.error ?? "send_failed" }
  }
  return { ok: true, detail: result.output }
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  return Math.max(min, Math.min(max, Math.trunc(value)))
}

export const __TESTING__ = { clamp, extractTextPreview }
