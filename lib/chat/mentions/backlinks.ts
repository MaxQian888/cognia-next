/**
 * "What referenced this?" — the read side of `lib/db/mention-links.ts`.
 *
 * Grouped by conversation rather than returned flat, because that is the shape
 * of the answer people want: not "seventeen turns cited this memory" but "three
 * conversations did, and here is the first turn in each". The message id is
 * kept so the row can land on the exact turn via `jumpToSessionMessage`.
 *
 * Address a record the way its `ContextRef` does. A `@memory:` pick records
 * `{ kind: "entity", id: "memory:mem_1" }`, so an entity is addressed by
 * `entityBacklinkTarget("memory", "mem_1")` and a file by its relPath — the
 * helpers below are the only place that composition is spelled, so a caller
 * cannot half-remember it.
 */

import type { EntitySelectionKind } from "@/types/artifact/artifact"
import type { ContextRefKind } from "./types"

export interface BacklinkTarget {
  refKind: ContextRefKind
  refId: string
}

/** The five first-party record kinds all share the `entity` ref kind. */
export function entityBacklinkTarget(
  entityKind: EntitySelectionKind,
  recordId: string
): BacklinkTarget {
  return { refKind: "entity", refId: `${entityKind}:${recordId}` }
}

/** A conversation referenced as a whole (`@chat:`). */
export function sessionBacklinkTarget(sessionId: string): BacklinkTarget {
  return entityBacklinkTarget("session", sessionId)
}

export interface BacklinkGroup {
  sessionId: string
  /** Conversation title at read time, or the id when it has none. */
  sessionTitle: string
  /** Newest citing message in this conversation — where a jump lands. */
  messageId: string
  /** That message's timestamp; the list is ordered by it. */
  createdAt: number
  /** Turns in this conversation that cited the record. */
  count: number
}

export interface BacklinkSummary {
  /** Conversations that cited the record, newest citation first. */
  groups: BacklinkGroup[]
  /** Total citing turns across all conversations. */
  total: number
}

export const EMPTY_BACKLINKS: BacklinkSummary = { groups: [], total: 0 }

/**
 * Conversations citing one record.
 *
 * Excludes `excludeSessionId`, which is how the chat header avoids telling a
 * conversation that it references itself — a `@msg:` pick pointed at an earlier
 * turn of the same chat is a real citation, but it is not a BACKLINK in the
 * sense the badge means ("who else reached for this").
 */
export async function loadBacklinks(
  target: BacklinkTarget,
  { excludeSessionId, limit = 50 }: { excludeSessionId?: string; limit?: number } = {}
): Promise<BacklinkSummary> {
  const { listMentionLinksFor } = await import("@/lib/db/mention-links")
  const { getDb } = await import("@/lib/db/schema")
  const rows = (await listMentionLinksFor(target.refKind, target.refId, limit)).filter(
    (row) => row.sessionId !== excludeSessionId
  )
  if (rows.length === 0) return EMPTY_BACKLINKS

  // Rows arrive newest-first, so the first row per session is both the newest
  // citation and the one a jump should land on.
  const bySession = new Map<string, BacklinkGroup>()
  for (const row of rows) {
    const existing = bySession.get(row.sessionId)
    if (existing) {
      existing.count++
      continue
    }
    bySession.set(row.sessionId, {
      sessionId: row.sessionId,
      sessionTitle: row.sessionId,
      messageId: row.messageId,
      createdAt: row.createdAt,
      count: 1,
    })
  }

  // One `bulkGet` for the titles rather than a read per group — the same rule
  // `lib/chat/search/engine.ts` follows for its hit sessions.
  const ids = [...bySession.keys()]
  const sessions = await getDb().sessions.bulkGet(ids)
  for (const [index, session] of sessions.entries()) {
    const group = bySession.get(ids[index])
    // A citing session that no longer exists keeps its row: the count is still
    // true, and dropping it would silently under-report.
    if (group && session?.title) group.sessionTitle = session.title
  }

  return {
    groups: [...bySession.values()].sort((a, b) => b.createdAt - a.createdAt),
    total: rows.length,
  }
}
