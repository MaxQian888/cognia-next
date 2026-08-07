import type { TranscriptTimelineItem } from "@cognia/agent-config-types"

import { getDb } from "./schema"

export interface ChatTurnSummaryRow {
  sessionId: string
  turnKey: string
  itemKey: string
  order: number
  revision: number
  detailRevision: number
  item: TranscriptTimelineItem
  updatedAt: number
}

export interface ChatTranscriptIndexStateRow {
  sessionId: string
  revision: number
  /** Oldest message timestamp covered by the currently persisted summaries. */
  indexedBeforeCreatedAt: number
  complete: boolean
  updatedAt: number
}

/**
 * Persist one lazily projected timeline page. A revision change invalidates
 * only this session's summaries; no schema migration scans existing messages.
 */
export async function commitTranscriptIndexPage({
  sessionId,
  revision,
  items,
  complete,
  now = Date.now(),
}: {
  sessionId: string
  revision: number
  items: TranscriptTimelineItem[]
  complete: boolean
  now?: number
}): Promise<void> {
  const db = getDb()
  const state = await db.chatTranscriptIndexState.get(sessionId)
  const durableItems = items.filter((item) => item.kind !== "active-turn")
  const rows: ChatTurnSummaryRow[] = durableItems.map((item) => ({
    sessionId,
    turnKey: item.kind === "completed-turn" ? item.turnKey : item.itemKey,
    itemKey: item.itemKey,
    order: item.startedAt,
    revision,
    detailRevision: item.kind === "completed-turn" ? item.detailRevision : revision,
    item,
    updatedAt: now,
  }))
  const indexedBeforeCreatedAt = items.reduce(
    (oldest, item) => Math.min(oldest, item.startedAt),
    state?.revision === revision ? state.indexedBeforeCreatedAt : Number.MAX_SAFE_INTEGER
  )

  await db.transaction("rw", db.chatTurnSummaries, db.chatTranscriptIndexState, async () => {
    if (state && state.revision !== revision) {
      await db.chatTurnSummaries.where("sessionId").equals(sessionId).delete()
    }
    if (rows.length > 0) await db.chatTurnSummaries.bulkPut(rows)
    await db.chatTranscriptIndexState.put({
      sessionId,
      revision,
      indexedBeforeCreatedAt:
        indexedBeforeCreatedAt === Number.MAX_SAFE_INTEGER ? 0 : indexedBeforeCreatedAt,
      complete,
      updatedAt: now,
    })
  })
}

export async function clearTranscriptIndex(sessionId: string): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.chatTurnSummaries, db.chatTranscriptIndexState, async () => {
    await Promise.all([
      db.chatTurnSummaries.where("sessionId").equals(sessionId).delete(),
      db.chatTranscriptIndexState.delete(sessionId),
    ])
  })
}
