"use client"

/**
 * History section of the Goals console (ADR-0019): every goal of the
 * workspace, newest first, searchable, filterable by status and sortable.
 *
 * Each row says what the goal was, where it ran (a link to its conversation),
 * how it ended (a status chip in the shared tones, not plain text), what it
 * cost and how long it took. A click opens the goal in the console's
 * inspector; the ⋯ menu opens the conversation, runs the goal again as a new
 * one, copies the objective or deletes it — the always-visible trash icon on
 * every row is gone.
 *
 * Reads 500 goals at a time and says so: "Load more" reaches the rest, where
 * the table used to stop silently at the 500th.
 *
 * Columns give way to the objective as the container narrows (`@container/
 * goal-history`): duration first, then tokens and turns.
 */

import { useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useFormatter, useLocale, useNow, useTranslations } from "next-intl"
import { ArrowDownIcon, ArrowUpIcon, SearchIcon, TargetIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Surface } from "@/components/surface/surface"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useGoalRowContext } from "@/hooks/goal/use-goal-row-context"
import { countAllGoals, listAllGoals } from "@/lib/db/goals"
import { formatGoalDuration, formatGoalTokens, goalRunDurationMs } from "@/lib/goal/format"
import { filterAndSortGoals, type GoalSortKey, type SortDir } from "@/lib/goal/history-filter"
import type { GoalStatus } from "@/types/goal"

import { GoalActionsMenu } from "../goal-actions-menu"
import { GoalConversationLink } from "../goal-conversation-link"
import { GoalQuickCreateDialog } from "../goal-quick-create-dialog"
import { GoalStatusChip } from "../goal-status-chip"

/** Sentinel for "every status" in the status filter (Radix forbids ""). */
export const ALL_GOAL_STATUSES = "__all__"
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
/** Goals read per page. */
export const GOAL_HISTORY_PAGE = 500

export interface GoalHistorySectionProps {
  selectedGoalId: string | null
  onSelect: (goalId: string) => void
  onDeleted: (goalId: string) => void
  /** Status filter, owned by the console so the lifetime strip can set it. */
  statusFilter: string
  onStatusFilterChange: (status: string) => void
}

