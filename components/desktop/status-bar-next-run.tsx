"use client"

/**
 * Status-bar "next run" segment: the soonest active schedule on this device,
 * and how long until it fires — `Daily digest · in 2 hours`.
 *
 * Schedules run unattended, which is exactly why the bar should say when the
 * next one is due: a user about to quit the app, or wondering why the fan
 * spun up at nine, otherwise has to open `/scheduler` to find out. Clicking it
 * opens that schedule there (`scheduleHref`, the same address the workspace
 * card links to).
 *
 * Only the local scheduler is read. When this window drives a paired host's
 * scheduler (`useSchedulerHostTarget`), the local table says nothing about
 * what will run, so the segment steps aside rather than name the wrong job.
 * The query is re-issued once a minute: "upcoming" is relative to now, and a
 * schedule that just fired has to give way to the next one even though no row
 * changed until the run records itself.
 *
 * Below `lg` it is hidden: a narrow window spends its bar on the edge
 * clusters, and `/scheduler` still has the whole list.
 */

import Link from "next/link"
import { useFormatter, useNow, useTranslations } from "next-intl"
import { CalendarClockIcon } from "lucide-react"

import { scheduleHref } from "@/components/workspace/workspace-schedules"
import { useClientLiveQuery } from "@/hooks/data"
import { useSchedulerHostTarget } from "@/hooks/scheduler/use-scheduler-host-target"
import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import type { ScheduledTask } from "@/types/scheduler"

const CLOCK_TICK_MS = 60_000

export function StatusBarNextRun() {
  const t = useTranslations("desktop.statusBar.nextRun")
  const format = useFormatter()
  const now = useNow({ updateInterval: CLOCK_TICK_MS })
  const minute = Math.floor(now.getTime() / CLOCK_TICK_MS)
  const { target } = useSchedulerHostTarget()
  const local = target === "local"

  const upcoming = useClientLiveQuery<ScheduledTask[]>(
    () => (local ? schedulerDb.getUpcomingTasks(1) : Promise.resolve([])),
    [local, minute],
    []
  )
  const next = upcoming?.[0]
  if (!local || !next?.nextRunAt) return null

  const when = format.relativeTime(new Date(next.nextRunAt), now)
  const label = t("label", { name: next.name, when })

  return (
    <Link
      href={scheduleHref(next)}
      data-testid="status-next-run"
      aria-label={label}
      title={label}
      className="hidden h-6 min-w-0 max-w-[16rem] items-center lg:flex gap-1 px-1.5 text-muted-foreground transition-colors hover:text-foreground"
    >
      <CalendarClockIcon aria-hidden className="size-3 shrink-0" />
      <span className="truncate">{next.name}</span>
      <span aria-hidden className="shrink-0 text-muted-foreground/50">
        ·
      </span>
      <span className="shrink-0 tabular-nums">{when}</span>
    </Link>
  )
}
