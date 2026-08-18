"use client"

/**
 * Trace drill-down drawer (Tempo/Jaeger style). Opens from the recent-traces
 * table; renders the selected trace's span tree as a waterfall with per-span
 * timing, metrics and events.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { WaterfallRow } from "./waterfall-row"
import { useTraceDetail } from "@/hooks/observability/use-trace-detail"
import { useThemeColors } from "@/hooks/logging/use-theme-colors"
import { paletteColor } from "@/lib/observability/chart-palette"
import { flattenWaterfall } from "@/lib/observability/trace-rollup"
import { formatMs } from "@/lib/observability/format-utils"
import type { SpanOperationName } from "@/types/agent-trace/span"

const OP_ORDER: readonly SpanOperationName[] = [
  "invoke_agent",
  "execute_tool",
  "chat",
  "invoke_workflow",
  "retrieval",
  "embeddings",
]

export interface TraceWaterfallDrawerProps {
  traceId: string | null
  onClose: () => void
}

export function TraceWaterfallDrawer({ traceId, onClose }: TraceWaterfallDrawerProps) {
  const t = useTranslations("observability.waterfall")
  const colors = useThemeColors()
  const { waterfall, loading } = useTraceDetail(traceId)
  const rows = useMemo(() => flattenWaterfall(waterfall), [waterfall])

  return (
    <Sheet open={traceId !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
        <SheetHeader className="border-b">
          <SheetTitle>{t("title")}</SheetTitle>
          <SheetDescription className="font-mono text-xs">
            {traceId ?? ""} · {t("totalDuration", { value: formatMs(waterfall.totalMs) })} ·{" "}
            {t("spanCount", { count: rows.length })}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1">
          {loading ? (
            <div className="space-y-2 p-4" data-testid="waterfall-loading">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : rows.length === 0 ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
              {t("empty")}
            </div>
          ) : (
            <ScrollArea className="h-full">
              <ul className="px-3 py-2">
                {rows.map((node) => {
                  const idx = OP_ORDER.indexOf(node.span.operationName)
                  const color = node.isError
                    ? colors.destructive
                    : paletteColor(colors, idx < 0 ? 0 : idx)
                  return (
                    <WaterfallRow
                      key={node.span.spanId}
                      node={node}
                      totalMs={waterfall.totalMs}
                      color={color}
                    />
                  )
                })}
              </ul>
            </ScrollArea>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
