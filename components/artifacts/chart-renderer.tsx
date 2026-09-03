"use client"

/**
 * ChartRenderer - Recharts-based chart rendering for artifact preview.
 * Lazy-loaded by artifact-renderers to keep recharts (~200KB) out of the
 * initial bundle.
 */

import { useEffect, useMemo } from "react"
import { useTranslations } from "next-intl"
import { AlertCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { CHART_COLORS, parseChartPayload } from "@/lib/artifacts"
import { loggers } from "@cognia/logging"
import type { ArtifactChartType, ChartDataPoint } from "@/types"
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
  chartType?: ArtifactChartType
  chartData?: ChartDataPoint[]
}

export function ChartRenderer({ content, chartType, chartData, className }: ChartRendererProps) {
  const t = useTranslations("artifactPreview")

  // One place decides what a payload means: `lib/artifacts/chart-contract.ts`.
  // The module returns codes, this component translates them, so the rules
  // stay testable without a DOM and the Canvas preview can reuse them later.
  const contract = useMemo(
    () => parseChartPayload(content, { fallbackType: chartType, chartData }),
    [content, chartType, chartData]
  )

  const fatal = contract.findings.find((finding) => finding.severity === "fatal")
  const degraded = contract.findings.filter((finding) => finding.severity === "degraded")

  useEffect(() => {
    if (!fatal) return
    loggers.ui.warn("artifacts.chart.parse-failed", {
      error: fatal.code,
      contentLength: content.length,
    })
  }, [fatal, content.length])

  if (fatal) {
    return (
      <Alert variant="destructive" className={cn("m-4", className)}>
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          {fatal.code === "invalidJson" ? t("failedToParseChart") : t("invalidChartFormat")}
        </AlertDescription>
      </Alert>
    )
  }

  // Every rule the payload bent, said out loud. Deliberately `role="status"`
  // and not `components/ui/alert`, which hardcodes an assertive `role="alert"`:
  // this annotates a chart that still drew, it does not replace it.
  const notice =
    degraded.length > 0 ? (
      <div
        data-testid="chart-contract-notice"
        role="status"
        className="border-b bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
      >
        <details>
          <summary className="cursor-pointer">
            {t("chartNoticeSummary", { count: degraded.length })}
          </summary>
          <ul className="mt-1 space-y-0.5">
            {degraded.map((finding) => (
              <li key={`${finding.code}:${JSON.stringify(finding.params ?? {})}`}>
                {t(`chartFindings.${finding.code}`, finding.params)}
              </li>
            ))}
          </ul>
        </details>
      </div>
    ) : null

  if (!contract.drawable) {
    return (
      <div className={cn("flex h-full flex-col", className)}>
        {notice}
        <div className="flex flex-1 items-center justify-center p-8 text-muted-foreground">
          {t("noChartData")}
        </div>
      </div>
    )
  }

  const { data, chartType: detectedType, series: numericKeys, valueKey } = contract

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
              dataKey={valueKey ?? "value"}
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
            <Scatter name={t("chartSeriesFallbackName")} data={data} fill={CHART_COLORS[0]} />
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

  // The notice takes rows off the top and the chart gives them up, rather than
  // overlaying it. Same shape `artifact-preview.tsx` uses for its own bars.
  return (
    <div className={cn("flex h-[300px] w-full flex-col", className)}>
      {notice}
      <div className="min-h-0 flex-1 p-4">
        <ResponsiveContainer
          width="100%"
          height="100%"
          minWidth={1}
          minHeight={1}
          initialDimension={{ width: 320, height: 300 }}
        >
          {renderChart()}
        </ResponsiveContainer>
      </div>
    </div>
  )
}
