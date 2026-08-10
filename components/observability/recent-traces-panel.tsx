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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
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
          <Table className="text-xs">
            <TableHeader className="sticky top-0 bg-card">
              <TableRow className="text-left text-muted-foreground hover:bg-card">
                <TableHead className="h-auto px-2 py-1.5">{t("traces.root")}</TableHead>
                <TableHead className="h-auto px-2 py-1.5">{t("traces.started")}</TableHead>
                <TableHead className="h-auto px-2 py-1.5 text-right">
                  {t("traces.duration")}
                </TableHead>
                <TableHead className="h-auto px-2 py-1.5 text-right">{t("traces.spans")}</TableHead>
                <TableHead className="h-auto px-2 py-1.5 text-right">{t("traces.cost")}</TableHead>
                <TableHead className="h-auto px-2 py-1.5">{t("traces.surface")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {traces.map((tr) => (
                <TableRow
                  key={tr.traceId}
                  onClick={() => onSelectTrace(tr.traceId)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault()
                      onSelectTrace(tr.traceId)
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  className={cn(
                    "cursor-pointer border-border/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    tr.errorCount > 0 && "bg-destructive/5"
                  )}
                  data-testid={`trace-row-${tr.traceId}`}
                >
                  <TableCell className="max-w-[220px] truncate px-2 py-1.5 font-medium">
                    <span className="inline-flex items-center gap-1">
                      {tr.errorCount > 0 && (
                        <AlertTriangleIcon className="size-3 shrink-0 text-destructive" />
                      )}
                      {tr.rootName}
                    </span>
                  </TableCell>
                  <TableCell className="px-2 py-1.5 text-muted-foreground">
                    {formatTimestamp(tr.startTime)}
                  </TableCell>
                  <TableCell className="px-2 py-1.5 text-right tabular-nums">
                    {formatMs(tr.durationMs)}
                  </TableCell>
                  <TableCell className="px-2 py-1.5 text-right tabular-nums">
                    {tr.spanCount}
                  </TableCell>
                  <TableCell className="px-2 py-1.5 text-right tabular-nums">
                    {formatUsd(tr.totalCostUsd)}
                  </TableCell>
                  <TableCell className="px-2 py-1.5">
                    <Badge variant="outline" className="text-[10px]">
                      {tr.surface}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      )}
    </PanelFrame>
  )
}
