"use client"

/**
 * A2UI Chart Component
 * Maps to Recharts for data visualization
 */

import React, { useMemo, memo } from "react"
import { cn } from "@/lib/utils"
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  AreaChart,
  Area,
  ScatterChart,
  Scatter,
  RadarChart,
  Radar,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  Cell,
  Label,
} from "recharts"
import type { A2UIComponentProps, A2UIChartComponent } from "@/types/a2ui/schema"
import { useA2UIData } from "@/hooks/a2ui"
import { resolveArrayOrPath } from "@/lib/a2ui/data-model"
import {
  DEFAULT_CHART_COLORS as DEFAULT_COLORS,
  CHART_TOOLTIP_STYLE as TOOLTIP_STYLE,
} from "@/lib/a2ui/chart-constants"

function ChartAxes({
  xKey,
  xAxisLabel,
  yAxisLabel,
}: {
  xKey: string
  xAxisLabel?: string
  yAxisLabel?: string
}) {
  return (
    <>
      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
      <XAxis dataKey={xKey} className="text-xs">
        {xAxisLabel && <Label value={xAxisLabel} offset={-5} position="insideBottom" />}
      </XAxis>
      <YAxis className="text-xs">
        {yAxisLabel && <Label value={yAxisLabel} angle={-90} position="insideLeft" />}
      </YAxis>
    </>
  )
}

function ChartExtras({ showLegend }: { showLegend: boolean }) {
  return (
    <>
      <Tooltip contentStyle={TOOLTIP_STYLE} />
      {showLegend && <Legend />}
    </>
  )
}

export const A2UIChart = memo(function A2UIChart({
  component,
  onAction,
}: A2UIComponentProps<A2UIChartComponent>) {
  const { dataModel } = useA2UIData()

  // Resolve data - can be static array or data-bound
  const data = useMemo(() => {
    if (Array.isArray(component.data)) {
      return component.data
    }
    return resolveArrayOrPath(component.data, dataModel, [])
  }, [component.data, dataModel])

  const chartType = component.chartType || "line"
  const height = component.height || 300
  const xKey = component.xKey || "name"
  const yKeys = component.yKeys || ["value"]
  const colors = component.colors || DEFAULT_COLORS

  const handleDataPointClick = (dataPoint: Record<string, unknown>, index: number) => {
    if (component.clickAction) {
      onAction(component.clickAction, { dataPoint, index })
    }
  }

  const showLegend = component.showLegend !== false
  const cursorStyle = component.clickAction ? "pointer" : "default"

  const renderChart = () => {
    switch (chartType) {
      case "bar":
        return (
          <BarChart data={data}>
            <ChartAxes
              xKey={xKey}
              xAxisLabel={component.xAxisLabel}
              yAxisLabel={component.yAxisLabel}
            />
            <ChartExtras showLegend={showLegend} />
            {yKeys.map((yKey: string, idx: number) => (
              <Bar
                key={yKey}
                dataKey={yKey}
                fill={colors[idx % colors.length]}
                onClick={(barData) =>
                  handleDataPointClick(barData as unknown as Record<string, unknown>, idx)
                }
                cursor={cursorStyle}
              />
            ))}
          </BarChart>
        )

      case "pie":
        return (
          <PieChart>
            <Pie
              data={data}
              dataKey={yKeys[0]}
              nameKey={xKey}
              cx="50%"
              cy="50%"
              outerRadius={height / 3}
              label={component.showLabels !== false}
              cursor={cursorStyle}
            >
              {data.map((_, index) => (
                <Cell key={`cell-${index}`} fill={colors[index % colors.length]} />
              ))}
            </Pie>
            <ChartExtras showLegend={showLegend} />
          </PieChart>
        )

      case "area":
        return (
          <AreaChart data={data}>
            <ChartAxes
              xKey={xKey}
              xAxisLabel={component.xAxisLabel}
              yAxisLabel={component.yAxisLabel}
            />
            <ChartExtras showLegend={showLegend} />
            {yKeys.map((yKey: string, idx: number) => (
              <Area
                key={yKey}
                type="monotone"
                dataKey={yKey}
                stroke={colors[idx % colors.length]}
                fill={colors[idx % colors.length]}
                fillOpacity={0.3}
                cursor={cursorStyle}
              />
            ))}
          </AreaChart>
        )

      case "scatter":
        return (
          <ScatterChart>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
            <XAxis dataKey={xKey} className="text-xs" name={component.xAxisLabel || xKey}>
              {component.xAxisLabel && (
                <Label value={component.xAxisLabel} offset={-5} position="insideBottom" />
              )}
            </XAxis>
            <YAxis className="text-xs" name={component.yAxisLabel || yKeys[0]}>
              {component.yAxisLabel && (
                <Label value={component.yAxisLabel} angle={-90} position="insideLeft" />
              )}
            </YAxis>
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ strokeDasharray: "3 3" }} />
            {showLegend && <Legend />}
            {yKeys.map((yKey: string, idx: number) => (
              <Scatter
                key={yKey}
                name={yKey}
                data={data}
                fill={colors[idx % colors.length]}
                cursor={cursorStyle}
              />
            ))}
          </ScatterChart>
        )

      case "radar":
        return (
          <RadarChart cx="50%" cy="50%" outerRadius={height / 3} data={data}>
            <PolarGrid />
            <PolarAngleAxis dataKey={xKey} className="text-xs" />
            <PolarRadiusAxis className="text-xs" />
            <ChartExtras showLegend={showLegend} />
            {yKeys.map((yKey: string, idx: number) => (
              <Radar
                key={yKey}
                name={yKey}
                dataKey={yKey}
                stroke={colors[idx % colors.length]}
                fill={colors[idx % colors.length]}
                fillOpacity={0.3}
              />
            ))}
          </RadarChart>
        )

      case "donut":
        return (
          <PieChart>
            <Pie
              data={data}
              dataKey={yKeys[0]}
              nameKey={xKey}
              cx="50%"
              cy="50%"
              innerRadius={height / 5}
              outerRadius={height / 3}
              label={component.showLabels !== false}
              cursor={cursorStyle}
            >
              {data.map((_, index) => (
                <Cell key={`cell-${index}`} fill={colors[index % colors.length]} />
              ))}
            </Pie>
            <ChartExtras showLegend={showLegend} />
          </PieChart>
        )

      case "line":
      default:
        return (
          <LineChart data={data}>
            <ChartAxes
              xKey={xKey}
              xAxisLabel={component.xAxisLabel}
              yAxisLabel={component.yAxisLabel}
            />
            <ChartExtras showLegend={showLegend} />
            {yKeys.map((yKey: string, idx: number) => (
              <Line
                key={yKey}
                type="monotone"
                dataKey={yKey}
                stroke={colors[idx % colors.length]}
                strokeWidth={2}
                dot={{ r: 4 }}
                activeDot={{
                  r: 6,
                  cursor: cursorStyle,
                }}
              />
            ))}
          </LineChart>
        )
    }
  }

  return (
    <div
      className={cn("w-full", component.className)}
      style={{ height, ...(component.style as React.CSSProperties) }}
    >
      {component.title && <h3 className="mb-2 text-sm font-medium">{component.title}</h3>}
      {/* initialDimension keeps the chart visible when mounted at 0×0 (tabs, dialogs, collapsibles) */}
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 320, height }}>
        {renderChart()}
      </ResponsiveContainer>
    </div>
  )
})
