"use client"

/**
 * Compact segmented control that switches a breakdown panel's measure between
 * span count, cost and error count. Rendered in the panel header (via the
 * `PanelFrame` actions slot); lives in its own file so both the donut and bar
 * panels share one tested control.
 */

import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
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
        <Button
          key={m}
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => onChange(m)}
          aria-pressed={value === m}
          data-testid={`metric-toggle-${panelId}-${m}`}
          className={cn(
            "h-5 rounded-sm px-1.5 text-[10px] uppercase tracking-wide",
            value === m
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {t(m)}
        </Button>
      ))}
    </div>
  )
}
