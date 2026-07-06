"use client"

/**
 * Overview section of the Goals console (ADR-0019) — the live-operations
 * dashboard: the two-cluster stat row plus the searchable / sortable open-goals
 * list. Extracted from `goal-console.tsx` so the console shell stays a thin
 * header + segmented-tab frame.
 *
 * Adaptive by *container* width (`@container/goal-console`), not the viewport,
 * so the grids reflow correctly whether the route is full-width or embedded in
 * a narrow pane. A Skeleton grid covers the `useLiveQuery` undefined→loaded
 * frame so the empty state never flashes before data arrives.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { motion, AnimatePresence } from "motion/react"
import { ArrowDownIcon, ArrowUpIcon, SearchIcon, TargetIcon } from "lucide-react"

import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Card } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { computeGoalAnalytics } from "@/lib/goal/analytics"
import { filterAndSortGoals, type GoalSortKey, type SortDir } from "@/lib/goal/history-filter"
import type { Goal, GoalStatus } from "@/types/goal"
import {
  STAGGER_CHILD,
  STAGGER_CONTAINER,
  mobileTransition,
  useReducedMotionTransition,
  useReducedMotionVariants,
} from "@/lib/ui/motion"
import { ActiveGoalCard } from "@/components/goal/views/active-goal-card"
import { GoalConsoleViewToggle } from "@/components/goal/goal-console-view-toggle"
import { GoalQuickCreateDialog } from "@/components/goal/goal-quick-create-dialog"
import { GoalStatRow } from "@/components/goal/console/goal-stat-row"
import { useGoalConsoleView } from "@/hooks/goal/use-goal-console-view"
import { useGoalConsolePrefs } from "@/hooks/goal/use-goal-console-prefs"
import type { GoalConsoleTab } from "@/lib/goal/console-prefs"

/** Sentinel for "any open status" in the toolbar's status filter. */
const ALL_OPEN = "__all__"
/** Only active/paused goals ever appear in the open-goals section. */
const OPEN_STATUSES: readonly GoalStatus[] = ["active", "paused"]

export interface GoalOverviewSectionProps {
  /** All goals (already resolved; `[]` while loading). */
  goals: Goal[]
  /** `true` until the first Dexie snapshot arrives. */
  loading: boolean
  /** Switch the console's top section (used by the metric stat cards). */
  onSwitchSection: (tab: GoalConsoleTab) => void
}

