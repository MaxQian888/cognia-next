// Bridge between a "scheduled task is due" pet reminder and the unified
// notification center (ADR-0042). Strings are passed in by the calling React
// hook (which has `useTranslations`); this module stays i18n-free — mirrors
// `lib/pet/care/notify-care.ts`.
//
// The center governs DND / quiet hours through notification preferences, so the
// reminder can fire independently of the pet's *speech* settings while still
// respecting the user's OS-level Do-Not-Disturb. The `dedupeKey` coalesces
// re-entries (e.g. two windows) into a single durable record per task instant.

import type { NotificationInput } from "@/types/notifications"

/** Already-localized notification copy supplied by the caller. */
export interface ScheduledDueNotifyStrings {
  title: string
  body?: string
}

/** Injectable notify (defaults to the real runtime; tests pass a spy). */
export interface ScheduledDueNotifyDeps {
  notify?: (input: NotificationInput) => Promise<string>
}

/** Stable UI grouping key for all pet scheduled-due reminders. */
export const SCHEDULED_DUE_GROUP_KEY = "pet-scheduled-due"

/** One reminder record per task instant. */
export function scheduledDueDedupeKey(taskId: string): string {
  return `pet-scheduled-due:${taskId}`
}

/**
 * Post a "your scheduled task is due" reminder. Fans out to center + toast + os
 * (intersected with the user's preferences by the center). Never throws — a
 * background reminder must not disrupt the caller.
 */
export async function notifyScheduledDue(
  taskId: string,
  strings: ScheduledDueNotifyStrings,
  deps: ScheduledDueNotifyDeps = {}
): Promise<boolean> {
  try {
    const notify = deps.notify ?? (await import("@/lib/notifications/runtime")).notify
    await notify({
      source: "system",
      level: "info",
      title: strings.title,
      body: strings.body,
      channels: ["center", "toast", "os"],
      dedupeKey: scheduledDueDedupeKey(taskId),
      groupKey: SCHEDULED_DUE_GROUP_KEY,
      sourceRef: { kind: "task", id: taskId },
      icon: "Clock",
      directed: true,
    })
    return true
  } catch {
    return false
  }
}
