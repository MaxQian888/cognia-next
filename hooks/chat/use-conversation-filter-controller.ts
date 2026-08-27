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
  DEFAULT_CONVERSATION_SORT_BY,
  countActiveConversationFilters,
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
import {
  DEFAULT_CONVERSATION_GROUP_BY,
  resolveConversationGroupBy,
} from "@/lib/chat/conversation-grouping"
import { resolveConversationSearchOptions } from "@/lib/chat/conversation-search-scope"
import {
  applyConversationView,
  captureConversationViewOverlay,
  conversationViewDrift,
  removeConversationView,
  renameConversationView,
  resolveConversationViews,
  setBuiltInViewHidden,
  suggestedConversationViewDimensions,
  toStoredConversationView,
  upsertConversationView,
  type ConversationViewDimension,
  type ConversationViewState,
  type ResolvedConversationView,
} from "@/lib/chat/conversation-views"
import { trackConversationFiltered } from "@/lib/telemetry/conversation-list-events"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { useUIStore } from "@/stores/ui"
import type {
  Character,
  ChatSession,
  ConversationActivityFilter,
  ConversationFilters,
  ConversationGroupBy,
  ConversationKindFilter,
  ConversationSearchOptions,
  ConversationSidebarSettings,
  ConversationSortBy,
  ConversationView,
} from "@cognia/agent-config-types"

/**
 * One controller for the conversation-list filter UI, shared by the desktop
 * sidebar and the mobile channel list.
 *
 * It owns the state the filter menu touches, which is split across two
 * persistence faces on purpose:
 *
 * - **UI store** (per device): the active quick filters and which saved view is
 *   selected. Layout state — a phone and a desktop may sit in different views.
 * - **Settings blob** (follows the profile): sort, grouping, the search reach,
 *   and the saved *view definitions*.
 *
 * Applying a view therefore writes to both, which is exactly why that write
 * lives here rather than in each surface: doing it twice, slightly differently,
 * is how the two lists drifted before this controller existed.
 *
 * Both surfaces get the same prop bags for `ConversationFilterMenu` /
 * `ConversationFilterChips`.
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
  /**
   * True when the surface's own chrome already splits the list into direct vs
   * team conversations, so the `kind` facet has nothing left to decide.
   *
   * The desktop rail is that surface: its guild rows scope the list to Chats or
   * to one team on every grouping axis, which leaves `kind` a second, invisible
   * copy of a choice already on screen — and a stale `kind: "team"` sitting
   * inside Chats then matches nothing and empties the list with no control
   * anywhere to explain it. Set here, the facet is neither offered nor applied.
   *
   * Reading only: the stored value is left exactly as it is, because the mobile
   * list has no guild rows and `kind` is the only way to separate the two there.
   */
  scopeOwnsKind?: boolean
}

export interface ConversationFilterActions {
  toggle: (key: ConversationFilterToggle, enabled: boolean) => void
  setKind: (kind: ConversationKindFilter) => void
  setList: (key: ConversationFilterListKey, values: readonly string[]) => void
  toggleValue: (key: ConversationFilterListKey, value: string, enabled: boolean) => void
  setActivity: (activity: ConversationActivityFilter) => void
  reset: () => void
  setSortBy: (sortBy: ConversationSortBy) => void
  setGroupBy: (groupBy: ConversationGroupBy) => void
  setSearchOptions: (patch: Partial<ConversationSearchOptions>) => void
  /** Put the list into a saved view; unknown ids are ignored. */
  applyView: (id: string) => void
  /** Leave the current view without changing what is on screen. */
  clearView: () => void
  /** Put back every dimension the active view pins. */
  revertView: () => void
  /**
   * Save the current state under `name`, pinning `dimensions`. Returns the new
   * view id, or `null` when refused (blank name, or nothing worth pinning).
   */
  saveView: (name: string, dimensions: readonly ConversationViewDimension[]) => string | null
  /** Re-capture the active view's own dimensions from the current state. */
  updateView: (id: string) => void
  renameView: (id: string, name: string) => void
  /** Delete a custom view, or hide a built-in one (built-ins are code, not data). */
  removeView: (id: string) => void
  /** Put a hidden built-in view back in the menu. */
  restoreView: (id: string) => void
}

