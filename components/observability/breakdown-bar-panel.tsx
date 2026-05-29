"use client"

/**
 * Horizontal bar breakdown panel (Top-N by span count) for a dimension such as
 * surface or operation.
 */

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
import type { PanelDef } from "./panel-registry"
import type { BreakdownRow } from "@/lib/observability/breakdown"
import { useThemeColors } from "@/hooks/logging/use-theme-colors"
import { paletteColor } from "@/lib/observability/chart-palette"
import { TOOLTIP_STYLE } from "@/lib/observability/chart-config"

const TOP_N = 8

export interface BreakdownBarPanelProps {
  panel: PanelDef
  rows: BreakdownRow[]
  editMode?: boolean
}

export function BreakdownBarPanel({ panel, rows, editMode }: BreakdownBarPanelProps) {
  const t = useTranslations("observability")
  const colors = useThemeColors()
  const data = rows.slice(0, TOP_N).map((r) => ({ key: r.key, spans: r.spans }))

  return (
    <PanelFrame
      title={t(`panels.${panel.titleKey}`)}
      editMode={editMode}
      data-testid={`bar-panel-${panel.id}`}
    >
      {data.length === 0 ? (
        <EmptyHint label={t("noData")} />
      ) : (
        <div className="h-full w-full" data-testid={`bar-chart-${panel.id}`}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={data}
              layout="vertical"
              margin={{ top: 4, right: 12, left: 8, bottom: 4 }}
            >
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
              <YAxis type="category" dataKey="key" tick={{ fontSize: 11 }} width={90} />
              <Tooltip
                contentStyle={TOOLTIP_STYLE.contentStyle}
                labelStyle={TOOLTIP_STYLE.labelStyle}
              />
              <Bar dataKey="spans" radius={[0, 4, 4, 0]} isAnimationActive={false}>
                {data.map((d, i) => (
                  <Cell key={d.key} fill={paletteColor(colors, i)} />
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
