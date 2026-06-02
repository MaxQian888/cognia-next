// Read-state cascade (ADR-0042, GitHub/Novu monotonic model):
//   unseen → seen → read → done(archived)
// Pure. Marking a higher state stamps the lower ones; marking a lower state
// never downgrades an already-higher record (except an explicit re-surface,
// handled by the dedup bump, not here).

import type { NotificationRecord, NotificationReadState } from "@/types/notifications"

const RANK: Record<NotificationReadState, number> = {
  unseen: 0,
  seen: 1,
  read: 2,
  done: 3,
}

/**
 * Patch to move `rec` toward `target`. Returns an empty object when the record
 * is already at or beyond `target` (no downgrade, no redundant write).
 */
export function cascadeReadState(
  rec: Pick<NotificationRecord, "readState" | "firstSeenAt">,
  target: Exclude<NotificationReadState, "unseen">,
  now: number
): Partial<NotificationRecord> {
  if (RANK[rec.readState] >= RANK[target]) return {}

  const patch: Partial<NotificationRecord> = { readState: target }

  // Seen stamps (set whenever crossing into seen-or-beyond).
  if (rec.firstSeenAt === undefined) patch.firstSeenAt = now
  patch.lastSeenAt = now

  if (target === "read" || target === "done") {
    patch.lastReadAt = now
  }
  if (target === "done") {
    patch.doneAt = now
  }
  return patch
}
