"use client"

/**
 * One run, wherever runs are listed (ADR-0179 §1).
 *
 * The overview's recent runs, the detail's runs section and every kind's
 * "recent runs" used to be three row layouts. This is the one. It answers,
 * left to right: how it ended, what ran (optional, when the list mixes
 * items), when it started, how long it took, and a Stop while it is still
 * going. A failed row carries its error message on a second line so the
 * reason is on screen without opening the sheet. A run that stopped for want
 * of an approver (`needs-approval`) reads as that, in amber, with what it
 * was waiting on, rather than as a crash.
 */

import { useTranslations } from "next-intl"
import { HandIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { RunStatusPill } from "@/components/workflow/runs/run-status-pill"
import { useNowTicker } from "@/hooks/fleet/use-now-ticker"
import { cn } from "@/lib/utils"
import { formatDuration } from "@/lib/scheduler/format-utils"
import {
  runApprovalRequest,
  toRunStatusPill,
  type RunApprovalRequest,
  type UnifiedExecutionRun,
} from "@/types/scheduler/unified-runs"

import { KindIcon } from "./kind-visuals"

/** A run's status pill: `Needs approval` for a run that stopped for one. */
export function RunOutcomePill({
  run,
  className,
}: {
  run: UnifiedExecutionRun
  className?: string
}) {
  const t = useTranslations("scheduler.approval")
  if (!runApprovalRequest(run)) {
    return <RunStatusPill status={toRunStatusPill(run.status)} className={className} />
  }
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5 border-amber-500/40 bg-amber-500/15 font-normal text-amber-700 dark:text-amber-400",
        className
      )}
      data-testid="run-status-needs-approval"
    >
      <HandIcon className="size-3" aria-hidden="true" />
      {t("pill")}
    </Badge>
  )
}

/** One line naming what a `needs-approval` run was waiting on. */
export function useRunApprovalLine(): (request: RunApprovalRequest) => string {
  const t = useTranslations("scheduler.approval")
  return (request) => {
    const parts: string[] = []
    if (request.tools.length > 0) parts.push(t("tools", { tools: request.tools.join(", ") }))
    if (request.untrustedRoots.length > 0) {
      const roots = request.untrustedRoots.join(", ")
      parts.push(request.unverified ? t("trustUnverified", { roots }) : t("trust", { roots }))
    }
    return parts.length > 0 ? parts.join(" · ") : t("fallback")
  }
}

export interface RunRowProps {
  run: UnifiedExecutionRun
  onOpen: (run: UnifiedExecutionRun) => void
  /** Offered on a running row; the caller decides whether cancel can reach it. */
  onCancel?: (run: UnifiedExecutionRun) => void
  /** Show the item's name and kind, for lists that mix items. */
  showItem?: boolean
  /** Marks the row the sheet is showing. */
  selected?: boolean
  className?: string
}

/** "3m ago" for something that already happened; the ticker keeps it fresh. */
export function useRunRelativeTime(): (epochMs: number) => string {
  const t = useTranslations("scheduler.runRow")
  const now = useNowTicker()
  return (epochMs) => {
    const diff = Math.max(0, now - epochMs)
    if (diff < 60_000) return t("justNow")
    if (diff < 3_600_000) return t("minutesAgo", { count: Math.floor(diff / 60_000) })
    if (diff < 86_400_000) return t("hoursAgo", { count: Math.floor(diff / 3_600_000) })
    if (diff < 7 * 86_400_000) return t("daysAgo", { count: Math.floor(diff / 86_400_000) })
    return new Date(epochMs).toLocaleDateString(undefined, { month: "short", day: "numeric" })
  }
}

export function RunRow({
  run,
  onOpen,
  onCancel,
  showItem = false,
  selected,
  className,
}: RunRowProps) {
  const t = useTranslations("scheduler")
  const relative = useRunRelativeTime()
  const approvalLine = useRunApprovalLine()
  const isRunning = run.status === "running"
  const approval = runApprovalRequest(run)

  return (
    <div
      className={cn(
        "group flex items-start gap-2.5 rounded-md px-2 py-1.5",
        selected && "bg-muted",
        className
      )}
      data-testid={`run-row-${run.unifiedId}`}
      data-status={run.status}
      data-terminal-reason={run.terminalReason}
    >
      <button
        type="button"
        onClick={() => onOpen(run)}
        className="flex min-w-0 flex-1 items-start gap-2.5 text-left hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
        aria-current={selected ? "true" : undefined}
      >
        <RunOutcomePill run={run} className="mt-px shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5 text-xs">
            {showItem ? (
              <>
                <KindIcon kind={run.kind} className="size-3 text-muted-foreground" />
                <span className="min-w-0 truncate font-medium">{run.itemName}</span>
              </>
            ) : null}
            <span
              className={cn(
                "shrink-0 text-muted-foreground",
                !showItem && "font-medium text-foreground"
              )}
            >
              {relative(run.startedAt)}
            </span>
            {run.triggerSource && run.triggerSource !== "schedule" ? (
              <Badge
                variant="outline"
                className="h-4 rounded-pill px-1 text-[10px] font-normal"
                data-testid="run-row-trigger-source"
              >
                {t(`triggerSources.${run.triggerSource}`)}
              </Badge>
            ) : null}
          </span>
          {approval ? (
            <span
              className="mt-0.5 block truncate text-[11px] text-amber-600 dark:text-amber-400"
              data-testid="run-row-approval"
            >
              {approvalLine(approval)}
            </span>
          ) : run.status === "failed" && run.error?.message ? (
            <span
              className="mt-0.5 block truncate text-[11px] text-red-600 dark:text-red-400"
              data-testid="run-row-error"
            >
              {run.error.message}
            </span>
          ) : null}
        </span>
      </button>
      {isRunning && onCancel ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="h-6 shrink-0 px-2 text-[11px]"
          onClick={() => onCancel(run)}
          data-testid="run-row-cancel"
        >
          {t("cancelRun")}
        </Button>
      ) : null}
      <span
        className="shrink-0 pt-0.5 font-mono text-[11px] tabular-nums text-muted-foreground"
        data-testid="run-row-duration"
      >
        {isRunning ? "…" : formatDuration(run.durationMs)}
      </span>
    </div>
  )
}
