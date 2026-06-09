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
 * Append a sent message to the session's history. No-ops on empty text and on
 * a consecutive duplicate (sending the same line twice keeps one entry).
 * Trims the session back down to {@link MAX_HISTORY_PER_SESSION} newest rows.
 */
export async function recordInput(sessionId: string, text: string): Promise<void> {
  const trimmed = text.trim()
  if (!sessionId || trimmed.length === 0) return

  const db = getDb()
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
