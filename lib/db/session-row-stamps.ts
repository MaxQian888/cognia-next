import type { ChatSession } from "@cognia/agent-config-types"

/**
 * Stamp an organizational write (pin, folder, rank) on a session row so it
 * syncs without moving the row in the recency order.
 *
 * `updatedAt` is the `sessions` sync cursor (`readSessionsDelta` pulls rows
 * whose `updatedAt` passed the client's watermark), so a write that leaves it
 * alone never reaches a paired device. But the conversation list sorts by
 * `lastMessageAt ?? updatedAt` (`conversation-list-model.ts:activityAt`), so a
 * bare bump would float a message-less row to the top. Pinning the row's
 * current display recency into `lastMessageAt` first keeps the order exactly
 * where it was.
 *
 * One definition for every writer that organizes a session — the desktop
 * repositories in `lib/db/sessions.ts` and `lib/db/session-folders.ts`, and the
 * Host applier in `lib/sync/host-state-store.ts` — so a pin made on a phone and
 * one made on the desktop leave the row in the same state. A leaf module on
 * purpose: the Host applier runs inside its ledger transaction and must not
 * pull in the session repository's dependency graph.
 */
export function stampOrganizationalWrite(
  session: Pick<ChatSession, "lastMessageAt" | "updatedAt">,
  now: number
): void {
  session.lastMessageAt ??= session.updatedAt
  session.updatedAt = now
}
