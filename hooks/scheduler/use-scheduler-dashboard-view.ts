"use client"

/**
 * Active view mode (overview / calendar / timeline) for the `/scheduler`
 * dashboard.
 *
 * Persisted on `AppSettings.schedulerDashboardView` via
 * `useSettingsStore.save()` — the same cross-device settings singleton that
 * backs `useDiscoverView`. Unlike a localStorage toggle, the chosen view
 * follows the user across devices.
 */

import { useCallback } from "react"

import { useSettingsStore } from "@/stores/settings/settings-store"

export type SchedulerDashboardView = "overview" | "calendar" | "timeline"

export const DEFAULT_SCHEDULER_DASHBOARD_VIEW: SchedulerDashboardView = "overview"

const VALID_VIEWS: readonly SchedulerDashboardView[] = ["overview", "calendar", "timeline"]

/** Type guard for the toggle's `onValueChange` (which yields `string`). */
export function isSchedulerDashboardView(value: string): value is SchedulerDashboardView {
  return (VALID_VIEWS as readonly string[]).includes(value)
}

export interface UseSchedulerDashboardView {
  /** The stored view mode, or the default if unset. */
  view: SchedulerDashboardView
  setView: (mode: SchedulerDashboardView) => Promise<void>
}

export function useSchedulerDashboardView(): UseSchedulerDashboardView {
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const view = settings?.schedulerDashboardView ?? DEFAULT_SCHEDULER_DASHBOARD_VIEW

  const setView = useCallback(
    async (mode: SchedulerDashboardView) => {
      await save({ schedulerDashboardView: mode })
    },
    [save]
  )

  return { view, setView }
}
