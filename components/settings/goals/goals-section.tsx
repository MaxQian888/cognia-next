"use client"

/**
 * Settings → Goals tab — three sub-tabs:
 *   - History — every persisted goal across all sessions.
 *   - Tracker — defaults for the built-in "Goal Tracker" character.
 *   - Defaults — global default GoalConfig applied to new goals.
 */

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { TargetIcon } from "lucide-react"
import { GoalsHistoryTable } from "./history-table"
import { GoalTrackerConfig } from "./goal-tracker-config"
import { GoalDefaultsForm } from "./goal-defaults-form"

export function GoalsSection() {
  return (
    <div className="space-y-4" data-testid="goals-section">
      <header className="flex items-center gap-2">
        <TargetIcon className="size-5 text-primary" aria-hidden />
        <div>
          <h2 className="text-lg font-semibold">Goals</h2>
          <p className="text-sm text-muted-foreground">
            Persistent objectives the agent works toward automatically (ADR-0013).
          </p>
        </div>
      </header>
      <Tabs defaultValue="history">
        <TabsList>
          <TabsTrigger value="history" data-testid="goals-section-history">
            History
          </TabsTrigger>
          <TabsTrigger value="tracker" data-testid="goals-section-tracker">
            Tracker
          </TabsTrigger>
          <TabsTrigger value="defaults" data-testid="goals-section-defaults">
            Defaults
          </TabsTrigger>
        </TabsList>
        <TabsContent value="history" className="mt-4">
          <GoalsHistoryTable />
        </TabsContent>
        <TabsContent value="tracker" className="mt-4">
          <GoalTrackerConfig />
        </TabsContent>
        <TabsContent value="defaults" className="mt-4">
          <GoalDefaultsForm />
        </TabsContent>
      </Tabs>
    </div>
  )
}
