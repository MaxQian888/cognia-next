"use client"

/**
 * Overview section of the Goals console (ADR-0019) — what is running and what
 * needs the user, with as little chrome as possible ahead of it.
 *
 *   lifetime strip      Completed n/finished · Avg turns · Avg tokens · Spend
 *   Needs you (n)       goals parked for an acceptance verdict, with Accept /
 *                       Request changes inline — only when there are some
 *   Open goals          search · All / Active / Paused (with counts) · sort ·
 *                       list ⇄ grid, then the goals
 *
 * Selecting a row hands the goal to the console's inspector (`onSelect`); ↑/↓
 * move the selection through the list the way they move through a mailbox.
 *
 * Sized by its own container (`@container/console-pane`, `@container/goal-
 * list`), not the viewport, so it reflows the same whether the inspector is
 * open beside it or not.
 */

import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { useNow, useTranslations } from "next-intl"
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useGoalConsolePrefs } from "@/hooks/goal/use-goal-console-prefs"
import { useGoalConsoleView } from "@/hooks/goal/use-goal-console-view"
import { useGoalRowContext } from "@/hooks/goal/use-goal-row-context"
import type { GoalAnalytics } from "@/lib/goal/analytics"
import type { GoalSortKey, SortDir } from "@/lib/goal/history-filter"
import {
  OPEN_GOAL_SCOPES,
  countOpenGoalScopes,
  filterOpenGoals,
  isOpenGoalScope,
  splitOpenGoals,
  type OpenGoalScope,
} from "@/lib/goal/overview-filter"
import { cn } from "@/lib/utils"
import type { Goal } from "@/types/goal"

import { GoalConsoleViewToggle } from "../goal-console-view-toggle"
import { GoalQuickCreateDialog } from "../goal-quick-create-dialog"
import { GoalGridTile } from "./goal-grid-tile"
import { GoalListRow } from "./goal-list-row"
import { GoalSummaryStrip } from "./goal-summary-strip"

const SORT_KEYS: readonly GoalSortKey[] = ["created", "turns", "tokens"]

export interface GoalOverviewSectionProps {
  /** Every open goal of the workspace; `undefined` until the first read lands. */
  openGoals: Goal[] | undefined
  /** Lifetime aggregates for the strip. */
  analytics: GoalAnalytics
  analyticsLoading: boolean
  selectedGoalId: string | null
  onSelect: (goalId: string) => void
  /** A goal was deleted from a row; drop it from the selection. */
  onDeleted: (goalId: string) => void
  onOpenCompleted: () => void
  onOpenAnalytics: () => void
}

