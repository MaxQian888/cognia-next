"use client"

// Reads `pluginScheduledJobs` straight from Dexie, presents one row per
// job with cron + next-run + last-run + status. Mirrors the scheduler
// settings panel shape but scoped to plugin contributions only. Provides
// a deep link to the global scheduler section for advanced configuration.

import Link from "next/link"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { ClockIcon, PlayIcon, PauseIcon, ArrowRightIcon } from "lucide-react"
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
import { getDb } from "@/lib/db/schema"
import type { PluginScheduledJobRow } from "@/lib/db/plugin-types"

async function listScheduledJobs(): Promise<PluginScheduledJobRow[]> {
  return getDb().pluginScheduledJobs.orderBy("nextRunAt").toArray()
}

export function PluginScheduledJobs() {
  const t = useTranslations("plugins.scheduledJobs")
  const jobs = useLiveQuery(() => listScheduledJobs(), [])

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

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Badge variant="secondary" className="text-xs">
          {t("countTotal", { count: jobs.length })}
        </Badge>
        <Button asChild size="sm" variant="outline">
          <Link href="/settings?section=scheduled-tasks">
            {t("openScheduler")}
            <ArrowRightIcon className="ml-1.5 size-3.5" />
          </Link>
        </Button>
      </div>

      <div className="rounded-md border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("colPlugin")}</TableHead>
              <TableHead>{t("colHandler")}</TableHead>
              <TableHead>{t("colCron")}</TableHead>
              <TableHead>{t("colStatus")}</TableHead>
              <TableHead className="hidden md:table-cell">{t("colNextRun")}</TableHead>
              <TableHead className="hidden md:table-cell">{t("colLastRun")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.map((job) => (
              <TableRow key={job.id}>
                <TableCell className="font-mono text-xs">{job.pluginId}</TableCell>
                <TableCell className="font-mono text-xs">{job.handler}</TableCell>
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
