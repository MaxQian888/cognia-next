/**
 * Chat-history search-text store (ADR-0099).
 *
 * One lean row per message holding *only* the projected searchable text — never
 * `parts`. Two reasons it is a table of its own rather than a column on
 * `messages`:
 *
 *  1. The search path must never load `parts`. A single message can carry tens of
 *     KB of tool output or a content-addressed media reference set; reading whole
 *     message rows to search them is exactly what made the old
 *     `searchSessionsByContent` unusable.
 *  2. It is derived data. It can be dropped and rebuilt at any time, which is
 *     what makes the lazy backfill safe to interrupt.
 *
 * There is deliberately **no inverted index**. Because highlighting needs
 * character offsets, the final decision is always `indexOf` over the text — and
 * once the text is reachable, `indexOf` is faster than an index probe. See the
 * resident corpus in `lib/chat/search/corpus.ts`.
 *
 * Writes are keyed by `messageId` and therefore idempotent: Tauri runs several
 * WebViews against one IndexedDB (main, pet, pet-overlay, pet-popup), and
 * re-projecting a message from two of them overwrites rather than duplicates. No
 * leader election, and so no "the leader window was closed" liveness hole.
 */

import type { StoredMessage } from "@cognia/agent-config-types"

import { projectSearchText } from "@/lib/chat/search/project-text"
import { getDb } from "./schema"

/** Lean, searchable projection of one message. */
export interface ChatSearchTextRow {
  messageId: string
  sessionId: string
  /**
   * `""` for pre-isolation messages that predate the v86 `projectId` stamp.
   * Never `undefined`: Dexie omits a row from a compound index when any
   * component key is absent, so an undefined `projectId` would make the row
   * invisible to `[projectId+createdAt]` — that is, unsearchable.
   */
  projectId: string
  role: string
  createdAt: number
  text: string
}

/** Descending-backfill bookkeeping. Single row, key `"singleton"`. */
export interface ChatSearchStateRow {
  id: "singleton"
  /**
   * `createdAt` of the oldest message the backfill has examined. Everything
   * newer has been projected. `null` = the walk has not started.
   */
  oldestProjectedAt: number | null
  /**
   * `id` of that same message. Needed as well as the timestamp because the walk
   * is ordered by `[createdAt+id]` and several messages routinely share a
   * millisecond — resuming on the timestamp alone would either re-read or skip
   * the tied rows.
   */
  oldestProjectedId: string | null
  /** True once the walk reached the oldest message. */
  complete: boolean
  updatedAt: number
}

export const DEFAULT_CHAT_SEARCH_STATE: ChatSearchStateRow = {
  id: "singleton",
  oldestProjectedAt: null,
  oldestProjectedId: null,
  complete: false,
  updatedAt: 0,
}

/** Messages examined per lazy-backfill step. */
export const BACKFILL_BATCH_SIZE = 500

/** Rows read per page when scanning history beyond the resident corpus. */
const SCAN_PAGE_SIZE = 1_000

/**
 * Project one message into its search row, or `null` when there is nothing to
 * match against. Storing an empty projection would cost space and buy nothing —
 * but callers must still advance their watermark past it (see
 * {@link backfillChatSearchTextStep}), or a message that projects to nothing
 * would wedge the walk on the same batch forever.
 */
export function projectMessageToSearchRow(message: StoredMessage): ChatSearchTextRow | null {
  const text = projectSearchText(message.parts)
  if (!text) return null
  return {
    messageId: message.id,
    sessionId: message.sessionId,
    projectId: message.projectId ?? "",
    role: message.role,
    createdAt: message.createdAt,
    text,
  }
}

/** Upsert a batch of projections. Idempotent by `messageId`. */
export async function putChatSearchText(rows: readonly ChatSearchTextRow[]): Promise<void> {
  if (rows.length === 0) return
  await getDb().chatSearchText.bulkPut(rows as ChatSearchTextRow[])
}

/**
 * Drop projections for specific messages. Called from the message delete /
 * truncate paths — a surviving projection would keep producing hits that jump to
 * a message that is no longer there.
 */
export async function deleteChatSearchTextForMessages(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  await getDb().chatSearchText.bulkDelete(ids as string[])
}

/** Drop every projection of a session. Called from the session delete paths. */
export async function deleteChatSearchTextForSession(sessionId: string): Promise<void> {
  await getDb().chatSearchText.where("sessionId").equals(sessionId).delete()
}

export async function countChatSearchText(): Promise<number> {
  return getDb().chatSearchText.count()
}

/**
 * Re-project a whole session and reconcile its projections.
 *
 * Whole-session rather than incremental because `truncateAfter` and the
 * regenerate/edit flows *remove* messages: an append-only indexer would leave
 * projections behind that keep matching and then jump to a message that no
 * longer renders. Reconciling means one read of the session's rows through
 * `[sessionId+createdAt]` — cheap, and it makes the index exactly correct after
 * any mutation rather than eventually correct after the right one.
 *
 * Returns the rows written, so the caller can fold them into the resident corpus
 * without re-reading them.
 */
