import type { UIMessage } from "ai"
import type { StoredMessage } from "@/lib/claude/types"
import { getDb } from "./schema"

function newId() {
  return "m_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export async function listMessages(sessionId: string): Promise<UIMessage[]> {
  const rows = await getDb()
    .messages.where("[sessionId+createdAt]")
    .between([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER])
    .toArray()
  return rows
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((r) => {
      // Hoist top-level senderId/senderKind into metadata so the UI layer can
      // read them off the in-memory UIMessage. (The store itself uses
      // ai.UIMessage which has no senderId field.)
      const metadata: Record<string, unknown> = { ...(r.metadata ?? {}) }
      if (r.senderId !== undefined) metadata.senderId = r.senderId
      if (r.senderKind !== undefined) metadata.senderKind = r.senderKind
      return {
        id: r.id,
        role: r.role,
        parts: r.parts,
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      }
    })
}

/**
 * Persist the current message list for a session.
 *
 * Streaming sends one event per token-batch, so this gets called many times
 * per turn. We diff by id: upsert what's still here, delete what disappeared.
 * That keeps the IO proportional to *changed* messages instead of total
 * messages, which matters once a session grows past a few dozen turns.
 */
export async function persistMessages(sessionId: string, messages: UIMessage[]): Promise<void> {
  const db = getDb()
  const now = Date.now()

  await db.transaction("rw", db.messages, async () => {
    // Existing ids for this session — used to compute deletions.
    const existingIds = new Set(
      await db.messages.where("sessionId").equals(sessionId).primaryKeys()
    )

    if (messages.length === 0) {
      if (existingIds.size > 0) {
        await db.messages.bulkDelete([...existingIds])
      }
      return
    }

    // Build the rows we want to write, preserving order via createdAt.
    // Reuse existing createdAt values where we can so re-ordering doesn't
    // happen on every persist; only new messages get a fresh timestamp.
    const rows: StoredMessage[] = []
    const incomingIds = new Set<string>()

    // Pre-fetch existing rows to preserve their createdAt.
    const existingRows = existingIds.size ? await db.messages.bulkGet([...existingIds]) : []
    const byId = new Map<string, StoredMessage>()
    for (const r of existingRows) {
      if (r) byId.set(r.id, r)
    }

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]
      const id = m.id ?? newId()
      incomingIds.add(id)
      const prior = byId.get(id)
      // `metadata` may carry usage/cost info plus team-routing fields
      // (senderId/senderKind). The latter are hoisted into top-level columns
      // so we can index by senderId for fast lookups.
      const meta = (m as { metadata?: Record<string, unknown> }).metadata
      const senderId = typeof meta?.senderId === "string" ? meta.senderId : undefined
      const senderKindRaw = meta?.senderKind
      const senderKind =
        senderKindRaw === "user" || senderKindRaw === "assistant" || senderKindRaw === "system"
          ? senderKindRaw
          : undefined
      // Strip the routing keys from metadata so we don't persist them twice.
      let strippedMeta: Record<string, unknown> | undefined = meta
      if (meta && (senderId !== undefined || senderKind !== undefined)) {
        const copy = { ...meta }
        delete copy.senderId
        delete copy.senderKind
        strippedMeta = Object.keys(copy).length > 0 ? copy : undefined
      }
      rows.push({
        id,
        sessionId,
        role: m.role,
        parts: m.parts,
        senderId,
        senderKind,
        metadata: strippedMeta,
        createdAt: prior?.createdAt ?? now + i,
      })
    }

    const toDelete: string[] = []
    for (const id of existingIds) {
      if (!incomingIds.has(id)) toDelete.push(id)
    }

    if (toDelete.length > 0) {
      await db.messages.bulkDelete(toDelete)
    }
    await db.messages.bulkPut(rows)
  })
}

export async function clearMessages(sessionId: string): Promise<void> {
  await getDb().messages.where("sessionId").equals(sessionId).delete()
}

/**
 * Drop every message in `sessionId` whose `createdAt` is strictly greater than
 * the anchor message's `createdAt`. Used by edit-and-resend / regenerate to
 * lop off the tail before re-issuing a turn.
 *
 * If the anchor is unknown we delete nothing rather than wiping the session.
 */
export async function truncateAfter(
  sessionId: string,
  anchorMessageId: string,
  options: { inclusive?: boolean } = {}
): Promise<void> {
  const db = getDb()
  const anchor = await db.messages.get(anchorMessageId)
  if (!anchor || anchor.sessionId !== sessionId) return

  const lowerBound = options.inclusive ? anchor.createdAt : anchor.createdAt + 1
  await db.transaction("rw", db.messages, async () => {
    const ids = await db.messages
      .where("[sessionId+createdAt]")
      .between([sessionId, lowerBound], [sessionId, Number.MAX_SAFE_INTEGER])
      .primaryKeys()
    if (ids.length > 0) {
      await db.messages.bulkDelete(ids as string[])
    }
  })
}
