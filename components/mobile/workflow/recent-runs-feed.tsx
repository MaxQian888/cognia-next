"use client"

import Link from "next/link"
import { useMemo } from "react"
import { useTranslations } from "next-intl"
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

function relative(ms: number, now: number = Date.now()): string {
  const diff = now - ms
  if (diff < 60_000) return "now"
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h`
  return `${Math.round(diff / 86_400_000)}d`
}

export function RecentRunsFeed({ limit = 10, className }: RecentRunsFeedProps) {
  const t = useTranslations("mobile.workflow")
  const runs =
    useLiveQuery<WorkflowRunRow[]>(
      () => getDb().workflowRuns.orderBy("startedAt").reverse().limit(limit).toArray(),
      [limit]
    ) ?? []
  const workflows = useLiveQuery<WorkflowRow[]>(() => listWorkflows(), []) ?? []
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
                  href={`/workflows/${encodeURIComponent(r.workflowId)}/runs/${encodeURIComponent(r.id)}`}
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
                    {relative(r.startedAt)}
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
