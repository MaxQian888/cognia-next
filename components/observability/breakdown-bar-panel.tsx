"use client"

/**
 * Horizontal bar breakdown panel (Top-N by the selected measure) for a
 * dimension such as surface or operation. Bars are click-to-filter: clicking a
 * bar toggles that value in the dashboard's variable filters.
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

const TOP_N = 8

export interface BreakdownBarPanelProps {
  panel: PanelDef
  rows: BreakdownRow[]
  editMode?: boolean
  onSelectValue?: (value: string) => void
  selectedValues?: string[]
}

export function BreakdownBarPanel({
  panel,
  rows,
  editMode,
  onSelectValue,
  selectedValues,
}: BreakdownBarPanelProps) {
  const t = useTranslations("observability")
  const colors = useThemeColors()
  const [metric, setMetric] = useState<BreakdownMetric>("spans")
  const data = topByMetric(rows, metric, TOP_N).map((r) => ({
    key: r.key,
    value: breakdownValue(r, metric),
  }))
  const selected = new Set(selectedValues ?? [])
  const isCost = metric === "cost"

  return (
    <PanelFrame
      title={t(`panels.${panel.titleKey}`)}
      editMode={editMode}
      data-testid={`bar-panel-${panel.id}`}
      actions={<BreakdownMetricToggle value={metric} onChange={setMetric} panelId={panel.id} />}
    >
      {data.length === 0 ? (
        <EmptyHint label={t("noData")} />
      ) : (
        <div className="h-full w-full" data-testid={`bar-chart-${panel.id}`}>
          {/* Accessible + deterministic click targets for filtering (recharts
              bar hit-testing is unreliable under jsdom). */}
          {onSelectValue && (
            <div className="sr-only">
              {data.map((d) => (
                <button
                  key={d.key}
                  type="button"
                  onClick={() => onSelectValue(d.key)}
                  data-testid={`bar-select-${panel.id}-${d.key}`}
                >
                  {d.key}
                </button>
              ))}
            </div>
          )}
          <ResponsiveContainer width="100%" height="100%">
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
                tickFormatter={isCost ? (v) => formatUsd(Number(v)) : undefined}
              />
              <YAxis type="category" dataKey="key" tick={{ fontSize: 11 }} width={90} />
              <Tooltip
                contentStyle={TOOLTIP_STYLE.contentStyle}
                labelStyle={TOOLTIP_STYLE.labelStyle}
                formatter={(value) => (isCost ? formatUsd(Number(value)) : String(value))}
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
                {data.map((d, i) => (
                  <Cell
                    key={d.key}
                    fill={paletteColor(colors, i)}
                    opacity={selected.size === 0 || selected.has(d.key) ? 1 : 0.4}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
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
