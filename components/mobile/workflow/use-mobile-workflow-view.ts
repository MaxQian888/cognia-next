"use client"

/**
 * Row density for the mobile workflow library list. Persisted on
 * `settings.mobileWorkflowView` via `useSettingsStore.save()` — the same
 * pattern as the other mobile customizations (no Dexie migration).
 */

import { useCallback } from "react"

import { useSettingsStore } from "@/stores/settings/settings-store"

export type MobileWorkflowView = "compact" | "comfortable"

export function useMobileWorkflowView() {
  const view = useSettingsStore(
    (s): MobileWorkflowView => s.settings?.mobileWorkflowView ?? "comfortable"
  )
  const save = useSettingsStore((s) => s.save)

  const setView = useCallback(
    (next: MobileWorkflowView) => save({ mobileWorkflowView: next }),
    [save]
  )
  const toggle = useCallback(
    () => setView(view === "compact" ? "comfortable" : "compact"),
    [setView, view]
  )

  return { view, setView, toggle }
}
