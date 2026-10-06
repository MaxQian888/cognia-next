"use client"

/**
 * The inline ```chart block (ADR-0218).
 *
 * The fence body is the chart payload `chart-design` teaches and
 * `lib/artifacts/chart-contract.ts` interprets — one contract for the dock's
 * chart artifact and this inline chart — drawn by the shared `ChartPlot` in
 * the app palette. The block sits in the shared `RichBlockFrame` with a data
 * table view, copy-as-JSON, PNG export and fullscreen.
 *
 * While the fence is still streaming it holds a sized placeholder in the same
 * frame; a half-written JSON payload is never parsed.
 */

import { useCallback, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  AreaChartIcon,
  BarChart3Icon,
  ChartScatterIcon,
  ImageDownIcon,
  LineChartIcon,
  Maximize2Icon,
  PieChartIcon,
  RadarIcon,
  Table2Icon,
} from "lucide-react"
import { toast } from "sonner"
import { ChartPlot, seriesColor } from "@/components/artifacts/chart-plot"
import { CopyFeedbackIcon } from "@/components/shared/animated-action-icon"
import { RichBlockAction } from "@/components/chat/renderers/rich-block/rich-block-action"
import { RichBlockError } from "@/components/chat/renderers/rich-block/rich-block-error"
import { RichBlockFrame } from "@/components/chat/renderers/rich-block/rich-block-frame"
import {
  RICH_BLOCK_FULLSCREEN_ACTION_CLASS,
  RichBlockFullscreen,
} from "@/components/chat/renderers/rich-block/rich-block-fullscreen"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { Skeleton } from "@/components/ui/skeleton"
import { useCopy } from "@/hooks/ui/use-copy"
import { parseChartPayload, type ChartContract } from "@/lib/artifacts"
import { useChatDiagramPalette, type ChatDiagramPalette } from "@/lib/chat/diagram-palette"
import { downloadBlob } from "@/lib/files/download"
import { cn } from "@/lib/utils"
import { loggers } from "@cognia/logging"
import type { ArtifactChartType } from "@/types"

export interface ChartBlockProps {
  content: string
  /** The fence is still streaming; show the placeholder. */
  isIncomplete?: boolean
  className?: string
}

const CHART_ICONS: Record<ArtifactChartType, typeof BarChart3Icon> = {
  bar: BarChart3Icon,
  line: LineChartIcon,
  area: AreaChartIcon,
  pie: PieChartIcon,
  doughnut: PieChartIcon,
  scatter: ChartScatterIcon,
  radar: RadarIcon,
}

/** Columns of the data view: `name` + series, or `x` / `y` for scatter. */
export function chartTableColumns(contract: ChartContract): string[] {
  if (contract.chartType === "scatter") return ["x", "y"]
  const series =
    contract.chartType === "pie" || contract.chartType === "doughnut"
      ? [contract.valueKey ?? "value"]
      : contract.series
  return ["name", ...series]
}

/** Legend entries the PNG has to draw itself (Recharts' legend is HTML). */
export function chartLegendItems(
  contract: ChartContract,
  palette: ChatDiagramPalette,
  scatterName: string
): { label: string; color: string }[] {
  if (contract.chartType === "pie" || contract.chartType === "doughnut") {
    return contract.data.map((row, index) => ({
      label: String(row.name ?? index + 1),
      color: seriesColor(palette, index),
    }))
  }
  if (contract.chartType === "scatter")
    return [{ label: scatterName, color: seriesColor(palette, 0) }]
  return contract.series.map((key, index) => ({ label: key, color: seriesColor(palette, index) }))
}

/**
 * Rasterise the chart's SVG at 2x on the palette background, with the legend
 * drawn underneath. Recharts' SVG holds no `foreignObject`, so the canvas is
 * not tainted and `toBlob` succeeds.
 */
