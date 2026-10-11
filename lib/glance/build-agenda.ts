/**
 * Agenda slice: the next scheduled run, the last outcome, unread
 * notifications and connectivity, on one line (ADR-0225 §2).
 *
 * Each part routes to its own owner. The scheduler page selects a task by its
 * unified id, the notification center owns read state, and the connectivity
 * settings own pairing. This slice only carries what a glance needs to say
 * "next 09:00 morning brief · 3 unread · synced".
 */

import { redactText } from "@cognia/redact"

import { truncateLine } from "@/lib/fleet/format"
import { isSnoozed } from "@/lib/notifications/snooze"
import type { NotificationRecord } from "@/types/notifications"
import { makeUnifiedId, unifiedKindForTaskType } from "@/types/scheduler/unified"

import type { GlanceAgendaSlice } from "./snapshot"

const NAME_MAX = 64
const TITLE_MAX = 80

export interface AgendaTaskInput {
  id: string
  type: string
  name: string
  nextRunAt: number
}

export interface AgendaExecutionInput {
  taskName: string
  status: string
  startedAt: number
  completedAt: number | null
}

export interface BuildAgendaSliceInput {
  schedulerLocal: boolean
  nextTask: AgendaTaskInput | null
  /** Newest first. Only terminal ones count as an outcome. */
  recentExecutions: readonly AgendaExecutionInput[]
  notifications: readonly Pick<
    NotificationRecord,
    "readState" | "directed" | "snoozedUntil" | "title" | "createdAt"
  >[]
  connectivity: GlanceAgendaSlice["connectivity"]
  now: number
}

function safe(value: string, max: number): string {
  return truncateLine(redactText(value).redacted, max)
}

/**
 * Unread, counted once per record: the union of the bell's two badges. A
 * directed record still unread, or any record not yet seen. Summing the two
 * badge counts would count a directed, unseen record twice.
 */
export function unreadNotifications<
  T extends Pick<NotificationRecord, "readState" | "directed" | "snoozedUntil">,
>(items: readonly T[], at: number): T[] {
  return items.filter((r) => {
    if (r.readState === "done" || isSnoozed(r, at)) return false
    if (r.readState === "unseen") return true
    return r.directed === true && r.readState === "seen"
  })
}

export function buildAgendaSlice(input: BuildAgendaSliceInput): GlanceAgendaSlice {
  const unread = unreadNotifications(input.notifications, input.now)
  const latest = [...unread].sort((a, b) => b.createdAt - a.createdAt)[0]

  const terminal = input.recentExecutions.find(
    (e) => e.status === "completed" || e.status === "failed"
  )

  return {
    updatedAt: input.now,
    schedulerLocal: input.schedulerLocal,
    nextRun:
      input.schedulerLocal && input.nextTask
        ? {
            itemId: makeUnifiedId(unifiedKindForTaskType(input.nextTask.type), input.nextTask.id),
            name: safe(input.nextTask.name, NAME_MAX),
            at: input.nextTask.nextRunAt,
          }
        : null,
    lastOutcome:
      input.schedulerLocal && terminal
        ? {
            ok: terminal.status === "completed",
            at: terminal.completedAt ?? terminal.startedAt,
            name: safe(terminal.taskName, NAME_MAX),
          }
        : null,
    unread: unread.length,
    latestUnreadTitle: latest ? safe(latest.title, TITLE_MAX) : null,
    connectivity: input.connectivity,
  }
}
