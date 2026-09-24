// Bridge between a "scheduled task is due" pet reminder and the unified
// notification center (ADR-0042). Strings are passed in by the calling React
// hook (which has `useTranslations`); this module stays i18n-free — mirrors
// `lib/pet/care/notify-care.ts`.
//
// The center governs DND / quiet hours through notification preferences, so the
// reminder can fire independently of the pet's *speech* settings while still
// respecting the user's OS-level Do-Not-Disturb. The `dedupeKey` + an
// unbounded coalescing window keep ONE durable record per task: every later
// fire bumps its count and re-surfaces it as unseen, instead of adding a
// directed row per fire (a 5-minute interval task alone produced hundreds of
// unread rows under the old 45 s window). Archiving the row starts a new one.

import type { NotificationAction, NotificationInput } from "@/types/notifications"
import { COALESCE_UNTIL_ARCHIVED } from "@/lib/notifications/dedup"

/** Already-localized notification payload supplied by the caller. */
export interface ScheduledDueNotifyOptions {
  title: string
  body?: string
  /**
   * Structured payload the functional toast reads back — the due card's
   * `scheduledDue` meta (`buildScheduledDueMeta`). Plain JSON; persisted on
   * the record.
   */
  meta?: Record<string, unknown>
  /**
   * Persisted center/toast actions (command-keyed — the registry dispatches
   * them identically on both surfaces). Supplied by the caller because their
   * labels are localized strings.
   */
  actions?: NotificationAction[]
  /** Center row click-through — the task's `/scheduler?item=` address. */
  href?: string
}

/** Injectable notify (defaults to the real runtime; tests pass a spy). */
export interface ScheduledDueNotifyDeps {
  notify?: (input: NotificationInput) => Promise<string>
}

/** Stable UI grouping key for all pet scheduled-due reminders. */
export const SCHEDULED_DUE_GROUP_KEY = "pet-scheduled-due"

/** One reminder record per task (coalesced until archived). */
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
  options: ScheduledDueNotifyOptions,
  deps: ScheduledDueNotifyDeps = {}
): Promise<boolean> {
  try {
    const notify = deps.notify ?? (await import("@/lib/notifications/runtime")).notify
    await notify({
      source: "system",
      level: "info",
      title: options.title,
      body: options.body,
      channels: ["center", "toast", "os"],
      dedupeKey: scheduledDueDedupeKey(taskId),
      coalesceWindowMs: COALESCE_UNTIL_ARCHIVED,
      groupKey: SCHEDULED_DUE_GROUP_KEY,
      sourceRef: { kind: "task", id: taskId },
      icon: "Clock",
      directed: true,
      ...(options.meta ? { meta: options.meta } : {}),
      ...(options.actions ? { actions: options.actions } : {}),
      ...(options.href ? { href: options.href } : {}),
    })
    return true
  } catch {
    return false
  }
}