async function exportChartPng(
  svg: SVGSVGElement,
  legend: { label: string; color: string }[],
  palette: ChatDiagramPalette
): Promise<Blob> {
  const { width, height } = svg.getBoundingClientRect()
  const clone = svg.cloneNode(true) as SVGSVGElement
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg")
  clone.setAttribute("width", String(width))
  clone.setAttribute("height", String(height))
  const markup = new XMLSerializer().serializeToString(clone)
  const image = new Image()
  image.decoding = "async"
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`
  await image.decode()

  const scale = 2
  const legendRow = legend.length > 0 ? 28 : 0
  const canvas = document.createElement("canvas")
  canvas.width = Math.ceil(width * scale)
  canvas.height = Math.ceil((height + legendRow) * scale)
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("Canvas 2D is unavailable")
  ctx.scale(scale, scale)
  ctx.fillStyle = palette.colors.background
  ctx.fillRect(0, 0, width, height + legendRow)
  ctx.drawImage(image, 0, 0, width, height)

  ctx.font = `12px ${palette.fontFamily}`
  ctx.textBaseline = "middle"
  let x = 12
  const y = height + legendRow / 2
  for (const item of legend) {
    ctx.fillStyle = item.color
    ctx.beginPath()
    ctx.arc(x + 4, y, 4, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = palette.colors.mutedForeground
    ctx.fillText(item.label, x + 12, y)
    x += 12 + ctx.measureText(item.label).width + 16
    if (x > width - 40) break
  }

  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("PNG encoding failed"))),
      "image/png"
    )
  )
}

function ChartDataTable({ contract }: { contract: ChartContract }) {
  const columns = chartTableColumns(contract)
  return (
    <div className="max-h-72 overflow-auto">
      <table className="w-max min-w-full border-separate border-spacing-0 text-left text-sm tabular-nums">
        <thead>
          <tr>
            {columns.map((column, index) => (
              <th
                key={column}
                className={cn(
                  "sticky top-0 border-b bg-muted/60 px-(--rich-cell-px) py-(--rich-cell-py) text-xs font-semibold",
                  index > 0 && "text-right"
                )}
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {contract.data.map((row, rowIndex) => (
            <tr key={rowIndex} className="hover:bg-muted/40">
              {columns.map((column, index) => (
                <td
                  key={column}
                  className={cn(
                    "border-b border-border/60 px-(--rich-cell-px) py-(--rich-cell-py)",
                    index > 0 && "text-right"
                  )}
                >
                  {row[column] === undefined ? "" : String(row[column])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function ChartBlock({ content, isIncomplete = false, className }: ChartBlockProps) {
  const t = useTranslations("chat.renderers.chart")
  const tPreview = useTranslations("artifactPreview")
  const palette = useChatDiagramPalette()
  const plotRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<"chart" | "table">("chart")
  const [fullscreen, setFullscreen] = useState(false)
  const { copied, copy } = useCopy({ logger: loggers.chat, scope: "chat" })
  const contract = useMemo(
    () => (isIncomplete ? null : parseChartPayload(content)),
    [content, isIncomplete]
  )

  const handleExport = useCallback(async () => {
    const svg = plotRef.current?.querySelector("svg.recharts-surface")
    if (!(svg instanceof SVGSVGElement) || !contract) {
      toast.error(t("exportFailed"))
      return
    }
    try {
      const blob = await exportChartPng(
        svg,
        chartLegendItems(contract, palette, tPreview("chartSeriesFallbackName")),
        palette
      )
      const outcome = await downloadBlob(blob, `${contract.title ?? "chart"}.png`)
      if (outcome.kind === "error") toast.error(t("exportFailed"))
    } catch (error) {
      loggers.chat.warn("chart png export failed", {
        err: error instanceof Error ? error.message : String(error),
      })
      toast.error(t("exportFailed"))
    }
  }, [contract, palette, t, tPreview])

  if (!contract) {
    return (
      <RichBlockFrame
        kind="chart"
        className={className}
        icon={<BarChart3Icon />}
        label={t("label")}
        bodyClassName="p-(--rich-block-pad)"
        aria-busy
        data-fence-pending
      >
        <Skeleton className="h-56 w-full" />
      </RichBlockFrame>
    )
  }

  const fatal = contract.findings.find((finding) => finding.severity === "fatal")
  if (fatal) {
    return (
      <RichBlockError
        className={className}
        title={t("error")}
        detail={
          fatal.code === "invalidJson"
            ? tPreview("failedToParseChart")
            : tPreview("invalidChartFormat")
        }
      >
        <pre className="max-h-40 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-xs">
          <code>{content}</code>
        </pre>
      </RichBlockError>
    )
  }

  const degraded = contract.findings.filter((finding) => finding.severity === "degraded")
  const Icon = CHART_ICONS[contract.chartType]
  const label = contract.title ?? t(`types.${contract.chartType}`)
  const notice =
    degraded.length > 0 ? (
      <details
        role="status"
        data-testid="chart-block-notice"
        className="border-t bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground"
      >
        <summary className="cursor-pointer">
          {tPreview("chartNoticeSummary", { count: degraded.length })}
        </summary>
        <ul className="mt-1 space-y-0.5">
          {degraded.map((finding) => (
            <li key={`${finding.code}:${JSON.stringify(finding.params ?? {})}`}>
              {tPreview(`chartFindings.${finding.code}`, finding.params)}
            </li>
          ))}
        </ul>
      </details>
    ) : null

  const body = !contract.drawable ? (
    <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
      {tPreview("noChartData")}
    </div>
  ) : view === "table" ? (
    <ChartDataTable contract={contract} />
  ) : (
    <div ref={plotRef} className="h-64 px-2 pt-3 pb-1" data-testid="chart-block-plot">
      <ChartPlot
        contract={contract}
        palette={palette}
        scatterSeriesName={tPreview("chartSeriesFallbackName")}
      />
    </div>
  )

  return (
    <>
      <RichBlockFrame
        kind="chart"
        className={className}
        role="figure"
        aria-label={label}
        icon={<Icon />}
        label={label}
        meta={contract.title ? t(`types.${contract.chartType}`) : null}
        footer={notice}
        actions={
          contract.drawable ? (
            <>
              <RichBlockAction
                label={view === "table" ? t("showChart") : t("showData")}
                aria-pressed={view === "table"}
                onClick={() => setView(view === "table" ? "chart" : "table")}
              >
                {view === "table" ? <Icon /> : <Table2Icon />}
              </RichBlockAction>
              <RichBlockAction label={t("copyJson")} onClick={() => void copy(content)}>
                <CopyFeedbackIcon copied={copied} size={12} />
              </RichBlockAction>
              <RichBlockAction
                label={t("downloadPng")}
                disabled={view !== "chart"}
                onClick={() => void handleExport()}
              >
                <ImageDownIcon />
              </RichBlockAction>
              <RichBlockAction label={t("fullscreen")} onClick={() => setFullscreen(true)}>
                <Maximize2Icon />
              </RichBlockAction>
            </>
          ) : null
        }
      >
        {body}
      </RichBlockFrame>
      {contract.drawable ? (
        <RichBlockFullscreen
          open={fullscreen}
          onOpenChange={setFullscreen}
          testId="chart-fullscreen"
          icon={<Icon />}
          title={label}
          subtitle={t("points", { count: contract.data.length })}
          actions={
            <TooltipIconButton
              variant="ghost"
              size="icon"
              className={RICH_BLOCK_FULLSCREEN_ACTION_CLASS}
              onClick={() => void copy(content)}
              aria-label={t("copyJson")}
              tooltip={t("copyJson")}
            >
              <CopyFeedbackIcon copied={copied} size={16} />
            </TooltipIconButton>
          }
        >
          {fullscreen ? (
            <div className="flex h-full flex-col gap-4 p-4">
              <div className="min-h-80 flex-1">
                <ChartPlot
                  contract={contract}
                  palette={palette}
                  scatterSeriesName={tPreview("chartSeriesFallbackName")}
                />
              </div>
              <div className="rounded-lg border">
                <ChartDataTable contract={contract} />
              </div>
            </div>
          ) : null}
        </RichBlockFullscreen>
      ) : null}
    </>
  )
}
