"use client"

/**
 * One muted line under a long-run launch control saying what runs like this
 * usually cost and take (ADR-0232). Advisory only: it never disables or gates
 * the control it sits beside.
 *
 * Renders nothing while history loads or when the read failed, so a launch
 * surface never shows a placeholder that reads like a measurement.
 */

import { useTranslations } from "next-intl"
import { GaugeIcon } from "lucide-react"

import { useRunEstimate } from "@/hooks/usage/use-run-estimate"
import { EMPTY_ESTIMATE, type RunEstimateQuery } from "@/lib/usage/run-estimate/estimate"
import { formatRunEstimate } from "@/lib/usage/run-estimate/format"
import { cn } from "@/lib/utils"

export interface RunEstimateHintProps {
  /** One query per parallel part of the launch; `null` keeps the hint idle. */
  queries: readonly RunEstimateQuery[] | null
  className?: string
  "data-testid"?: string
}

export function RunEstimateHint({
  queries,
  className,
  "data-testid": testId = "run-estimate-hint",
}: RunEstimateHintProps) {
  const t = useTranslations("runEstimate")
  const { status, estimate, dormant } = useRunEstimate(queries)
  if (status !== "ready" || (!estimate && !dormant)) return null
  const formatted = formatRunEstimate(estimate ?? EMPTY_ESTIMATE, t, { dormant })
  return (
    <p
      className={cn("flex items-start gap-1.5 text-xs text-muted-foreground", className)}
      data-testid={testId}
      data-confidence={dormant ? "dormant" : estimate?.confidence}
    >
      <GaugeIcon aria-hidden className="mt-px size-3.5 shrink-0" />
      <span>
        <span className="sr-only">{t("label")} </span>
        {formatted.summary}
        {formatted.detail ? <span className="opacity-80"> · {formatted.detail}</span> : null}
      </span>
    </p>
  )
}
