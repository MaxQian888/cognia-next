"use client"

/**
 * Donut breakdown panel — share of spans by a dimension (e.g. model). Slices
 * are colored from the theme palette and a compact legend lists the top
 * categories with their span counts.
 */

import { useTranslations } from "next-intl"
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts"
import { PanelFrame } from "./panel-frame"
import type { PanelDef } from "./panel-registry"
import type { BreakdownRow } from "@/lib/observability/breakdown"
import { useThemeColors } from "@/hooks/logging/use-theme-colors"
import { paletteColor } from "@/lib/observability/chart-palette"
import { TOOLTIP_STYLE } from "@/lib/observability/chart-config"

const TOP_N = 6

export interface DonutPanelProps {
  panel: PanelDef
  rows: BreakdownRow[]
  editMode?: boolean
}

export function DonutPanel({ panel, rows, editMode }: DonutPanelProps) {
  const t = useTranslations("observability")
  const colors = useThemeColors()
  const data = rows.slice(0, TOP_N).map((r, i) => ({
    key: r.key,
    spans: r.spans,
    color: paletteColor(colors, i),
  }))

  return (
    <PanelFrame
      title={t(`panels.${panel.titleKey}`)}
      editMode={editMode}
      data-testid={`donut-panel-${panel.id}`}
    >
      {data.length === 0 ? (
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          {t("noData")}
        </div>
      ) : (
        <div className="flex h-full items-center gap-2">
          <div className="h-full min-w-0 flex-1" data-testid={`donut-chart-${panel.id}`}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={data}
                  dataKey="spans"
                  nameKey="key"
                  cx="50%"
                  cy="50%"
                  innerRadius="55%"
                  outerRadius="80%"
                  paddingAngle={2}
                  isAnimationActive={false}
                >
                  {data.map((d) => (
                    <Cell key={d.key} fill={d.color} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={TOOLTIP_STYLE.contentStyle}
                  labelStyle={TOOLTIP_STYLE.labelStyle}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <ul className="flex max-h-full shrink-0 flex-col gap-1 overflow-auto pr-1 text-xs">
            {data.map((d) => (
              <li
                key={d.key}
                className="flex items-center gap-1.5"
                data-testid={`donut-legend-${panel.id}`}
              >
                <span className="size-2 shrink-0 rounded-sm" style={{ backgroundColor: d.color }} />
                <span className="max-w-[120px] truncate text-muted-foreground">{d.key}</span>
                <span className="ml-auto tabular-nums">{d.spans}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </PanelFrame>
  )
}