export function GoalOverviewSection({ goals, loading, onSwitchSection }: GoalOverviewSectionProps) {
  const t = useTranslations("goal")
  const { view } = useGoalConsoleView()
  const { prefs } = useGoalConsolePrefs()

  const analytics = useMemo(() => computeGoalAnalytics(goals), [goals])
  const openGoals = useMemo(
    () => goals.filter((g) => g.status === "active" || g.status === "paused"),
    [goals]
  )

  // Open-goals toolbar state (sort seeds from the persisted prefs).
  const [query, setQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState<string>(ALL_OPEN)
  const [sort, setSort] = useState<GoalSortKey>(() => prefs.openGoalsSort)
  const [dir, setDir] = useState<SortDir>(() => prefs.openGoalsDir)

  const filteredOpen = useMemo(
    () =>
      filterAndSortGoals(openGoals, {
        query,
        statuses: statusFilter === ALL_OPEN ? [...OPEN_STATUSES] : [statusFilter as GoalStatus],
        sort,
        dir,
      }),
    [openGoals, query, statusFilter, sort, dir]
  )

  const containerVariants = useReducedMotionVariants(STAGGER_CONTAINER)
  const childVariants = useReducedMotionVariants(STAGGER_CHILD)
  const switchTransition = useReducedMotionTransition(mobileTransition("fast"))

  /** Toggle a status shortcut: click the active card again to clear the scope. */
  const scopeStatus = (status: GoalStatus) =>
    setStatusFilter((prev) => (prev === status ? ALL_OPEN : status))

  return (
    <div className="@container/goal-console space-y-8">
      <GoalStatRow
        analytics={analytics}
        statusFilter={statusFilter}
        onScope={scopeStatus}
        onSwitchSection={onSwitchSection}
      />

      <section>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("console.openGoalsHeading")}
          </h2>
          {!loading && openGoals.length > 0 && <GoalConsoleViewToggle />}
        </div>

        {loading ? (
          <OverviewSkeleton />
        ) : openGoals.length === 0 ? (
          <Empty
            className="rounded-xl border border-dashed bg-muted/20"
            data-testid="goal-console-active-empty"
          >
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <TargetIcon className="size-5" aria-hidden />
              </EmptyMedia>
              <EmptyTitle>{t("console.openGoalsHeading")}</EmptyTitle>
              <EmptyDescription>{t("console.activeEmpty")}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <GoalQuickCreateDialog />
            </EmptyContent>
          </Empty>
        ) : (
          <>
            <div
              className="mb-3 flex flex-wrap items-center gap-2"
              data-testid="goal-console-open-toolbar"
            >
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
                  data-testid="goal-console-open-search"
                />
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger
                  className="w-32"
                  aria-label={t("history.filterStatus")}
                  data-testid="goal-console-open-status"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_OPEN}>{t("history.all")}</SelectItem>
                  {OPEN_STATUSES.map((s) => (
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
                  data-testid="goal-console-open-sort"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["created", "turns", "tokens"] as GoalSortKey[]).map((k) => (
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
                data-testid="goal-console-open-dir"
              >
                {dir === "asc" ? (
                  <ArrowUpIcon className="size-4" aria-hidden />
                ) : (
                  <ArrowDownIcon className="size-4" aria-hidden />
                )}
              </Button>
            </div>

            {filteredOpen.length === 0 ? (
              <p
                className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground"
                data-testid="goal-console-open-no-results"
              >
                {t("history.noResults")}
              </p>
            ) : (
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={view}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 6 }}
                  transition={switchTransition}
                >
                  <motion.div
                    className={
                      view === "grid"
                        ? "grid gap-3 @lg/goal-console:grid-cols-2 @4xl/goal-console:grid-cols-3"
                        : "flex flex-col gap-2"
                    }
                    variants={containerVariants}
                    initial="initial"
                    animate="animate"
                    data-testid="goal-console-open-list"
                  >
                    {filteredOpen.map((g) => (
                      <motion.div key={g.id} variants={childVariants} layout>
                        <ActiveGoalCard goal={g} variant={view === "list" ? "compact" : "card"} />
                      </motion.div>
                    ))}
                  </motion.div>
                </motion.div>
              </AnimatePresence>
            )}
          </>
        )}
      </section>
    </div>
  )
}

/** Card-grid placeholder mirroring the open-goals grid while data loads. */
function OverviewSkeleton() {
  return (
    <div
      className="grid gap-3 @lg/goal-console:grid-cols-2 @4xl/goal-console:grid-cols-3"
      aria-busy
      data-testid="goal-console-overview-skeleton"
    >
      {Array.from({ length: 3 }, (_, i) => (
        <Card key={i} className="space-y-3 p-4 pl-5">
          <div className="flex items-center justify-between">
            <Skeleton className="h-5 w-16 rounded-full" />
            <Skeleton className="h-3 w-12" />
          </div>
          <Skeleton className="h-4 w-4/5" />
          <div className="space-y-2">
            <Skeleton className="h-1.5 w-full rounded-full" />
            <Skeleton className="h-1.5 w-full rounded-full" />
          </div>
          <div className="flex justify-end gap-1 pt-1">
            <Skeleton className="size-8 rounded-md" />
            <Skeleton className="size-8 rounded-md" />
          </div>
        </Card>
      ))}
    </div>
  )
}

GoalOverviewSection.displayName = "GoalOverviewSection"
