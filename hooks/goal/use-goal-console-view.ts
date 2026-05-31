"use client"

/**
 * Active view mode (grid / list) for the `/goals` console open-goals section.
 *
 * Persisted on `AppSettings.goalConsoleView` via `useSettingsStore.save()` —
 * the same cross-device settings singleton that backs
 * `useSchedulerDashboardView` / `useDiscoverView`, so the chosen layout follows
 * the user across devices (no localStorage, no Dexie migration).
 */

import { useCallback } from "react"

import { useSettingsStore } from "@/stores/settings/settings-store"

export type GoalConsoleView = "grid" | "list"

export const DEFAULT_GOAL_CONSOLE_VIEW: GoalConsoleView = "grid"

const VALID_VIEWS: readonly GoalConsoleView[] = ["grid", "list"]

/** Type guard for the toggle's `onValueChange` (which yields `string`). */
export function isGoalConsoleView(value: string): value is GoalConsoleView {
  return (VALID_VIEWS as readonly string[]).includes(value)
}

export interface UseGoalConsoleView {
  view: GoalConsoleView
  setView: (mode: GoalConsoleView) => Promise<void>
}

export function useGoalConsoleView(): UseGoalConsoleView {
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const view = settings?.goalConsoleView ?? DEFAULT_GOAL_CONSOLE_VIEW

  const setView = useCallback(
    async (mode: GoalConsoleView) => {
      await save({ goalConsoleView: mode })
    },
    [save]
  )

  return { view, setView }
}
