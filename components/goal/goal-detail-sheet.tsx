"use client"

/**
 * Detail surface for a `/goal` (ADR-0013). Four tabs:
 *   - Overview   — status badge, objective, progress bars, last judge reason
 *   - Subgoals   — Phase 2 placeholder
 *   - Activity   — reverse-chrono event log from `chatGoalEvents`
 *   - Settings   — per-goal config knobs (maxTurns / maxTokens / etc.)
 *
 * Responsive (ADR-0019 Phase 3): a right-side Sheet on desktop, a bottom
 * Drawer on small screens. Both render the identical tab content.
 */

import { useTranslations } from "next-intl"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useIsMobile } from "@/hooks/ui/use-mobile"
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

export function GoalDetailSheet({ goal, open, onOpenChange }: Props) {
  const t = useTranslations("goal")
  const isMobile = useIsMobile()
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

  const tabs = (
    <Tabs defaultValue="overview" className="mt-4 flex-1 overflow-y-auto px-4 pb-4">
      <TabsList className="grid w-full grid-cols-4">
        <TabsTrigger value="overview" data-testid="goal-tab-overview">
          {t("detailSheet.tabs.overview")}
        </TabsTrigger>
        <TabsTrigger value="subgoals" data-testid="goal-tab-subgoals">
          {t("detailSheet.tabs.subgoals")}
        </TabsTrigger>
        <TabsTrigger value="activity" data-testid="goal-tab-activity">
          {t("detailSheet.tabs.activity")}
        </TabsTrigger>
        <TabsTrigger value="settings" data-testid="goal-tab-settings">
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
  )

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="max-h-[85vh]">
          <DrawerHeader>
            <DrawerTitle>{title}</DrawerTitle>
            <DrawerDescription className="line-clamp-3 text-xs">
              {goal.safeObjective}
            </DrawerDescription>
            {pluginActions}
          </DrawerHeader>
          {tabs}
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full max-w-md sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription className="line-clamp-3 text-xs">{goal.safeObjective}</SheetDescription>
          {pluginActions}
        </SheetHeader>
        {tabs}
      </SheetContent>
    </Sheet>
  )
}
