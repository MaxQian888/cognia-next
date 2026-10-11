"use client"

/**
 * The dashboard's headline numbers as one flat strip above the chart grid.
 *
 * The eight KPIs used to be eight framed tiles inside the draggable grid —
 * each a `PanelFrame` with its own top rule, bottom rule and header rule, laid
 * out 5 + 3 at unequal widths on a desktop and 2 × 4 on a phone, where they
 * filled the whole first screen before a single chart. They were never charts:
 * a stat has nothing to resize, and dragging one only reordered numbers.
 *
 * The strip draws hairlines between cells rather than boxes around them, and
 * reflows by its own width (`@container/kpi`), not the viewport's — the Traces
 * channel can be a third of a wide window or the whole of a phone:
 *
 *   < 32rem  two columns
 *   ≥ 32rem  four
 *   ≥ 64rem  all eight on one line
 *
 * Hidden stats (Settings sheet → panel visibility) drop out of the strip the
 * same way hidden charts drop out of the grid. A strip with every stat hidden
 * renders nothing rather than an empty rule.
 */

import { useTranslations } from "next-intl"
import { StatPanel } from "./stat-panel"
import { KPI_PANELS } from "./panel-registry"
import type { WindowKpis } from "@/lib/observability/aggregate-series"
import type { ThresholdConfig, ThresholdMetric } from "@/lib/observability/thresholds"
import { cn } from "@/lib/utils"

export interface KpiStripProps {
  kpis: WindowKpis
  hiddenPanels?: readonly string[]
  /** Resolved thresholds (defaults merged with user overrides). */
  thresholds?: Record<ThresholdMetric, ThresholdConfig>
  /** Errors-only drill into Explore, offered by the failure-count stats. */
  onDrillErrors?: () => void
  className?: string
}

export function KpiStrip({
  kpis,
  hiddenPanels,
  thresholds,
  onDrillErrors,
  className,
}: KpiStripProps) {
  const t = useTranslations("observability")
  const hidden = new Set(hiddenPanels ?? [])
  const visible = KPI_PANELS.filter((panel) => !hidden.has(panel.id))
  if (visible.length === 0) return null

  return (
    <section
      aria-label={t("kpiStrip.label")}
      className={cn("@container/kpi overflow-hidden border-b", className)}
      data-testid="kpi-strip"
    >
      {/* The cells carry the rules (`border-t border-l`) and the list is pulled
          up and left by a pixel, so only the rules BETWEEN cells show — and a
          short last row leaves blank space instead of a filled gap. */}
      <dl
        className="-mt-px -ml-px grid grid-cols-2 @lg/kpi:grid-cols-4 @5xl/kpi:grid-cols-8"
        data-count={visible.length}
      >
        {visible.map((panel) => (
          <StatPanel
            key={panel.id}
            panel={panel}
            kpis={kpis}
            thresholds={thresholds}
            onDrill={panel.drillErrors ? onDrillErrors : undefined}
            className="border-t border-l"
          />
        ))}
      </dl>
    </section>
  )
}
