import type {
  ConversationFilters,
  ConversationGroupBy,
  ConversationSearchOptions,
  ConversationSidebarSettings,
  ConversationSortBy,
  ConversationView,
} from "@cognia/agent-config-types"

import {
  conversationFiltersEqual,
  hasActiveConversationFilters,
  normalizeConversationFilterPresetName,
  resolveConversationFilters,
} from "@/lib/chat/conversation-filters"
import { resolveConversationSearchOptions } from "@/lib/chat/conversation-search-scope"

/**
 * Saved views — "which conversations am I looking at, in what order, and how
 * far does search reach", saved under a name.
 *
 * The predecessor, `filterPresets`, could only save the quick filters, so the
 * views people actually wanted ("unread first", "everything I made this week",
 * "search my whole account") were unrepresentable: each needed a sort, a
 * grouping or a search reach as well. A view carries all four.
 *
 * **Partial overlay, not a snapshot.** Every dimension is optional and
 * `undefined` means "leave the current value alone". That is what makes the
 * older presets valid views with no migration — a preset is a view that pins
 * only its filters — and it is why applying "unread first" does not silently
 * throw away the grouping the user had chosen. The cost is honest and small: a
 * view is a set of decisions, not a photograph, so two applications of the same
 * view can differ in the dimensions it does not mention.
 *
 * Storage is split on purpose (see `hooks/chat/use-conversation-filter-controller.ts`):
 * the *definitions* live in the settings blob so they follow the profile across
 * devices, while *which view is active* lives in the UI store, so a phone and a
 * desktop can sit in different views without fighting each other.
 */

/** The dimensions a view may pin. Absent = leave the current value alone. */
export interface ConversationViewOverlay {
  filters?: Required<ConversationFilters>
  sortBy?: ConversationSortBy
  groupBy?: ConversationGroupBy
  search?: ConversationSearchOptions
}

/** A view ready to render and apply. */
export interface ResolvedConversationView {
  id: string
  /**
   * Custom views carry their own text; built-ins carry a **translation key**
   * (see {@link ResolvedConversationView.builtIn}), because a built-in's name
   * must follow the app's locale rather than whichever one it was created in.
   */
  name: string
  builtIn: boolean
  createdAt: number
  overlay: ConversationViewOverlay
}

/** The dimensions, in the order the "modified" comparison reports them. */
export const CONVERSATION_VIEW_DIMENSIONS = ["filters", "sortBy", "groupBy", "search"] as const

export type ConversationViewDimension = (typeof CONVERSATION_VIEW_DIMENSIONS)[number]

/** Same clamp the older presets used — the menu row has ~40 characters of room. */
export const CONVERSATION_VIEW_NAME_MAX = 40

/**
 * Built-in view ids. Namespaced so a custom view can never collide with one,
 * and stable so "hidden" survives a rename of the label.
 */
export const BUILT_IN_VIEW_IDS = {
  unread: "builtin:unread",
  recentlyCreated: "builtin:recentlyCreated",
  globalSearch: "builtin:globalSearch",
} as const

/**
 * The views the app ships with.
 *
 * They exist as much for discovery as for convenience: `sortBy: "created"` and
 * the search reach are new vocabulary, and nobody goes looking in a menu for a
 * capability they do not know exists. `name` is a translation key — the surface
 * resolves it against its own namespace.
 *
 * `createdAt: 0` sorts them ahead of anything the user has saved.
 */
export const BUILT_IN_CONVERSATION_VIEWS: readonly ResolvedConversationView[] = Object.freeze([
  Object.freeze({
    id: BUILT_IN_VIEW_IDS.unread,
    name: "views.builtIn.unread",
    builtIn: true,
    createdAt: 0,
    overlay: Object.freeze({
      filters: resolveConversationFilters({ unread: true }),
      sortBy: "unread" as ConversationSortBy,
    }),
  }),
  Object.freeze({
    id: BUILT_IN_VIEW_IDS.recentlyCreated,
    name: "views.builtIn.recentlyCreated",
    builtIn: true,
    createdAt: 0,
    // Both halves are needed: the sort alone would leave the headers bucketing
    // by last activity, which is the disagreement the date-basis work removed.
    overlay: Object.freeze({
      sortBy: "created" as ConversationSortBy,
      groupBy: "date" as ConversationGroupBy,
    }),
  }),
  Object.freeze({
    id: BUILT_IN_VIEW_IDS.globalSearch,
    name: "views.builtIn.globalSearch",
    builtIn: true,
    createdAt: 0,
    overlay: Object.freeze({
      search: Object.freeze({ workspace: "all", includeArchived: true, content: true }),
    }),
  }),
] as ResolvedConversationView[])

/** True when a stored overlay pins nothing — a view for "everything" is a no-op button. */
export function conversationViewOverlayIsEmpty(overlay: ConversationViewOverlay): boolean {
  if (overlay.sortBy || overlay.groupBy || overlay.search) return false
  return !overlay.filters || !hasActiveConversationFilters(overlay.filters)
}

