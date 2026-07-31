// When a scheduled task becomes due, the pet reminds the user: an attention
// flourish (the `surprised` one-shot) plus a durable Notification-Center
// reminder (center + toast + OS). Main window only — mounted by `PetWidget`
// alongside `usePetSpeak`/`usePetProactive`; the overlay/popup windows are
// presentation-only and would double-fire.
//
// The reminder is a real reminder, so it is gated ONLY on the pet being enabled
// (NOT on `mutedBubbles` or the proactive-speech settings). The *spoken* bubble
// for a due task is a separate concern owned by `usePetProactive` /
// `usePetBubbles` (via the `scheduledRunDue` template + claim). The center
// applies the user's DND / quiet-hours to the notification itself.

"use client"

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"

import { getPetEventBus } from "@/lib/pet/events/pet-event-bus"
import { notifyScheduledDue } from "@/lib/pet/care/notify-scheduled-due"
import { usePetStore } from "@/stores/pet/pet-store"
import type { PetEvent } from "@/types/pet"

/** Best-effort task-name lookup, keeping `scheduler-db` out of the eager graph. */
async function defaultResolveTaskName(taskId: string): Promise<string | null> {
  try {
    const { schedulerDb } = await import("@/lib/scheduler/scheduler-db")
    const task = await schedulerDb.getTask(taskId)
    return task?.name ?? null
  } catch {
    return null
  }
}

export interface UsePetScheduledReminderDeps {
  /** Resolve a friendly task name from its id (defaults to a `scheduler-db` read). */
  resolveTaskName?: (taskId: string) => Promise<string | null>
  /** The notify bridge (defaults to `notifyScheduledDue`; injected in tests). */
  notifyDue?: typeof notifyScheduledDue
}

export function usePetScheduledReminder(
  enabled: boolean,
  deps: UsePetScheduledReminderDeps = {}
): void {
  const t = useTranslations("pet")

  // Read deps through a ref so a new (stable-in-practice) deps object never
  // re-binds the bus subscription mid-session.
  const depsRef = useRef(deps)
  useEffect(() => {
    depsRef.current = deps
  })

  useEffect(() => {
    if (!enabled) return
    const off = getPetEventBus().subscribe((event: PetEvent) => {
      if (event.kind !== "scheduledRunDue") return
      const taskId = typeof event.meta?.taskId === "string" ? event.meta.taskId : null

      // Immediate flourish so the pet visibly reacts even before the async copy
      // resolves; the resting state itself stays needs-driven (see reducer).
      usePetStore.getState().enqueueOneShot("surprised")

      const resolveTaskName = depsRef.current.resolveTaskName ?? defaultResolveTaskName
      const notifyDue = depsRef.current.notifyDue ?? notifyScheduledDue
      void (async () => {
        const name = taskId ? await resolveTaskName(taskId).catch(() => null) : null
        const title = t("notifications.scheduledDue.title")
        const body = name
          ? t("notifications.scheduledDue.body", { taskName: name })
          : t("notifications.scheduledDue.bodyGeneric")
        await notifyDue(taskId ?? "unknown", { title, body })
      })()
    })
    return () => off()
  }, [enabled, t])
}
