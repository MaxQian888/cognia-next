"use client"

import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { SessionObservationSummary } from "@/types/agent/agent-trace"

export type TraceHealthGrade = "A" | "B" | "C" | "D" | "F"

export interface TraceHealthScore {
  grade: TraceHealthGrade
  score: number
  breakdown: {
    successRate: string
    costEfficiency: string
    latencyPercentile: string
    errorDensity: string
  }
}

const GRADE_CLASSNAME: Record<TraceHealthGrade, string> = {
  A: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  B: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  C: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  D: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300",
  F: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
}

/**
 * Self-contained health-score derivation. Cognia's full implementation
 * lives in `lib/agent-trace/health-score.ts`; cognia-next computes a
 * coarse approximation directly from the observation summary so this
 * badge does not pull in the (un-migrated) agent-trace stack.
 */
export function deriveTraceHealthScore(summary: SessionObservationSummary): TraceHealthScore {
  const toolCallCount = Math.max(0, summary.toolCallCount ?? summary.toolCount ?? 0)
  const errorCount = Math.max(0, summary.errorCount ?? 0)

  const successRatePct =
    toolCallCount > 0 ? ((toolCallCount - errorCount) / toolCallCount) * 100 : 100
  const successRate = Math.max(0, Math.min(100, Math.round(successRatePct)))

  const errorDensityPct = toolCallCount > 0 ? (errorCount / toolCallCount) * 100 : 0
  const errorDensity = Math.max(0, Math.min(100, Math.round(errorDensityPct)))

  const cost = summary.totalTokenCost ?? 0
  const costEfficiency =
    cost <= 0 ? 100 : cost <= 0.05 ? 90 : cost <= 0.5 ? 70 : cost <= 2 ? 50 : 30

  const latency = summary.latencyP50Ms ?? 0
  const latencyPercentile =
    latency <= 0 ? 100 : latency <= 1500 ? 90 : latency <= 5000 ? 70 : latency <= 15000 ? 50 : 30

  const score = Math.round(
    successRate * 0.4 +
      costEfficiency * 0.2 +
      latencyPercentile * 0.25 +
      (100 - errorDensity) * 0.15
  )

  let grade: TraceHealthGrade = "F"
  if (summary.outcome === "error" || score < 50) grade = "F"
  else if (score >= 90) grade = "A"
  else if (score >= 80) grade = "B"
  else if (score >= 70) grade = "C"
  else if (score >= 60) grade = "D"

  return {
    grade,
    score: Math.max(0, Math.min(100, score)),
    breakdown: {
      successRate: `${successRate}%`,
      costEfficiency: `${costEfficiency}%`,
      latencyPercentile: `${latencyPercentile}%`,
      errorDensity: `${errorDensity}%`,
    },
  }
}

interface TraceHealthBadgeProps {
  summary: SessionObservationSummary
  className?: string
}

export function TraceHealthBadge({ summary, className }: TraceHealthBadgeProps) {
  const t = useTranslations("externalAgent.traceHealth")
  const health = deriveTraceHealthScore(summary)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className={cn(
            "gap-1 text-[10px] font-medium tabular-nums",
            GRADE_CLASSNAME[health.grade],
            className
          )}
        >
          <span>{health.grade}</span>
          <span>{health.score}</span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="space-y-1 text-xs">
        <div className="font-medium">{t("title")}</div>
        <div>
          {t("success")}: {health.breakdown.successRate}
        </div>
        <div>
          {t("cost")}: {health.breakdown.costEfficiency}
        </div>
        <div>
          {t("latency")}: {health.breakdown.latencyPercentile}
        </div>
        <div>
          {t("errorDensity")}: {health.breakdown.errorDensity}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
