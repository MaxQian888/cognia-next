"use client"

/**
 * Per-step performance + cost table for a run. Surfaces what the Gantt can't:
 * exact durations, retry attempts, and token/cost per step — sortable by
 * duration so the slowest step (the bottleneck) is one click away.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { FlameIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { VisualWorkflow, WorkflowRunEventRow } from "@/types/workflow/visual"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { computeStepBreakdown } from "@/lib/workflow/runs/step-breakdown"
import { formatDurationMs } from "./format"
import { formatCostUsd, formatTokens } from "@/lib/workflow/runs/usage-aggregate"

export function RunStepBreakdown({
  workflow,
  events,
  startedAt,
  completedAt,
}: {
  workflow: VisualWorkflow
  events: WorkflowRunEventRow[]
  startedAt: number
  completedAt: number | undefined
}) {
  const t = useTranslations("workflows.runs.detail.breakdown")
  const [sortByDuration, setSortByDuration] = useState(false)
  const breakdown = useMemo(
    () => computeStepBreakdown(workflow, events, completedAt, startedAt),
    [workflow, events, completedAt, startedAt]
  )

  const rows = useMemo(() => {
    if (!sortByDuration) return breakdown.rows
    return [...breakdown.rows].sort((a, b) => b.durationMs - a.durationMs)
  }, [breakdown.rows, sortByDuration])

  if (rows.length === 0) {
    return <p className="px-1 py-4 text-sm text-muted-foreground">{t("empty")}</p>
  }

  return (
    <section className="mt-6" aria-label={t("title")}>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t("title")}</h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSortByDuration((s) => !s)}
          aria-pressed={sortByDuration}
          data-testid="breakdown-sort-duration"
        >
          {t("sortByDuration")}
        </Button>
      </div>
      <div className="rounded-md border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("step")}</TableHead>
              <TableHead>{t("status")}</TableHead>
              <TableHead className="text-right">{t("duration")}</TableHead>
              <TableHead className="text-right">{t("attempts")}</TableHead>
              <TableHead className="text-right">{t("tokens")}</TableHead>
              <TableHead className="text-right">{t("cost")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const isSlowest = row.stepId === breakdown.slowestStepId
              return (
                <TableRow
                  key={row.stepId}
                  className={cn(isSlowest && "bg-wf-status-waiting/10")}
                  data-testid={`breakdown-row-${row.stepId}`}
                >
                  <TableCell className="font-medium">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate" title={row.label}>
                        {row.label}
                      </span>
                      {isSlowest ? (
                        <Badge
                          variant="outline"
                          className="gap-1 border-wf-status-waiting/40 text-wf-status-waiting"
                        >
                          <FlameIcon className="size-3" aria-hidden="true" />
                          {t("slowest")}
                        </Badge>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{row.status}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatDurationMs(row.durationMs)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.attempts > 1 ? (
                      <span title={t("retried", { count: row.attempts - 1 })}>×{row.attempts}</span>
                    ) : (
                      row.attempts
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {row.usage ? formatTokens(row.usage.totalTokens) : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {row.usage?.costUsd !== undefined ? formatCostUsd(row.usage.costUsd) : "—"}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </section>
  )
}
