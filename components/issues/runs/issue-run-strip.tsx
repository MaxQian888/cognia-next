"use client"

/**
 * An issue's runs at a glance: one mark per run, oldest to newest, coloured
 * by how it ended, with engine, status and start time on hover. Sits above
 * the run cards so a history of retries reads as a pattern (fail, fail,
 * succeed) before anyone scrolls through the cards one by one.
 */

import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"
import type { IssueRun, IssueRunStatus } from "@/types/issues"

const STATUS_CLASS: Readonly<Record<IssueRunStatus, string>> = {
  queued: "bg-muted-foreground/40",
  running: "bg-amber-500 motion-safe:animate-pulse",
  succeeded: "bg-emerald-500",
  failed: "bg-destructive",
  cancelled: "bg-muted-foreground/60",
}

export interface IssueRunStripProps {
  /** Newest first, as `listIssueRuns` returns them. */
  runs: readonly IssueRun[]
}

export function IssueRunStrip({ runs }: IssueRunStripProps) {
  const t = useTranslations("issues")
  if (runs.length < 2) return null
  const format = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })
  return (
    <ol
      className="flex flex-wrap items-center gap-1"
      aria-label={t("run.timeline")}
      data-testid="issue-run-strip"
    >
      {[...runs].reverse().map((run) => {
        const label = t("run.timelineEntry", {
          engine: t(`run.adapter.${run.adapterId}.name`),
          status: t(`run.status.${run.status}`),
          at: format.format(run.startedAt),
        })
        return (
          <li
            key={run.id}
            title={label}
            aria-label={label}
            className={cn("size-2.5 rounded-full", STATUS_CLASS[run.status])}
            data-testid={`issue-run-strip-${run.status}`}
          />
        )
      })}
    </ol>
  )
}
