"use client"

/**
 * Right-side detail sheet for the active `/goal` (ADR-0013).
 *
 * Four tabs:
 *   - Overview   — status badge, objective, progress bars, last judge reason
 *   - Subgoals   — Phase 2 placeholder
 *   - Activity   — reverse-chrono event log from `chatGoalEvents`
 *   - Settings   — per-goal config knobs (maxTurns / maxTokens / etc.)
 */

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
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
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full max-w-md sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Goal · {goal.status}</SheetTitle>
          <SheetDescription className="line-clamp-3 text-xs">{goal.safeObjective}</SheetDescription>
        </SheetHeader>
        <Tabs defaultValue="overview" className="mt-4 flex-1 overflow-y-auto px-4 pb-4">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="overview" data-testid="goal-tab-overview">
              Overview
            </TabsTrigger>
            <TabsTrigger value="subgoals" data-testid="goal-tab-subgoals">
              Subgoals
            </TabsTrigger>
            <TabsTrigger value="activity" data-testid="goal-tab-activity">
              Activity
            </TabsTrigger>
            <TabsTrigger value="settings" data-testid="goal-tab-settings">
              Settings
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
      </SheetContent>
    </Sheet>
  )
}
