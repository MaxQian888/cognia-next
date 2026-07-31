"use client"

/**
 * Compact segmented control that switches a breakdown panel's measure between
 * span count, cost and error count. Rendered in the panel header (via the
 * `PanelFrame` actions slot); lives in its own file so both the donut and bar
 * panels share one tested control.
 */

import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import type { BreakdownMetric } from "@/lib/observability/breakdown"

const METRICS: readonly BreakdownMetric[] = ["spans", "cost", "errors"]

export interface BreakdownMetricToggleProps {
  value: BreakdownMetric
  onChange: (metric: BreakdownMetric) => void
  /** Disambiguates test ids / aria when several toggles are on screen. */
  panelId: string
}

export function BreakdownMetricToggle({ value, onChange, panelId }: BreakdownMetricToggleProps) {
  const t = useTranslations("observability.metricToggle")
  return (
    <div
      className="flex items-center gap-0.5 rounded-md border p-0.5"
      role="group"
      aria-label={t("label")}
      data-testid={`metric-toggle-${panelId}`}
    >
      {METRICS.map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          aria-pressed={value === m}
          data-testid={`metric-toggle-${panelId}-${m}`}
          className={cn(
            "rounded-sm px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide transition-colors",
            value === m
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {t(m)}
        </button>
      ))}
    </div>
  )
}
