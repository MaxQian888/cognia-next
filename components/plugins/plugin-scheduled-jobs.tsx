"use client"

// Reads `pluginScheduledJobs` straight from Dexie, presents one row per
// job with cron + next-run + last-run + status. Mirrors the scheduler
// settings panel shape but scoped to plugin contributions only. Provides
// a deep link to the global scheduler section for advanced configuration.

import { useMemo, useState } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
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
import { Card } from "@/components/ui/card"
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
import { getDb } from "@/lib/db/schema"
import type { PluginScheduledJobRow } from "@/lib/db/plugin-types"
import { FilterChips } from "@/components/scheduler/filter-chips"

async function listScheduledJobs(): Promise<PluginScheduledJobRow[]> {
  return getDb().pluginScheduledJobs.orderBy("nextRunAt").toArray()
}

type SortKey = "pluginId" | "handler" | "cron" | "status" | "nextRunAt" | "lastRunAt"
type SortDir = "asc" | "desc"
type StatusFilter = "all" | "active" | "paused" | "error"

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
          "inline-flex items-center gap-1 -ml-1 px-1 py-0.5 rounded text-left",
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
  jobsOverride?: PluginScheduledJobRow[]
}

export function PluginScheduledJobs({ jobsOverride }: PluginScheduledJobsProps = {}) {
  const t = useTranslations("plugins.scheduledJobs")
  const live = useLiveQuery(
    () => (jobsOverride ? jobsOverride : listScheduledJobs()),
    [jobsOverride]
  )
  const jobs = jobsOverride ?? live

  const [sortKey, setSortKey] = useState<SortKey>("nextRunAt")
  const [sortDir, setSortDir] = useState<SortDir>("asc")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")

  const filteredAndSorted = useMemo(() => {
    if (!jobs) return [] as PluginScheduledJobRow[]
    const filtered =
      statusFilter === "all" ? jobs : jobs.filter((job) => job.status === statusFilter)
    const cmp = (a: PluginScheduledJobRow, b: PluginScheduledJobRow): number => {
      const av = readKey(a, sortKey)
      const bv = readKey(b, sortKey)
      if (av === bv) return 0
      if (av == null) return 1
      if (bv == null) return -1
      return av < bv ? -1 : 1
    }
    const sorted = [...filtered].sort(cmp)
    return sortDir === "desc" ? sorted.reverse() : sorted
  }, [jobs, sortKey, sortDir, statusFilter])

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"))
    } else {
      setSortKey(key)
      setSortDir("asc")
    }
  }

  if (!jobs) {
    return <p className="text-sm text-muted-foreground">{t("loading")}</p>
  }

  if (jobs.length === 0) {
    return (
      <Card className="p-6 text-center space-y-3">
        <ClockIcon className="size-10 mx-auto text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
        <Button asChild size="sm" variant="outline">
          <Link href="/settings?section=scheduled-tasks">
            {t("openScheduler")}
            <ArrowRightIcon className="ml-1.5 size-3.5" />
          </Link>
        </Button>
      </Card>
    )
  }

  const filterChips = [
    { key: "all", label: t("statusFilter.all") || "All", count: jobs.length },
    {
      key: "active",
      label: t("status.active") || "Active",
      count: jobs.filter((j) => j.status === "active").length,
    },
    {
      key: "paused",
      label: t("status.paused") || "Paused",
      count: jobs.filter((j) => j.status === "paused").length,
    },
    {
      key: "error",
      label: t("status.error") || "Error",
      count: jobs.filter((j) => j.status === "error").length,
    },
  ]

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Badge variant="secondary" className="text-xs">
          {t("countTotal", { count: filteredAndSorted.length })}
        </Badge>
        <Button asChild size="sm" variant="outline">
          <Link href="/settings?section=scheduled-tasks">
            {t("openScheduler")}
            <ArrowRightIcon className="ml-1.5 size-3.5" />
          </Link>
        </Button>
      </div>

      <FilterChips
        filters={filterChips}
        activeFilter={statusFilter}
        onFilterChange={(k) => setStatusFilter(k as StatusFilter)}
      />

      <div className="rounded-md border overflow-x-auto">
        <Table>
          <TableHeader className="sticky top-0 bg-background z-10">
            <TableRow>
              <SortableHeader
                label={t("colPlugin")}
                sortKey="pluginId"
                activeKey={sortKey}
                activeDir={sortDir}
                onClick={handleSort}
              />
              <SortableHeader
                label={t("colHandler")}
                sortKey="handler"
                activeKey={sortKey}
                activeDir={sortDir}
                onClick={handleSort}
                className="hidden sm:table-cell"
              />
              <SortableHeader
                label={t("colCron")}
                sortKey="cron"
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
                className="hidden md:table-cell"
              />
              <SortableHeader
                label={t("colLastRun")}
                sortKey="lastRunAt"
                activeKey={sortKey}
                activeDir={sortDir}
                onClick={handleSort}
                className="hidden md:table-cell"
              />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredAndSorted.map((job) => (
              <TableRow key={job.id}>
                <TableCell className="font-mono text-xs">{job.pluginId}</TableCell>
                <TableCell className="hidden sm:table-cell font-mono text-xs">
                  {job.handler}
                </TableCell>
                <TableCell className="font-mono text-xs">{job.cron}</TableCell>
                <TableCell>
                  <StatusBadge status={job.status} />
                </TableCell>
                <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                  {job.nextRunAt
                    ? new Date(job.nextRunAt).toISOString().replace("T", " ").slice(0, 16)
                    : "—"}
                </TableCell>
                <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                  {job.lastRunAt
                    ? new Date(job.lastRunAt).toISOString().replace("T", " ").slice(0, 16)
                    : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function readKey(job: PluginScheduledJobRow, key: SortKey): string | number | null {
  switch (key) {
    case "pluginId":
      return job.pluginId
    case "handler":
      return job.handler
    case "cron":
      return job.cron
    case "status":
      return job.status
    case "nextRunAt":
      return job.nextRunAt ?? null
    case "lastRunAt":
      return job.lastRunAt ?? null
  }
}

function StatusBadge({ status }: { status: string }) {
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
  if (status === "error") {
    return (
      <Badge variant="destructive" className="text-xs">
        {t("error")}
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="text-xs">
      {status}
    </Badge>
  )
}
