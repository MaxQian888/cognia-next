"use client"

/**
 * Recent-traces table. One row per trace in the window; clicking a row opens
 * the waterfall drill-down drawer (handled by the parent via `onSelectTrace`).
 */

import { useTranslations } from "next-intl"
import { AlertTriangleIcon } from "lucide-react"
import { PanelFrame } from "./panel-frame"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { PanelDef } from "./panel-registry"
import type { TraceRollupRow } from "@/lib/observability/trace-rollup"
import { formatMs, formatTimestamp, formatUsd } from "@/lib/observability/format-utils"

export interface RecentTracesPanelProps {
  panel: PanelDef
  traces: TraceRollupRow[]
  editMode?: boolean
  onSelectTrace: (traceId: string) => void
}

export function RecentTracesPanel({
  panel,
  traces,
  editMode,
  onSelectTrace,
}: RecentTracesPanelProps) {
  const t = useTranslations("observability")

  return (
    <PanelFrame
      title={t(`panels.${panel.titleKey}`)}
      editMode={editMode}
      data-testid="recent-traces-panel"
    >
      {traces.length === 0 ? (
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          {t("traces.empty")}
        </div>
      ) : (
        <ScrollArea className="h-full">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b text-left text-muted-foreground">
                <th className="px-2 py-1.5 font-medium">{t("traces.root")}</th>
                <th className="px-2 py-1.5 font-medium">{t("traces.started")}</th>
                <th className="px-2 py-1.5 text-right font-medium">{t("traces.duration")}</th>
                <th className="px-2 py-1.5 text-right font-medium">{t("traces.spans")}</th>
                <th className="px-2 py-1.5 text-right font-medium">{t("traces.cost")}</th>
                <th className="px-2 py-1.5 font-medium">{t("traces.surface")}</th>
              </tr>
            </thead>
            <tbody>
              {traces.map((tr) => (
                <tr
                  key={tr.traceId}
                  onClick={() => onSelectTrace(tr.traceId)}
                  className={cn(
                    "cursor-pointer border-b border-border/50 hover:bg-accent/50",
                    tr.errorCount > 0 && "bg-destructive/5"
                  )}
                  data-testid={`trace-row-${tr.traceId}`}
                >
                  <td className="max-w-[220px] truncate px-2 py-1.5 font-medium">
                    <span className="inline-flex items-center gap-1">
                      {tr.errorCount > 0 && (
                        <AlertTriangleIcon className="size-3 shrink-0 text-destructive" />
                      )}
                      {tr.rootName}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-muted-foreground">
                    {formatTimestamp(tr.startTime)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{formatMs(tr.durationMs)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{tr.spanCount}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {formatUsd(tr.totalCostUsd)}
                  </td>
                  <td className="px-2 py-1.5">
                    <Badge variant="outline" className="text-[10px]">
                      {tr.surface}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollArea>
      )}
    </PanelFrame>
  )
}
