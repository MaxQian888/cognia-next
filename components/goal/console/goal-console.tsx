"use client"

/**
 * Unified Goals console — "Mission Control" dashboard (ADR-0019 Phase 3).
 * The standalone `/goals` route hosts it full-height. A stat-chip header,
 * a responsive grid of rich open-goal cards, then a segmented tab bar for
 * History / Templates / Defaults / Tracker. Composes the same components the
 * chat surface and Settings use, so there's one IA across every entry point.
 */

import { useTranslations } from "next-intl"
import { TargetIcon } from "lucide-react"
import { useLiveQuery } from "dexie-react-hooks"
import { cn } from "@/lib/utils"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { listAllGoals } from "@/lib/db/goals"
import { ActiveGoalCard } from "@/components/goal/views/active-goal-card"
import { GoalsHistoryTable } from "@/components/settings/goals/history-table"
import { GoalTemplatesManager } from "@/components/settings/goals/goal-templates-manager"
import { GoalDefaultsForm } from "@/components/settings/goals/goal-defaults-form"
import { GoalTrackerConfig } from "@/components/settings/goals/goal-tracker-config"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"

export function GoalConsole() {
  const t = useTranslations("goal")
  const allGoals = useLiveQuery(() => listAllGoals(500), [])
  const goals = allGoals ?? []
  const openGoals = goals.filter((g) => g.status === "active" || g.status === "paused")
  const activeCount = goals.filter((g) => g.status === "active").length
  const pausedCount = goals.filter((g) => g.status === "paused").length
  const doneCount = goals.filter((g) => g.status === "completed").length

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
        <div className="flex items-center gap-2" data-testid="goal-console-stats">
          <Stat dot="bg-success" label={t("console.statActive", { count: activeCount })} />
          <Stat dot="bg-warning" label={t("console.statPaused", { count: pausedCount })} />
          <Stat dot="bg-muted-foreground" label={t("console.statDone", { count: doneCount })} />
          {/* Plugin toolbar contributions for the Goals console. */}
          <PluginExtensionSlot
            point="goal.toolbar"
            className="flex items-center gap-2 empty:hidden"
          />
        </div>
      </header>

      <ScrollArea className="min-h-0 min-w-0 flex-1">
        <div className="mx-auto min-w-0 max-w-4xl space-y-8 p-6">
          <section>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("console.openGoalsHeading")}
            </h2>
            {openGoals.length === 0 ? (
              <div
                className="flex flex-col items-center gap-2 rounded-xl border border-dashed bg-muted/20 px-6 py-10 text-center"
                data-testid="goal-console-active-empty"
              >
                <TargetIcon className="size-6 text-muted-foreground/60" aria-hidden />
                <p className="max-w-xs text-sm text-muted-foreground">{t("console.activeEmpty")}</p>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2" data-testid="goal-console-open-list">
                {openGoals.map((g) => (
                  <ActiveGoalCard key={g.id} goal={g} />
                ))}
              </div>
            )}
          </section>

          <Tabs defaultValue="history">
            <TabsList>
              <TabsTrigger value="history" data-testid="goal-console-tab-history">
                {t("console.tabs.history")}
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

function Stat({ dot, label }: { dot: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs text-muted-foreground">
      <span className={cn("size-1.5 rounded-full", dot)} aria-hidden />
      {label}
    </span>
  )
}

GoalConsole.displayName = "GoalConsole"
