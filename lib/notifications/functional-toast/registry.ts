// Record → functional-toast factory resolution. `showToast` asks this before
// falling back to the plain sonner toast. Matching is deliberately narrow —
// a factory only claims records it can actually draw (producer signature via
// `groupKey` + `sourceRef`), never a whole `source`.

import type { NotificationRecord } from "@/types/notifications"

import { scheduledDueToastSpec } from "./scheduled-due"
import type { FunctionalToastContext, FunctionalToastFactory, FunctionalToastSpec } from "./types"

/**
 * The pet's scheduled-due reminders. `groupKey` is the stable producer
 * signature (`notify-scheduled-due.ts`); `sourceRef.kind === "task"` pins it
 * to scheduler tasks rather than anything else that might reuse the key.
 */
function isScheduledDue(rec: NotificationRecord): boolean {
  return rec.groupKey === "pet-scheduled-due" && rec.sourceRef?.kind === "task"
}

export function resolveFunctionalToastFactory(
  rec: NotificationRecord
): FunctionalToastFactory | null {
  if (isScheduledDue(rec)) return scheduledDueToastSpec
  return null
}

/** Render-time resolution — builds the spec once `t`/locale are available. */
export function resolveFunctionalToastSpec(
  rec: NotificationRecord,
  ctx: FunctionalToastContext
): FunctionalToastSpec | null {
  return resolveFunctionalToastFactory(rec)?.(rec, ctx) ?? null
}
