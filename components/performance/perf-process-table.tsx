"use client"

/**
 * PerfProcessTable — sortable table of the sampled process tree (main app +
 * Node sidecar + children) with a summary KPI row, CPU / memory / disk columns,
 * a per-process CPU trend sparkline, a memory-share bar, and process uptime —
 * mirroring (and going a little beyond) Task Manager's Processes tab.
 *
 * Takes the full sample `history` so it can derive each process's CPU trend;
 * the table itself renders the most-recent frame.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CpuIcon,
  HardDriveIcon,
  LayersIcon,
  MemoryStickIcon,
  SearchIcon,
} from "lucide-react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Button } from "@/components/ui/button"
import { StatCard } from "@/components/observability/stat-card"
import { cn, formatDurationShort } from "@/lib/utils"
import type { PerfSample, ProcessRole } from "@/lib/perf/backend/types"
import {
  formatBytes,
  formatBytesPerSec,
  formatCount,
  formatPercent,
} from "@/lib/perf/backend/format"
import { useThemeColors } from "@/hooks/logging/use-theme-colors"
import { PerfSparkline } from "./perf-sparkline"
import { buildProcessTree, filterProcessTree, type ProcessTreeNode } from "@/lib/perf/process-tree"

type SortKey = "name" | "pid" | "cpuPct" | "memBytes" | "runSecs" | "diskReadBps" | "diskWriteBps"
type SortDir = "asc" | "desc"

const ROLE_BADGE: Record<ProcessRole, string> = {
  main: "bg-primary/15 text-primary",
  sidecar: "bg-chart-2/15 text-foreground",
  child: "bg-muted text-muted-foreground",
}

/** Tailwind heat-map classes for CPU% cells. */
function cpuHeatClass(pct: number): string {
  if (pct >= 80) return "bg-red-500/20 text-red-600 dark:text-red-400"
  if (pct >= 60) return "bg-orange-500/15 text-orange-600 dark:text-orange-400"
  if (pct >= 30) return "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400"
  return ""
}

/** Tailwind heat-map classes for memory cells (relative to column max). */
function memHeatClass(bytes: number, maxBytes: number): string {
  if (maxBytes <= 0) return ""
  const ratio = bytes / maxBytes
  if (ratio >= 0.8) return "bg-red-500/20 text-red-600 dark:text-red-400"
  if (ratio >= 0.6) return "bg-orange-500/15 text-orange-600 dark:text-orange-400"
  if (ratio >= 0.3) return "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400"
  return ""
}

export interface PerfProcessTableProps {
  history: PerfSample[]
}

