import { differenceInCalendarDays } from "date-fns"
import type {
  ChatSession,
  ConversationActivityFilter,
  ConversationFilterPreset,
  ConversationFilters,
  ConversationKindFilter,
  ConversationSidebarSettings,
  ConversationSortBy,
} from "@cognia/agent-config-types"

/**
 * Conversation-list sort + filter vocabulary — the pure half of "how the
 * session list narrows and orders itself". Kept out of
 * `lib/chat/conversation-list-model.ts` so the settings card, the sidebar
 * toolbar, the UI store, and the model all normalize the same persisted shapes
 * through one module instead of each re-deriving defaults.
 *
 * Mirrors `lib/chat/conversation-grouping.ts`, which owns the *grouping* axis.
 *
 * Semantics: values inside one list facet are OR-ed ("workspace A or B"),
 * facets are AND-ed with each other and with the boolean toggles.
 */

/** Order used when nothing is persisted — recency, the historical behavior. */
export const DEFAULT_CONVERSATION_SORT_BY: ConversationSortBy = "recent"

/** Render order for the sort selector; also the exhaustiveness list. */
export const CONVERSATION_SORT_BY_OPTIONS: readonly ConversationSortBy[] = [
  "recent",
  "oldest",
  "created",
  "title",
  "unread",
] as const

/** Render order for the conversation-kind selector. */
export const CONVERSATION_KIND_FILTER_OPTIONS: readonly ConversationKindFilter[] = [
  "all",
  "dm",
  "team",
] as const

/** Render order for the last-activity selector. */
export const CONVERSATION_ACTIVITY_FILTER_OPTIONS: readonly ConversationActivityFilter[] = [
  "any",
  "today",
  "week",
  "month",
  "older",
] as const

/** The boolean quick filters, in the order the toolbar renders them. */
export const CONVERSATION_FILTER_TOGGLES = ["unread", "pinned", "branched"] as const

export type ConversationFilterToggle = (typeof CONVERSATION_FILTER_TOGGLES)[number]

/** The multi-value facets, in the order the menu renders them. */
export const CONVERSATION_FILTER_LIST_KEYS = [
  "workspaceIds",
  "folderIds",
  "agentIds",
  "teamIds",
  "models",
  "providers",
] as const

export type ConversationFilterListKey = (typeof CONVERSATION_FILTER_LIST_KEYS)[number]

/**
 * Sentinel admitted by the workspace / folder / agent facets meaning "carries no
 * value" — a conversation outside any workspace, loose (not in a folder), or
 * with no bound character. A real id can never collide with it.
 */
export const CONVERSATION_FILTER_UNASSIGNED = "__unassigned__"

const EMPTY_LIST: readonly string[] = Object.freeze([])

/**
 * Stable identity for "no filters". Handed to the model as the default so an
 * unfiltered list never mints a fresh object per render (the model result feeds
 * `useMemo` deps on both surfaces).
 */
export const EMPTY_CONVERSATION_FILTERS: Readonly<Required<ConversationFilters>> = Object.freeze({
  unread: false,
  pinned: false,
  branched: false,
  kind: "all" as ConversationKindFilter,
  workspaceIds: EMPTY_LIST as string[],
  folderIds: EMPTY_LIST as string[],
  agentIds: EMPTY_LIST as string[],
  teamIds: EMPTY_LIST as string[],
  models: EMPTY_LIST as string[],
  providers: EMPTY_LIST as string[],
  activity: "any" as ConversationActivityFilter,
})

function isSortBy(value: unknown): value is ConversationSortBy {
  return CONVERSATION_SORT_BY_OPTIONS.includes(value as ConversationSortBy)
}

function isKindFilter(value: unknown): value is ConversationKindFilter {
  return CONVERSATION_KIND_FILTER_OPTIONS.includes(value as ConversationKindFilter)
}

function isActivityFilter(value: unknown): value is ConversationActivityFilter {
  return CONVERSATION_ACTIVITY_FILTER_OPTIONS.includes(value as ConversationActivityFilter)
}

/** Dedupe + drop non-string / blank entries; returns the shared empty list when nothing survives. */
function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return EMPTY_LIST as string[]
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry === "string" && entry.length > 0) seen.add(entry)
  }
  return seen.size === 0 ? (EMPTY_LIST as string[]) : [...seen]
}

