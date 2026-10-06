"use client"

/**
 * ChartRenderer - chart artifact preview: the contract notices around the
 * shared themed `ChartPlot` (ADR-0218), which the chat's inline chart block
 * draws with too.
 * Lazy-loaded by artifact-renderers to keep recharts (~200KB) out of the
 * initial bundle.
 */

import { useEffect, useMemo } from "react"
import { useTranslations } from "next-intl"
import { AlertCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { parseChartPayload } from "@/lib/artifacts"
import { useChatDiagramPalette } from "@/lib/chat/diagram-palette"
import { ChartPlot } from "./chart-plot"
import { loggers } from "@cognia/logging"
import type { ArtifactChartType, ChartDataPoint } from "@/types"

export type { ChartDataPoint } from "@/types"

interface ChartRendererProps {
  content: string
  className?: string
  chartType?: ArtifactChartType
  chartData?: ChartDataPoint[]
}

export function ChartRenderer({ content, chartType, chartData, className }: ChartRendererProps) {
  const t = useTranslations("artifactPreview")
  // ADR-0218: the shared themed plot, in the app palette (it used to draw in
  // recharts' demo colours whatever the theme).
  const palette = useChatDiagramPalette()

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

  // The notice takes rows off the top and the chart gives them up, rather than
  // overlaying it. Same shape `artifact-preview.tsx` uses for its own bars.
  return (
    <div className={cn("flex h-[300px] w-full flex-col", className)}>
      {notice}
      <div className="min-h-0 flex-1 p-4">
        <ChartPlot
          contract={contract}
          palette={palette}
          scatterSeriesName={t("chartSeriesFallbackName")}
        />
      </div>
    </div>
  )
}
