"use client"

/**
 * The themed Recharts drawing for one chart contract (ADR-0218).
 *
 * Shared by the dock's chart artifact (`chart-renderer.tsx`) and the chat's
 * inline ```chart block (`components/chat/renderers/chart-block.tsx`), so a
 * chart looks the same in both places. What makes it "themed":
 *
 *   - series colours are the app's `--chart-1…5`, resolved to literal hex by
 *     `lib/chat/diagram-palette.ts` (recharts' demo palette used to ignore every
 *     theme, and an exported PNG/SVG cannot resolve `var()`);
 *   - grid, axes and legend take the border and muted-foreground tokens, with
 *     quiet axes (no tick marks, horizontal grid only);
 *   - the tooltip is an HTML element, so it reads the popover tokens directly.
 *
 * The caller owns the size: this renders into a `ResponsiveContainer` that
 * fills its parent.
 */

import type { CSSProperties } from "react"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import type { ChartContract } from "@/lib/artifacts"
import type { ChatDiagramPalette } from "@/lib/chat/diagram-palette"

export interface ChartPlotProps {
  contract: ChartContract
  palette: ChatDiagramPalette
  /** Translated legend name for the single scatter series. */
  scatterSeriesName: string
  /** Off for exports and reduced motion. */
  animate?: boolean
}

/** Tooltip in popover tokens; Recharts renders it as an HTML `<div>`. */
export const CHART_PLOT_TOOLTIP_STYLE: CSSProperties = {
  backgroundColor: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--popover-foreground)",
  fontSize: 12,
  padding: "6px 8px",
  boxShadow: "0 4px 12px rgb(0 0 0 / 0.08)",
}

export function seriesColor(palette: ChatDiagramPalette, index: number): string {
  const chart = palette.colors.chart
  return chart[index % chart.length]
}

/**
 * Legend position of an item: its series index on cartesian and radar charts,
 * its slice index on pies (whose legend items are the data rows' names).
 * Unknown items sort last.
 */
export function legendRank(
  contract: ChartContract,
  item: { dataKey?: unknown; value?: unknown }
): number {
  const index =
    contract.chartType === "pie" || contract.chartType === "doughnut"
      ? contract.data.findIndex((row) => String(row.name) === String(item.value))
      : contract.series.indexOf(String(item.dataKey))
  return index < 0 ? Number.MAX_SAFE_INTEGER : index
}

export function ChartPlot({
  contract,
  palette,
  scatterSeriesName,
  animate = true,
}: ChartPlotProps) {
  const c = palette.colors
  const { data, chartType, series, valueKey } = contract
  const axis = {
    tick: { fill: c.mutedForeground, fontSize: 11, fontFamily: palette.fontFamily },
    axisLine: { stroke: c.border },
    tickLine: false,
  } as const
  const grid = <CartesianGrid stroke={c.border} strokeDasharray="3 3" vertical={false} />
  const tooltip = (
    <Tooltip
      contentStyle={CHART_PLOT_TOOLTIP_STYLE}
      labelStyle={{ fontWeight: 600, marginBottom: 2 }}
      itemStyle={{ padding: 0 }}
      cursor={{ fill: c.muted, fillOpacity: 0.5 }}
    />
  )
  // Recharts sorts legend items alphabetically by default, which detaches them
  // from the palette order the reader sees; `null` would leave the order
  // render-dependent. Pin it to the payload's own order instead.
  const legend = (
    <Legend
      itemSorter={(item) => legendRank(contract, item)}
      iconType="circle"
      iconSize={8}
      wrapperStyle={{ fontSize: 12, color: c.mutedForeground, fontFamily: palette.fontFamily }}
    />
  )

  const chart = (() => {
    switch (chartType) {
      case "bar":
        return (
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
            {grid}
            <XAxis dataKey="name" {...axis} />
            <YAxis {...axis} />
            {tooltip}
            {series.length > 1 ? legend : null}
            {series.map((key, index) => (
              <Bar
                key={key}
                dataKey={key}
                fill={seriesColor(palette, index)}
                radius={[3, 3, 0, 0]}
                maxBarSize={48}
                isAnimationActive={animate}
              />
            ))}
          </BarChart>
        )
      case "pie":
      case "doughnut":
        return (
          <PieChart>
            <Pie
              data={data}
              dataKey={valueKey ?? "value"}
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius={chartType === "doughnut" ? "55%" : 0}
              outerRadius="80%"
              stroke={c.background}
              strokeWidth={2}
              paddingAngle={chartType === "doughnut" ? 1 : 0}
              isAnimationActive={animate}
            >
              {data.map((_, index) => (
                <Cell key={`cell-${index}`} fill={seriesColor(palette, index)} />
              ))}
            </Pie>
            {tooltip}
            {legend}
          </PieChart>
        )
      case "area":
        return (
          <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
            {grid}
            <XAxis dataKey="name" {...axis} />
            <YAxis {...axis} />
            {tooltip}
            {series.length > 1 ? legend : null}
            {series.map((key, index) => (
              <Area
                key={key}
                type="monotone"
                dataKey={key}
                fill={seriesColor(palette, index)}
                stroke={seriesColor(palette, index)}
                strokeWidth={2}
                fillOpacity={0.18}
                isAnimationActive={animate}
              />
            ))}
          </AreaChart>
        )
      case "scatter":
        return (
          <ScatterChart margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
            <CartesianGrid stroke={c.border} strokeDasharray="3 3" />
            <XAxis dataKey="x" type="number" name="X" {...axis} />
            <YAxis dataKey="y" type="number" name="Y" {...axis} />
            <Tooltip contentStyle={CHART_PLOT_TOOLTIP_STYLE} cursor={{ strokeDasharray: "3 3" }} />
            <Scatter
              name={scatterSeriesName}
              data={data}
              fill={seriesColor(palette, 0)}
              isAnimationActive={animate}
            />
          </ScatterChart>
        )
      case "radar":
        return (
          <RadarChart cx="50%" cy="50%" outerRadius="75%" data={data}>
            <PolarGrid stroke={c.border} />
            <PolarAngleAxis dataKey="name" tick={axis.tick} />
            <PolarRadiusAxis tick={axis.tick} axisLine={false} />
            {tooltip}
            {series.length > 1 ? legend : null}
            {series.map((key, index) => (
              <Radar
                key={key}
                name={key}
                dataKey={key}
                stroke={seriesColor(palette, index)}
                fill={seriesColor(palette, index)}
                fillOpacity={0.2}
                isAnimationActive={animate}
              />
            ))}
          </RadarChart>
        )
      case "line":
      default:
        return (
          <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
            {grid}
            <XAxis dataKey="name" {...axis} />
            <YAxis {...axis} />
            {tooltip}
            {series.length > 1 ? legend : null}
            {series.map((key, index) => (
              <Line
                key={key}
                type="monotone"
                dataKey={key}
                stroke={seriesColor(palette, index)}
                strokeWidth={2}
                dot={
                  data.length <= 24
                    ? { r: 2.5, strokeWidth: 0, fill: seriesColor(palette, index) }
                    : false
                }
                activeDot={{ r: 4 }}
                isAnimationActive={animate}
              />
            ))}
          </LineChart>
        )
    }
  })()

  return (
    <ResponsiveContainer
      width="100%"
      height="100%"
      minWidth={1}
      minHeight={1}
      initialDimension={{ width: 320, height: 240 }}
    >
      {chart}
    </ResponsiveContainer>
  )
}
