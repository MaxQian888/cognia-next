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

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { ResponsiveDetailSheet } from "@/components/shared/responsive-detail-sheet"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { resolveGoalAcceptance } from "@/lib/goal/acceptance"
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
  const [resolvingAcceptance, setResolvingAcceptance] = useState(false)

  const resolveAcceptance = async (accepted: boolean) => {
    if (resolvingAcceptance) return
    setResolvingAcceptance(true)
    try {
      await resolveGoalAcceptance(goal.id, accepted)
    } finally {
      setResolvingAcceptance(false)
    }
  }

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
      {goal.status === "paused" && goal.awaitingAcceptance === true && (
        // Acceptance gate banner: the judge declared the objective met, but
        // `requireAcceptance` parked the goal for a human verdict.
        <div
          data-testid="goal-acceptance-banner"
          className="mx-4 mt-3 space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3"
        >
          <p className="text-sm font-medium">{t("acceptance.title")}</p>
          <p className="text-xs text-muted-foreground">{t("acceptance.description")}</p>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={resolvingAcceptance}
              onClick={() => void resolveAcceptance(true)}
              data-testid="goal-acceptance-accept"
            >
              {t("acceptance.accept")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={resolvingAcceptance}
              onClick={() => void resolveAcceptance(false)}
              data-testid="goal-acceptance-request-changes"
            >
              {t("acceptance.requestChanges")}
            </Button>
          </div>
        </div>
      )}
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
