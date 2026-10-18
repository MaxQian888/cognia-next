"use client"

/**
 * One muted line under a long run that is still going: what it has spent so
 * far against what runs like it usually total (ADR-0232, phase 2). Past the
 * usual range the line turns amber and says so. Advisory only: it offers no
 * action and stops nothing.
 *
 * Renders nothing until both the spend and an estimate exist, so a run that
 * has not billed a turn yet, or has no comparable history, shows no line.
 */

import { useTranslations } from "next-intl"
import { GaugeIcon } from "lucide-react"

import { useRunEstimate } from "@/hooks/usage/use-run-estimate"
import type { RunEstimateQuery } from "@/lib/usage/run-estimate/estimate"
import { formatRunProgress } from "@/lib/usage/run-estimate/format"
import { compareRunProgress, type RunSpend } from "@/lib/usage/run-estimate/progress"
import { cn } from "@/lib/utils"

export interface RunProgressHintProps {
  /** The same queries the launch hint used for this kind of run. */
  queries: readonly RunEstimateQuery[] | null
  /** What the run has used so far; `null` while unknown. */
  spend: RunSpend | null
  className?: string
  "data-testid"?: string
}

export function RunProgressHint({
  queries,
  spend,
  className,
  "data-testid": testId = "run-progress-hint",
}: RunProgressHintProps) {
  const t = useTranslations("runEstimate")
  const { status, estimate } = useRunEstimate(spend ? queries : null)
  if (status !== "ready" || !spend) return null
  const comparison = compareRunProgress(spend, estimate)
  if (!comparison) return null
  const formatted = formatRunProgress(comparison, t)
  return (
    <p
      className={cn(
        "flex items-start gap-1.5 text-xs",
        comparison.overRange ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
        className
      )}
      data-testid={testId}
      data-over-range={comparison.overRange}
    >
      <GaugeIcon aria-hidden className="mt-px size-3.5 shrink-0" />
      <span>
        {formatted.text}
        <span className="opacity-80"> · {formatted.detail}</span>
      </span>
    </p>
  )
}
