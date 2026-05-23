"use client"

/**
 * ChartRenderer - Recharts-based chart rendering for artifact preview.
 * Lazy-loaded by artifact-renderers to keep recharts (~200KB) out of the
 * initial bundle.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { AlertCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { CHART_COLORS } from "@/lib/artifacts"
import { loggers } from "@/lib/logging"
import type { ChartDataPoint } from "@/types"
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
} from "recharts"

export type { ChartDataPoint } from "@/types"

interface ChartRendererProps {
  content: string
  className?: string
  chartType?: "line" | "bar" | "pie" | "doughnut" | "area" | "scatter" | "radar"
  chartData?: ChartDataPoint[]
}

export function ChartRenderer({
  content,
  chartType = "line",
  chartData,
  className,
}: ChartRendererProps) {
  const t = useTranslations("artifactPreview")

  const invalidChartFormatMsg = t("invalidChartFormat")
  const failedToParseChartMsg = t("failedToParseChart")

  const { data, error, detectedType } = useMemo<{
    data: ChartDataPoint[]
    error: string | null
    detectedType: string
  }>(() => {
    try {
      if (chartData) {
        return { data: chartData, error: null, detectedType: chartType }
      }
      const parsed = JSON.parse(content)
      const nextType = typeof parsed?.type === "string" ? parsed.type : chartType

      if (Array.isArray(parsed)) {
        return { data: parsed, error: null, detectedType: nextType }
      }
      if (parsed?.data && Array.isArray(parsed.data)) {
        return { data: parsed.data, error: null, detectedType: nextType }
      }
      throw new Error(invalidChartFormatMsg)
    } catch (err) {
      loggers.ui.warn("artifacts.chart.parse-failed", {
        error: err,
        contentLength: content.length,
      })
      return {
        data: [],
        error: err instanceof Error ? err.message : failedToParseChartMsg,
        detectedType: chartType,
      }
    }
  }, [content, chartData, chartType, invalidChartFormatMsg, failedToParseChartMsg])

  if (error) {
    return (
      <Alert variant="destructive" className={cn("m-4", className)}>
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  }

  if (data.length === 0) {
    return (
      <div className={cn("flex items-center justify-center p-8 text-muted-foreground", className)}>
        {t("noChartData")}
      </div>
    )
  }

  const numericKeys = Object.keys(data[0] || {}).filter(
    (key) => key !== "name" && typeof data[0][key] === "number"
  )

  const renderChart = () => {
    switch (detectedType) {
      case "bar":
        return (
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="name" />
            <YAxis />
            <Tooltip />
            <Legend />
            {numericKeys.map((key, index) => (
              <Bar key={key} dataKey={key} fill={CHART_COLORS[index % CHART_COLORS.length]} />
            ))}
          </BarChart>
        )

      case "pie":
      case "doughnut":
        return (
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius={detectedType === "doughnut" ? 45 : 0}
              outerRadius={80}
              label
            >
              {data.map((_, index) => (
                <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip />
            <Legend />
          </PieChart>
        )

      case "area":
        return (
          <AreaChart data={data}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="name" />
            <YAxis />
            <Tooltip />
            <Legend />
            {numericKeys.map((key, index) => (
              <Area
                key={key}
                type="monotone"
                dataKey={key}
                fill={CHART_COLORS[index % CHART_COLORS.length]}
                stroke={CHART_COLORS[index % CHART_COLORS.length]}
                fillOpacity={0.3}
              />
            ))}
          </AreaChart>
        )

      case "scatter":
        return (
          <ScatterChart>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="x" type="number" name="X" />
            <YAxis dataKey="y" type="number" name="Y" />
            <Tooltip cursor={{ strokeDasharray: "3 3" }} />
            <Legend />
            <Scatter name="Data" data={data} fill={CHART_COLORS[0]} />
          </ScatterChart>
        )

      case "radar":
        return (
          <RadarChart cx="50%" cy="50%" outerRadius="80%" data={data}>
            <PolarGrid />
            <PolarAngleAxis dataKey="name" />
            <PolarRadiusAxis />
            <Tooltip />
            <Legend />
            {numericKeys.map((key, index) => (
              <Radar
                key={key}
                name={key}
                dataKey={key}
                stroke={CHART_COLORS[index % CHART_COLORS.length]}
                fill={CHART_COLORS[index % CHART_COLORS.length]}
                fillOpacity={0.3}
              />
            ))}
          </RadarChart>
        )

      case "line":
      default:
        return (
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="name" />
            <YAxis />
            <Tooltip />
            <Legend />
            {numericKeys.map((key, index) => (
              <Line
                key={key}
                type="monotone"
                dataKey={key}
                stroke={CHART_COLORS[index % CHART_COLORS.length]}
                strokeWidth={2}
              />
            ))}
          </LineChart>
        )
    }
  }

  return (
    <div className={cn("h-[300px] w-full p-4", className)}>
      <ResponsiveContainer width="100%" height="100%">
        {renderChart()}
      </ResponsiveContainer>
    </div>
  )
}
