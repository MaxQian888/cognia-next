"use client"

/**
 * Cloudflare Worker logs, as rows rather than a JSON dump.
 *
 * `logs()` returned `unknown` and the console rendered it with `<JsonTree>` —
 * honest, and unusable for the thing people open logs to do: scan a window for
 * the request that went wrong. `parseSiteWorkerLogs` lifts the four facts a
 * scan needs; the original event stays one click away.
 *
 * Virtualized because the query caps at 500 events and every one arrives at
 * once.
 */
import { useRef, useState } from "react"
import { useTranslations, useFormatter } from "next-intl"
import { useVirtualizer } from "@tanstack/react-virtual"
import { ChevronRightIcon } from "lucide-react"

import { JsonTree } from "@/components/shared/json-tree"
import { Surface } from "@/components/surface/surface"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import type {
  SiteLogEntry,
  SiteLogLevel,
  SiteLogsView,
} from "@/lib/sites/cloudflare/observability-parse"
import { cn } from "@/lib/utils"

/**
 * Level → ink. These are status colours because a log level *is* a status;
 * they carry a label beside them, never colour alone.
 */
const LEVEL_INK: Record<SiteLogLevel, string> = {
  error: "text-destructive",
  warn: "text-warning",
  info: "text-info",
  debug: "text-muted-foreground",
  unknown: "text-muted-foreground",
}

export interface SiteLogTableProps {
  view: SiteLogsView
}

export function SiteLogTable({ view }: SiteLogTableProps) {
  const t = useTranslations("sites")
  const scrollRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: view.entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 30,
    overscan: 12,
    getItemKey: (index) => view.entries[index]?.id ?? index,
  })

  if (view.entries.length === 0) {
    return (
      <Empty role="status" className="gap-2 px-4 py-10" data-testid="site-log-table-empty">
        <EmptyHeader>
          <EmptyTitle className="text-sm">{t("observability.logs.empty")}</EmptyTitle>
          {view.unparsed > 0 ? (
            <EmptyDescription className="text-xs">
              {t("observability.logs.unparsed", { count: view.unparsed })}
            </EmptyDescription>
          ) : null}
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="space-y-1.5" data-testid="site-log-table">
      {view.unparsed > 0 ? (
        // Counted rather than dropped: losing rows silently would make a
        // partial read look like a quiet period.
        <p className="text-xs text-muted-foreground" data-testid="site-log-unparsed">
          {t("observability.logs.unparsed", { count: view.unparsed })}
        </p>
      ) : null}

      <Surface layer="raised" radius="panel" className="overflow-hidden border">
        <div className="flex gap-3 border-b bg-muted/40 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          <span className="w-24 shrink-0">{t("observability.logs.time")}</span>
          <span className="w-14 shrink-0">{t("observability.logs.level")}</span>
          <span className="min-w-0 flex-1">{t("observability.logs.message")}</span>
          <span className="w-24 shrink-0 text-right">{t("observability.logs.status")}</span>
        </div>
        <div ref={scrollRef} className="max-h-[46vh] overflow-y-auto">
          <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const entry = view.entries[virtualRow.index]
              if (!entry) return null
              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <SiteLogRow
                    entry={entry}
                    expanded={expanded === entry.id}
                    onToggle={() => setExpanded(expanded === entry.id ? null : entry.id)}
                  />
                </div>
              )
            })}
          </div>
        </div>
      </Surface>
    </div>
  )
}

function SiteLogRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: SiteLogEntry
  expanded: boolean
  onToggle: () => void
}) {
  const t = useTranslations("sites")
  const format = useFormatter()
  return (
    <div className="border-b last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        data-testid={`site-log-row-${entry.id}`}
        className="flex w-full gap-3 px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent/50 motion-reduce:transition-none"
      >
        <span className="w-24 shrink-0 font-mono tabular-nums text-muted-foreground">
          {format.dateTime(new Date(entry.timestamp), {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })}
        </span>
        <span className={cn("w-14 shrink-0 font-medium", LEVEL_INK[entry.level])}>
          {t(`observability.level.${entry.level}`)}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono">
          {entry.requestMethod ? `${entry.requestMethod} ` : ""}
          {entry.message || entry.requestUrl || entry.outcome}
        </span>
        <span className="flex w-24 shrink-0 items-center justify-end gap-1 font-mono tabular-nums text-muted-foreground">
          {entry.statusCode ?? entry.outcome ?? ""}
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3 transition-transform motion-reduce:transition-none",
              expanded && "rotate-90"
            )}
          />
        </span>
      </button>
      {expanded ? (
        <div className="border-t bg-muted/20 px-3 py-2" data-testid={`site-log-detail-${entry.id}`}>
          <JsonTree value={entry.raw} />
        </div>
      ) : null}
    </div>
  )
}
