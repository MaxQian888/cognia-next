"use client"

/**
 * Collapse state for the settings sidebar's section groups (AI / Extensions /
 * Interface / Data / Observability / System).
 *
 * Persisted on `AppSettings.settingsSidebarCollapsedGroups` via
 * `useSettingsStore.save()` — the same cross-device settings singleton that
 * backs `useMcpPanelView` / `useGoalConsoleView`, so the collapse state
 * follows the user across devices (no localStorage, no Dexie migration).
 * Absent / empty = all groups expanded; unknown ids are dropped on read.
 */

import { useCallback, useMemo } from "react"

import { useSettingsStore } from "@/stores/settings/settings-store"
import { SETTINGS_GROUP_ORDER, type SettingsGroup } from "@/components/settings/settings-nav-config"

const VALID_GROUPS = new Set<string>(SETTINGS_GROUP_ORDER)

function isSettingsGroup(value: unknown): value is SettingsGroup {
  return typeof value === "string" && VALID_GROUPS.has(value)
}

export interface UseSettingsSidebarCollapse {
  /** Sanitized list of currently collapsed group ids. */
  collapsedGroups: SettingsGroup[]
  isGroupCollapsed: (group: SettingsGroup) => boolean
  /** Idempotent — persists only when the state actually changes. */
  setGroupCollapsed: (group: SettingsGroup, collapsed: boolean) => Promise<void>
  toggleGroup: (group: SettingsGroup) => Promise<void>
  expandGroup: (group: SettingsGroup) => Promise<void>
}

export function useSettingsSidebarCollapse(): UseSettingsSidebarCollapse {
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const collapsedGroups = useMemo(
    () => (settings?.settingsSidebarCollapsedGroups ?? []).filter(isSettingsGroup),
    [settings?.settingsSidebarCollapsedGroups]
  )

  const collapsedSet = useMemo(() => new Set(collapsedGroups), [collapsedGroups])

  const isGroupCollapsed = useCallback(
    (group: SettingsGroup) => collapsedSet.has(group),
    [collapsedSet]
  )

  const setGroupCollapsed = useCallback(
    async (group: SettingsGroup, collapsed: boolean) => {
      if (collapsedSet.has(group) === collapsed) return
      const next = collapsed
        ? [...collapsedGroups, group]
        : collapsedGroups.filter((g) => g !== group)
      await save({ settingsSidebarCollapsedGroups: next })
    },
    [collapsedSet, collapsedGroups, save]
  )

  const toggleGroup = useCallback(
    (group: SettingsGroup) => setGroupCollapsed(group, !collapsedSet.has(group)),
    [setGroupCollapsed, collapsedSet]
  )

  const expandGroup = useCallback(
    (group: SettingsGroup) => setGroupCollapsed(group, false),
    [setGroupCollapsed]
  )

  return { collapsedGroups, isGroupCollapsed, setGroupCollapsed, toggleGroup, expandGroup }
}
