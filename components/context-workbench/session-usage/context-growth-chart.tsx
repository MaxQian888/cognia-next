"use client"

/**
 * How full the context window was on every billed turn.
 *
 * The area is the prompt each turn had to read; the two reference lines are
 * the model's window and the auto-compaction threshold (when the policy knows
 * one), so "how close did this conversation get" is visible across its whole
 * life rather than only for the latest turn. Sharp falls are marked: a
 * compaction, a cleared history or a fresh branch — the data cannot tell which,
 * so the marker says "context dropped" and nothing more.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import {
  Area,
  AreaChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"

import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { useThemeColors } from "@/hooks/logging/use-theme-colors"
import { paletteColor } from "@/lib/observability/chart-palette"
import { CHART_MARGINS, TOOLTIP_STYLE } from "@/lib/observability/chart-config"
import { detectContextDrops, type TurnCostPoint } from "@/lib/usage/session-cost-profile"
import { formatTokens } from "@/types/system/usage"

export interface ContextGrowthChartProps {
  points: readonly TurnCostPoint[]
  /** Model window, when known. */
  maxTokens?: number
  /** Absolute auto-compaction threshold, when the policy has one. */
  compactAtTokens?: number | null
}

export function ContextGrowthChart({
  points,
  maxTokens,
  compactAtTokens,
}: ContextGrowthChartProps) {
  const t = useTranslations("contextWorkbench.sessionUsage.growth")
  const colors = useThemeColors()
  const { reduce } = useFlowMotion()
  const data = useMemo(
    () => points.map((p) => ({ turn: p.index, context: p.contextTokens })),
    [points]
  )
  const drops = useMemo(() => detectContextDrops(points), [points])
  const peak = useMemo(() => points.reduce((m, p) => Math.max(m, p.contextTokens), 0), [points])

  if (points.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="context-growth-empty">
        {t("empty")}
      </p>
    )
  }

  const ceiling = Math.max(peak, maxTokens ?? 0)
  return (
    <div className="space-y-1.5" data-testid="context-growth">
      <div className="h-40">
        <ResponsiveContainer
          width="100%"
          height="100%"
          minWidth={1}
          minHeight={1}
          initialDimension={{ width: 320, height: 160 }}
        >
          <AreaChart data={data} margin={CHART_MARGINS.compact}>
            <defs>
              <linearGradient id="context-growth-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={paletteColor(colors, 0)} stopOpacity={0.45} />
                <stop offset="100%" stopColor={paletteColor(colors, 0)} stopOpacity={0.04} />
              </linearGradient>
            </defs>
            <XAxis dataKey="turn" tick={{ fontSize: 10 }} />
            <YAxis
              width={40}
              tick={{ fontSize: 10 }}
              domain={[0, ceiling]}
              tickFormatter={(v) => formatTokens(Number(v))}
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE.contentStyle}
              labelStyle={TOOLTIP_STYLE.labelStyle}
              itemStyle={TOOLTIP_STYLE.itemStyle}
              labelFormatter={(v) => t("turn", { index: Number(v) })}
              formatter={(value) => [formatTokens(Number(value)), t("context")]}
            />
            {maxTokens ? (
              <ReferenceLine
                y={maxTokens}
                stroke={colors["muted-foreground"]}
                strokeDasharray="4 3"
                // Left, while the threshold's label sits right: the two lines are
                // close (83.5% apart from 100%) and same-side labels collide.
                label={{ value: t("window"), position: "insideTopLeft", fontSize: 10 }}
              />
            ) : null}
            {compactAtTokens ? (
              <ReferenceLine
                y={compactAtTokens}
                stroke={paletteColor(colors, 3)}
                strokeDasharray="2 3"
                label={{ value: t("compactAt"), position: "insideBottomRight", fontSize: 10 }}
              />
            ) : null}
            <Area
              // Straight segments: turns are discrete samples, and a spline
              // would invent a smooth slide into a compaction that was a step.
              type="linear"
              dataKey="context"
              stroke={paletteColor(colors, 0)}
              fill="url(#context-growth-fill)"
              strokeWidth={1.5}
              isAnimationActive={!reduce}
            />
            {drops.map((p) => (
              <ReferenceDot
                key={p.messageId}
                x={p.index}
                y={p.contextTokens}
                r={4}
                fill={paletteColor(colors, 3)}
                stroke="none"
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <p className="text-[11px] text-muted-foreground" data-testid="context-growth-summary">
        {t("summary", {
          peak: formatTokens(peak),
          latest: formatTokens(points[points.length - 1].contextTokens),
        })}
        {drops.length > 0 ? ` ${t("drops", { count: drops.length })}` : ""}
      </p>
    </div>
  )
}
