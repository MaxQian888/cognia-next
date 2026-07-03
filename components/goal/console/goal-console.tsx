"use client"

/**
 * Unified Goals console — "Mission Control" dashboard (ADR-0019 Phase 3).
 *
 * The standalone `/goals` route hosts it full-height. A header with a quick-
 * create action + a preferences gear, a responsive StatCard row (live counters
 * + averages, each card an actionable shortcut), an open-goals section with a
 * search / status / sort toolbar over grid/list-toggleable rich cards, then a
 * deep-linkable segmented tab bar for History / Analytics / Templates /
 * Defaults / Tracker. Composes the same components the chat surface and
 * Settings use, so there's one IA across every entry point.
 *
 * Interactions:
 *  - Stat cards are shortcuts: Active / Paused scope the open-goals list;
 *    Completed jumps to History; Avg turns / Token spend jump to Analytics.
 *  - The bottom tab bar is controlled and honours a `?tab=` deep link
 *    (`initialTab`) plus the persisted `goalConsolePrefs.defaultTab`.
 *  - The open-goals toolbar delegates to the pure `filterAndSortGoals`.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { motion, AnimatePresence } from "motion/react"
import {
  ActivityIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CheckCircle2Icon,
  CoinsIcon,
  PauseIcon,
  RepeatIcon,
  SearchIcon,
  TargetIcon,
} from "lucide-react"
import { useLiveQuery } from "dexie-react-hooks"

import { cn } from "@/lib/utils"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
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
import { StatCard } from "@/components/scheduler/stat-card"
import { listAllGoals } from "@/lib/db/goals"
import { computeGoalAnalytics } from "@/lib/goal/analytics"
import { filterAndSortGoals, type GoalSortKey, type SortDir } from "@/lib/goal/history-filter"
import type { GoalStatus } from "@/types/goal"
import {
  STAGGER_CHILD,
  STAGGER_CONTAINER,
  mobileTransition,
  useReducedMotionTransition,
  useReducedMotionVariants,
} from "@/lib/ui/motion"
import { ActiveGoalCard } from "@/components/goal/views/active-goal-card"
import { GoalAnalyticsPanel } from "@/components/goal/analytics/goal-analytics-panel"
import { GoalConsoleViewToggle } from "@/components/goal/goal-console-view-toggle"
import { GoalQuickCreateDialog } from "@/components/goal/goal-quick-create-dialog"
import { GoalConsolePrefsPopover } from "@/components/goal/console/goal-console-prefs-popover"
import { useGoalConsoleView } from "@/hooks/goal/use-goal-console-view"
import { useGoalConsolePrefs } from "@/hooks/goal/use-goal-console-prefs"
import { GOAL_CONSOLE_TABS, type GoalConsoleTab } from "@/lib/goal/console-prefs"
import { GoalsHistoryTable } from "@/components/settings/goals/history-table"
import { GoalTemplatesManager } from "@/components/settings/goals/goal-templates-manager"
import { GoalDefaultsForm } from "@/components/settings/goals/goal-defaults-form"
import { GoalTrackerConfig } from "@/components/settings/goals/goal-tracker-config"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"

function kfmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(Math.round(n))
}

/** Sentinel for "any open status" in the toolbar's status filter. */
const ALL_OPEN = "__all__"
/** Only active/paused goals ever appear in the open-goals section. */
const OPEN_STATUSES: readonly GoalStatus[] = ["active", "paused"]

export interface GoalConsoleProps {
  /** Initial bottom tab (deep link `?tab=` / bridge nav). Falls back to prefs. */
  initialTab?: GoalConsoleTab
}

