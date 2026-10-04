"use client"

/**
 * Horizontal bar breakdown panel (Top-N by the selected measure) for a
 * dimension such as surface or operation. Bars are click-to-filter: clicking a
 * bar toggles that value in the dashboard's variable filters.
 *
 * The keyboard path is the visible `BreakdownLegend` beside the chart (it
 * replaced a row of `sr-only` buttons that sighted keyboard users tabbed
 * through without seeing), which also carries the "Show traces" drill. The
 * legend names every bar with its colour swatch, so the chart drops its own
 * category axis rather than printing every label twice in a 280px tile.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
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

const TOP_N = 8

export interface BreakdownBarPanelProps {
  panel: PanelDef
  rows: BreakdownRow[]
  editMode?: boolean
  onSelectValue?: (value: string) => void
  selectedValues?: string[]
  /** Drill into Explore narrowed to one value. */
  onShowTraces?: (value: string) => void
}

export function BreakdownBarPanel({
  panel,
  rows,
  editMode,
  onSelectValue,
  selectedValues,
  onShowTraces,
}: BreakdownBarPanelProps) {
  const t = useTranslations("observability")
  const colors = useThemeColors()
  const fmt = useObservabilityFormatters()
  const labelFor = useBreakdownLabel(panel.dimension)
  const [metric, setMetric] = useState<BreakdownMetric>("spans")
  const data = topByMetric(rows, metric, TOP_N).map((r, i) => ({
    key: r.key,
    value: breakdownValue(r, metric),
    color: paletteColor(colors, i),
  }))
  const selected = new Set(selectedValues ?? [])
  const isCost = metric === "cost"
  const title = t(`panels.${panel.titleKey}`)

  return (
    <PanelFrame
      title={title}
      editMode={editMode}
      data-testid={`bar-panel-${panel.id}`}
      actions={<BreakdownMetricToggle value={metric} onChange={setMetric} panelId={panel.id} />}
    >
      {data.length === 0 ? (
        <EmptyHint label={t("noData")} />
      ) : (
        <div className="flex h-full w-full items-stretch gap-2">
          <div className="h-full min-w-0 flex-1" data-testid={`bar-chart-${panel.id}`}>
            <ResponsiveContainer
              width="100%"
              height="100%"
              minWidth={1}
              minHeight={1}
              initialDimension={{ width: 320, height: 180 }}
            >
              <BarChart
                data={data}
                layout="vertical"
                margin={{ top: 4, right: 12, left: 8, bottom: 4 }}
              >
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" horizontal={false} />
                <XAxis
                  type="number"
                  tick={{ fontSize: 11 }}
                  allowDecimals={isCost}
                  tickFormatter={(v) => formatBreakdownMetric(Number(v), metric, fmt)}
                />
                <YAxis type="category" dataKey="key" hide />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE.contentStyle}
                  labelStyle={TOOLTIP_STYLE.labelStyle}
                  formatter={(value) => formatBreakdownMetric(Number(value), metric, fmt)}
                  labelFormatter={(key) => labelFor(String(key))}
                />
                <Bar
                  dataKey="value"
                  radius={[0, 4, 4, 0]}
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
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <BreakdownLegend
            className="max-w-[45%] shrink-0"
            label={title}
            testIdPrefix={`bar-select-${panel.id}`}
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

function EmptyHint({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
      {label}
    </div>
  )
}