function readOverlay(stored: ConversationView): ConversationViewOverlay {
  const overlay: ConversationViewOverlay = {}
  if (stored.filters) overlay.filters = resolveConversationFilters(stored.filters)
  if (stored.sortBy) overlay.sortBy = stored.sortBy
  if (stored.groupBy) overlay.groupBy = stored.groupBy
  if (stored.search) overlay.search = resolveConversationSearchOptions({ search: stored.search })
  return overlay
}

/**
 * Every view the menu should offer: the built-ins the user has not hidden,
 * then the stored ones — including the older `filterPresets`, read as views
 * that pin only their filters.
 *
 * Drops entries with no id / no usable name / an overlay that pins nothing, and
 * keeps the first of any duplicate id. A stored view claiming a built-in id is
 * ignored rather than shadowing it: built-ins are code, and letting data
 * override them would make "reset" unreachable.
 */
export function resolveConversationViews(
  settings: ConversationSidebarSettings | null | undefined
): ResolvedConversationView[] {
  const hidden = new Set(Array.isArray(settings?.hiddenViewIds) ? settings.hiddenViewIds : [])
  const out: ResolvedConversationView[] = BUILT_IN_CONVERSATION_VIEWS.filter(
    (view) => !hidden.has(view.id)
  )
  const seen = new Set(BUILT_IN_CONVERSATION_VIEWS.map((view) => view.id))

  const stored: ConversationView[] = [
    ...(Array.isArray(settings?.views) ? settings.views : []),
    // A preset IS a view that pins only its filters. Reading them instead of
    // migrating means a downgrade keeps working and no stored sort is invented.
    ...(Array.isArray(settings?.filterPresets)
      ? settings.filterPresets.map((preset) => ({
          id: preset?.id,
          name: preset?.name,
          createdAt: preset?.createdAt,
          filters: preset?.filters,
        }))
      : []),
  ] as ConversationView[]

  for (const entry of stored) {
    if (!entry || typeof entry.id !== "string" || !entry.id || seen.has(entry.id)) continue
    const name = normalizeConversationFilterPresetName(String(entry.name ?? ""))
    if (!name) continue
    const overlay = readOverlay(entry)
    if (conversationViewOverlayIsEmpty(overlay)) continue
    seen.add(entry.id)
    out.push({
      id: entry.id,
      name,
      builtIn: false,
      createdAt: typeof entry.createdAt === "number" ? entry.createdAt : 0,
      overlay,
    })
  }
  return out
}

/** The current, resolved list state a view is compared against and applied over. */
export interface ConversationViewState {
  filters: Required<ConversationFilters>
  sortBy: ConversationSortBy
  groupBy: ConversationGroupBy
  search: Required<ConversationSearchOptions>
}

function searchEqual(
  a: Required<ConversationSearchOptions>,
  b: ConversationSearchOptions
): boolean {
  const rb = resolveConversationSearchOptions({ search: b })
  return (
    a.workspace === rb.workspace &&
    a.includeArchived === rb.includeArchived &&
    a.content === rb.content
  )
}

/**
 * Which of the view's own dimensions the current state no longer matches.
 *
 * Dimensions the view does not pin are never reported: they were never its
 * claim. An empty array means the view is exactly in effect.
 *
 * This is what powers the "view name · modified" chip. It replaces asking
 * whether the *filters* happen to equal a preset's, which lost track of the
 * view the moment the user nudged anything — and made "update this view"
 * impossible to offer, because by then nothing knew which view was meant.
 */
export function conversationViewDrift(
  view: ResolvedConversationView,
  state: ConversationViewState
): ConversationViewDimension[] {
  const drift: ConversationViewDimension[] = []
  const { overlay } = view
  if (overlay.filters && !conversationFiltersEqual(overlay.filters, state.filters))
    drift.push("filters")
  if (overlay.sortBy && overlay.sortBy !== state.sortBy) drift.push("sortBy")
  if (overlay.groupBy && overlay.groupBy !== state.groupBy) drift.push("groupBy")
  if (overlay.search && !searchEqual(state.search, overlay.search)) drift.push("search")
  return drift
}

/** True when every dimension the view pins is currently in effect. */
export function conversationViewIsActive(
  view: ResolvedConversationView,
  state: ConversationViewState
): boolean {
  return conversationViewDrift(view, state).length === 0
}

/**
 * The two writes applying a view needs, split by where they land: `filters` go
 * to the UI store (layout state, per device), the rest to the settings blob
 * (follows the profile). Returning them rather than performing them keeps this
 * module pure and lets the controller own the store handles.
 *
 * `filters` is `undefined` when the view does not pin them — the caller must
 * leave the current filters alone, not clear them.
 */
