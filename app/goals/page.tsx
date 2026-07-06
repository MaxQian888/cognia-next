"use client"

import { Suspense } from "react"
import { useSearchParams } from "next/navigation"

import { GoalConsole } from "@/components/goal/console/goal-console"
import { GoalsMobileBody } from "@/components/mobile/goals/goals-mobile-body"
import { usePlatform } from "@/hooks/use-platform"
import { isGoalConsoleTab } from "@/lib/goal/console-prefs"

/**
 * Dedicated full-page Goals console route (ADR-0019 Phase 3). Reached from the
 * guild-rail "Goals" entry. The console owns its own chrome; this page just
 * hosts it full-height (mirrors `/performance`).
 *
 * On the mobile companion the desktop console has no usable layout, so the
 * phone renders a read-mostly `GoalsMobileBody` instead (reached via /me).
 *
 * Static-export-safe deep link: the initial bottom tab rides in `?tab=` (read
 * via `useSearchParams` inside a `<Suspense>` boundary), used by the Settings
 * launcher and plugin bridges to land users on a specific management tab.
 */
function GoalsRoute() {
  const params = useSearchParams()
  const tabParam = params.get("tab")
  return <GoalConsole initialTab={isGoalConsoleTab(tabParam) ? tabParam : undefined} />
}

export default function GoalsPage() {
  const platform = usePlatform()
  if (platform === "mobile") return <GoalsMobileBody />
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
      <Suspense fallback={null}>
        <GoalsRoute />
      </Suspense>
    </div>
  )
}
