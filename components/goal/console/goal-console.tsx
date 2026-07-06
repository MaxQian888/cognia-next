"use client"

/**
 * Unified Goals console — "Mission Control" dashboard (ADR-0019 Phase 3).
 *
 * The standalone `/goals` route hosts it full-height. Mirrors the `/performance`
 * dashboard chrome: a header (quick-create + preferences gear), a top-level
 * segmented tab bar, then a single scroll region holding one section at a time.
 *
 * Sections (all first-class, no longer buried under the goals list):
 *  - **Overview** — the live-operations dashboard: the two-cluster stat row +
 *    the searchable/sortable open-goals list (`GoalOverviewSection`).
 *  - **History / Analytics / Templates / Defaults / Tracker** — the management
 *    surfaces, each re-parenting the same component Settings uses.
 *
 * Interactions:
 *  - The Overview metric stat cards deep-link into a section (Completed →
 *    History; the averages → Analytics) via `setTab`; the Active/Paused cards
 *    scope the open-goals list in place.
 *  - The tab bar is controlled and honours a `?tab=` deep link (`initialTab`)
 *    plus the persisted `goalConsolePrefs.defaultTab` (defaults to Overview).
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { TargetIcon } from "lucide-react"
import { useLiveQuery } from "dexie-react-hooks"

import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { listAllGoals } from "@/lib/db/goals"
import { GoalAnalyticsPanel } from "@/components/goal/analytics/goal-analytics-panel"
import { GoalQuickCreateDialog } from "@/components/goal/goal-quick-create-dialog"
import { GoalConsolePrefsPopover } from "@/components/goal/console/goal-console-prefs-popover"
import { GoalOverviewSection } from "@/components/goal/console/goal-overview-section"
import { useGoalConsolePrefs } from "@/hooks/goal/use-goal-console-prefs"
import { GOAL_CONSOLE_TABS, type GoalConsoleTab } from "@/lib/goal/console-prefs"
import { GoalsHistoryTable } from "@/components/settings/goals/history-table"
import { GoalTemplatesManager } from "@/components/settings/goals/goal-templates-manager"
import { GoalDefaultsForm } from "@/components/settings/goals/goal-defaults-form"
import { GoalTrackerConfig } from "@/components/settings/goals/goal-tracker-config"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"

export interface GoalConsoleProps {
  /** Initial section (deep link `?tab=` / bridge nav). Falls back to prefs. */
  initialTab?: GoalConsoleTab
}

export function GoalConsole({ initialTab }: GoalConsoleProps) {
  const t = useTranslations("goal")
  const { prefs } = useGoalConsolePrefs()
  const allGoals = useLiveQuery(() => listAllGoals(500), [])
  const goals = useMemo(() => allGoals ?? [], [allGoals])

  // ── Controlled section (deep link wins → prefs default → overview) ─────────
  const [tab, setTab] = useState<GoalConsoleTab>(() => initialTab ?? prefs.defaultTab)
  const [prevInitialTab, setPrevInitialTab] = useState(initialTab)
  if (initialTab !== prevInitialTab) {
    // Follow later deep links (navigating /goals?tab=x while already mounted).
    // Adjusted during render per React's "derive from prop change" pattern.
    setPrevInitialTab(initialTab)
    if (initialTab) setTab(initialTab)
  }

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col" data-testid="goal-console">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-6 py-4">
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

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as GoalConsoleTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="mx-6 mt-4 w-fit">
          {GOAL_CONSOLE_TABS.map((id) => (
            <TabsTrigger key={id} value={id} data-testid={`goal-console-tab-${id}`}>
              {t(`console.tabs.${id}`)}
            </TabsTrigger>
          ))}
        </TabsList>

        <ScrollArea className="min-h-0 min-w-0 flex-1">
          <div className="p-6">
            <TabsContent value="overview" className="mt-0">
              <GoalOverviewSection
                goals={goals}
                loading={allGoals === undefined}
                onSwitchSection={setTab}
              />
            </TabsContent>
            <TabsContent value="history" className="mt-0">
              <GoalsHistoryTable />
            </TabsContent>
            <TabsContent value="analytics" className="mt-0">
              <GoalAnalyticsPanel goals={goals} />
            </TabsContent>
            <TabsContent value="templates" className="mt-0">
              <GoalTemplatesManager />
            </TabsContent>
            <TabsContent value="defaults" className="mt-0">
              <GoalDefaultsForm />
            </TabsContent>
            <TabsContent value="tracker" className="mt-0">
              <GoalTrackerConfig />
            </TabsContent>
          </div>
        </ScrollArea>
      </Tabs>
    </div>
  )
}

GoalConsole.displayName = "GoalConsole"