/**
 * Read the persisted sort preference, falling back to recency. Unknown values
 * (a downgrade after a newer build wrote a mode this one doesn't know) resolve
 * to the default rather than producing an empty comparator.
 */
export function resolveConversationSortBy(
  settings: ConversationSidebarSettings | null | undefined
): ConversationSortBy {
  return isSortBy(settings?.sortBy) ? settings.sortBy : DEFAULT_CONVERSATION_SORT_BY
}

/**
 * Normalize a persisted (or partially-typed) filter blob into the complete
 * shape every consumer can read without `??` chains. Unknown enum values
 * degrade to their "any" member so a stale persisted value can never hide every
 * row with no visible cause.
 */
export function resolveConversationFilters(
  filters: ConversationFilters | null | undefined
): Required<ConversationFilters> {
  if (!filters) return EMPTY_CONVERSATION_FILTERS
  return {
    unread: filters.unread === true,
    pinned: filters.pinned === true,
    branched: filters.branched === true,
    kind: isKindFilter(filters.kind) ? filters.kind : "all",
    workspaceIds: normalizeList(filters.workspaceIds),
    folderIds: normalizeList(filters.folderIds),
    agentIds: normalizeList(filters.agentIds),
    teamIds: normalizeList(filters.teamIds),
    models: normalizeList(filters.models),
    providers: normalizeList(filters.providers),
    activity: isActivityFilter(filters.activity) ? filters.activity : "any",
  }
}

/**
 * How many facets are narrowing the list — drives the toolbar badge and the
 * per-facet counters in the menu. A list facet counts once however many values
 * it holds: "3 workspaces" is one decision, not three.
 */
export function countActiveConversationFilters(
  filters: ConversationFilters | null | undefined
): number {
  const resolved = resolveConversationFilters(filters)
  let count = 0
  for (const key of CONVERSATION_FILTER_TOGGLES) if (resolved[key]) count += 1
  if (resolved.kind !== "all") count += 1
  for (const key of CONVERSATION_FILTER_LIST_KEYS) if (resolved[key].length > 0) count += 1
  if (resolved.activity !== "any") count += 1
  return count
}

/** True when at least one filter is narrowing the list. */
export function hasActiveConversationFilters(
  filters: ConversationFilters | null | undefined
): boolean {
  return countActiveConversationFilters(filters) > 0
}

/** Flip one boolean quick filter without disturbing its siblings. */
export function toggleConversationFilter(
  filters: ConversationFilters | null | undefined,
  key: ConversationFilterToggle,
  enabled: boolean
): Required<ConversationFilters> {
  return { ...resolveConversationFilters(filters), [key]: enabled }
}

/** Set the conversation-kind facet (radio, not a toggle). */
export function setConversationKindFilter(
  filters: ConversationFilters | null | undefined,
  kind: ConversationKindFilter
): Required<ConversationFilters> {
  return { ...resolveConversationFilters(filters), kind: isKindFilter(kind) ? kind : "all" }
}

/** Set the last-activity window (radio). */
export function setConversationActivityFilter(
  filters: ConversationFilters | null | undefined,
  activity: ConversationActivityFilter
): Required<ConversationFilters> {
  return {
    ...resolveConversationFilters(filters),
    activity: isActivityFilter(activity) ? activity : "any",
  }
}

/** Replace one list facet wholesale (an empty list clears it). */
export function setConversationFilterList(
  filters: ConversationFilters | null | undefined,
  key: ConversationFilterListKey,
  values: readonly string[]
): Required<ConversationFilters> {
  return { ...resolveConversationFilters(filters), [key]: normalizeList([...values]) }
}

/** Add or remove one value inside a list facet. */
export function toggleConversationFilterValue(
  filters: ConversationFilters | null | undefined,
  key: ConversationFilterListKey,
  value: string,
  enabled: boolean
): Required<ConversationFilters> {
  const resolved = resolveConversationFilters(filters)
  const current = resolved[key]
  const has = current.includes(value)
  if (enabled === has) return resolved
  const next = enabled ? [...current, value] : current.filter((entry) => entry !== value)
  return { ...resolved, [key]: normalizeList(next) }
}

