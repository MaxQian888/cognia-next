"use client"

/**
 * Daily cost stacked by one axis (model, surface, provider).
 *
 * The total-only bar answers "which day was expensive"; the stack answers
 * "expensive because of what", which is how the OpenAI and Anthropic usage
 * pages lay out the same data. Series come pre-ranked from
 * {@link buildDailyStack}, already capped with an "other" bucket, so this file
 * only draws. Colours cycle the theme's chart palette, and the legend is a
 * plain list so it wraps instead of overflowing a narrow settings pane.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"

import { useThemeColors } from "@/hooks/logging/use-theme-colors"
import { paletteColor } from "@/lib/observability/chart-palette"
import { CHART_MARGINS, TOOLTIP_STYLE } from "@/lib/observability/chart-config"
import { OTHER_SERIES_KEY, type DailyStack } from "@/lib/usage/usage-insights"
import { formatCostInCurrency } from "@/types/system/usage"

export interface UsageStackedCostChartProps {
  stack: DailyStack
  /** Display label for a series key ({@link OTHER_SERIES_KEY} is handled here). */
  labelFor: (key: string) => string
  /** Disable bar animation (reduced motion). */
  reduce?: boolean
  testid?: string
}

/**
 * Recharts keys on `dataKey` paths, and a model id such as `gpt-4.1` would be
 * read as a nested path. Series are addressed by index instead.
 */
function seriesField(index: number): string {
  return `s${index}`
}

export function UsageStackedCostChart({
  stack,
  labelFor,
  reduce = false,
  testid = "usage-stacked-chart",
}: UsageStackedCostChartProps) {
  const t = useTranslations("usageInsights.stack")
  const colors = useThemeColors()
  const label = (key: string) => (key === OTHER_SERIES_KEY ? t("other") : labelFor(key))

  const data = useMemo(
    () =>
      stack.days.map((day) => {
        const point: Record<string, number | string> = { date: day.date, total: day.total }
        stack.keys.forEach((key, i) => {
          point[seriesField(i)] = day.values[key] ?? 0
        })
        return point
      }),
    [stack]
  )

  return (
    <div className="space-y-2" data-testid={testid}>
      <div className="h-52">
        <ResponsiveContainer
          width="100%"
          height="100%"
          minWidth={1}
          minHeight={1}
          initialDimension={{ width: 320, height: 208 }}
        >
          <BarChart data={data} margin={CHART_MARGINS.compact}>
            <XAxis dataKey="date" hide />
            <YAxis
              width={48}
              tick={{ fontSize: 11 }}
              tickFormatter={(v) =>
                Number(v) === 0 ? "0" : formatCostInCurrency(Number(v), "USD")
              }
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE.contentStyle}
              labelStyle={TOOLTIP_STYLE.labelStyle}
              itemStyle={TOOLTIP_STYLE.itemStyle}
              formatter={(value, name) => [formatCostInCurrency(Number(value), "USD"), name]}
            />
            {stack.keys.map((key, i) => (
              <Bar
                key={key}
                dataKey={seriesField(i)}
                name={label(key)}
                stackId="cost"
                fill={paletteColor(colors, i)}
                radius={i === stack.keys.length - 1 ? [4, 4, 0, 0] : undefined}
                isAnimationActive={!reduce}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ul
        className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground"
        aria-label={t("legend")}
        data-testid={`${testid}-legend`}
      >
        {stack.keys.map((key, i) => (
          <li key={key} className="flex min-w-0 items-center gap-1.5">
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-sm"
              style={{ backgroundColor: paletteColor(colors, i) }}
            />
            <span className="max-w-[12rem] truncate" title={label(key)}>
              {label(key)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