export function PerfProcessTable({ history }: PerfProcessTableProps) {
  const t = useTranslations("performance.process")
  const colors = useThemeColors()
  const [sortKey, setSortKey] = useState<SortKey>("cpuPct")
  const [sortDir, setSortDir] = useState<SortDir>("desc")
  const [searchQuery, setSearchQuery] = useState("")

  const processes = useMemo(
    () => (history.length > 0 ? history[history.length - 1].processes : []),
    [history]
  )

  // Per-PID CPU history for the trend sparklines (oldest → newest).
  //
  // One pass over the window, not one `find` per (process × frame): the naive
  // shape is O(processes² × window) and was recomputed on every 1 Hz frame —
  // ~190k scans/sec on a 40-process tree, inside the panel meant to *diagnose*
  // CPU cost. Frames where a PID is absent contribute 0 so every series stays
  // the same length and lines up with the others.
  const cpuHistories = useMemo(() => {
    const map = new Map<number, number[]>()
    for (const p of processes) map.set(p.pid, new Array<number>(history.length).fill(0))
    history.forEach((sample, frame) => {
      for (const proc of sample.processes) {
        const series = map.get(proc.pid)
        if (series) series[frame] = proc.cpuPct
      }
    })
    return map
  }, [history, processes])

  // Tree-wide aggregates for the summary row.
  const totals = useMemo(
    () =>
      processes.reduce(
        (acc, p) => ({
          cpu: acc.cpu + p.cpuPct,
          mem: acc.mem + p.memBytes,
          disk: acc.disk + p.diskReadBps + p.diskWriteBps,
        }),
        { cpu: 0, mem: 0, disk: 0 }
      ),
    [processes]
  )

  const sorted = useMemo(() => {
    const compare = (a: (typeof processes)[number], b: (typeof processes)[number]) => {
      let cmp: number
      if (sortKey === "name") {
        cmp = a.name.localeCompare(b.name)
      } else {
        cmp = (a[sortKey] as number) - (b[sortKey] as number)
      }
      return sortDir === "asc" ? cmp : -cmp
    }
    const roots = filterProcessTree(buildProcessTree(processes, compare), searchQuery)
    const rows: Array<{ process: (typeof processes)[number]; depth: number; orphaned: boolean }> = []
    const visit = (nodes: ProcessTreeNode[], depth: number) => {
      for (const node of nodes) {
        rows.push({ process: node.process, depth, orphaned: node.orphaned })
        visit(node.children, depth + 1)
      }
    }
    visit(roots, 0)
    return rows
  }, [processes, searchQuery, sortKey, sortDir])

  const maxMem = useMemo(
    () => sorted.reduce((maximum, row) => Math.max(maximum, row.process.memBytes), 0),
    [sorted]
  )

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortKey(key)
      setSortDir(key === "name" ? "asc" : "desc")
    }
  }

  // The sort control is a real shadcn Button inside the header cell; keeping
  // the control separate from the cell preserves keyboard and screen-reader access.
  const header = (key: SortKey, label: string, numeric = false) => (
    <TableHead
      className={cn("select-none", numeric && "text-right")}
      data-testid={`perf-proc-th-${key}`}
      aria-sort={sortKey === key ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
    >
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={() => toggleSort(key)}
        className={cn("h-6 gap-1 rounded-sm px-1", numeric && "flex-row-reverse")}
      >
        {label}
        {sortKey === key ? (
          sortDir === "asc" ? (
            <ArrowUpIcon className="size-3" />
          ) : (
            <ArrowDownIcon className="size-3" />
          )
        ) : null}
      </Button>
    </TableHead>
  )

  if (processes.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground" data-testid="perf-proc-empty">
        {t("empty")}
      </p>
    )
  }

  return (
    <div className="space-y-4" data-testid="perf-process-table">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          icon={LayersIcon}
          label={t("summary.processes")}
          value={formatCount(processes.length)}
          color="bg-chart-3/10 text-chart-3"
          data-testid="perf-proc-total-count"
        />
        <StatCard
          icon={CpuIcon}
          label={t("summary.totalCpu")}
          value={formatPercent(totals.cpu)}
          color="bg-chart-1/10 text-chart-1"
          data-testid="perf-proc-total-cpu"
        />
        <StatCard
          icon={MemoryStickIcon}
          label={t("summary.totalMemory")}
          value={formatBytes(totals.mem)}
          color="bg-chart-2/10 text-chart-2"
          data-testid="perf-proc-total-mem"
        />
        <StatCard
          icon={HardDriveIcon}
          label={t("summary.totalDisk")}
          value={formatBytesPerSec(totals.disk)}
          color="bg-chart-5/10 text-chart-5"
          data-testid="perf-proc-total-disk"
        />
      </div>

      <div className="relative">
        <SearchIcon className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="text"
          placeholder={t("searchPlaceholder")}
          aria-label={t("searchPlaceholder")}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="h-8 pl-8 text-sm"
          data-testid="perf-proc-search"
        />
      </div>
      {sorted.length === 0 && searchQuery ? (
        <p
          className="py-4 text-center text-sm text-muted-foreground"
          data-testid="perf-proc-no-match"
        >
          {t("noMatch")}
        </p>
      ) : (
        <div className="border-y">
          <Table>
            <TableHeader>
              <TableRow>
                {header("name", t("columns.name"))}
                {header("pid", t("columns.pid"), true)}
                {header("cpuPct", t("columns.cpu"), true)}
                <TableHead className="text-right">{t("columns.trend")}</TableHead>
                {header("memBytes", t("columns.memory"), true)}
                {header("runSecs", t("columns.uptime"), true)}
                {header("diskReadBps", t("columns.diskRead"), true)}
                {header("diskWriteBps", t("columns.diskWrite"), true)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map(({ process: p, depth, orphaned }) => (
                <TableRow key={p.pid} data-testid={`perf-proc-row-${p.pid}`}>
                  <TableCell>
                    <div className="flex items-center gap-2" style={{ paddingInlineStart: `${depth * 16}px` }}>
                      {depth > 0 && <span aria-hidden="true" className="text-muted-foreground">↳</span>}
                      <Badge variant="secondary" className={cn("shrink-0", ROLE_BADGE[p.role])}>
                        {t(`roles.${p.role}`)}
                      </Badge>
                      <span className="truncate font-medium">{p.name}</span>
                      {orphaned && <Badge variant="outline">{t("orphaned")}</Badge>}
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {p.pid}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right font-mono tabular-nums transition-colors",
                      cpuHeatClass(p.cpuPct)
                    )}
                    data-testid={`perf-proc-cpu-${p.pid}`}
                  >
                    {formatPercent(p.cpuPct)}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end">
                      <PerfSparkline
                        points={cpuHistories.get(p.pid) ?? []}
                        color={colors["chart-1"]}
                        strokeWidth={1}
                        fillOpacity={0.15}
                        className="h-5 w-16"
                        data-testid={`perf-proc-trend-${p.pid}`}
                      />
                    </div>
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right font-mono tabular-nums transition-colors",
                      memHeatClass(p.memBytes, maxMem)
                    )}
                    data-testid={`perf-proc-mem-${p.pid}`}
                  >
                    <div className="space-y-1">
                      <div>{formatBytes(p.memBytes)}</div>
                      <Progress
                        value={totals.mem > 0 ? (p.memBytes / totals.mem) * 100 : 0}
                        className="h-1"
                        data-testid={`perf-proc-mem-share-${p.pid}`}
                      />
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                    {formatDurationShort(p.runSecs * 1000)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                    {formatBytesPerSec(p.diskReadBps)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                    {formatBytesPerSec(p.diskWriteBps)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
