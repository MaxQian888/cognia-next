"use client"

import { GoalConsole } from "@/components/goal/console/goal-console"

/**
 * Dedicated full-page Goals console route (ADR-0019 Phase 3). Reached from the
 * guild-rail "Goals" entry. The console owns its own chrome; this page just
 * hosts it full-height (mirrors `/performance`).
 */
export default function GoalsPage() {
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
      <GoalConsole />
    </div>
  )
}
