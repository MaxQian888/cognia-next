"use client"

/**
 * Read + persist the `/goals` console preferences (default landing tab,
 * open-goals default sort). Backed by `AppSettings.goalConsolePrefs` through
 * the settings singleton — the same cross-device store that powers
 * `useGoalConsoleView`, so the choices follow the user across devices with no
 * localStorage and no Dexie migration.
 *
 * `setPrefs` takes a partial patch and merges it over the current resolved
 * prefs before persisting, so callers can flip one field without clobbering
 * the others.
 */

import { useCallback } from "react"

import { useSettingsStore } from "@/stores/settings/settings-store"
import { resolveGoalConsolePrefs, type GoalConsolePrefs } from "@/lib/goal/console-prefs"

export interface UseGoalConsolePrefs {
  prefs: GoalConsolePrefs
  setPrefs: (patch: Partial<GoalConsolePrefs>) => Promise<void>
}

export function useGoalConsolePrefs(): UseGoalConsolePrefs {
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const prefs = resolveGoalConsolePrefs(settings?.goalConsolePrefs)

  const setPrefs = useCallback(
    async (patch: Partial<GoalConsolePrefs>) => {
      const next = { ...prefs, ...patch }
      await save({ goalConsolePrefs: next })
    },
    [prefs, save]
  )

  return { prefs, setPrefs }
}