export function GoalConsole({ initialTab }: GoalConsoleProps = {}) {
  const t = useTranslations("goal")
  const { view } = useGoalConsoleView()
  const { prefs } = useGoalConsolePrefs()
  const allGoals = useLiveQuery(() => listAllGoals(500), [])
  const goals = useMemo(() => allGoals ?? [], [allGoals])
  const openGoals = useMemo(
    () => goals.filter((g) => g.status === "active" || g.status === "paused"),
    [goals]
  )
  const analytics = useMemo(() => computeGoalAnalytics(goals), [goals])

  // ── Controlled bottom tab (deep link wins → prefs default → history) ───────
  const [tab, setTab] = useState<GoalConsoleTab>(() => initialTab ?? prefs.defaultTab)
  const [prevInitialTab, setPrevInitialTab] = useState(initialTab)
  if (initialTab !== prevInitialTab) {
    // Follow later deep links (navigating /goals?tab=x while already mounted).
    // Adjusted during render per React's "derive from prop change" pattern.
    setPrevInitialTab(initialTab)
    if (initialTab) setTab(initialTab)
  }

  // ── Open-goals toolbar state (sort seeds from the persisted prefs) ─────────
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
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col" data-testid="goal-console">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-4">
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <TargetIcon className="size-5" aria-hidden />
          </span>
          <div>
            <h1 className="text-lg font-semibold leading-tight">{t("console.title")}</h1>
            <p className="text-xs text-muted-foreground">{t("console.subtitle")}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Plugin toolbar contributions for the Goals console. */}
          <PluginExtensionSlot
            point="goal.toolbar"
            className="flex items-center gap-2 empty:hidden"
          />
          <GoalConsolePrefsPopover />
          <GoalQuickCreateDialog />
        </div>
      </header>

      <ScrollArea className="min-h-0 min-w-0 flex-1">
        <div className="mx-auto min-w-0 max-w-7xl space-y-8 p-6">
          {/* Stat row — each card is an actionable shortcut. */}
          <motion.div
            className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
            variants={containerVariants}
            initial="initial"
            animate="animate"
            data-testid="goal-console-stats"
          >
            <StatShortcut
              variants={childVariants}
              actionLabel={t("console.stats.filterActive")}
              active={statusFilter === "active"}
              onActivate={() => scopeStatus("active")}
              testid="goal-stat-active"
            >
              <StatCard
                label={t("console.stats.active")}
                value={analytics.active}
                icon={<ActivityIcon className="h-5 w-5 text-green-500" aria-hidden />}
                valueClassName="text-green-500"
                accentGradient="from-green-500 to-emerald-400"
                iconBgClassName="bg-green-500/10"
              />
            </StatShortcut>
            <StatShortcut
              variants={childVariants}
              actionLabel={t("console.stats.filterPaused")}
              active={statusFilter === "paused"}
              onActivate={() => scopeStatus("paused")}
              testid="goal-stat-paused"
            >
              <StatCard
                label={t("console.stats.paused")}
                value={analytics.paused}
                icon={<PauseIcon className="h-5 w-5 text-yellow-500" aria-hidden />}
                valueClassName="text-yellow-500"
                accentGradient="from-yellow-500 to-amber-400"
                iconBgClassName="bg-yellow-500/10"
              />
            </StatShortcut>
            <StatShortcut
              variants={childVariants}
              actionLabel={t("console.stats.openHistory")}
              onActivate={() => setTab("history")}
              testid="goal-stat-done"
            >
              <StatCard
                label={t("console.stats.done")}
                value={analytics.completed}
                icon={<CheckCircle2Icon className="h-5 w-5 text-muted-foreground" aria-hidden />}
                valueClassName="text-foreground"
                accentGradient="from-border to-border/50"
                iconBgClassName="bg-muted/50"
              />
            </StatShortcut>
            <StatShortcut
              variants={childVariants}
              actionLabel={t("console.stats.openAnalytics")}
              onActivate={() => setTab("analytics")}
              testid="goal-stat-avg-turns"
            >
              <StatCard
                label={t("console.stats.avgTurns")}
                value={analytics.avgTurns.toFixed(1)}
                icon={<RepeatIcon className="h-5 w-5 text-blue-500" aria-hidden />}
                valueClassName="text-blue-500"
                accentGradient="from-blue-500 to-sky-400"
                iconBgClassName="bg-blue-500/10"
              />
            </StatShortcut>
            <StatShortcut
              variants={childVariants}
              actionLabel={t("console.stats.openAnalytics")}
              onActivate={() => setTab("analytics")}
              testid="goal-stat-token-spend"
            >
              <StatCard
                label={t("console.stats.tokenSpend")}
                value={kfmt(analytics.totalTokens)}
                icon={<CoinsIcon className="h-5 w-5 text-violet-500" aria-hidden />}
                valueClassName="text-violet-500"
                accentGradient="from-violet-500 to-purple-400"
                iconBgClassName="bg-violet-500/10"
              />
            </StatShortcut>
          </motion.div>

          {/* Open goals */}
          <section>
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t("console.openGoalsHeading")}
              </h2>
              {openGoals.length > 0 && <GoalConsoleViewToggle />}
            </div>

            {openGoals.length === 0 ? (
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
                            ? "grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
                            : "flex flex-col gap-2"
                        }
                        variants={containerVariants}
                        initial="initial"
                        animate="animate"
                        data-testid="goal-console-open-list"
                      >
                        {filteredOpen.map((g) => (
                          <motion.div key={g.id} variants={childVariants} layout>
                            <ActiveGoalCard
                              goal={g}
                              variant={view === "list" ? "compact" : "card"}
                            />
                          </motion.div>
                        ))}
                      </motion.div>
                    </motion.div>
                  </AnimatePresence>
                )}
              </>
            )}
          </section>

          <Tabs value={tab} onValueChange={(v) => setTab(v as GoalConsoleTab)}>
            <TabsList>
              {GOAL_CONSOLE_TABS.map((id) => (
                <TabsTrigger key={id} value={id} data-testid={`goal-console-tab-${id}`}>
                  {t(`console.tabs.${id}`)}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="history" className="mt-4">
              <GoalsHistoryTable />
            </TabsContent>
            <TabsContent value="analytics" className="mt-4">
              <GoalAnalyticsPanel goals={goals} />
            </TabsContent>
            <TabsContent value="templates" className="mt-4">
              <GoalTemplatesManager />
            </TabsContent>
            <TabsContent value="defaults" className="mt-4">
              <GoalDefaultsForm />
            </TabsContent>
            <TabsContent value="tracker" className="mt-4">
              <GoalTrackerConfig />
            </TabsContent>
          </Tabs>
        </div>
      </ScrollArea>
    </div>
  )
}

/**
 * Wraps a StatCard in button semantics so the whole card is a keyboard-
 * reachable shortcut. `active` paints a ring when the card's filter is the
 * one currently scoping the open-goals list.
 */
function StatShortcut({
  actionLabel,
  active,
  onActivate,
  testid,
  variants,
  children,
}: {
  actionLabel: string
  active?: boolean
  onActivate: () => void
  testid: string
  variants: ReturnType<typeof useReducedMotionVariants>
  children: React.ReactNode
}) {
  return (
    <motion.div
      variants={variants}
      role="button"
      tabIndex={0}
      aria-label={actionLabel}
      aria-pressed={active}
      data-testid={testid}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onActivate()
        }
      }}
      className={cn(
        "cursor-pointer rounded-xl outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring",
        active && "ring-2 ring-primary"
      )}
    >
      {children}
    </motion.div>
  )
}

GoalConsole.displayName = "GoalConsole"