/**
 * Structural equality over the *resolved* shape (list order is irrelevant —
 * "A or B" is "B or A"). Used to tell whether the active filters equal a saved
 * preset so the menu can mark it selected.
 */
export function conversationFiltersEqual(
  a: ConversationFilters | null | undefined,
  b: ConversationFilters | null | undefined
): boolean {
  const ra = resolveConversationFilters(a)
  const rb = resolveConversationFilters(b)
  for (const key of CONVERSATION_FILTER_TOGGLES) if (ra[key] !== rb[key]) return false
  if (ra.kind !== rb.kind || ra.activity !== rb.activity) return false
  for (const key of CONVERSATION_FILTER_LIST_KEYS) {
    const la = ra[key]
    const lb = rb[key]
    if (la.length !== lb.length) return false
    const set = new Set(la)
    for (const value of lb) if (!set.has(value)) return false
  }
  return true
}

/**
 * Per-session facet resolution the pure matcher cannot do on its own: the
 * effective model / provider fall back through the bound character to the
 * profile defaults, and those live outside the session row.
 */
export interface ConversationFilterContext {
  /** Injected clock for the activity window (never `Date.now()` here). */
  now?: number
  /** Effective model id for a session; `undefined` = unknown (never matches a model filter). */
  modelOf?: (session: ChatSession) => string | undefined
  /** Effective provider id for a session; `undefined` = unknown. */
  providerOf?: (session: ChatSession) => string | undefined
}

/** True when the list facet is inactive or admits `value` (with the unassigned sentinel). */
function listAdmits(list: readonly string[], value: string | undefined): boolean {
  if (list.length === 0) return true
  return list.includes(value ?? CONVERSATION_FILTER_UNASSIGNED)
}

/**
 * Whether an activity timestamp falls inside the window. Buckets are the same
 * calendar-day cuts as the date grouping so "this week" in the filter is the
 * "Today + Yesterday + Previous 7 days" the list already shows.
 */
export function matchesConversationActivity(
  activity: ConversationActivityFilter,
  now: number,
  activityAt: number | undefined
): boolean {
  if (activity === "any") return true
  if (activityAt == null) return activity === "older"
  const days = differenceInCalendarDays(now, activityAt)
  switch (activity) {
    case "today":
      return days <= 0
    case "week":
      return days <= 7
    case "month":
      return days <= 30
    case "older":
      return days > 30
    default:
      return true
  }
}

/**
 * Does this session survive the active filters?
 *
 * Facets are AND-ed: asking for "unread + team" means unread team conversations
 * only. `unreadIds` is injected because unread counts live in a separate Dexie
 * table (`lib/db/session-state.ts`), not on the session row — keeping the
 * lookup a parameter is what lets this stay pure and exhaustively testable.
 * The optional `context` supplies the clock and the model / provider fallback
 * chain for the same reason.
 */
export function matchesConversationFilters(
  session: ChatSession,
  filters: Required<ConversationFilters>,
  unreadIds: ReadonlySet<string> | undefined,
  context?: ConversationFilterContext
): boolean {
  if (filters.unread && !(unreadIds?.has(session.id) ?? false)) return false
  if (filters.pinned && !session.pinned) return false
  if (filters.branched && !session.parentSessionId) return false
  if (filters.kind === "team" && session.kind !== "team") return false
  if (filters.kind === "dm" && session.kind === "team") return false
  if (!listAdmits(filters.workspaceIds, session.projectId)) return false
  if (!listAdmits(filters.folderIds, session.folderId ?? undefined)) return false
  if (!listAdmits(filters.agentIds, session.characterId)) return false
  if (filters.teamIds.length > 0 && !(session.teamId && filters.teamIds.includes(session.teamId)))
    return false
  if (filters.models.length > 0) {
    const model = session.model ?? context?.modelOf?.(session)
    if (!model || !filters.models.includes(model)) return false
  }
  if (filters.providers.length > 0) {
    const provider = session.providerOverride ?? context?.providerOf?.(session)
    if (!provider || !filters.providers.includes(provider)) return false
  }
  if (filters.activity !== "any") {
    const now = context?.now ?? 0
    if (
      !matchesConversationActivity(
        filters.activity,
        now,
        session.lastMessageAt ?? session.updatedAt ?? undefined
      )
    )
      return false
  }
  return true
}

