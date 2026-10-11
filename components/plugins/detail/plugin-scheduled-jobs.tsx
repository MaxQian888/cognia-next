"use client"

// Reads real plugin ScheduledTask rows from SchedulerDB, presents one row per
// job with cron + next-run + last-run + status. Mirrors the scheduler
// settings panel shape but scoped to plugin contributions only. Provides
// one deep link to the global scheduler section for advanced configuration.
//
// Rendered flat in the plugin detail pane's Data tab and in the Governance
// pane, so it carries its own anonymous `@container` and hides columns by its
// own width, not the viewport's. The schedule column reads through the
// scheduler's own trigger phrasing (`useTriggerText`), so an interval job says
// "Every 5m" in the user's language instead of a raw `interval:300000ms`.

import { useMemo, useState } from "react"
import Link from "next/link"
import { useFormatter, useNow, useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import {
  ClockIcon,
  PlayIcon,
  PauseIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  ArrowUpDownIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"
import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import { FilterChips } from "@/components/scheduler/filter-chips"
import { useTriggerText } from "@/components/scheduler/kind-visuals"
import { usePluginDisplayName } from "@/hooks/plugins/use-plugin-display-name"
import type { ScheduledTaskStatus } from "@/types/scheduler"
import type { UnifiedTriggerSummary } from "@/types/scheduler/unified"

export interface PluginScheduledJobView {
  id: string
  pluginId: string
  handler: string
  /** The trigger, phrased at render time by the scheduler's `useTriggerText`. */
  trigger: UnifiedTriggerSummary
  status: ScheduledTaskStatus
  nextRunAt?: number
  lastRunAt?: number
}

async function listScheduledJobs(): Promise<PluginScheduledJobView[]> {
  const tasks = await schedulerDb.getFilteredTasks({ types: ["plugin"] })
  return tasks.map((task) => {
    const payload = task.payload as { pluginId?: string; handler?: string }
    return {
      id: task.id,
      pluginId: payload.pluginId ?? "",
      handler: payload.handler ?? "",
      trigger: {
        type: task.trigger.type,
        cron: task.trigger.cronExpression,
        intervalMs: task.trigger.intervalMs,
        runAtMs: task.trigger.runAt?.getTime(),
        eventType: task.trigger.eventType,
        timezone: task.trigger.timezone,
      },
      status: task.status,
      nextRunAt: task.nextRunAt?.getTime(),
      lastRunAt: task.lastRunAt?.getTime(),
    }
  })
}

type SortKey = "pluginId" | "handler" | "schedule" | "status" | "nextRunAt" | "lastRunAt"
type SortDir = "asc" | "desc"
type StatusFilter = "all" | "active" | "paused" | "disabled"

interface SortableHeaderProps {
  label: string
  sortKey: SortKey
  activeKey: SortKey
  activeDir: SortDir
  onClick: (key: SortKey) => void
  className?: string
}

function SortableHeader({
  label,
  sortKey,
  activeKey,
  activeDir,
  onClick,
  className,
}: SortableHeaderProps) {
  const isActive = activeKey === sortKey
  const Icon = !isActive ? ArrowUpDownIcon : activeDir === "asc" ? ArrowUpIcon : ArrowDownIcon
  return (
    <TableHead
      className={className}
      aria-sort={isActive ? (activeDir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => onClick(sortKey)}
        className={cn(
          "inline-flex items-center gap-1 -ml-1 px-1 py-0.5 rounded text-left pointer-coarse:min-h-10",
          "hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring",
          isActive && "text-foreground"
        )}
        data-testid={`plugin-jobs-sort-${sortKey}`}
      >
        {label}
        <Icon className="size-3 opacity-60" aria-hidden="true" />
      </button>
    </TableHead>
  )
}

interface PluginScheduledJobsProps {
  /** Override the live data — used by tests to avoid wiring Dexie. */
  jobsOverride?: PluginScheduledJobView[]
  /**
   * When set, only jobs belonging to this plugin are rendered. Used by the
   * per-plugin detail pane (`PluginDetailData`) to filter the shared Dexie
   * live-query to one plugin without forking the component.
   */
  pluginId?: string
}

export function PluginScheduledJobs({ jobsOverride, pluginId }: PluginScheduledJobsProps = {}) {
  const t = useTranslations("plugins.scheduledJobs")
  const triggerText = useTriggerText()
  // One reference instant for every row's "next run", refreshed each minute.
  const now = useNow({ updateInterval: 60_000 })
  const live = useLiveQuery(
    () => (jobsOverride ? jobsOverride : listScheduledJobs()),
    [jobsOverride]
  )
  const sourceJobs = jobsOverride ?? live
  const jobs = useMemo(() => {
    if (!sourceJobs) return sourceJobs
    if (!pluginId) return sourceJobs
    return sourceJobs.filter((job) => job.pluginId === pluginId)
  }, [sourceJobs, pluginId])

  const [sortKey, setSortKey] = useState<SortKey>("nextRunAt")
  const [sortDir, setSortDir] = useState<SortDir>("asc")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")

  const filteredAndSorted = useMemo(() => {
    if (!jobs) return [] as PluginScheduledJobView[]
    const filtered =
      statusFilter === "all" ? jobs : jobs.filter((job) => job.status === statusFilter)
    const read = (job: PluginScheduledJobView) =>
      sortKey === "schedule" ? triggerText(job.trigger) : readKey(job, sortKey)
    const cmp = (a: PluginScheduledJobView, b: PluginScheduledJobView): number => {
      const av = read(a)
      const bv = read(b)
      if (av === bv) return 0
      if (av == null) return 1
      if (bv == null) return -1
      return av < bv ? -1 : 1
    }
    const sorted = [...filtered].sort(cmp)
    return sortDir === "desc" ? sorted.reverse() : sorted
  }, [jobs, sortKey, sortDir, statusFilter, triggerText])

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"))
    } else {
      setSortKey(key)
      setSortDir("asc")
    }
  }

  if (!jobs) {
    return <p className="text-xs text-muted-foreground">{t("loading")}</p>
  }

  // The one scheduler link: in the summary row whether or not there are jobs.
  const schedulerLink = (
    <Button asChild size="sm" variant="ghost" className="h-7 text-xs pointer-coarse:h-10">
      <Link href="/settings?section=scheduled-tasks">
        {t("openScheduler")}
        <ArrowRightIcon className="size-3.5" aria-hidden="true" />
      </Link>
    </Button>
  )

  if (jobs.length === 0) {
    return (
      <div
        className="@container flex flex-wrap items-center justify-between gap-2"
        data-testid="plugin-scheduled-jobs"
      >
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <ClockIcon className="size-3.5 shrink-0" aria-hidden="true" />
          {t("empty")}
        </p>
        {schedulerLink}
      </div>
    )
  }

  const filterChips = [
    { key: "all", label: t("status.all"), count: jobs.length },
    {
      key: "active",
      label: t("status.active"),
      count: jobs.filter((j) => j.status === "active").length,
    },
    {
      key: "paused",
      label: t("status.paused"),
      count: jobs.filter((j) => j.status === "paused").length,
    },
    {
      key: "disabled",
      label: t("status.disabled"),
      count: jobs.filter((j) => j.status === "disabled").length,
    },
  ]

  return (
    <div className="@container space-y-2" data-testid="plugin-scheduled-jobs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {t("countTotal", { count: filteredAndSorted.length })}
        </p>
        {schedulerLink}
      </div>

      <FilterChips
        filters={filterChips}
        activeFilter={statusFilter}
        onFilterChange={(k) => setStatusFilter(k as StatusFilter)}
      />

      {filteredAndSorted.length === 0 ? (
        // A filter that matches nothing reads as an answer, not as an empty
        // table whose header suggests the data failed to load.
        <div
          className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
          data-testid="plugin-jobs-no-match"
        >
          <p>{t("noMatch")}</p>
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs pointer-coarse:h-10"
            onClick={() => setStatusFilter("all")}
          >
            {t("showAllJobs")}
          </Button>
        </div>
      ) : (
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              {/* Inside one plugin's Data tab every row is that plugin, so the
                  column would repeat its id on every line. */}
              {pluginId ? null : (
                <SortableHeader
                  label={t("colPlugin")}
                  sortKey="pluginId"
                  activeKey={sortKey}
                  activeDir={sortDir}
                  onClick={handleSort}
                />
              )}
              <SortableHeader
                label={t("colHandler")}
                sortKey="handler"
                activeKey={sortKey}
                activeDir={sortDir}
                onClick={handleSort}
                className="hidden @sm:table-cell"
              />
              <SortableHeader
                label={t("colCron")}
                sortKey="schedule"
                activeKey={sortKey}
                activeDir={sortDir}
                onClick={handleSort}
              />
              <SortableHeader
                label={t("colStatus")}
                sortKey="status"
                activeKey={sortKey}
                activeDir={sortDir}
                onClick={handleSort}
              />
              <SortableHeader
                label={t("colNextRun")}
                sortKey="nextRunAt"
                activeKey={sortKey}
                activeDir={sortDir}
                onClick={handleSort}
                className="hidden @md:table-cell"
              />
              <SortableHeader
                label={t("colLastRun")}
                sortKey="lastRunAt"
                activeKey={sortKey}
                activeDir={sortDir}
                onClick={handleSort}
                className="hidden @md:table-cell"
              />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredAndSorted.map((job) => (
              <TableRow key={job.id}>
                {pluginId ? null : (
                  <TableCell>
                    <PluginNameCell pluginId={job.pluginId} />
                  </TableCell>
                )}
                <TableCell className="hidden font-mono text-xs @sm:table-cell">
                  {job.handler}
                </TableCell>
                <TableCell className={cn("text-xs", job.trigger.type === "cron" && "font-mono")}>
                  {triggerText(job.trigger)}
                </TableCell>
                <TableCell>
                  <StatusBadge status={job.status} />
                </TableCell>
                <TableCell className="hidden text-xs text-muted-foreground @md:table-cell">
                  <RunTime at={job.nextRunAt} relativeTo={now} missing={t("noNextRun")} />
                </TableCell>
                <TableCell className="hidden text-xs text-muted-foreground @md:table-cell">
                  <RunTime at={job.lastRunAt} missing={t("noLastRun")} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}

/** Local date + time to the minute, the precision the run columns always carried. */
const RUN_TIME_FORMAT = { dateStyle: "medium", timeStyle: "short" } as const

/**
 * One run instant in the viewer's locale and time zone. With `relativeTo` it
 * reads relative ("in 5 minutes", or "3 minutes ago" when overdue) — what the
 * next-run column is scanned for — with the absolute time as the hover title.
 * Without it, the absolute time. The ISO instant stays on `<time dateTime>`.
 * A missing or unparseable instant renders the column's translated `missing`
 * answer ("Not scheduled", "Never").
 */
function RunTime({
  at,
  relativeTo,
  missing,
}: {
  at: number | undefined
  relativeTo?: Date
  missing: string
}) {
  const format = useFormatter()
  const date = at ? new Date(at) : null
  if (!date || Number.isNaN(date.getTime())) return missing
  const absolute = format.dateTime(date, RUN_TIME_FORMAT)
  return (
    <time dateTime={date.toISOString()} title={relativeTo ? absolute : undefined}>
      {relativeTo ? format.relativeTime(date, relativeTo) : absolute}
    </time>
  )
}

function readKey(
  job: PluginScheduledJobView,
  key: Exclude<SortKey, "schedule">
): string | number | null {
  switch (key) {
    case "pluginId":
      return job.pluginId
    case "handler":
      return job.handler
    case "status":
      return job.status
    case "nextRunAt":
      return job.nextRunAt ?? null
    case "lastRunAt":
      return job.lastRunAt ?? null
  }
}

function StatusBadge({ status }: { status: ScheduledTaskStatus }) {
  const t = useTranslations("plugins.scheduledJobs.status")
  if (status === "active") {
    return (
      <Badge variant="secondary" className="text-xs gap-1">
        <PlayIcon className="size-3" />
        {t("active")}
      </Badge>
    )
  }
  if (status === "paused") {
    return (
      <Badge variant="outline" className="text-xs gap-1">
        <PauseIcon className="size-3" />
        {t("paused")}
      </Badge>
    )
  }
  if (status === "disabled") {
    return (
      <Badge variant="destructive" className="text-xs">
        {t("disabled")}
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="text-xs">
      {t("expired")}
    </Badge>
  )
}

/** The plugin's localized name, with its id underneath for the governance view. */
function PluginNameCell({ pluginId }: { pluginId: string }) {
  const name = usePluginDisplayName(pluginId)
  return (
    <div className="min-w-0 space-y-0.5">
      <div className="truncate text-xs font-medium">{name}</div>
      {name !== pluginId ? (
        <div className="truncate font-mono text-[10px] text-muted-foreground">{pluginId}</div>
      ) : null}
    </div>
  )
}