export function GoalHistorySection({
  selectedGoalId,
  onSelect,
  onDeleted,
  statusFilter,
  onStatusFilterChange,
}: GoalHistorySectionProps) {
  const t = useTranslations("goal")
  const format = useFormatter()
  const locale = useLocale()
  const now = useNow({ updateInterval: 60_000 })
  const [limit, setLimit] = useState(GOAL_HISTORY_PAGE)
  const goals = useLiveQuery(() => listAllGoals(limit), [limit])
  const total = useLiveQuery(() => countAllGoals(), [])

  const [query, setQuery] = useState("")
  const [sort, setSort] = useState<GoalSortKey>("created")
  const [dir, setDir] = useState<SortDir>("desc")

  const filtered = useMemo(
    () =>
      filterAndSortGoals(goals ?? [], {
        query,
        statuses: statusFilter === ALL_GOAL_STATUSES ? undefined : [statusFilter as GoalStatus],
        sort,
        dir,
      }),
    [goals, query, statusFilter, sort, dir]
  )
  const context = useGoalRowContext(filtered)

  if (goals === undefined) {
    return (
      <div className="space-y-2" aria-busy data-testid="goals-history-loading">
        <Skeleton className="h-8 w-full" />
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-11 w-full" />
        ))}
      </div>
    )
  }

  if (goals.length === 0) {
    return (
      <Empty className="rounded-panel border border-dashed" data-testid="goals-history-empty">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TargetIcon className="size-5" aria-hidden />
          </EmptyMedia>
          <EmptyTitle>{t("history.emptyTitle")}</EmptyTitle>
          <EmptyDescription>{t("history.empty")}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <GoalQuickCreateDialog triggerTestId="goals-history-create" triggerVariant="outline" />
        </EmptyContent>
      </Empty>
    )
  }

  const narrowed = query.trim() !== "" || statusFilter !== ALL_GOAL_STATUSES

  return (
    <div className="@container/goal-history space-y-3" data-testid="goals-history">
      <div className="flex flex-wrap items-center gap-2" data-testid="goals-history-filters">
        <InputGroup className="h-8 min-w-0 flex-1 basis-48">
          <InputGroupAddon>
            <SearchIcon className="size-4" aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.preventDefault()
                setQuery("")
              }
            }}
            placeholder={t("history.search")}
            aria-label={t("history.search")}
            data-testid="goals-history-search"
          />
          {query ? (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                onClick={() => setQuery("")}
                aria-label={t("console.clearSearch")}
              >
                <XIcon className="size-3.5" />
              </InputGroupButton>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
        <Select value={statusFilter} onValueChange={onStatusFilterChange}>
          <SelectTrigger
            size="sm"
            className="w-36"
            aria-label={t("history.filterStatus")}
            data-testid="goals-history-status"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_GOAL_STATUSES}>{t("history.allStatuses")}</SelectItem>
            {STATUSES.map((status) => (
              <SelectItem key={status} value={status}>
                <span className="first-letter:uppercase">{t(`status.${status}`)}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1">
          <Select value={sort} onValueChange={(value) => setSort(value as GoalSortKey)}>
            <SelectTrigger
              size="sm"
              className="w-32"
              aria-label={t("history.sortBy")}
              data-testid="goals-history-sort"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_KEYS.map((key) => (
                <SelectItem key={key} value={key}>
                  {t(`history.sort${key.charAt(0).toUpperCase()}${key.slice(1)}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={dir === "asc" ? t("history.dirAsc") : t("history.dirDesc")}
            onClick={() => setDir((current) => (current === "asc" ? "desc" : "asc"))}
            data-testid="goals-history-dir"
          >
            {dir === "asc" ? (
              <ArrowUpIcon className="size-4" aria-hidden />
            ) : (
              <ArrowDownIcon className="size-4" aria-hidden />
            )}
          </Button>
        </div>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums" role="status">
          {narrowed
            ? t("history.matching", { shown: filtered.length, total: goals.length })
            : t("history.count", { count: total ?? goals.length })}
        </span>
      </div>

      {filtered.length === 0 ? (
        <div
          className="flex flex-wrap items-center gap-2 py-6 text-sm text-muted-foreground"
          data-testid="goals-history-no-results"
        >
          <span>{t("history.noResults")}</span>
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0"
            onClick={() => {
              setQuery("")
              onStatusFilterChange(ALL_GOAL_STATUSES)
            }}
          >
            {t("console.clearFilters")}
          </Button>
        </div>
      ) : (
        <Surface layer="raised" radius="panel" className="overflow-hidden border">
          <Table className="table-fixed" data-testid="goals-history-table">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-auto">{t("history.objective")}</TableHead>
                <TableHead className="w-36">{t("history.status")}</TableHead>
                <TableHead className="hidden w-16 text-right @xl/goal-history:table-cell">
                  {t("history.turns")}
                </TableHead>
                <TableHead className="hidden w-20 text-right @xl/goal-history:table-cell">
                  {t("history.tokens")}
                </TableHead>
                <TableHead className="hidden w-20 text-right @2xl/goal-history:table-cell">
                  {t("history.duration")}
                </TableHead>
                <TableHead className="w-28">{t("history.created")}</TableHead>
                <TableHead className="w-10">
                  <span className="sr-only">{t("actions.menu")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((goal) => {
                const session = context.sessionFor(goal)
                const selected = goal.id === selectedGoalId
                return (
                  <TableRow
                    key={goal.id}
                    data-testid="goals-history-row"
                    data-state={selected ? "selected" : undefined}
                    className="cursor-pointer"
                    onClick={() => onSelect(goal.id)}
                  >
                    <TableCell className="max-w-0">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          onSelect(goal.id)
                        }}
                        aria-current={selected ? "true" : undefined}
                        title={goal.safeObjective}
                        className="block w-full truncate rounded-sm text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                        data-testid="goals-history-row-select"
                      >
                        {goal.safeObjective}
                      </button>
                      <div className="mt-0.5 flex min-w-0 text-[11px]">
                        <GoalConversationLink
                          sessionId={goal.sessionId}
                          session={session}
                          className="max-w-full"
                        />
                      </div>
                    </TableCell>
                    <TableCell>
                      <GoalStatusChip goal={goal} size="sm" />
                    </TableCell>
                    <TableCell className="hidden text-right text-xs tabular-nums @xl/goal-history:table-cell">
                      {goal.turnsUsed}
                    </TableCell>
                    <TableCell
                      className="hidden text-right text-xs tabular-nums @xl/goal-history:table-cell"
                      title={format.number(goal.tokensUsed)}
                    >
                      {formatGoalTokens(goal.tokensUsed, locale)}
                    </TableCell>
                    <TableCell className="hidden text-right text-xs tabular-nums text-muted-foreground @2xl/goal-history:table-cell">
                      {formatGoalDuration(goalRunDurationMs(goal, now.getTime()), locale)}
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                      <time
                        dateTime={new Date(goal.createdAt).toISOString()}
                        title={format.dateTime(new Date(goal.createdAt), {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}
                      >
                        {format.relativeTime(new Date(goal.createdAt), now)}
                      </time>
                    </TableCell>
                    <TableCell className="text-right" onClick={(event) => event.stopPropagation()}>
                      <GoalActionsMenu
                        goal={goal}
                        conversationMissing={session === null}
                        onOpenDetails={() => onSelect(goal.id)}
                        onDeleted={() => onDeleted(goal.id)}
                        triggerClassName="size-7"
                      />
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </Surface>
      )}

      {total !== undefined && total > goals.length ? (
        <div className="flex flex-col items-center gap-1 pt-1">
          <p className="text-[11px] text-muted-foreground tabular-nums">
            {t("history.loadedOf", { shown: goals.length, total })}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setLimit((current) => current + GOAL_HISTORY_PAGE)}
            data-testid="goals-history-load-more"
          >
            {t("history.loadMore")}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

GoalHistorySection.displayName = "GoalHistorySection"
