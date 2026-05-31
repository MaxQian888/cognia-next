"use client"

/**
 * Goals History table (ADR-0019). Newest-first list of every goal with a
 * search box, a status filter, sortable columns, row-click → detail sheet, and
 * a per-row delete (with confirm). Filtering / sorting is delegated to the pure
 * `filterAndSortGoals` so the matching logic stays unit-tested.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { ArrowDownIcon, ArrowUpIcon, SearchIcon, Trash2Icon } from "lucide-react"

import { listAllGoals } from "@/lib/db/goals"
import { getGoalRuntime } from "@/lib/goal/runtime"
import { filterAndSortGoals, type GoalSortKey, type SortDir } from "@/lib/goal/history-filter"
import type { Goal, GoalStatus } from "@/types/goal"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
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
import { GoalDetailSheet } from "@/components/goal/goal-detail-sheet"

const ALL_STATUS = "__all__"
const STATUSES: readonly GoalStatus[] = [
  "active",
  "paused",
  "completed",
  "stopped",
  "budget_limited",
  "turn_limited",
  "timed_out",
  "preempted",
]
const SORT_KEYS: readonly GoalSortKey[] = ["created", "turns", "tokens"]

export function GoalsHistoryTable() {
  const t = useTranslations("goal")
  const goals = useLiveQuery(() => listAllGoals(500), [])

  const [query, setQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState<string>(ALL_STATUS)
  const [sort, setSort] = useState<GoalSortKey>("created")
  const [dir, setDir] = useState<SortDir>("desc")
  const [openGoal, setOpenGoal] = useState<Goal | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Goal | null>(null)

  const filtered = useMemo(
    () =>
      filterAndSortGoals(goals ?? [], {
        query,
        statuses: statusFilter === ALL_STATUS ? undefined : [statusFilter as GoalStatus],
        sort,
        dir,
      }),
    [goals, query, statusFilter, sort, dir]
  )

  if (!goals) return <p className="text-sm text-muted-foreground">{t("activity.loading")}</p>

  if (goals.length === 0) {
    return (
      <p
        className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground"
        data-testid="goals-history-empty"
      >
        {t("history.empty")}
      </p>
    )
  }

  async function confirmDelete() {
    if (!pendingDelete) return
    await getGoalRuntime().deleteGoal(pendingDelete.id)
    setPendingDelete(null)
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2" data-testid="goals-history-filters">
        <div className="relative min-w-0 flex-1 basis-48">
          <SearchIcon
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("history.search")}
            aria-label={t("history.search")}
            className="pl-8"
            data-testid="goals-history-search"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger
            className="w-36"
            aria-label={t("history.filterStatus")}
            data-testid="goals-history-status"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_STATUS}>{t("history.all")}</SelectItem>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {t(`status.${s}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={(v) => setSort(v as GoalSortKey)}>
          <SelectTrigger
            className="w-32"
            aria-label={t("history.sortBy")}
            data-testid="goals-history-sort"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORT_KEYS.map((k) => (
              <SelectItem key={k} value={k}>
                {t(`history.sort${k.charAt(0).toUpperCase()}${k.slice(1)}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="icon"
          aria-label={dir === "asc" ? t("history.dirAsc") : t("history.dirDesc")}
          onClick={() => setDir((d) => (d === "asc" ? "desc" : "asc"))}
          data-testid="goals-history-dir"
        >
          {dir === "asc" ? (
            <ArrowUpIcon className="size-4" aria-hidden />
          ) : (
            <ArrowDownIcon className="size-4" aria-hidden />
          )}
        </Button>
      </div>

      {filtered.length === 0 ? (
        <p
          className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground"
          data-testid="goals-history-no-results"
        >
          {t("history.noResults")}
        </p>
      ) : (
        <Table data-testid="goals-history-table">
          <TableHeader>
            <TableRow>
              <TableHead>{t("history.objective")}</TableHead>
              <TableHead>{t("history.status")}</TableHead>
              <TableHead>{t("history.turns")}</TableHead>
              <TableHead>{t("history.tokens")}</TableHead>
              <TableHead>{t("history.created")}</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((g) => (
              <TableRow
                key={g.id}
                data-testid="goals-history-row"
                className="cursor-pointer"
                onClick={() => setOpenGoal(g)}
              >
                <TableCell className="max-w-xs truncate" title={g.safeObjective}>
                  {g.safeObjective}
                </TableCell>
                <TableCell>{t(`status.${g.status}`)}</TableCell>
                <TableCell>{g.turnsUsed}</TableCell>
                <TableCell>{g.tokensUsed.toLocaleString()}</TableCell>
                <TableCell>{new Date(g.createdAt).toLocaleString()}</TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground hover:text-destructive"
                    aria-label={t("history.delete")}
                    data-testid="goals-history-delete"
                    onClick={(e) => {
                      e.stopPropagation()
                      setPendingDelete(g)
                    }}
                  >
                    <Trash2Icon className="size-4" aria-hidden />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {openGoal && (
        <GoalDetailSheet
          goal={openGoal}
          open={!!openGoal}
          onOpenChange={(next) => {
            if (!next) setOpenGoal(null)
          }}
        />
      )}

      <AlertDialog open={!!pendingDelete} onOpenChange={(next) => !next && setPendingDelete(null)}>
        <AlertDialogContent data-testid="goals-history-delete-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("history.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("history.deleteBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("history.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void confirmDelete()}
              data-testid="goals-history-delete-confirm"
            >
              {t("history.deleteConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