/**
 * Whether a drag-reordered `manualOrder` still applies under this sort.
 *
 * Only recency does: every other mode derives its order from session data, so
 * honoring a hand-placed row there would silently override the axis the user
 * just picked for an arbitrary subset of rows. The sidebar also uses this to
 * turn drag-reordering off, so the affordance never suggests an order the list
 * will not keep.
 */
export function sortSupportsManualOrder(sortBy: ConversationSortBy): boolean {
  return sortBy === "recent"
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/** Longest name a preset may carry (the menu row has ~40 characters of room). */
export const CONVERSATION_FILTER_PRESET_NAME_MAX = 40

/** Trim + clamp a preset name; `null` when nothing usable remains. */
export function normalizeConversationFilterPresetName(name: string): string | null {
  const trimmed = name.trim().replace(/\s+/g, " ")
  if (!trimmed) return null
  return trimmed.slice(0, CONVERSATION_FILTER_PRESET_NAME_MAX)
}

/**
 * Persisted presets, normalized: drops entries with no id / no usable name /
 * filters that narrow nothing (a preset for "everything" is a no-op button), and
 * keeps the first of any duplicate id.
 */
export function resolveConversationFilterPresets(
  presets: readonly ConversationFilterPreset[] | null | undefined
): ConversationFilterPreset[] {
  if (!Array.isArray(presets)) return []
  const seen = new Set<string>()
  const out: ConversationFilterPreset[] = []
  for (const preset of presets) {
    if (!preset || typeof preset.id !== "string" || !preset.id || seen.has(preset.id)) continue
    const name = normalizeConversationFilterPresetName(String(preset.name ?? ""))
    if (!name) continue
    const filters = resolveConversationFilters(preset.filters)
    if (!hasActiveConversationFilters(filters)) continue
    seen.add(preset.id)
    out.push({
      id: preset.id,
      name,
      filters,
      createdAt: typeof preset.createdAt === "number" ? preset.createdAt : 0,
    })
  }
  return out
}

/**
 * Append a preset capturing `filters`. Returns the unchanged list when the name
 * is blank or the filters narrow nothing — callers gate the button on
 * `hasActiveConversationFilters`, this is the belt to that suspender.
 */
export function addConversationFilterPreset(
  presets: readonly ConversationFilterPreset[] | null | undefined,
  input: { id: string; name: string; filters: ConversationFilters; createdAt: number }
): ConversationFilterPreset[] {
  const current = resolveConversationFilterPresets(presets)
  const name = normalizeConversationFilterPresetName(input.name)
  const filters = resolveConversationFilters(input.filters)
  if (!name || !hasActiveConversationFilters(filters) || current.some((p) => p.id === input.id))
    return current
  return [...current, { id: input.id, name, filters, createdAt: input.createdAt }]
}

/** Rename one preset; unknown ids and blank names leave the list untouched. */
export function renameConversationFilterPreset(
  presets: readonly ConversationFilterPreset[] | null | undefined,
  id: string,
  name: string
): ConversationFilterPreset[] {
  const current = resolveConversationFilterPresets(presets)
  const next = normalizeConversationFilterPresetName(name)
  if (!next) return current
  return current.map((preset) => (preset.id === id ? { ...preset, name: next } : preset))
}

/** Drop one preset by id. */
export function removeConversationFilterPreset(
  presets: readonly ConversationFilterPreset[] | null | undefined,
  id: string
): ConversationFilterPreset[] {
  return resolveConversationFilterPresets(presets).filter((preset) => preset.id !== id)
}

/** The saved preset whose filters equal the active ones, if any. */
export function findMatchingConversationFilterPreset(
  presets: readonly ConversationFilterPreset[] | null | undefined,
  filters: ConversationFilters | null | undefined
): ConversationFilterPreset | undefined {
  if (!hasActiveConversationFilters(filters)) return undefined
  return resolveConversationFilterPresets(presets).find((preset) =>
    conversationFiltersEqual(preset.filters, filters)
  )
}
