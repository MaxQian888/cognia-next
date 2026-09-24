// When a scheduled task becomes due, the pet reminds the user: an attention
// flourish (the `surprised` one-shot) plus a durable Notification-Center
// reminder (center + functional toast + OS). Main window only — mounted by
// `PetWidget` alongside `usePetSpeak`/`usePetProactive`; the overlay/popup
// windows are presentation-only and would double-fire.
//
// The reminder is a real reminder, so it is gated ONLY on the pet being enabled
// (NOT on `mutedBubbles` or the proactive-speech settings) — and on the task's
// own `notification.dueReminder`, which the toast's Mute action and the task
// form's "Remind when due" switch write. The *spoken* bubble for a due task is
// a separate concern owned by `usePetProactive` / `usePetBubbles` (via the
// `scheduledRunDue` template + claim). The center applies the user's DND /
// quiet-hours to the notification itself.
//
// The record carries everything the functional toast draws: the task snapshot
// under `meta.scheduledDue` (`buildScheduledDueMeta`), command-keyed actions
// (open → `/scheduler?item=…`, mute → writes `dueReminder: false`) and the
// deep link as `href`, so the center row is as useful as the toast.

"use client"

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"

import {
  SCHEDULED_DUE_META_KEY,
  buildScheduledDueMeta,
} from "@/lib/notifications/functional-toast/scheduled-due"
import { getPetEventBus } from "@/lib/pet/events/pet-event-bus"
import { notifyScheduledDue } from "@/lib/pet/care/notify-scheduled-due"
import {
  SCHEDULED_DUE_MUTE_COMMAND,
  SCHEDULER_OPEN_TASK_COMMAND,
} from "@/lib/scheduler/notification-commands"
import { usePetStore } from "@/stores/pet/pet-store"
import { useProjectStore } from "@/stores/project/project-store"
import type { PetEvent } from "@/types/pet"
import type { ScheduledTask } from "@/types/scheduler"
import { makeUnifiedId } from "@/types/scheduler/unified"

/** Best-effort task lookup, keeping `scheduler-db` out of the eager graph. */
async function defaultResolveTask(taskId: string): Promise<ScheduledTask | null> {
  try {
    const { schedulerDb } = await import("@/lib/scheduler/scheduler-db")
    return await schedulerDb.getTask(taskId)
  } catch {
    return null
  }
}

/** Project id → display name, from the already-hydrated project store. */
function defaultResolveWorkspaceName(projectId: string): string | null {
  return (
    useProjectStore.getState().projects.find((project) => project.id === projectId)?.name ?? null
  )
}

export interface UsePetScheduledReminderDeps {
  /** Resolve the task row from its id (defaults to a `scheduler-db` read). */
  resolveTask?: (taskId: string) => Promise<ScheduledTask | null>
  /** Project id → display name for the card's workspace footnote. */
  resolveWorkspaceName?: (projectId: string) => string | null
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

      void (async () => {
        const resolveTask = depsRef.current.resolveTask ?? defaultResolveTask
        const task = taskId ? await resolveTask(taskId).catch(() => null) : null

        // The task's own `dueReminder` flag mutes the reminder entirely — the
        // flourish and the record both belong to the reminder. Absent means on.
        const dueReminder = task?.notification?.dueReminder
        const maintenance =
          task?.type === "provider-diagnostics-refresh" ||
          task?.type === "connection:presence:refresh" ||
          task?.tags?.some((tag) => tag.startsWith("system:"))
        if (dueReminder === false || (dueReminder === undefined && maintenance)) return

        // Attention flourish alongside the card; the resting state itself
        // stays needs-driven (see reducer).
        usePetStore.getState().enqueueOneShot("surprised")

        const notifyDue = depsRef.current.notifyDue ?? notifyScheduledDue
        const title = t("notifications.scheduledDue.title")
        const body = task?.name
          ? t("notifications.scheduledDue.body", { taskName: task.name })
          : t("notifications.scheduledDue.bodyGeneric")
        if (!taskId) {
          await notifyDue("unknown", { title, body })
          return
        }

        const resolveWorkspaceName =
          depsRef.current.resolveWorkspaceName ?? defaultResolveWorkspaceName
        const workspaceName = task?.projectId
          ? (resolveWorkspaceName(task.projectId) ?? undefined)
          : undefined
        const dueMeta = task ? buildScheduledDueMeta(task, workspaceName) : undefined
        // `app:` only covers app-type tasks — plugin tasks live under
        // `plugin:<id>` in the unified scheduler list, so the deep link takes
        // the kind prefix from the resolved task.
        const itemId = dueMeta ? makeUnifiedId(dueMeta.kind, taskId) : `app:${taskId}`
        await notifyDue(taskId, {
          title,
          body,
          ...(dueMeta ? { meta: { [SCHEDULED_DUE_META_KEY]: dueMeta } } : {}),
          actions: [
            {
              id: "open",
              label: t("notifications.scheduledDue.open"),
              command: SCHEDULER_OPEN_TASK_COMMAND,
              args: { taskId, itemId },
              variant: "primary",
            },
            {
              id: "mute",
              label: t("notifications.scheduledDue.mute"),
              command: SCHEDULED_DUE_MUTE_COMMAND,
              args: { taskId },
            },
          ],
          href: `/scheduler?item=${encodeURIComponent(itemId)}`,
        })
      })()
    })
    return () => off()
  }, [enabled, t])
}
