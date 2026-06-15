"use client"

/**
 * Per-workflow runs list. Reads `workflowRuns` for a given `workflowId`,
 * sorts newest-first, and layers management affordances on top: a summary
 * stat band, status/trigger/date/text filters, bulk + single-run deletion,
 * "clear history", JSON/CSV export of the filtered set, in-list re-run, and
 * client-side "load more" windowing.
 */

import { useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import Link from "next/link"
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  FilterXIcon,
  MoreHorizontalIcon,
  PlayCircleIcon,
  RotateCcwIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { getDb } from "@/lib/db/schema"
import { deleteAllRunsForWorkflow, deleteWorkflowRun, deleteWorkflowRuns } from "@/lib/db/workflows"
import { runWorkflow } from "@/lib/workflow/runtime/orchestrator"
import type { RunStatus, TriggerEvent, WorkflowRunRow } from "@/types/workflow/visual"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { useDebouncedCallback } from "@/hooks/workflow/use-debounced-callback"
import { RunStatusPill } from "./run-status-pill"
import { formatRunDuration, formatRunStartedAt, formatDurationMs } from "./format"
import {
  DEFAULT_RUN_FILTERS,
  distinctTriggerKinds,
  filterRuns,
  isRunFilterActive,
  summarizeRuns,
  type RunListFilters,
  type RunTimeWindow,
} from "@/lib/workflow/runs/run-list-filter"
import { downloadRunsCsv, downloadRunsJson } from "@/lib/workflow/runs/run-export"

const PAGE_SIZE = 50
const STATUS_OPTIONS: RunStatus[] = [
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "waiting",
  "paused",
  "pending",
]
const WINDOW_OPTIONS: RunTimeWindow[] = ["all", "24h", "7d", "30d"]

type PendingDelete =
  | { kind: "single"; runId: string }
  | { kind: "bulk"; runIds: string[] }
  | { kind: "all" }
  | null

export function RunList({ workflowId }: { workflowId: string }) {
  const t = useTranslations("workflows.runs.list")
  const tStatus = useTranslations("workflows.runs.status")
  const tToast = useTranslations("workflows.canvasToast")

  const runs = useLiveQuery(
    async () =>
      getDb()
        .workflowRuns.where("[workflowId+startedAt]")
        .between([workflowId, 0], [workflowId, Number.MAX_SAFE_INTEGER])
        .reverse()
        .toArray(),
    [workflowId]
  )

  const [filters, setFilters] = useState<RunListFilters>(DEFAULT_RUN_FILTERS)
  const [searchText, setSearchText] = useState("")
  const { call: debouncedSearch } = useDebouncedCallback(
    (value: string) => setFilters((f) => ({ ...f, query: value })),
    200
  )
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [busy, setBusy] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<PendingDelete>(null)

  // Pin "now" at mount so the date-window boundary is stable across renders
  // (avoids an impure Date.now() in render and needless recompute churn).
  const [now] = useState(() => Date.now())
  const triggerKinds = useMemo(() => distinctTriggerKinds(runs ?? []), [runs])
  const filtered = useMemo(() => filterRuns(runs ?? [], filters, now), [runs, filters, now])
  const summary = useMemo(() => summarizeRuns(filtered), [filtered])
  const visible = filtered.slice(0, visibleCount)
  const workflowName = runs?.[0]?.workflowSnapshot.name ?? workflowId
  const filterActive = isRunFilterActive(filters)

  const allVisibleSelected = visible.length > 0 && visible.every((r) => selected.has(r.id))
  const someSelected = selected.size > 0

  const toggleRow = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allVisibleSelected) visible.forEach((r) => next.delete(r.id))
      else visible.forEach((r) => next.add(r.id))
      return next
    })
  }
  const clearFilters = () => {
    setFilters(DEFAULT_RUN_FILTERS)
    setSearchText("")
  }

  const handleReRun = async (run: WorkflowRunRow) => {
    if (busy) return
    setBusy(true)
    const toastId = toast.loading(t("rerunning"))
    try {
      const trigger: TriggerEvent = {
        workflowId: run.workflowId,
        kind: "trigger.manual",
        payload: run.triggerPayload,
        originAt: Date.now(),
      }
      const result = await runWorkflow({ workflow: run.workflowSnapshot, trigger })
      if (result.status === "succeeded") toast.success(tToast("completed"), { id: toastId })
      else
        toast.error(`${tToast("runFailed")}: ${result.error?.message ?? "unknown error"}`, {
          id: toastId,
        })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : tToast("runFailed"), { id: toastId })
    } finally {
      setBusy(false)
    }
  }

  const confirmDelete = async () => {
    const target = pendingDelete
    setPendingDelete(null)
    if (!target) return
    try {
      if (target.kind === "single") {
        await deleteWorkflowRun(target.runId)
        setSelected((prev) => {
          const next = new Set(prev)
          next.delete(target.runId)
          return next
        })
      } else if (target.kind === "bulk") {
        await deleteWorkflowRuns(target.runIds)
        setSelected(new Set())
      } else {
        await deleteAllRunsForWorkflow(workflowId)
        setSelected(new Set())
      }
      toast.success(t("deleteSuccess"))
    } catch {
      toast.error(t("deleteFailed"))
    }
  }

  const deleteDialogCopy = (): { title: string; description: string } => {
    if (pendingDelete?.kind === "all") {
      return { title: t("clearHistory.title"), description: t("clearHistory.description") }
    }
    if (pendingDelete?.kind === "bulk") {
      return {
        title: t("bulk.deleteTitle"),
        description: t("bulk.deleteDescription", { count: pendingDelete.runIds.length }),
      }
    }
    return { title: t("row.deleteTitle"), description: t("row.deleteDescription") }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b px-6 py-4">
        <Button asChild size="icon" variant="ghost" aria-label={t("backToEditor")}>
          <Link href={`/workflows/editor?id=${encodeURIComponent(workflowId)}`}>
            <ArrowLeftIcon className="size-4" />
          </Link>
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-semibold leading-tight">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
        {runs && runs.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" data-testid="runs-export">
                <DownloadIcon className="size-4 sm:mr-1.5" />
                <span className="hidden sm:inline">{t("export.button")}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => downloadRunsJson(filtered, workflowName)}>
                {t("export.json")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => downloadRunsCsv(filtered, workflowName)}>
                {t("export.csv")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {runs && runs.length > 0 ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPendingDelete({ kind: "all" })}
            data-testid="runs-clear-history"
          >
            <Trash2Icon className="size-4 sm:mr-1.5" />
            <span className="hidden sm:inline">{t("clearHistory.button")}</span>
          </Button>
        ) : null}
      </header>

      {runs && runs.length > 0 ? (
        <>
          <div className="grid grid-cols-2 gap-px border-b bg-border sm:grid-cols-4">
            <StatCell label={t("stats.total")} value={String(summary.total)} />
            <StatCell
              label={t("stats.successRate")}
              value={
                summary.successRate === null ? "—" : `${Math.round(summary.successRate * 100)}%`
              }
            />
            <StatCell label={t("stats.failed")} value={String(summary.failed)} />
            <StatCell
              label={t("stats.avgDuration")}
              value={summary.avgDurationMs === null ? "—" : formatDurationMs(summary.avgDurationMs)}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2 border-b px-6 py-3">
            <div className="relative min-w-[180px] flex-1 sm:max-w-xs">
              <SearchIcon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchText}
                onChange={(e) => {
                  setSearchText(e.target.value)
                  debouncedSearch(e.target.value)
                }}
                placeholder={t("search.placeholder")}
                className="pl-9"
                aria-label={t("search.placeholder")}
                data-testid="runs-search"
              />
            </div>
            <NativeSelect
              size="sm"
              value={filters.status}
              onChange={(e) =>
                setFilters((f) => ({ ...f, status: e.target.value as RunListFilters["status"] }))
              }
              aria-label={t("filter.status")}
              data-testid="runs-filter-status"
            >
              <NativeSelectOption value="all">{t("filter.allStatuses")}</NativeSelectOption>
              {STATUS_OPTIONS.map((s) => (
                <NativeSelectOption key={s} value={s}>
                  {tStatus(s)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <NativeSelect
              size="sm"
              value={filters.triggerKind}
              onChange={(e) => setFilters((f) => ({ ...f, triggerKind: e.target.value }))}
              aria-label={t("filter.trigger")}
              data-testid="runs-filter-trigger"
            >
              <NativeSelectOption value="all">{t("filter.allTriggers")}</NativeSelectOption>
              {triggerKinds.map((k) => (
                <NativeSelectOption key={k} value={k}>
                  {k}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <NativeSelect
              size="sm"
              value={filters.window}
              onChange={(e) =>
                setFilters((f) => ({ ...f, window: e.target.value as RunTimeWindow }))
              }
              aria-label={t("filter.window")}
              data-testid="runs-filter-window"
            >
              {WINDOW_OPTIONS.map((w) => (
                <NativeSelectOption key={w} value={w}>
                  {t(`window.${w}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            {filterActive ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearFilters}
                data-testid="runs-clear-filters"
              >
                <FilterXIcon className="size-4 sm:mr-1.5" />
                <span className="hidden sm:inline">{t("clearFilters")}</span>
              </Button>
            ) : null}
          </div>

          {someSelected ? (
            <div className="flex items-center gap-3 border-b bg-accent/40 px-6 py-2">
              <span className="text-sm font-medium" data-testid="runs-selected-count">
                {t("bulk.selected", { count: selected.size })}
              </span>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setPendingDelete({ kind: "bulk", runIds: [...selected] })}
                data-testid="runs-bulk-delete"
              >
                <Trash2Icon className="size-4 mr-1.5" />
                {t("bulk.delete")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                {t("bulk.clear")}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {runs === undefined ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : runs.length === 0 ? (
          <Empty className="mx-auto max-w-md py-12">
            <EmptyHeader>
              <EmptyMedia>
                <PlayCircleIcon className="size-8" aria-hidden="true" />
              </EmptyMedia>
            </EmptyHeader>
            <EmptyTitle>{t("empty.title")}</EmptyTitle>
            <EmptyDescription>
              {t.rich("empty.description", {
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </EmptyDescription>
          </Empty>
        ) : visible.length === 0 ? (
          <Empty className="mx-auto max-w-md py-12">
            <EmptyHeader>
              <EmptyMedia>
                <FilterXIcon className="size-8" aria-hidden="true" />
              </EmptyMedia>
            </EmptyHeader>
            <EmptyTitle>{t("filteredEmpty.title")}</EmptyTitle>
            <EmptyDescription>{t("filteredEmpty.description")}</EmptyDescription>
            <Button variant="outline" size="sm" className="mt-2" onClick={clearFilters}>
              {t("clearFilters")}
            </Button>
          </Empty>
        ) : (
          <>
            <div className="rounded-md border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox
                        checked={allVisibleSelected}
                        onCheckedChange={toggleAllVisible}
                        aria-label={t("selectAll")}
                        data-testid="runs-select-all"
                      />
                    </TableHead>
                    <TableHead>{t("columns.status")}</TableHead>
                    <TableHead>{t("columns.trigger")}</TableHead>
                    <TableHead>{t("columns.started")}</TableHead>
                    <TableHead>{t("columns.duration")}</TableHead>
                    <TableHead className="w-12" aria-label={t("columns.open")} />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((run) => (
                    <TableRow
                      key={run.id}
                      data-state={selected.has(run.id) ? "selected" : undefined}
                    >
                      <TableCell>
                        <Checkbox
                          checked={selected.has(run.id)}
                          onCheckedChange={() => toggleRow(run.id)}
                          aria-label={t("selectRow", { id: run.id })}
                          data-testid={`runs-select-${run.id}`}
                        />
                      </TableCell>
                      <TableCell>
                        <RunStatusPill status={run.status} />
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground font-mono">
                        {run.triggerKind}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatRunStartedAt(run.startedAt)}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground tabular-nums">
                        {formatRunDuration(run)}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8"
                              aria-label={t("row.actions", { id: run.id })}
                              data-testid={`runs-actions-${run.id}`}
                            >
                              <MoreHorizontalIcon className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem asChild>
                              <Link
                                href={`/workflows/run?id=${encodeURIComponent(workflowId)}&runId=${encodeURIComponent(run.id)}`}
                              >
                                <ChevronRightIcon className="size-4" />
                                {t("row.open")}
                              </Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem disabled={busy} onSelect={() => handleReRun(run)}>
                              <RotateCcwIcon className="size-4" />
                              {t("row.rerun")}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              onSelect={() => setPendingDelete({ kind: "single", runId: run.id })}
                            >
                              <Trash2Icon className="size-4" />
                              {t("row.delete")}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {filtered.length > visible.length ? (
              <div className="mt-3 flex justify-center">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                  data-testid="runs-load-more"
                >
                  {t("loadMore", { count: filtered.length - visible.length })}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{deleteDialogCopy().title}</AlertDialogTitle>
            <AlertDialogDescription>{deleteDialogCopy().description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} data-testid="runs-confirm-delete">
              {t("confirmDelete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-background px-4 py-2.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  )
}
