"use client"

import Link from "next/link"
import { useMemo } from "react"
import { useFormatter, useNow, useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { motion, useReducedMotion } from "motion/react"

import { getDb } from "@/lib/db/schema"
import { listWorkflows } from "@/lib/db/workflows"
import type { WorkflowRow, WorkflowRunRow } from "@/types/workflow/visual"
import { STAGGER_CHILD, STAGGER_CONTAINER } from "@/lib/ui/motion"
import { cn } from "@/lib/utils"

export interface RecentRunsFeedProps {
  /** Cap on how many runs to show. */
  limit?: number
  className?: string
}

const STATUS_COLOR: Record<string, string> = {
  running: "bg-emerald-500",
  succeeded: "bg-sky-500",
  failed: "bg-destructive",
  cancelled: "bg-muted-foreground",
  skipped: "bg-muted-foreground",
  waiting: "bg-amber-500",
}

export function RecentRunsFeed({ limit = 10, className }: RecentRunsFeedProps) {
  const t = useTranslations("mobile.workflow")
  // Localized "3 minutes ago" via next-intl — the old hand-rolled "3m"/"2d"
  // helper rendered raw English abbreviations for zh-CN users.
  const format = useFormatter()
  const now = useNow()
  const runsRaw = useLiveQuery<WorkflowRunRow[]>(
    () => getDb().workflowRuns.orderBy("startedAt").reverse().limit(limit).toArray(),
    [limit]
  )
  const workflowsRaw = useLiveQuery<WorkflowRow[]>(() => listWorkflows(), [])
  const runs = useMemo(() => runsRaw ?? [], [runsRaw])
  const workflows = useMemo(() => workflowsRaw ?? [], [workflowsRaw])
  const workflowById = useMemo(() => {
    const map = new Map<string, WorkflowRow>()
    for (const wf of workflows) map.set(wf.id, wf)
    return map
  }, [workflows])
  const reduce = useReducedMotion()

  return (
    <section className={cn("flex flex-col gap-2 px-4", className)} data-testid="recent-runs-feed">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t("runsHeader")}
      </h2>
      {runs.length === 0 ? (
        <p
          className="rounded-md border border-dashed border-border bg-card/40 px-4 py-4 text-center text-xs text-muted-foreground"
          data-testid="recent-runs-empty"
        >
          {t("noRuns")}
        </p>
      ) : (
        <motion.ul
          className="flex flex-col divide-y divide-border rounded-md border border-border bg-card"
          initial={reduce ? false : "initial"}
          animate="animate"
          variants={STAGGER_CONTAINER}
        >
          {runs.map((r) => {
            const wf = workflowById.get(r.workflowId)
            const dot = STATUS_COLOR[r.status] ?? "bg-muted-foreground"
            return (
              <motion.li key={r.id} variants={STAGGER_CHILD}>
                <Link
                  href={`/workflows/run?id=${encodeURIComponent(r.workflowId)}&runId=${encodeURIComponent(r.id)}`}
                  data-testid={`recent-run-${r.id}`}
                  className="flex items-center gap-3 px-3 py-2 active:bg-muted/50"
                >
                  <span
                    className={cn("inline-flex size-2 shrink-0 rounded-full", dot)}
                    aria-hidden="true"
                    data-status={r.status}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="truncate text-sm font-medium">{wf?.name ?? r.workflowId}</span>
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {format.relativeTime(new Date(r.startedAt), now)}
                  </span>
                </Link>
              </motion.li>
            )
          })}
        </motion.ul>
      )}
    </section>
  )
}