export interface ConversationViewApplication {
  filters?: Required<ConversationFilters>
  settings: Partial<ConversationSidebarSettings>
}

export function applyConversationView(view: ResolvedConversationView): ConversationViewApplication {
  const settings: Partial<ConversationSidebarSettings> = {}
  if (view.overlay.sortBy) settings.sortBy = view.overlay.sortBy
  if (view.overlay.groupBy) settings.groupBy = view.overlay.groupBy
  if (view.overlay.search) settings.search = view.overlay.search
  return { filters: view.overlay.filters, settings }
}

/**
 * Capture the current state as a view's overlay.
 *
 * `dimensions` is what the user ticked in the save dialog; anything not listed
 * stays unpinned, which is the whole point of the overlay model. Filters are
 * only pinned when they actually narrow something — otherwise the view would
 * carry a promise it does not make.
 */
export function captureConversationViewOverlay(
  state: ConversationViewState,
  dimensions: readonly ConversationViewDimension[]
): ConversationViewOverlay {
  const overlay: ConversationViewOverlay = {}
  const wanted = new Set(dimensions)
  if (wanted.has("filters") && hasActiveConversationFilters(state.filters))
    overlay.filters = state.filters
  if (wanted.has("sortBy")) overlay.sortBy = state.sortBy
  if (wanted.has("groupBy")) overlay.groupBy = state.groupBy
  if (wanted.has("search")) overlay.search = state.search
  return overlay
}

/** Turn an overlay into the persisted shape (drops the resolved-only bits). */
export function toStoredConversationView(input: {
  id: string
  name: string
  createdAt: number
  overlay: ConversationViewOverlay
}): ConversationView | null {
  const name = normalizeConversationFilterPresetName(input.name)
  if (!name || conversationViewOverlayIsEmpty(input.overlay)) return null
  const stored: ConversationView = { id: input.id, name, createdAt: input.createdAt }
  if (input.overlay.filters) stored.filters = input.overlay.filters
  if (input.overlay.sortBy) stored.sortBy = input.overlay.sortBy
  if (input.overlay.groupBy) stored.groupBy = input.overlay.groupBy
  if (input.overlay.search) stored.search = input.overlay.search
  return stored
}

/**
 * The stored list with `next` appended (or replaced in place when its id is
 * already there — that is "update this view"). Built-in ids are refused: they
 * are code, and a stored row shadowing one would make the built-in unreachable.
 */
export function upsertConversationView(
  views: readonly ConversationView[] | null | undefined,
  next: ConversationView
): ConversationView[] {
  if (BUILT_IN_CONVERSATION_VIEWS.some((view) => view.id === next.id)) {
    return [...(views ?? [])]
  }
  const current = [...(views ?? [])]
  const at = current.findIndex((view) => view?.id === next.id)
  if (at >= 0) {
    current[at] = next
    return current
  }
  return [...current, next]
}

/** Rename one stored view; unknown ids and blank names leave the list untouched. */
export function renameConversationView(
  views: readonly ConversationView[] | null | undefined,
  id: string,
  name: string
): ConversationView[] {
  const next = normalizeConversationFilterPresetName(name)
  const current = [...(views ?? [])]
  if (!next) return current
  return current.map((view) => (view?.id === id ? { ...view, name: next } : view))
}

/** Drop one stored view by id. */
export function removeConversationView(
  views: readonly ConversationView[] | null | undefined,
  id: string
): ConversationView[] {
  return [...(views ?? [])].filter((view) => view?.id !== id)
}

/**
 * Hide or restore a built-in view. Non-built-in ids are ignored — a custom view
 * is deleted, not hidden, and letting both mechanisms touch it would leave a
 * row that is gone from the menu but still in the blob.
 */
export function setBuiltInViewHidden(
  hiddenIds: readonly string[] | null | undefined,
  id: string,
  hidden: boolean
): string[] {
  if (!BUILT_IN_CONVERSATION_VIEWS.some((view) => view.id === id)) return [...(hiddenIds ?? [])]
  const current = new Set(hiddenIds ?? [])
  if (hidden) current.add(id)
  else current.delete(id)
  return [...current]
}

/**
 * Which dimensions a fresh "save as view" dialog should tick.
 *
 * Anything the user has moved away from its default is presumably why they are
 * saving — a view whose boxes start empty makes the user re-state what is
 * already on screen.
 */
export function suggestedConversationViewDimensions(
  state: ConversationViewState,
  defaults: { sortBy: ConversationSortBy; groupBy: ConversationGroupBy }
): ConversationViewDimension[] {
  const out: ConversationViewDimension[] = []
  if (hasActiveConversationFilters(state.filters)) out.push("filters")
  if (state.sortBy !== defaults.sortBy) out.push("sortBy")
  if (state.groupBy !== defaults.groupBy) out.push("groupBy")
  const search = state.search
  if (search.workspace !== "current" || search.includeArchived || search.content) out.push("search")
  return out
}
