"use client"

/**
 * Detail surface for a `/goal` (ADR-0013). Four tabs:
 *   - Overview   — status badge, objective, progress bars, last judge reason
 *   - Subgoals   — Phase 2 placeholder
 *   - Activity   — reverse-chrono event log from `chatGoalEvents`
 *   - Settings   — per-goal config knobs (maxTurns / maxTokens / etc.)
 *
 * Responsive (ADR-0019 Phase 3): the Sheet-desktop / Drawer-mobile switch
 * lives in the shared `ResponsiveDetailSheet`; the tab strip scrolls
 * horizontally on narrow screens (44px touch targets) and snaps back to a
 * 4-column grid from `md` up.
 */

import { useTranslations } from "next-intl"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ResponsiveDetailSheet } from "@/components/shared/responsive-detail-sheet"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import type { Goal } from "@/types/goal"
import { GoalOverviewTab } from "./tabs/overview-tab"
import { GoalSubgoalsTab } from "./tabs/subgoals-tab"
import { GoalActivityTab } from "./tabs/activity-tab"
import { GoalSettingsTab } from "./tabs/settings-tab"

interface Props {
  goal: Goal
  open: boolean
  onOpenChange: (next: boolean) => void
}

const TAB_TRIGGER_CLASS = "min-h-11 shrink-0 md:min-h-0"

export function GoalDetailSheet({ goal, open, onOpenChange }: Props) {
  const t = useTranslations("goal")
  const title = t("detailSheet.title", { status: t(`status.${goal.status}`) })

  // Plugin contribution row — e.g. "Copy summary", "Export". Conversation-
  // scoped context so contributions don't re-derive the goal identity.
  const pluginActions = (
    <PluginExtensionSlot
      point="goal.detail.actions"
      context={{ goalId: goal.id, status: goal.status }}
      className="flex flex-wrap items-center gap-2 empty:hidden"
    />
  )

  return (
    <ResponsiveDetailSheet
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={goal.safeObjective}
      headerExtra={pluginActions}
    >
      <Tabs defaultValue="overview" className="mt-4 flex-1 overflow-y-auto px-4 pb-4">
        <TabsList className="flex w-full justify-start overflow-x-auto md:grid md:grid-cols-4">
          <TabsTrigger
            value="overview"
            className={TAB_TRIGGER_CLASS}
            data-testid="goal-tab-overview"
          >
            {t("detailSheet.tabs.overview")}
          </TabsTrigger>
          <TabsTrigger
            value="subgoals"
            className={TAB_TRIGGER_CLASS}
            data-testid="goal-tab-subgoals"
          >
            {t("detailSheet.tabs.subgoals")}
          </TabsTrigger>
          <TabsTrigger
            value="activity"
            className={TAB_TRIGGER_CLASS}
            data-testid="goal-tab-activity"
          >
            {t("detailSheet.tabs.activity")}
          </TabsTrigger>
          <TabsTrigger
            value="settings"
            className={TAB_TRIGGER_CLASS}
            data-testid="goal-tab-settings"
          >
            {t("detailSheet.tabs.settings")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="mt-4">
          <GoalOverviewTab goal={goal} />
        </TabsContent>
        <TabsContent value="subgoals" className="mt-4">
          <GoalSubgoalsTab goal={goal} />
        </TabsContent>
        <TabsContent value="activity" className="mt-4">
          <GoalActivityTab goal={goal} />
        </TabsContent>
        <TabsContent value="settings" className="mt-4">
          <GoalSettingsTab goal={goal} />
        </TabsContent>
      </Tabs>
    </ResponsiveDetailSheet>
  )
}
