"use client"

/**
 * `/workspace`'s schedules: what this workspace runs on its own, and when next.
 *
 * ADR-0144 gave every schedule a workspace (`ScheduledTask.projectId`), and
 * `/scheduler` filters by it, but the page about the workspace never said it
 * had any. `schedulerDb.getTasksByProject` had no caller at all.
 *
 * Same visibility rule as the scheduler page: a schedule bound here, plus the
 * unattributed ones, which belong to every workspace rather than to none
 * (`taskVisibleInWorkspace`). Those carry a label saying so.
 *
 * Only the local scheduler is read. Workspace ids are local, so against a
 * paired host this device's list says nothing about what the host will run
 * (`workspaceScopeForSchedulerHost`); the card says where to look instead of
 * showing an empty list that reads as "nothing scheduled".
 */

import Link from "next/link"
import { useFormatter, useNow, useTranslations } from "next-intl"
import { ArrowUpRightIcon, CalendarClockIcon } from "lucide-react"

import { ConsoleSection } from "@/components/surface/console-section"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { useClientLiveQuery } from "@/hooks/data"
import { useSchedulerHostTarget } from "@/hooks/scheduler/use-scheduler-host-target"
import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import { makeUnifiedId, unifiedKindForTaskType } from "@/types/scheduler/unified"
import type { ScheduledTask } from "@/types/scheduler"

/** How many rows the card holds before it hands off to the scheduler. */
export const WORKSPACE_SCHEDULE_LIMIT = 5

const STATUS_ORDER: Record<ScheduledTask["status"], number> = {
  active: 0,
  paused: 1,
  disabled: 2,
  expired: 3,
}

/** Active first, soonest first; everything else after, by name. */
export function orderSchedules(tasks: readonly ScheduledTask[]): ScheduledTask[] {
  return [...tasks].sort((a, b) => {
    const byStatus = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
    if (byStatus !== 0) return byStatus
    const aNext = a.nextRunAt ? +new Date(a.nextRunAt) : Number.POSITIVE_INFINITY
    const bNext = b.nextRunAt ? +new Date(b.nextRunAt) : Number.POSITIVE_INFINITY
    if (aNext !== bNext) return aNext - bNext
    return a.name.localeCompare(b.name)
  })
}

/** The scheduler's selection address for one app-table row. */
export function scheduleHref(task: Pick<ScheduledTask, "id" | "type">): string {
  const item = makeUnifiedId(unifiedKindForTaskType(task.type), task.id)
  return `/scheduler?item=${encodeURIComponent(item)}`
}

export interface WorkspaceSchedulesProps {
  workspaceId: string | null
}

export function WorkspaceSchedules({ workspaceId }: WorkspaceSchedulesProps) {
  const t = useTranslations("workspace.schedules")
  const tStatus = useTranslations("scheduler.statuses")
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const { target } = useSchedulerHostTarget()
  const local = target === "local"

  const tasks = useClientLiveQuery(
    () => (local && workspaceId ? schedulerDb.getTasksByProject(workspaceId) : Promise.resolve([])),
    [workspaceId, local],
    [] as ScheduledTask[]
  )
  const ordered = tasks ? orderSchedules(tasks) : undefined
  const activeCount = ordered?.filter((task) => task.status === "active").length ?? 0
  // Its own line in every state rather than appended to a sentence: joining two
  // messages with a space reads wrong after a CJK full stop.
  const schedulerLink = (
    <Link
      href="/scheduler"
      className="inline-flex items-center gap-1 self-start px-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
      data-testid="workspace-schedules-all"
    >
      {t("openScheduler")}
      <ArrowUpRightIcon aria-hidden className="size-3" />
    </Link>
  )

  return (
    <ConsoleSection
      id="schedules"
      pane="workspace-pane"
      idPrefix="workspace-section"
      icon={CalendarClockIcon}
      title={t("title")}
      meta={
        local && ordered && ordered.length > 0
          ? t("activeCount", { active: activeCount, total: ordered.length })
          : undefined
      }
    >
      {!local ? (
        <div className="flex flex-col gap-2" data-testid="workspace-schedules-remote">
          <p className="text-xs text-muted-foreground">{t("remoteHost")}</p>
          {schedulerLink}
        </div>
      ) : ordered === undefined ? (
        <ul
          className="flex flex-col gap-2"
          role="status"
          aria-busy="true"
          aria-label={t("loading")}
          data-testid="workspace-schedules-loading"
        >
          {[0, 1].map((row) => (
            <li key={row}>
              <Skeleton className="h-8 w-full" />
            </li>
          ))}
        </ul>
      ) : ordered.length === 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground" data-testid="workspace-schedules-empty">
            {t("empty")}
          </p>
          {schedulerLink}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <ul className="flex flex-col gap-1" data-testid="workspace-schedules-list">
            {ordered.slice(0, WORKSPACE_SCHEDULE_LIMIT).map((task) => (
              <li key={task.id}>
                <Link
                  href={scheduleHref(task)}
                  className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-control px-2 py-1.5 text-sm transition-colors hover:bg-accent/50"
                  data-testid={`workspace-schedule-${task.id}`}
                >
                  <span className="min-w-0 flex-1 truncate">{task.name}</span>
                  {!task.projectId ? (
                    <Badge variant="outline" className="shrink-0 text-[10px] font-normal">
                      {t("shared")}
                    </Badge>
                  ) : null}
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {task.status === "active" && task.nextRunAt
                      ? t("next", { time: format.relativeTime(new Date(task.nextRunAt), now) })
                      : tStatus(task.status)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {schedulerLink}
        </div>
      )}
    </ConsoleSection>
  )
}