export interface ConversationFilterController {
  /**
   * The filters actually narrowing the list — the stored blob minus whatever
   * this surface's scope already owns (see `scopeOwnsKind`). Read this; write
   * through `actions`, which build off the stored blob instead.
   */
  filters: Required<ConversationFilters>
  activeFilters: number
  sortBy: ConversationSortBy
  groupBy: ConversationGroupBy
  /** The resolved search reach — feed to the list and the scope control. */
  search: ConversationViewState["search"]
  options: ConversationFilterOptions
  /** Every view the menu should offer: visible built-ins, then the saved ones. */
  views: ResolvedConversationView[]
  /** The view the list is sitting in, if it still exists. */
  activeView: ResolvedConversationView | undefined
  /**
   * Which of the active view's own dimensions no longer match. Empty while the
   * view is exactly in effect; non-empty is what the chip calls "modified".
   */
  activeViewDrift: ConversationViewDimension[]
  /** Built-in views the user has hidden — the menu offers to restore them. */
  hiddenViewIds: string[]
  /** Dimensions a fresh "save as view" dialog should tick. */
  suggestedViewDimensions: ConversationViewDimension[]
  /** Model / provider fallback chain — feed to `useConversationListModel`. */
  filterContext: Pick<ConversationFilterContext, "modelOf" | "providerOf">
  /** Echoes the input: the menu drops the `kind` group when the scope owns it. */
  scopeOwnsKind: boolean
  actions: ConversationFilterActions
}

