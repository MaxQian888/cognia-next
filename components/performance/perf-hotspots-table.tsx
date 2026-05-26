"use client"

/**
 * PerfHotspotsTable — sortable table of instrumented span stats. Total time
 * carries a relative bar so the costliest backend operations jump out at a
 * glance. This is the panel's primary "where is the time going" surface.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { SpanSnapshot } from "@/lib/perf/backend/types"
import { formatCount, formatMs } from "@/lib/perf/backend/format"

type SortKey = "name" | "count" | "avgMs" | "p50Ms" | "p95Ms" | "maxMs" | "totalMs" | "errorCount"
type SortDir = "asc" | "desc"

/**
 * Tiny log-bucket latency histogram drawn as a sparkbar strip. Each bar's
 * height is its bucket count relative to the busiest bucket; empty buckets are
 * dimmed so the shape of the distribution (tight vs. long-tailed) reads at a
 * glance without a full chart.
 */
function SpanDistribution({ buckets, name }: { buckets: number[]; name: string }) {
  const max = useMemo(() => Math.max(1, ...buckets), [buckets])
  return (
    <div
      className="flex h-6 items-end justify-end gap-px"
      data-testid={`perf-hot-dist-${name}`}
      aria-hidden
    >
      {buckets.map((count, i) => (
        <div
          key={i}
          className="w-0.5 rounded-sm bg-chart-4"
          style={{ height: `${(count / max) * 100}%`, opacity: count > 0 ? 1 : 0.15 }}
        />
      ))}
    </div>
  )
}

export interface PerfHotspotsTableProps {
  spans: SpanSnapshot[]
}

export function PerfHotspotsTable({ spans }: PerfHotspotsTableProps) {
  const t = useTranslations("performance.hotspots")
  const [sortKey, setSortKey] = useState<SortKey>("totalMs")
  const [sortDir, setSortDir] = useState<SortDir>("desc")

  const maxTotal = useMemo(() => spans.reduce((m, s) => Math.max(m, s.totalMs), 0), [spans])

  const sorted = useMemo(() => {
    const rows = spans.slice()
    rows.sort((a, b) => {
      const cmp =
        sortKey === "name"
          ? a.name.localeCompare(b.name)
          : (a[sortKey] as number) - (b[sortKey] as number)
      return sortDir === "asc" ? cmp : -cmp
    })
    return rows
  }, [spans, sortKey, sortDir])

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortKey(key)
      setSortDir(key === "name" ? "asc" : "desc")
    }
  }

  const header = (key: SortKey, label: string, numeric = true) => (
    <TableHead
      className={cn("cursor-pointer select-none", numeric && "text-right")}
      onClick={() => toggleSort(key)}
      data-testid={`perf-hot-th-${key}`}
      aria-sort={sortKey === key ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
    >
      <span className={cn("inline-flex items-center gap-1", numeric && "flex-row-reverse")}>
        {label}
        {sortKey === key ? (
          sortDir === "asc" ? (
            <ArrowUpIcon className="size-3" />
          ) : (
            <ArrowDownIcon className="size-3" />
          )
        ) : null}
      </span>
    </TableHead>
  )

  if (spans.length === 0) {
    return (
      <div className="py-10 text-center" data-testid="perf-hot-empty">
        <p className="text-sm font-medium">{t("empty")}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t("hint")}</p>
      </div>
    )
  }

  return (
    <div className="rounded-lg border" data-testid="perf-hotspots-table">
      <Table>
        <TableHeader>
          <TableRow>
            {header("name", t("columns.name"), false)}
            {header("count", t("columns.calls"))}
            {header("avgMs", t("columns.avg"))}
            {header("p50Ms", t("columns.p50"))}
            {header("p95Ms", t("columns.p95"))}
            <TableHead className="text-right">{t("columns.distribution")}</TableHead>
            {header("maxMs", t("columns.max"))}
            {header("totalMs", t("columns.total"))}
            {header("errorCount", t("columns.errors"))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((s) => {
            const pct = maxTotal > 0 ? (s.totalMs / maxTotal) * 100 : 0
            return (
              <TableRow key={s.name} data-testid={`perf-hot-row-${s.name}`}>
                <TableCell className="font-mono text-xs font-medium">{s.name}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {formatCount(s.count)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {formatMs(s.avgMs)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {formatMs(s.p50Ms)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {formatMs(s.p95Ms)}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end">
                    <SpanDistribution buckets={s.buckets} name={s.name} />
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {formatMs(s.maxMs)}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-2">
                    <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-chart-1"
                        style={{ width: `${pct}%` }}
                        data-testid={`perf-hot-bar-${s.name}`}
                      />
                    </div>
                    <span className="font-mono tabular-nums">{formatMs(s.totalMs)}</span>
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  {s.errorCount > 0 ? (
                    <Badge variant="destructive" className="font-mono tabular-nums">
                      {formatCount(s.errorCount)}
                    </Badge>
                  ) : (
                    <span className="font-mono text-xs text-muted-foreground">0</span>
                  )}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
