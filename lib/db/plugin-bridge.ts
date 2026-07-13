/**
 * Plugin-facing Dexie bridge.
 *
 * The plugin Session API was drafted against a `content`-based message
 * shape; cognia-next stores messages as `StoredMessage` (with `parts`).
 * Rather than splitting the plugin runtime in two, this module gives
 * plugins a small, classic CRUD surface (`messageRepository`) and a
 * `db` proxy that exposes Dexie tables for hook subscription.
 *
 * Translation rules:
 *   StoredMessage  → UIMessage  (read):  parts[0].text  → content
 *   UIMessage      → StoredMessage (write):  content  → parts: [{type:'text', text}]
 *
 * Plugins that want richer parts-based interaction can read the
 * underlying `db.messages` table directly; the repository is a
 * convenience for the common case.
 */

import { isTauri } from "@/lib/platform/detect"
import type { StoredMessage } from "@cognia/agent-config-types"
import type { UIMessage } from "@/types"
import { getDb } from "./schema"

/**
 * Proxy that lazy-resolves Dexie tables. Plugin code that hooks
 * `db.messages.hook('creating', ...)` works the same way it does in
 * Cognia: get a table reference, register a hook.
 */
export const db = new Proxy(
  {},
  {
    get(_target, prop) {
      const dexie = getDb() as unknown as Record<string, unknown>
      return dexie[prop as string]
    },
  }
) as ReturnType<typeof getDb>

/**
 * Best-effort extract a single text string from a parts-based message.
 * Concatenates all `text` parts; non-text parts are silently dropped.
 */
function partsToContent(parts: StoredMessage["parts"]): string {
  if (!Array.isArray(parts)) return ""
  return parts
    .map((p) => {
      const part = p as { type?: string; text?: string }
      if (part?.type === "text" && typeof part.text === "string") return part.text
      return ""
    })
    .join("")
}

function contentToParts(content: string): StoredMessage["parts"] {
  // The `parts` union is constrained by `ai.UIMessage`; a single text
  // part is universally valid.
  return [{ type: "text", text: content }] as unknown as StoredMessage["parts"]
}

function storedToPlugin(row: StoredMessage): UIMessage {
  const meta = row.metadata ?? {}
  return {
    ...row,
    content: partsToContent(row.parts),
    attachments: Array.isArray((meta as { attachments?: unknown }).attachments)
      ? ((meta as { attachments?: UIMessage["attachments"] }).attachments ?? undefined)
      : undefined,
    tokens: (meta as { tokens?: UIMessage["tokens"] }).tokens,
    branchId:
      typeof (meta as { branchId?: unknown }).branchId === "string"
        ? (meta as { branchId: string }).branchId
        : undefined,
  }
}

function pluginToStored(sessionId: string, msg: UIMessage): StoredMessage {
  // Prefer caller-provided `parts`; fall back to wrapping `content`.
  const parts = msg.parts && msg.parts.length > 0 ? msg.parts : contentToParts(msg.content ?? "")
  const meta: Record<string, unknown> = { ...(msg.metadata ?? {}) }
  if (msg.attachments) meta.attachments = msg.attachments
  if (msg.tokens) meta.tokens = msg.tokens
  if (msg.branchId) meta.branchId = msg.branchId
  return {
    id: msg.id,
    sessionId,
    role: msg.role,
    parts,
    senderId: msg.senderId,
    senderKind: msg.senderKind,
    metadata: Object.keys(meta).length > 0 ? meta : undefined,
    createdAt: normalizeTimestamp((msg as { createdAt?: unknown }).createdAt),
  }
}

function normalizeTimestamp(value: unknown): number {
  if (typeof value === "number") return value
  if (value instanceof Date) return value.getTime()
  return Date.now()
}

/**
 * Phase A3 — broadcast a message mutation to companion WebSocket subscribers
 * (mobile). Uses a lazy import of `@tauri-apps/api/event` so the web build
 * stays decoupled from Tauri at the type level. Failures are swallowed:
 * the database write has already succeeded and we never want a broadcast
 * hiccup to surface as a Dexie error.
 */
async function emitMessageEvent(
  kind: "added" | "updated" | "deleted",
  payload: { sessionId: string; messageId: string; updates?: Record<string, unknown> }
): Promise<void> {
  if (!isTauri()) return
  try {
    const moduleId = "@tauri-apps/api/event"
    const mod = (await import(/* webpackIgnore: true */ moduleId)) as {
      emit: (event: string, payload: unknown) => Promise<void>
    }
    await mod.emit(`claude://message-${kind}`, payload)
  } catch {
    // Tauri unavailable or transport hiccup — best effort.
  }
}

export const messageRepository = {
  /** Fetch all messages for a session, ordered by createdAt asc. */
  async getBySessionId(sessionId: string): Promise<UIMessage[]> {
    const rows = await getDb().messages.where("sessionId").equals(sessionId).toArray()
    rows.sort((a, b) => a.createdAt - b.createdAt)
    return rows.map(storedToPlugin)
  },

  /**
   * Branch-aware fetch. Until cognia-next ships first-class branches,
   * we filter on `metadata.branchId`; messages without a branch tag
   * fall back to the default branch.
   */
  async getBySessionIdAndBranch(sessionId: string, branchId: string): Promise<UIMessage[]> {
    const rows = await getDb().messages.where("sessionId").equals(sessionId).toArray()
    rows.sort((a, b) => a.createdAt - b.createdAt)
    return rows
      .filter((r) => {
        const tag = (r.metadata as { branchId?: unknown } | undefined)?.branchId
        return typeof tag === "string" ? tag === branchId : branchId === "default"
      })
      .map(storedToPlugin)
  },

  async create(sessionId: string, message: UIMessage): Promise<UIMessage> {
    const row = pluginToStored(sessionId, message)
    await getDb().messages.put(row)
    void emitMessageEvent("added", { sessionId, messageId: message.id })
    return storedToPlugin(row)
  },

  async update(messageId: string, updates: Partial<UIMessage>): Promise<void> {
    const dexie = getDb()
    const existing = await dexie.messages.get(messageId)
    if (!existing) return

    const meta: Record<string, unknown> = { ...(existing.metadata ?? {}) }
    if (updates.attachments !== undefined) meta.attachments = updates.attachments
    if (updates.tokens !== undefined) meta.tokens = updates.tokens
    if (updates.branchId !== undefined) meta.branchId = updates.branchId

    const patch: Partial<StoredMessage> = {}
    if (updates.role !== undefined) patch.role = updates.role
    if (updates.parts !== undefined) {
      patch.parts = updates.parts
    } else if (updates.content !== undefined) {
      patch.parts = contentToParts(updates.content)
    }
    if (updates.senderId !== undefined) patch.senderId = updates.senderId
    if (updates.senderKind !== undefined) patch.senderKind = updates.senderKind
    if (Object.keys(meta).length > 0) {
      patch.metadata = meta
    }

    await dexie.messages.update(messageId, patch as Partial<StoredMessage>)
    void emitMessageEvent("updated", {
      sessionId: existing.sessionId,
      messageId,
      updates: updates as Record<string, unknown>,
    })
  },

  async delete(messageId: string): Promise<void> {
    const existing = await getDb().messages.get(messageId)
    await getDb().messages.delete(messageId)
    if (existing) {
      void emitMessageEvent("deleted", {
        sessionId: existing.sessionId,
        messageId,
      })
    }
  },

  async deleteBySessionId(sessionId: string): Promise<void> {
    await getDb().messages.where("sessionId").equals(sessionId).delete()
  },
}
