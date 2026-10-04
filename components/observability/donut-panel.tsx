"use client"

/**
 * Donut breakdown panel — share by a dimension (e.g. model) of the selected
 * measure (spans / cost / errors). Slices are colored from the theme palette;
 * a compact legend lists the top categories. Both the slices and the legend
 * rows are click-to-filter: choosing one toggles that value in the dashboard's
 * variable filters (Grafana-style cross-filtering).
 *
 * The legend is `BreakdownLegend` — the keyboard path, shared with the bar
 * panel — and carries the "Show traces" drill when `onShowTraces` is given.
 * Operation / surface ids render as translated labels (raw id in the title);
 * measures format in the app locale.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts"
import { PanelFrame } from "./panel-frame"
import { BreakdownLegend, formatBreakdownMetric } from "./breakdown-legend"
import { BreakdownMetricToggle } from "./breakdown-metric-toggle"
import type { PanelDef } from "./panel-registry"
import {
  breakdownValue,
  topByMetric,
  type BreakdownMetric,
  type BreakdownRow,
} from "@/lib/observability/breakdown"
import { useThemeColors } from "@/hooks/logging/use-theme-colors"
import { paletteColor } from "@/lib/observability/chart-palette"
import { TOOLTIP_STYLE } from "@/lib/observability/chart-config"
import { useObservabilityFormatters } from "@/hooks/observability/use-observability-formatters"
import { useBreakdownLabel } from "@/hooks/observability/use-span-labels"

const TOP_N = 6

export interface DonutPanelProps {
  panel: PanelDef
  rows: BreakdownRow[]
  editMode?: boolean
  /** Toggle a value in the parent filters. Absent → non-interactive. */
  onSelectValue?: (value: string) => void
  /** Values currently active in the filter for this dimension (for highlight). */
  selectedValues?: string[]
  /** Drill into Explore narrowed to one value. */
  onShowTraces?: (value: string) => void
}

export function DonutPanel({
  panel,
  rows,
  editMode,
  onSelectValue,
  selectedValues,
  onShowTraces,
}: DonutPanelProps) {
  const t = useTranslations("observability")
  const colors = useThemeColors()
  const fmt = useObservabilityFormatters()
  const labelFor = useBreakdownLabel(panel.dimension)
  const [metric, setMetric] = useState<BreakdownMetric>("spans")
  const title = t(`panels.${panel.titleKey}`)

  const data = topByMetric(rows, metric, TOP_N).map((r, i) => ({
    key: r.key,
    value: breakdownValue(r, metric),
    color: paletteColor(colors, i),
  }))
  const selected = new Set(selectedValues ?? [])

  return (
    <PanelFrame
      title={title}
      editMode={editMode}
      data-testid={`donut-panel-${panel.id}`}
      actions={<BreakdownMetricToggle value={metric} onChange={setMetric} panelId={panel.id} />}
    >
      {data.length === 0 ? (
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          {t("noData")}
        </div>
      ) : (
        <div className="flex h-full items-center gap-2">
          <div className="h-full min-w-0 flex-1" data-testid={`donut-chart-${panel.id}`}>
            <ResponsiveContainer
              width="100%"
              height="100%"
              minWidth={1}
              minHeight={1}
              initialDimension={{ width: 320, height: 180 }}
            >
              <PieChart>
                <Pie
                  data={data}
                  dataKey="value"
                  nameKey="key"
                  cx="50%"
                  cy="50%"
                  innerRadius="55%"
                  outerRadius="80%"
                  paddingAngle={2}
                  isAnimationActive={false}
                  onClick={(data) => {
                    const key = (data as { key?: string } | undefined)?.key
                    if (key) onSelectValue?.(key)
                  }}
                  className={onSelectValue ? "cursor-pointer" : undefined}
                >
                  {data.map((d) => (
                    <Cell
                      key={d.key}
                      fill={d.color}
                      opacity={selected.size === 0 || selected.has(d.key) ? 1 : 0.4}
                    />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={TOOLTIP_STYLE.contentStyle}
                  labelStyle={TOOLTIP_STYLE.labelStyle}
                  formatter={(value) => formatBreakdownMetric(Number(value), metric, fmt)}
                  labelFormatter={(key) => labelFor(String(key))}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <BreakdownLegend
            className="max-w-[45%] shrink-0"
            label={title}
            testIdPrefix={`donut-legend-${panel.id}`}
            items={data.map((d) => ({
              key: d.key,
              label: labelFor(d.key),
              value: formatBreakdownMetric(d.value, metric, fmt),
              color: d.color,
            }))}
            selected={selected}
            onSelectValue={onSelectValue}
            onShowTraces={editMode ? undefined : onShowTraces}
          />
        </div>
      )}
    </PanelFrame>
  )
}
