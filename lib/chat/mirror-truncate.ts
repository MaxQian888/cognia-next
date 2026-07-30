import { getDb } from "@/lib/db/schema"
import { deleteMessage } from "@/lib/claude/ipc"

/**
 * Mobile-only mirror for the chat truncate paths (mobile completeness
 * Phase 2), shared by `useClaudeChat` and `useTeamChat`. Fans out a
 * per-message `deleteMessage` RPC to the desktop's Dexie so a mobile-driven
 * edit/resend doesn't desync the authoritative store. The caller must not
 * delete locally unless every host deletion succeeds; otherwise the next sync
 * would restore any rows the host still owns.
 */
export async function mirrorTruncateToDesktop(
  sessionId: string,
  anchorMessageId: string
): Promise<void> {
  const db = getDb()
  const anchor = await db.messages.get(anchorMessageId)
  if (!anchor || anchor.sessionId !== sessionId) return
  const ids = await db.messages
    .where("[sessionId+createdAt]")
    .between([sessionId, anchor.createdAt], [sessionId, Number.MAX_SAFE_INTEGER])
    .primaryKeys()
  const results = await Promise.allSettled(
    ids.map((rawId) => deleteMessage(sessionId, rawId as string))
  )
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason)
  if (failures.length > 0) {
    const first = failures[0]
    const reason = first instanceof Error ? first.message : String(first)
    throw new AggregateError(
      failures,
      `Failed to delete ${failures.length} message(s) from the paired host: ${reason}`
    )
  }
}