export async function reprojectSession(sessionId: string): Promise<{
  written: ChatSearchTextRow[]
  removed: string[]
}> {
  const db = getDb()
  const messages = (await db.messages
    .where("[sessionId+createdAt]")
    .between([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER])
    .toArray()) as StoredMessage[]

  const written: ChatSearchTextRow[] = []
  const live = new Set<string>()
  for (const message of messages) {
    live.add(message.id)
    const projected = projectMessageToSearchRow(message)
    if (projected) written.push(projected)
  }

  const existing = await db.chatSearchText.where("sessionId").equals(sessionId).primaryKeys()
  // A message that is gone, and one that now projects to nothing (its text was
  // edited away), are the same case: drop the projection.
  const keep = new Set(written.map((row) => row.messageId))
  const removed = (existing as string[]).filter((id) => !keep.has(id) || !live.has(id))

  if (removed.length > 0) await db.chatSearchText.bulkDelete(removed)
  await putChatSearchText(written)

  return { written, removed }
}

export async function getChatSearchState(): Promise<ChatSearchStateRow> {
  const row = await getDb().chatSearchState.get("singleton")
  return row ?? DEFAULT_CHAT_SEARCH_STATE
}

export async function setChatSearchState(
  patch: Partial<Omit<ChatSearchStateRow, "id" | "updatedAt">>
): Promise<void> {
  const current = await getChatSearchState()
  await getDb().chatSearchState.put({
    ...current,
    ...patch,
    id: "singleton",
    updatedAt: Date.now(),
  })
}

/**
 * Project one descending batch of history.
 *
 * Newest-first on purpose: users search recent conversations far more often than
 * old ones, so walking down from the newest message makes search useful within
 * the first step instead of after the whole corpus is done. The upgrade callback
 * stays O(1) and this runs at idle.
 *
 * The watermark advances by messages **examined**, not messages stored, so a
 * batch that projects to nothing still makes progress.
 */
export async function backfillChatSearchTextStep({
  batchSize = BACKFILL_BATCH_SIZE,
}: { batchSize?: number } = {}): Promise<{ projected: number; complete: boolean }> {
  const state = await getChatSearchState()
  if (state.complete) return { projected: 0, complete: true }

  const db = getDb()
  const ordered =
    state.oldestProjectedAt === null || state.oldestProjectedId === null
      ? db.messages.orderBy("[createdAt+id]")
      : db.messages
          .where("[createdAt+id]")
          .below([state.oldestProjectedAt, state.oldestProjectedId])

  const batch = (await ordered.reverse().limit(batchSize).toArray()) as StoredMessage[]

  if (batch.length === 0) {
    await setChatSearchState({ complete: true })
    return { projected: 0, complete: true }
  }

  const rows: ChatSearchTextRow[] = []
  for (const message of batch) {
    const projected = projectMessageToSearchRow(message)
    if (projected) rows.push(projected)
  }
  await putChatSearchText(rows)

  const oldest = batch[batch.length - 1]
  const complete = batch.length < batchSize
  await setChatSearchState({
    oldestProjectedAt: oldest.createdAt,
    oldestProjectedId: oldest.id,
    complete,
  })

  return { projected: rows.length, complete }
}

/** The newest `limit` projections, newest-first. Seeds the resident corpus. */
export async function loadNewestChatSearchText(limit: number): Promise<ChatSearchTextRow[]> {
  if (limit <= 0) return []
  return getDb().chatSearchText.orderBy("[createdAt+messageId]").reverse().limit(limit).toArray()
}

/**
 * Walk projections older than `before`, newest-first, until `visit` returns
 * `false`.
 *
 * This is the path for history that did not fit the resident corpus. Paged
 * explicitly rather than via `Collection.each`, because `each` cannot be stopped
 * — and stopping early is the whole point: a query that already has enough hits
 * must not read the rest of the account's history.
 */
export async function scanOlderChatSearchText(
  before: number,
  visit: (row: ChatSearchTextRow) => boolean
): Promise<void> {
  const db = getDb()
  let cursor: [number, string] = [before, ""]
  for (;;) {
    const page = await db.chatSearchText
      .where("[createdAt+messageId]")
      .below(cursor)
      .reverse()
      .limit(SCAN_PAGE_SIZE)
      .toArray()
    if (page.length === 0) return
    for (const row of page) {
      if (visit(row) === false) return
    }
    const last = page[page.length - 1]
    cursor = [last.createdAt, last.messageId]
    if (page.length < SCAN_PAGE_SIZE) return
  }
}
