"use client"

import { useTranslations } from "next-intl"
import Link from "next/link"
import { motion, useReducedMotion } from "motion/react"

import type { WorkflowRunRow } from "@/types/workflow/visual"
import { STAGGER_CHILD, STAGGER_CONTAINER } from "@/lib/ui/motion"
import { cn } from "@/lib/utils"

import { RunStatusBadge } from "./run-status-badge"

export interface RunVerticalGanttProps {
  runs: WorkflowRunRow[]
  /** Optional href builder; defaults to `/workflows/<id>/runs/<runId>`. */
  hrefForRun?: (run: WorkflowRunRow) => string
  className?: string
}

function formatDuration(run: WorkflowRunRow): string {
  if (!run.completedAt) return ""
  const ms = Math.max(0, run.completedAt - run.startedAt)
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${Math.round(ms / 100) / 10}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

export function RunVerticalGantt({ runs, hrefForRun, className }: RunVerticalGanttProps) {
  const t = useTranslations("mobile.workflow")
  const reduce = useReducedMotion()

  if (runs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="run-vertical-gantt-empty">
        {t("noRuns")}
      </p>
    )
  }

  return (
    <motion.ol
      className={cn("flex flex-col", className)}
      data-testid="run-vertical-gantt"
      aria-label={t("runsHeader")}
      initial={reduce ? false : "initial"}
      animate="animate"
      variants={STAGGER_CONTAINER}
    >
      {runs.map((run) => {
        const href = hrefForRun
          ? hrefForRun(run)
          : `/workflows/${encodeURIComponent(run.workflowId)}/runs/${encodeURIComponent(run.id)}`
        const startedDate = new Date(run.startedAt).toLocaleString()
        const duration = formatDuration(run)
        return (
          <motion.li
            key={run.id}
            className="border-b border-border last:border-0"
            variants={STAGGER_CHILD}
          >
            <Link
              href={href}
              className="flex items-center gap-3 px-3 py-3 active:bg-muted/50"
              data-testid={`run-row-${run.id}`}
            >
              {/* Vertical timeline dot. */}
              <span
                aria-hidden
                className={cn(
                  "size-2.5 shrink-0 rounded-full",
                  run.status === "running" && "bg-blue-500 animate-pulse",
                  run.status === "succeeded" && "bg-emerald-500",
                  run.status === "failed" && "bg-destructive",
                  run.status === "cancelled" && "bg-muted-foreground",
                  run.status === "pending" && "bg-muted-foreground/60",
                  (run.status === "waiting" || run.status === "paused") && "bg-amber-500"
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{startedDate}</span>
                  <RunStatusBadge status={run.status} className="ml-auto" />
                </div>
                {duration ? (
                  <p className="mt-0.5 text-[11px] font-mono text-muted-foreground">{duration}</p>
                ) : null}
                {run.error?.message ? (
                  <p className="line-clamp-1 text-[11px] text-destructive">{run.error.message}</p>
                ) : null}
              </div>
            </Link>
          </motion.li>
        )
      })}
    </motion.ol>
  )
}
