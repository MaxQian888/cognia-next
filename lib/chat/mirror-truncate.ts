import { getDb } from "@/lib/db/schema"
import { deleteMessage } from "@/lib/claude/ipc"

/**
 * Mobile-only mirror for the chat truncate paths (mobile completeness
 * Phase 2), shared by `useClaudeChat` and `useTeamChat`. Fans out a
 * per-message `deleteMessage` RPC to the desktop's Dexie so a mobile-driven
 * edit/resend doesn't desync the authoritative store. Errors are best-effort
 * (sync will reconcile later).
 */
export async function mirrorTruncateToDesktop(
  sessionId: string,
  anchorMessageId: string
): Promise<void> {
  try {
    const db = getDb()
    const anchor = await db.messages.get(anchorMessageId)
    if (!anchor || anchor.sessionId !== sessionId) return
    const ids = await db.messages
      .where("[sessionId+createdAt]")
      .between([sessionId, anchor.createdAt], [sessionId, Number.MAX_SAFE_INTEGER])
      .primaryKeys()
    for (const rawId of ids) {
      const id = rawId as string
      try {
        await deleteMessage(sessionId, id)
      } catch (err) {
        console.warn("mirrorTruncateToDesktop: deleteMessage failed", { id, err })
      }
    }
  } catch (err) {
    console.warn("mirrorTruncateToDesktop failed", err)
  }
}
