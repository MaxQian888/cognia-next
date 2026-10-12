import { getDb } from "./schema"

export interface ChatInputHistoryRow {
  id?: number
  sessionId: string
  /** The exact text that was sent. */
  text: string
  createdAt: number
}

/** Cap on retained history entries per session (oldest trimmed past this). */
export const MAX_HISTORY_PER_SESSION = 100

/**
 * The history bucket of the composer that has no conversation yet (home, a
 * new chat). A first message is sent before its conversation exists, so it
 * used to be recorded nowhere and could never be recalled. It is filed here
 * instead, and every conversation's recall reaches it through
 * {@link listRecentInputHistory}. Not a session id: no session row has it, so
 * session cascades never touch it, and the per-bucket cap still trims it.
 */
export const HOME_COMPOSER_HISTORY_KEY = "composer:home"

/**
 * Append a sent message to the session's history. No-ops on empty text and on
 * a consecutive duplicate (sending the same line twice keeps one entry).
 * Trims the session back down to {@link MAX_HISTORY_PER_SESSION} newest rows.
 */
export async function recordInput(sessionId: string, text: string): Promise<void> {
  const trimmed = text.trim()
  if (!sessionId || trimmed.length === 0) return

  const db = getDb()
  // One read-write transaction: IndexedDB runs them one at a time, so two
  // sends of the same line in quick succession cannot both read "no duplicate"
  // and both append.
  await db.transaction("rw", db.chatInputHistory, async () => {
    const newest = await db.chatInputHistory
      .where("[sessionId+createdAt]")
      .between([sessionId, -Infinity], [sessionId, Infinity])
      .last()
    if (newest?.text === trimmed) return

    await db.chatInputHistory.add({ sessionId, text: trimmed, createdAt: Date.now() })

    // Trim oldest beyond the cap.
    const ids = await db.chatInputHistory
      .where("[sessionId+createdAt]")
      .between([sessionId, -Infinity], [sessionId, Infinity])
      .primaryKeys()
    if (ids.length > MAX_HISTORY_PER_SESSION) {
      const excess = ids.slice(0, ids.length - MAX_HISTORY_PER_SESSION)
      await db.chatInputHistory.bulkDelete(excess as number[])
    }
  })
}

/**
 * Return the session's history newest-first (index 0 = most recently sent),
 * which is the order the composer's ↑ recall walks through.
 */
export async function listInputHistory(sessionId: string): Promise<string[]> {
  if (!sessionId) return []
  const rows = await getDb()
    .chatInputHistory.where("[sessionId+createdAt]")
    .between([sessionId, -Infinity], [sessionId, Infinity])
    .toArray()
  return rows.reverse().map((r) => r.text)
}

/** Remove all history for a session (used when a session is deleted). */
export async function clearInputHistory(sessionId: string): Promise<void> {
  await getDb().chatInputHistory.where("sessionId").equals(sessionId).delete()
}

/**
 * Recent inputs across ALL sessions, newest-first and de-duplicated (an exact
 * line typed in two sessions appears once, at its most-recent position). Used
 * by the desktop→CLI history push to seed the standalone CLI's global composer
 * recall, and by the composer's ↑ recall once it has walked past the current
 * conversation's own lines (`excludeSessionId` drops that conversation's rows,
 * which it already has). `limit` caps the returned count.
 */
export async function listRecentInputHistory(
  limit = MAX_HISTORY_PER_SESSION,
  options: { excludeSessionId?: string } = {}
): Promise<string[]> {
  const rows = await getDb().chatInputHistory.toArray()
  rows.sort((a, b) => b.createdAt - a.createdAt)
  const out: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (options.excludeSessionId !== undefined && row.sessionId === options.excludeSessionId) {
      continue
    }
    if (seen.has(row.text)) continue
    seen.add(row.text)
    out.push(row.text)
    if (out.length >= limit) break
  }
  return out
}
