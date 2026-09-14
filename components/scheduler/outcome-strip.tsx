"use client"

/**
 * Fourteen days of outcomes, one cell each (ADR-0179 §3).
 *
 * Replaces the recharts bar chart on the overview and the copy of it on the
 * app-task detail. A cell is one of five tones; the counts live in the
 * cell's label for a screen reader and in its tooltip for a pointer. The
 * caption beside the strip says the totals, so the strip never has to be
 * counted.
 */

import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"
import type { OutcomeCell, OutcomeTone } from "@/lib/scheduler/outcome-strip"
import { summarizeOutcomeCells } from "@/lib/scheduler/outcome-strip"

const TONE_CLASS: Record<OutcomeTone, string> = {
  none: "bg-muted",
  success: "bg-emerald-500/80",
  failure: "bg-red-500/80",
  mixed: "bg-amber-500/80",
  running: "bg-sky-500/80 animate-pulse",
}

export interface OutcomeStripProps {
  cells: readonly OutcomeCell[]
  className?: string
  testId?: string
}

export function OutcomeStrip({ cells, className, testId = "outcome-strip" }: OutcomeStripProps) {
  const t = useTranslations("scheduler.outcome")
  const summary = summarizeOutcomeCells(cells)

  return (
    <div className={cn("min-w-0", className)} data-testid={testId}>
      <ol className="flex gap-1" aria-label={t("stripLabel", { days: cells.length })}>
        {cells.map((cell) => {
          const label = t("cellLabel", {
            date: cell.date.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
            succeeded: cell.succeeded,
            failed: cell.failed,
            running: cell.running,
          })
          return (
            <li
              key={cell.key}
              className={cn("h-6 min-w-0 flex-1 rounded-sm", TONE_CLASS[cell.tone])}
              title={label}
              aria-label={label}
              data-tone={cell.tone}
              data-testid={`${testId}-cell`}
            />
          )
        })}
      </ol>
      <p className="mt-1.5 flex items-center gap-x-3 text-[11px] text-muted-foreground tabular-nums">
        <span data-testid={`${testId}-succeeded`}>
          {t("succeeded", { count: summary.succeeded })}
        </span>
        <span data-testid={`${testId}-failed`}>{t("failed", { count: summary.failed })}</span>
        <span className="ml-auto" data-testid={`${testId}-rate`}>
          {summary.successRate === null ? t("noRuns") : t("rate", { rate: summary.successRate })}
        </span>
      </p>
    </div>
  )
}
