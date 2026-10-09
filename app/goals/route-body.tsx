"use client"

import { Suspense, useCallback } from "react"
import { useRouter, useSearchParams } from "next/navigation"

import { GoalConsole, type GoalConsolePlace } from "@/components/goal/console/goal-console"
import { GoalsMobileBody } from "@/components/mobile/goals/goals-mobile-body"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"
import { goalConsoleHref, resolveGoalConsoleLocation } from "@/lib/goal/console-prefs"

/**
 * Dedicated full-page Goals console route (ADR-0019 Phase 3). Reached from the
 * guild-rail "Goals" entry. The console owns its own chrome (it renders inside
 * `FeaturePageShell`, which also owns the wallpaper marker).
 *
 * On a narrow viewport the desktop console has no usable layout, so the
 * phone-shaped `GoalsMobileBody` renders instead (reached via /me). Keyed on
 * width rather than on the Capacitor runtime, so a 375px browser gets it too.
 *
 * Static-export-safe addressing: `?tab=` (+ `?section=` on Configure) and
 * `?goal=` are read via `useSearchParams` inside a `<Suspense>` boundary and
 * written back with the router, so a deep link opens one tab, panel or goal
 * and Back undoes a tab switch. Selecting a goal replaces rather than pushes:
 * walking a list with ↑/↓ must not fill the history.
 */
function GoalsRoute() {
  const params = useSearchParams()
  const router = useRouter()
  const location = resolveGoalConsoleLocation(params.get("tab"), params.get("section"))
  const selectedGoalId = params.get("goal")

  const navigate = useCallback(
    (place: GoalConsolePlace, options?: { replace?: boolean }) => {
      const href = goalConsoleHref(place)
      if (options?.replace) router.replace(href, { scroll: false })
      else router.push(href, { scroll: false })
    },
    [router]
  )

  return <GoalConsole location={location} selectedGoalId={selectedGoalId} onNavigate={navigate} />
}

export default function GoalsPage() {
  const compact = useCompactLayout()
  if (compact) return <GoalsMobileBody />
  return (
    <Suspense fallback={null}>
      <GoalsRoute />
    </Suspense>
  )
}
