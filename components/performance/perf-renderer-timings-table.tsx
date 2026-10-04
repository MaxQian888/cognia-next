"use client"

/**
 * Renderer timings — the browser side of "where is the time going".
 *
 * Reads the shared renderer collector's bounded User Timing history
 * (`workflow-ai:*` measures: chat-turn latency, `<PerfBoundary>` React
 * commits, ad-hoc `measure()` calls) through `summarizeRendererMeasurements`.
 * The host hotspot table only exists when a Rust or Node host is attached;
 * this one is what web and mobile have, and what explains a slow chat turn
 * on desktop too.
 *
 * `version` is any value that changes when new frames arrive (the dashboard
 * passes the renderer frame count) — the collector's map is mutated in place,
 * so React needs an outside signal to re-read it.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Trash2Icon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatCount, formatMs } from "@/lib/perf/backend/format"
import type { RendererMeasurementEntry } from "@/lib/perf/renderer-collector"
import {
  summarizeRendererMeasurements,
  type RendererTimingCategory,
} from "@/lib/perf/renderer-timings"
import { cn } from "@/lib/utils"

const CATEGORY_BADGE: Record<RendererTimingCategory, string> = {
  chat: "bg-chart-1/15 text-foreground",
  react: "bg-chart-2/15 text-foreground",
  other: "bg-muted text-muted-foreground",
}

export interface PerfRendererTimingsTableProps {
  /** Reads the collector's retained measures. */
  readMeasurements: () => ReadonlyMap<string, readonly RendererMeasurementEntry[]>
  /** Drops the retained measures (the collector's `clearMeasurements`). */
  onClear: () => void
  /** Changes whenever new renderer frames arrive; triggers a re-read. */
  version: number
}

export function PerfRendererTimingsTable({
  readMeasurements,
  onClear,
  version,
}: PerfRendererTimingsTableProps) {
  const t = useTranslations("performance.rendererTimings")
  // Bumped by Clear so the table empties immediately instead of on the next frame.
  const [clears, setClears] = useState(0)
  const [category, setCategory] = useState<RendererTimingCategory | "all">("all")

  const rows = useMemo(
    () => summarizeRendererMeasurements(readMeasurements()),
    // `version` and `clears` are the change signals for a map mutated in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [readMeasurements, version, clears]
  )
  const visible = category === "all" ? rows : rows.filter((row) => row.category === category)
  const maxP95 = visible.reduce((max, row) => Math.max(max, row.p95Ms), 0)

  return (
    <section className="border-y bg-background" data-testid="perf-renderer-timings">
      <header className="flex flex-row flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-base font-medium">{t("title")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t("description")}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1" role="group" aria-label={t("filterLabel")}>
            {(["all", "chat", "react", "other"] as const).map((value) => (
              <Button
                key={value}
                type="button"
                size="xs"
                variant={category === value ? "secondary" : "ghost"}
                aria-pressed={category === value}
                onClick={() => setCategory(value)}
                data-testid={`perf-renderer-timings-filter-${value}`}
              >
                {t(`categories.${value}`)}
              </Button>
            ))}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              onClear()
              setClears((count) => count + 1)
            }}
            disabled={rows.length === 0}
            data-testid="perf-renderer-timings-clear"
          >
            <Trash2Icon aria-hidden />
            {t("clear")}
          </Button>
        </div>
      </header>
      {visible.length === 0 ? (
        <div className="px-4 py-10 text-center" data-testid="perf-renderer-timings-empty">
          <p className="text-sm font-medium">{t("empty")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("hint")}</p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("columns.name")}</TableHead>
              <TableHead className="text-right">{t("columns.count")}</TableHead>
              <TableHead className="text-right">{t("columns.last")}</TableHead>
              <TableHead className="text-right">{t("columns.p50")}</TableHead>
              <TableHead className="text-right">{t("columns.p95")}</TableHead>
              <TableHead className="text-right">{t("columns.max")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((row) => (
              <TableRow key={row.name} data-testid={`perf-renderer-timing-${row.name}`}>
                <TableCell>
                  <div className="flex min-w-0 items-center gap-2">
                    <Badge
                      variant="secondary"
                      className={cn("shrink-0", CATEGORY_BADGE[row.category])}
                    >
                      {t(`categories.${row.category}`)}
                    </Badge>
                    <span className="truncate font-mono text-xs" title={row.name}>
                      {row.name}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {formatCount(row.count)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {formatMs(row.lastMs)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {formatMs(row.p50Ms)}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-2">
                    <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-chart-4"
                        style={{ width: `${maxP95 > 0 ? (row.p95Ms / maxP95) * 100 : 0}%` }}
                      />
                    </div>
                    <span className="font-mono tabular-nums">{formatMs(row.p95Ms)}</span>
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {formatMs(row.maxMs)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  )
}
