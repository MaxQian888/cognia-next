"use client"

import { nanoid } from "nanoid"
import { useCallback, useMemo } from "react"

import { getModelDisplayName, getProviderDisplayName } from "@/lib/ai/icons"
import {
  buildConversationFilterOptions,
  type ConversationFilterOptions,
  type NamedEntity,
} from "@/lib/chat/conversation-filter-options"
import {
  addConversationFilterPreset,
  countActiveConversationFilters,
  findMatchingConversationFilterPreset,
  removeConversationFilterPreset,
  renameConversationFilterPreset,
  resolveConversationFilterPresets,
  resolveConversationFilters,
  resolveConversationSortBy,
  setConversationActivityFilter,
  setConversationFilterList,
  setConversationKindFilter,
  toggleConversationFilter,
  toggleConversationFilterValue,
  type ConversationFilterContext,
  type ConversationFilterListKey,
  type ConversationFilterToggle,
} from "@/lib/chat/conversation-filters"
import { trackConversationFiltered } from "@/lib/telemetry/conversation-list-events"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { useUIStore } from "@/stores/ui"
import type {
  Character,
  ChatSession,
  ConversationActivityFilter,
  ConversationFilterPreset,
  ConversationFilters,
  ConversationKindFilter,
  ConversationSidebarSettings,
  ConversationSortBy,
} from "@cognia/agent-config-types"

/**
 * One controller for the conversation-list filter UI, shared by the desktop
 * sidebar and the mobile channel list.
 *
 * It owns the three stores the filter menu touches — active filters (UI store,
 * layout state), sort + saved presets (settings blob, follows the profile), and
 * the option candidates derived from the sessions on screen — and hands both
 * surfaces the same prop bags for `ConversationFilterMenu` /
 * `ConversationFilterChips`. Without it each surface re-derives eleven
 * callbacks and the two would drift (they already had, in the small).
 */

export interface UseConversationFilterControllerInput {
  /** Conversations in the current view (after the archive split, before filters). */
  sessions: readonly ChatSession[]
  workspaces?: readonly NamedEntity[]
  folders?: readonly NamedEntity[]
  /** Bound characters — also the model / provider fallback source. */
  characters?: readonly Character[]
  teams?: readonly NamedEntity[]
  /** Current sidebar settings (the surface already subscribes to them). */
  sidebarSettings: ConversationSidebarSettings | null | undefined
  /**
   * Persist a sidebar-settings patch. The desktop sidebar routes this through
   * its optimistic save queue; the mobile list writes straight to the store.
   */
  saveSidebarSettings: (patch: Partial<ConversationSidebarSettings>) => void | Promise<void>
}

export interface ConversationFilterActions {
  toggle: (key: ConversationFilterToggle, enabled: boolean) => void
  setKind: (kind: ConversationKindFilter) => void
  setList: (key: ConversationFilterListKey, values: readonly string[]) => void
  toggleValue: (key: ConversationFilterListKey, value: string, enabled: boolean) => void
  setActivity: (activity: ConversationActivityFilter) => void
  reset: () => void
  setSortBy: (sortBy: ConversationSortBy) => void
  applyPreset: (id: string) => void
  /** Save the *active* filters under `name`; returns the new preset id (or null when refused). */
  savePreset: (name: string) => string | null
  renamePreset: (id: string, name: string) => void
  deletePreset: (id: string) => void
}

export interface ConversationFilterController {
  filters: Required<ConversationFilters>
  activeFilters: number
  sortBy: ConversationSortBy
  options: ConversationFilterOptions
  presets: ConversationFilterPreset[]
  /** The saved preset equal to the active filters, if any. */
  activePreset: ConversationFilterPreset | undefined
  /** Model / provider fallback chain — feed to `useConversationListModel`. */
  filterContext: Pick<ConversationFilterContext, "modelOf" | "providerOf">
  actions: ConversationFilterActions
}

const EMPTY_SESSIONS: readonly ChatSession[] = []
/** Built-in defaults when neither the profile nor the character names one — mirrors the row metadata. */
const FALLBACK_MODEL = "claude-sonnet-4-5"
const FALLBACK_PROVIDER = "anthropic"

