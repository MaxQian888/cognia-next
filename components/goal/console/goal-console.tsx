"use client"

/**
 * Unified Goals console — "Mission Control" dashboard (ADR-0019 Phase 3).
 *
 * The standalone `/goals` route hosts it full-height. A header with a quick-
 * create action, a responsive StatCard row (live counters + averages), a
 * grid/list-toggleable section of rich open-goal cards, then a segmented tab
 * bar for History / Analytics / Templates / Defaults / Tracker. Composes the
 * same components the chat surface and Settings use, so there's one IA across
 * every entry point.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { motion, AnimatePresence } from "motion/react"
import {
  ActivityIcon,
  CheckCircle2Icon,
  CoinsIcon,
  PauseIcon,
  RepeatIcon,
  TargetIcon,
} from "lucide-react"
import { useLiveQuery } from "dexie-react-hooks"

import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
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
import { useGoalConsoleView } from "@/hooks/goal/use-goal-console-view"
import { GoalsHistoryTable } from "@/components/settings/goals/history-table"
import { GoalTemplatesManager } from "@/components/settings/goals/goal-templates-manager"
import { GoalDefaultsForm } from "@/components/settings/goals/goal-defaults-form"
import { GoalTrackerConfig } from "@/components/settings/goals/goal-tracker-config"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"

function kfmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(Math.round(n))
}

export function GoalConsole() {
  const t = useTranslations("goal")
  const { view } = useGoalConsoleView()
  const allGoals = useLiveQuery(() => listAllGoals(500), [])
  const goals = useMemo(() => allGoals ?? [], [allGoals])
  const openGoals = goals.filter((g) => g.status === "active" || g.status === "paused")
  const analytics = useMemo(() => computeGoalAnalytics(goals), [goals])

  const containerVariants = useReducedMotionVariants(STAGGER_CONTAINER)
  const childVariants = useReducedMotionVariants(STAGGER_CHILD)
  const switchTransition = useReducedMotionTransition(mobileTransition("fast"))

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
          <GoalQuickCreateDialog />
        </div>
      </header>

      <ScrollArea className="min-h-0 min-w-0 flex-1">
        <div className="mx-auto min-w-0 max-w-7xl space-y-8 p-6">
          {/* Stat row */}
          <motion.div
            className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
            variants={containerVariants}
            initial="initial"
            animate="animate"
            data-testid="goal-console-stats"
          >
            <motion.div variants={childVariants}>
              <StatCard
                label={t("console.stats.active")}
                value={analytics.active}
                icon={<ActivityIcon className="h-5 w-5 text-green-500" aria-hidden />}
                valueClassName="text-green-500"
                accentGradient="from-green-500 to-emerald-400"
                iconBgClassName="bg-green-500/10"
                testid="goal-stat-active"
              />
            </motion.div>
            <motion.div variants={childVariants}>
              <StatCard
                label={t("console.stats.paused")}
                value={analytics.paused}
                icon={<PauseIcon className="h-5 w-5 text-yellow-500" aria-hidden />}
                valueClassName="text-yellow-500"
                accentGradient="from-yellow-500 to-amber-400"
                iconBgClassName="bg-yellow-500/10"
                testid="goal-stat-paused"
              />
            </motion.div>
            <motion.div variants={childVariants}>
              <StatCard
                label={t("console.stats.done")}
                value={analytics.completed}
                icon={<CheckCircle2Icon className="h-5 w-5 text-muted-foreground" aria-hidden />}
                valueClassName="text-foreground"
                accentGradient="from-border to-border/50"
                iconBgClassName="bg-muted/50"
                testid="goal-stat-done"
              />
            </motion.div>
            <motion.div variants={childVariants}>
              <StatCard
                label={t("console.stats.avgTurns")}
                value={analytics.avgTurns.toFixed(1)}
                icon={<RepeatIcon className="h-5 w-5 text-blue-500" aria-hidden />}
                valueClassName="text-blue-500"
                accentGradient="from-blue-500 to-sky-400"
                iconBgClassName="bg-blue-500/10"
                testid="goal-stat-avg-turns"
              />
            </motion.div>
            <motion.div variants={childVariants}>
              <StatCard
                label={t("console.stats.tokenSpend")}
                value={kfmt(analytics.totalTokens)}
                icon={<CoinsIcon className="h-5 w-5 text-violet-500" aria-hidden />}
                valueClassName="text-violet-500"
                accentGradient="from-violet-500 to-purple-400"
                iconBgClassName="bg-violet-500/10"
                testid="goal-stat-token-spend"
              />
            </motion.div>
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
                    {openGoals.map((g) => (
                      <motion.div key={g.id} variants={childVariants} layout>
                        <ActiveGoalCard goal={g} variant={view === "list" ? "compact" : "card"} />
                      </motion.div>
                    ))}
                  </motion.div>
                </motion.div>
              </AnimatePresence>
            )}
          </section>

          <Tabs defaultValue="history">
            <TabsList>
              <TabsTrigger value="history" data-testid="goal-console-tab-history">
                {t("console.tabs.history")}
              </TabsTrigger>
              <TabsTrigger value="analytics" data-testid="goal-console-tab-analytics">
                {t("console.tabs.analytics")}
              </TabsTrigger>
              <TabsTrigger value="templates" data-testid="goal-console-tab-templates">
                {t("console.tabs.templates")}
              </TabsTrigger>
              <TabsTrigger value="defaults" data-testid="goal-console-tab-defaults">
                {t("console.tabs.defaults")}
              </TabsTrigger>
              <TabsTrigger value="tracker" data-testid="goal-console-tab-tracker">
                {t("console.tabs.tracker")}
              </TabsTrigger>
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

GoalConsole.displayName = "GoalConsole"