const EMPTY_SESSIONS: readonly ChatSession[] = []
const EMPTY_DRIFT: ConversationViewDimension[] = []
const EMPTY_IDS: string[] = []
const EMPTY_VIEWS: ConversationView[] = []
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
  scopeOwnsKind = false,
}: UseConversationFilterControllerInput): ConversationFilterController {
  const persistedFilters = useUIStore((s) => s.conversationFilters)
  const setConversationFilters = useUIStore((s) => s.setConversationFilters)
  const resetConversationFilters = useUIStore((s) => s.resetConversationFilters)
  const defaultModel = useSettingsStore((s) => s.settings?.defaultModel)
  const defaultProvider = useSettingsStore((s) => s.settings?.defaultProvider)

  // Two readings of one blob, and which one a caller wants follows what it is
  // for. `storedFilters` is the persisted truth — every write merges into it,
  // and the saved views pin and compare against it — so a surface that cannot
  // show a facet still cannot quietly erase it for the surface that can.
  // `filters` is what this surface actually applies, which is the same object
  // unless its scope already owns a facet.
  const storedFilters = useMemo(
    () => resolveConversationFilters(persistedFilters),
    [persistedFilters]
  )
  const filters = useMemo(
    () =>
      scopeOwnsKind && storedFilters.kind !== "all"
        ? setConversationKindFilter(storedFilters, "all")
        : storedFilters,
    [storedFilters, scopeOwnsKind]
  )
  const activeFilters = countActiveConversationFilters(filters)
  const sortBy = resolveConversationSortBy(sidebarSettings)
  const groupBy = resolveConversationGroupBy(sidebarSettings)
  const search = useMemo(() => resolveConversationSearchOptions(sidebarSettings), [sidebarSettings])
  // The four dimensions a view can pin, resolved — one object so the drift
  // check, the "save as" capture and the suggestion all read the same state.
  // Stored, not applied: a view that pins `kind` must not read as "modified"
  // on the rail that ignores it, nor be rewritten without it by `updateView`.
  const viewState = useMemo<ConversationViewState>(
    () => ({ filters: storedFilters, sortBy, groupBy, search }),
    [storedFilters, sortBy, groupBy, search]
  )

  const views = useMemo(() => resolveConversationViews(sidebarSettings), [sidebarSettings])
  const hiddenViewIds = useMemo(() => {
    const raw = sidebarSettings?.hiddenViewIds
    return Array.isArray(raw) ? raw : EMPTY_IDS
  }, [sidebarSettings?.hiddenViewIds])
  const activeViewId = useUIStore((s) => s.activeConversationViewId)
  const setActiveViewId = useUIStore((s) => s.setActiveConversationViewId)
  // A view the user deleted on another device leaves a dangling id here; the
  // chip must then show nothing rather than a name it cannot resolve.
  const activeView = useMemo(
    () => (activeViewId ? views.find((view) => view.id === activeViewId) : undefined),
    [views, activeViewId]
  )
  const activeViewDrift = useMemo(
    () => (activeView ? conversationViewDrift(activeView, viewState) : EMPTY_DRIFT),
    [activeView, viewState]
  )
  const suggestedViewDimensions = useMemo(
    () =>
      suggestedConversationViewDimensions(viewState, {
        sortBy: DEFAULT_CONVERSATION_SORT_BY,
        groupBy: DEFAULT_CONVERSATION_GROUP_BY,
      }),
    [viewState]
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

  const saveViews = useCallback(
    (next: ConversationView[]) => void saveSidebarSettings({ views: next }),
    [saveSidebarSettings]
  )
  // The stored list, not the resolved one: built-ins and legacy presets are
  // read into `views` for display but must never be written back as rows.
  const storedViews = useMemo(() => {
    const raw = sidebarSettings?.views
    return Array.isArray(raw) ? raw : EMPTY_VIEWS
  }, [sidebarSettings?.views])

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
      toggle: (key, enabled) =>
        applyFilters(key, toggleConversationFilter(storedFilters, key, enabled)),
      setKind: (kind) => applyFilters("kind", setConversationKindFilter(storedFilters, kind)),
      setList: (key, values) =>
        applyFilters(key, setConversationFilterList(storedFilters, key, values)),
      toggleValue: (key, value, enabled) =>
        applyFilters(key, toggleConversationFilterValue(storedFilters, key, value, enabled)),
      setActivity: (activity) =>
        applyFilters("activity", setConversationActivityFilter(storedFilters, activity)),
      reset: () => {
        resetConversationFilters()
        void trackConversationFiltered("reset", 0)
      },
      setSortBy: (next) => void saveSidebarSettings({ sortBy: next }),
      setGroupBy: (next) => void saveSidebarSettings({ groupBy: next }),
      // The scope control writes one axis at a time; merge against the resolved
      // object so flipping one never drops the other two.
      setSearchOptions: (patch) => void saveSidebarSettings({ search: { ...search, ...patch } }),

      applyView: (id) => {
        const view = views.find((entry) => entry.id === id)
        if (!view) return
        const { filters: nextFilters, settings } = applyConversationView(view)
        // Only what the view pins moves. A view that says nothing about filters
        // leaves the ones on screen alone — clearing them would make every
        // sort-only view double as a filter reset.
        if (nextFilters) applyFilters("view", nextFilters)
        if (Object.keys(settings).length > 0) void saveSidebarSettings(settings)
        setActiveViewId(id)
      },
      clearView: () => setActiveViewId(null),
      revertView: () => {
        if (!activeView) return
        const { filters: nextFilters, settings } = applyConversationView(activeView)
        if (nextFilters) applyFilters("view", nextFilters)
        if (Object.keys(settings).length > 0) void saveSidebarSettings(settings)
      },

      saveView: (name, dimensions) => {
        const id = nanoid()
        const stored = toStoredConversationView({
          id,
          name,
          createdAt: Date.now(),
          overlay: captureConversationViewOverlay(viewState, dimensions),
        })
        if (!stored) return null
        saveViews(upsertConversationView(storedViews, stored))
        setActiveViewId(id)
        return id
      },
      updateView: (id) => {
        const view = views.find((entry) => entry.id === id)
        // Built-ins are code: "update" would have nowhere to write, and a
        // stored row under their id is refused anyway.
        if (!view || view.builtIn) return
        // Re-capture exactly the dimensions this view already claims, so
        // updating "unread first" does not quietly pin the grouping too.
        const dimensions = (
          ["filters", "sortBy", "groupBy", "search"] as ConversationViewDimension[]
        ).filter((dimension) => view.overlay[dimension] !== undefined)
        const stored = toStoredConversationView({
          id: view.id,
          name: view.name,
          createdAt: view.createdAt,
          overlay: captureConversationViewOverlay(viewState, dimensions),
        })
        if (!stored) return
        saveViews(upsertConversationView(storedViews, stored))
      },
      renameView: (id, name) => saveViews(renameConversationView(storedViews, id, name)),
      removeView: (id) => {
        const view = views.find((entry) => entry.id === id)
        if (view?.builtIn) {
          void saveSidebarSettings({
            hiddenViewIds: setBuiltInViewHidden(hiddenViewIds, id, true),
          })
        } else {
          saveViews(removeConversationView(storedViews, id))
        }
        // Whichever it was, the list is no longer in it.
        if (activeViewId === id) setActiveViewId(null)
      },
      restoreView: (id) =>
        void saveSidebarSettings({ hiddenViewIds: setBuiltInViewHidden(hiddenViewIds, id, false) }),
    }),
    [
      storedFilters,
      search,
      viewState,
      views,
      storedViews,
      hiddenViewIds,
      activeView,
      activeViewId,
      setActiveViewId,
      applyFilters,
      resetConversationFilters,
      saveSidebarSettings,
      saveViews,
    ]
  )

  return {
    filters,
    activeFilters,
    sortBy,
    groupBy,
    search,
    options,
    views,
    activeView,
    activeViewDrift,
    hiddenViewIds,
    suggestedViewDimensions,
    filterContext,
    scopeOwnsKind,
    actions,
  }
}
