"use client"

/**
 * Donut breakdown panel — share by a dimension (e.g. model) of the selected
 * measure (spans / cost / errors). Slices are colored from the theme palette;
 * a compact legend lists the top categories. Both the slices and the legend
 * rows are click-to-filter: choosing one toggles that value in the dashboard's
 * variable filters (Grafana-style cross-filtering).
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts"
import { Button } from "@/components/ui/button"
import { PanelFrame } from "./panel-frame"
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
import { formatUsd } from "@/lib/observability/format-utils"
import { cn } from "@/lib/utils"

const TOP_N = 6

export interface DonutPanelProps {
  panel: PanelDef
  rows: BreakdownRow[]
  editMode?: boolean
  /** Toggle a value in the parent filters. Absent → non-interactive. */
  onSelectValue?: (value: string) => void
  /** Values currently active in the filter for this dimension (for highlight). */
  selectedValues?: string[]
}

function formatMetric(value: number, metric: BreakdownMetric): string {
  return metric === "cost" ? formatUsd(value) : String(value)
}

export function DonutPanel({
  panel,
  rows,
  editMode,
  onSelectValue,
  selectedValues,
}: DonutPanelProps) {
  const t = useTranslations("observability")
  const colors = useThemeColors()
  const [metric, setMetric] = useState<BreakdownMetric>("spans")

  const data = topByMetric(rows, metric, TOP_N).map((r, i) => ({
    key: r.key,
    value: breakdownValue(r, metric),
    color: paletteColor(colors, i),
  }))
  const selected = new Set(selectedValues ?? [])

  return (
    <PanelFrame
      title={t(`panels.${panel.titleKey}`)}
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
                  formatter={(value) => formatMetric(Number(value), metric)}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <ul className="flex max-h-full shrink-0 flex-col gap-1 overflow-auto pr-1 text-xs">
            {data.map((d) => {
              const isSelected = selected.has(d.key)
              const content = (
                <>
                  <span
                    className="size-2 shrink-0 rounded-sm"
                    style={{ backgroundColor: d.color }}
                  />
                  <span className="max-w-[120px] truncate text-muted-foreground">{d.key}</span>
                  <span className="ml-auto tabular-nums">{formatMetric(d.value, metric)}</span>
                </>
              )
              return (
                <li key={d.key} data-testid={`donut-legend-${panel.id}`}>
                  {onSelectValue ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => onSelectValue(d.key)}
                      aria-pressed={isSelected}
                      data-testid={`donut-legend-${panel.id}-${d.key}`}
                      className={cn(
                        "h-auto w-full justify-start gap-1.5 rounded-sm px-1 py-0.5 text-left text-xs whitespace-normal",
                        isSelected && "bg-accent/60 font-medium"
                      )}
                    >
                      {content}
                    </Button>
                  ) : (
                    <span className="flex items-center gap-1.5 px-1 py-0.5">{content}</span>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </PanelFrame>
  )
}