export function GoalOverviewSection({
  openGoals,
  analytics,
  analyticsLoading,
  selectedGoalId,
  onSelect,
  onDeleted,
  onOpenCompleted,
  onOpenAnalytics,
}: GoalOverviewSectionProps) {
  const t = useTranslations("goal")
  const { view } = useGoalConsoleView()
  const { prefs } = useGoalConsolePrefs()
  const now = useNow({ updateInterval: 30_000 }).getTime()
  const loading = openGoals === undefined

  const [query, setQuery] = useState("")
  const [scope, setScope] = useState<OpenGoalScope>("all")
  const [sort, setSort] = useState<GoalSortKey>(() => prefs.openGoalsSort)
  const [dir, setDir] = useState<SortDir>(() => prefs.openGoalsDir)

  const { awaiting, running } = useMemo(() => splitOpenGoals(openGoals ?? []), [openGoals])
  const counts = useMemo(() => countOpenGoalScopes(running), [running])
  const visible = useMemo(
    () => filterOpenGoals(running, { scope, query, sort, dir }),
    [running, scope, query, sort, dir]
  )
  const context = useGoalRowContext(openGoals, { judgeNotes: true })

  // ↑/↓ walk the selection through what is drawn, awaiting goals first.
  const order = useMemo(() => [...awaiting, ...visible].map((goal) => goal.id), [awaiting, visible])
  const listRef = useRef<HTMLDivElement>(null)
  const onListKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
      const target = event.target as HTMLElement
      const current = target.closest<HTMLElement>("[data-goal-select]")?.dataset.goalSelect
      if (!current) return
      const index = order.indexOf(current)
      const next = order[index + (event.key === "ArrowDown" ? 1 : -1)]
      if (!next) return
      event.preventDefault()
      onSelect(next)
      listRef.current
        ?.querySelector<HTMLElement>(`[data-goal-select="${CSS.escape(next)}"]`)
        ?.focus()
    },
    [order, onSelect]
  )

  const renderGoal = (goal: Goal) => {
    const shared = {
      goal,
      session: context.sessionFor(goal),
      agentName: context.agentNameFor(goal),
      judgeNote: context.judgeNoteFor(goal),
      selected: goal.id === selectedGoalId,
      onSelect,
      onDeleted,
      now,
    }
    return view === "grid" ? (
      <GoalGridTile key={goal.id} {...shared} />
    ) : (
      <GoalListRow key={goal.id} {...shared} />
    )
  }

  /**
   * The list is one surface with hairline rows; the grid is tiles on the page
   * ground, each its own surface (`GoalGridTile`) — never tiles in a frame.
   */
  const renderList = (goals: Goal[], label: string, testId?: string) =>
    view === "grid" ? (
      <ul
        className="grid gap-3 @lg/goal-list:grid-cols-2 @4xl/goal-list:grid-cols-3"
        aria-label={label}
        data-view={view}
        data-testid={testId}
      >
        {goals.map(renderGoal)}
      </ul>
    ) : (
      <Surface layer="raised" radius="panel" className="overflow-hidden border">
        <ul aria-label={label} data-view={view} data-testid={testId}>
          {goals.map(renderGoal)}
        </ul>
      </Surface>
    )

  const noOpenGoals = !loading && awaiting.length === 0 && running.length === 0

  return (
    <div
      className="@container/console-pane space-y-6"
      data-testid="goal-overview-section"
      ref={listRef}
      onKeyDown={onListKeyDown}
    >
      <GoalSummaryStrip
        analytics={analytics}
        loading={analyticsLoading}
        onOpenCompleted={onOpenCompleted}
        onOpenAnalytics={onOpenAnalytics}
      />

      {awaiting.length > 0 ? (
        <section aria-labelledby="goal-needs-you-heading" data-testid="goal-needs-you">
          <SectionHeading id="goal-needs-you-heading" count={awaiting.length} tone="attention">
            {t("console.needsYou")}
          </SectionHeading>
          <p className="mb-2 text-xs text-muted-foreground">{t("console.needsYouHint")}</p>
          <div className="@container/goal-list">
            {renderList(awaiting, t("console.needsYou"), "goal-needs-you-list")}
          </div>
        </section>
      ) : null}

      <section aria-labelledby="goal-open-heading">
        <div className="mb-2 flex items-center justify-between gap-2">
          <SectionHeading id="goal-open-heading" count={loading ? undefined : running.length}>
            {t("console.openGoalsHeading")}
          </SectionHeading>
          {!loading && running.length > 0 ? <GoalConsoleViewToggle /> : null}
        </div>

        {loading ? (
          <OverviewSkeleton />
        ) : noOpenGoals ? (
          <Empty
            className="rounded-panel border border-dashed"
            data-testid="goal-console-active-empty"
          >
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <TargetIcon className="size-5" aria-hidden />
              </EmptyMedia>
              <EmptyTitle>{t("console.emptyTitle")}</EmptyTitle>
              <EmptyDescription>{t("console.activeEmpty")}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <GoalQuickCreateDialog
                triggerTestId="goal-console-empty-create"
                triggerVariant="outline"
              />
            </EmptyContent>
          </Empty>
        ) : running.length === 0 ? (
          // Everything open is waiting on a verdict, listed above.
          <p className="text-sm text-muted-foreground" data-testid="goal-console-only-awaiting">
            {t("console.onlyAwaiting")}
          </p>
        ) : (
          <>
            <div
              className="mb-3 flex flex-wrap items-center gap-2"
              data-testid="goal-console-open-toolbar"
            >
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
                  data-testid="goal-console-open-search"
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
              <ToggleGroup
                type="single"
                size="sm"
                variant="outline"
                value={scope}
                onValueChange={(value) => {
                  if (isOpenGoalScope(value)) setScope(value)
                }}
                aria-label={t("history.filterStatus")}
                data-testid="goal-console-open-scope"
              >
                {OPEN_GOAL_SCOPES.map((id) => (
                  <ToggleGroupItem
                    key={id}
                    value={id}
                    className="gap-1.5 px-2.5 text-xs"
                    data-testid={`goal-console-scope-${id}`}
                  >
                    {t(`console.scopes.${id}`)}
                    <span className="tabular-nums text-muted-foreground">{counts[id]}</span>
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <div className="flex items-center gap-1">
                <Select value={sort} onValueChange={(value) => setSort(value as GoalSortKey)}>
                  <SelectTrigger
                    size="sm"
                    className="w-32"
                    aria-label={t("history.sortBy")}
                    data-testid="goal-console-open-sort"
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
                  data-testid="goal-console-open-dir"
                >
                  {dir === "asc" ? (
                    <ArrowUpIcon className="size-4" aria-hidden />
                  ) : (
                    <ArrowDownIcon className="size-4" aria-hidden />
                  )}
                </Button>
              </div>
            </div>

            {visible.length === 0 ? (
              <div
                className="flex flex-wrap items-center gap-2 py-6 text-sm text-muted-foreground"
                data-testid="goal-console-open-no-results"
              >
                <span>{t("history.noResults")}</span>
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0"
                  onClick={() => {
                    setQuery("")
                    setScope("all")
                  }}
                >
                  {t("console.clearFilters")}
                </Button>
              </div>
            ) : (
              <div className="@container/goal-list">
                {renderList(visible, t("console.openGoalsHeading"), "goal-console-open-list")}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  )
}

function SectionHeading({
  id,
  count,
  tone = "neutral",
  children,
}: {
  id: string
  count?: number
  tone?: "neutral" | "attention"
  children: React.ReactNode
}) {
  return (
    <h2 id={id} className="mb-1 flex items-center gap-2 text-sm font-semibold">
      {children}
      {count !== undefined ? (
        <span
          className={cn(
            "rounded-pill px-1.5 text-[11px] font-medium tabular-nums",
            tone === "attention" ? "bg-warning/15 text-warning" : "bg-muted text-muted-foreground"
          )}
        >
          {count}
        </span>
      ) : null}
    </h2>
  )
}

/** List-shaped placeholder while the first read is in flight. */
function OverviewSkeleton() {
  return (
    <div
      className="overflow-hidden rounded-panel border"
      aria-busy
      data-testid="goal-console-overview-skeleton"
    >
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className="space-y-2 border-b px-4 py-3 last:border-b-0">
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-14 rounded-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
          <Skeleton className="h-3 w-1/3" />
        </div>
      ))}
    </div>
  )
}

GoalOverviewSection.displayName = "GoalOverviewSection"