export function useConversationFilterController({
  sessions,
  workspaces,
  folders,
  characters,
  teams,
  sidebarSettings,
  saveSidebarSettings,
}: UseConversationFilterControllerInput): ConversationFilterController {
  const persistedFilters = useUIStore((s) => s.conversationFilters)
  const setConversationFilters = useUIStore((s) => s.setConversationFilters)
  const resetConversationFilters = useUIStore((s) => s.resetConversationFilters)
  const defaultModel = useSettingsStore((s) => s.settings?.defaultModel)
  const defaultProvider = useSettingsStore((s) => s.settings?.defaultProvider)

  const filters = useMemo(() => resolveConversationFilters(persistedFilters), [persistedFilters])
  const activeFilters = countActiveConversationFilters(filters)
  const sortBy = resolveConversationSortBy(sidebarSettings)
  const presets = useMemo(
    () => resolveConversationFilterPresets(sidebarSettings?.filterPresets),
    [sidebarSettings?.filterPresets]
  )
  const activePreset = useMemo(
    () => findMatchingConversationFilterPreset(presets, filters),
    [presets, filters]
  )

  const characterById = useMemo(() => {
    const map = new Map<string, Character>()
    for (const c of characters ?? []) map.set(c.id, c)
    return map
  }, [characters])

  // Same fallback chain the row metadata renders (`session → character →
  // profile default → built-in default`, see `components/desktop/channel-list.tsx`
  // `metadataBySessionId`), so a "Claude" filter matches exactly the rows
  // whose metadata line says Claude.
  const filterContext = useMemo<Pick<ConversationFilterContext, "modelOf" | "providerOf">>(
    () => ({
      modelOf: (session) => {
        const character = session.characterId ? characterById.get(session.characterId) : undefined
        return session.model ?? character?.model ?? defaultModel ?? FALLBACK_MODEL
      },
      providerOf: (session) => {
        const character = session.characterId ? characterById.get(session.characterId) : undefined
        return (
          session.providerOverride ?? character?.providerId ?? defaultProvider ?? FALLBACK_PROVIDER
        )
      },
    }),
    [characterById, defaultModel, defaultProvider]
  )

  const agents = useMemo<NamedEntity[]>(
    () => (characters ?? []).map((c) => ({ id: c.id, name: c.name })),
    [characters]
  )

  const options = useMemo(
    () =>
      buildConversationFilterOptions({
        sessions: sessions ?? EMPTY_SESSIONS,
        workspaces,
        folders,
        agents,
        teams,
        context: filterContext,
        labelModel: getModelDisplayName,
        labelProvider: getProviderDisplayName,
        selected: {
          workspaceIds: filters.workspaceIds,
          folderIds: filters.folderIds,
          agentIds: filters.agentIds,
          teamIds: filters.teamIds,
          models: filters.models,
          providers: filters.providers,
        },
      }),
    [sessions, workspaces, folders, agents, teams, filterContext, filters]
  )

  const savePresets = useCallback(
    (next: ConversationFilterPreset[]) => void saveSidebarSettings({ filterPresets: next }),
    [saveSidebarSettings]
  )

  // Every filter mutation funnels through here so the behavior event names the
  // control that changed (`facet`) and how many filters now narrow the list —
  // never a value the user typed or picked.
  const applyFilters = useCallback(
    (facet: string, next: ConversationFilters) => {
      setConversationFilters(next)
      void trackConversationFiltered(facet, countActiveConversationFilters(next))
    },
    [setConversationFilters]
  )
  const actions = useMemo<ConversationFilterActions>(
    () => ({
      toggle: (key, enabled) => applyFilters(key, toggleConversationFilter(filters, key, enabled)),
      setKind: (kind) => applyFilters("kind", setConversationKindFilter(filters, kind)),
      setList: (key, values) => applyFilters(key, setConversationFilterList(filters, key, values)),
      toggleValue: (key, value, enabled) =>
        applyFilters(key, toggleConversationFilterValue(filters, key, value, enabled)),
      setActivity: (activity) =>
        applyFilters("activity", setConversationActivityFilter(filters, activity)),
      reset: () => {
        resetConversationFilters()
        void trackConversationFiltered("reset", 0)
      },
      setSortBy: (next) => void saveSidebarSettings({ sortBy: next }),
      applyPreset: (id) => {
        const preset = presets.find((p) => p.id === id)
        if (preset) applyFilters("preset", preset.filters)
      },
      savePreset: (name) => {
        const id = nanoid()
        const next = addConversationFilterPreset(presets, {
          id,
          name,
          filters,
          createdAt: Date.now(),
        })
        if (next.length === presets.length) return null
        savePresets(next)
        return id
      },
      renamePreset: (id, name) => savePresets(renameConversationFilterPreset(presets, id, name)),
      deletePreset: (id) => savePresets(removeConversationFilterPreset(presets, id)),
    }),
    [filters, presets, applyFilters, resetConversationFilters, saveSidebarSettings, savePresets]
  )

  return { filters, activeFilters, sortBy, options, presets, activePreset, filterContext, actions }
}
