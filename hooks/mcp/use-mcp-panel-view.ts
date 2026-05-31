"use client"

/**
 * View preferences for the MCP servers management panel — the card-grid vs.
 * dense-list toggle, the section grouping mode, and the favorites set.
 *
 * Persisted on `AppSettings.mcpPanel` via `useSettingsStore.save()` — the same
 * cross-device settings singleton that backs `useGoalConsoleView` /
 * `useSchedulerDashboardView`, so the chosen layout follows the user across
 * devices (no localStorage, no Dexie migration). Favorites mirror the
 * `discoverFavorites` / `pinnedWorkflowIds` JSON-array pattern.
 */

import { useCallback, useMemo } from "react"

import { useSettingsStore } from "@/stores/settings/settings-store"

export type McpPanelView = "grid" | "list"
export type McpPanelGroupBy = "none" | "transport" | "status"

export interface McpPanelPrefs {
  view: McpPanelView
  groupBy: McpPanelGroupBy
  favorites: string[]
}

export const DEFAULT_MCP_PANEL_PREFS: McpPanelPrefs = {
  view: "grid",
  groupBy: "none",
  favorites: [],
}

const VALID_VIEWS: readonly McpPanelView[] = ["grid", "list"]
const VALID_GROUP_BY: readonly McpPanelGroupBy[] = ["none", "transport", "status"]

/** Type guard for the view ToggleGroup's `onValueChange` (yields `string`). */
export function isMcpPanelView(value: string): value is McpPanelView {
  return (VALID_VIEWS as readonly string[]).includes(value)
}

/** Type guard for the group-by Select's `onValueChange` (yields `string`). */
export function isMcpPanelGroupBy(value: string): value is McpPanelGroupBy {
  return (VALID_GROUP_BY as readonly string[]).includes(value)
}

export interface UseMcpPanelView {
  view: McpPanelView
  groupBy: McpPanelGroupBy
  favorites: string[]
  /** Stable membership lookup for the favorites set. */
  isFavorite: (id: string) => boolean
  setView: (view: McpPanelView) => Promise<void>
  setGroupBy: (groupBy: McpPanelGroupBy) => Promise<void>
  toggleFavorite: (id: string) => Promise<void>
}

export function useMcpPanelView(): UseMcpPanelView {
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const prefs: McpPanelPrefs = useMemo(
    () => ({ ...DEFAULT_MCP_PANEL_PREFS, ...(settings?.mcpPanel ?? {}) }),
    [settings?.mcpPanel]
  )

  const favoriteSet = useMemo(() => new Set(prefs.favorites), [prefs.favorites])

  const persist = useCallback(
    async (patch: Partial<McpPanelPrefs>) => {
      await save({ mcpPanel: { ...prefs, ...patch } })
    },
    [save, prefs]
  )

  const setView = useCallback((view: McpPanelView) => persist({ view }), [persist])
  const setGroupBy = useCallback((groupBy: McpPanelGroupBy) => persist({ groupBy }), [persist])

  const toggleFavorite = useCallback(
    async (id: string) => {
      const next = favoriteSet.has(id)
        ? prefs.favorites.filter((f) => f !== id)
        : [...prefs.favorites, id]
      await persist({ favorites: next })
    },
    [favoriteSet, prefs.favorites, persist]
  )

  const isFavorite = useCallback((id: string) => favoriteSet.has(id), [favoriteSet])

  return {
    view: prefs.view,
    groupBy: prefs.groupBy,
    favorites: prefs.favorites,
    isFavorite,
    setView,
    setGroupBy,
    toggleFavorite,
  }
}
