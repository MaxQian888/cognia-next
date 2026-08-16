import { differenceInCalendarDays } from "date-fns"

import {
  EMPTY_CONVERSATION_FILTERS,
  countActiveConversationFilters,
  matchesConversationFilters,
  resolveConversationFilters,
  sortSupportsManualOrder,
  type ConversationFilterContext,
} from "@/lib/chat/conversation-filters"
import type {
  ChatSession,
  ConversationFilters,
  ConversationGroupBy,
  ConversationSortBy,
  SessionFolder,
} from "@cognia/agent-config-types"

/**
 * Conversation-list model — the single, pure, exhaustively-testable source of
 * truth for how the session list is grouped/filtered. Both the desktop
 * (`components/desktop/channel-list.tsx`) and mobile
 * (`components/mobile/shell/mobile-channel-list.tsx`) surfaces render the
 * `Section[]` it produces; each keeps its own row markup and gestures.
 *
 * Pure by design: no `Date.now()` inside — the caller injects `now`, so
 * date-bucket boundaries are deterministic in tests. See the headless wrapper
 * `hooks/chat/use-conversation-list-model.ts`.
 */

/** ChatGPT-style relative date buckets, ordered newest → oldest. */
export type DateBucket = "today" | "yesterday" | "prev7" | "prev30" | "older"

/** Fixed render order for date buckets. */
export const DATE_BUCKET_ORDER: readonly DateBucket[] = [
  "today",
  "yesterday",
  "prev7",
  "prev30",
  "older",
] as const

/**
 * A named bucket the caller resolved for a non-date grouping axis (a workspace,
 * an agent). Kept deliberately thin so the model never has to import the project
 * or character stores and stays pure.
 */
export interface ConversationGroup {
  id: string
  name: string
}

/**
 * The bucket a session falls into when its group can't be resolved — an agent
 * that was deleted, or a legacy row with no `projectId` (Dexie v86 stamps it on
 * write; pre-isolation rows are grandfathered). Emitted last so it never
 * displaces a real group.
 */
export const UNGROUPED_ID = "__ungrouped__"

export type ConversationSection =
  | { kind: "pinned"; sessions: ChatSession[] }
  | { kind: "folder"; folder: SessionFolder; sessions: ChatSession[]; collapsed: boolean }
  | { kind: "date"; bucket: DateBucket; sessions: ChatSession[] }
  // Flat "recent" list emitted instead of buckets when grouping is off.
  | { kind: "recent"; sessions: ChatSession[] }
  | { kind: "search"; sessions: ChatSession[] }
  // One per workspace / agent, under `groupBy: "workspace" | "agent"`.
  | {
      kind: "group"
      axis: "workspace" | "agent"
      group: ConversationGroup
      sessions: ChatSession[]
      collapsed: boolean
    }

export interface BuildSectionsOptions {
  /** Search text. Empty/whitespace = grouped; non-empty = flat result list. */
  query: string
  /** Which slice of sessions to show. */
  view: "active" | "archived"
  /** Injected wall-clock (ms) used for date bucketing. */
  now: number
  /** Folder ids the user has collapsed (P3). */
  collapsedFolderIds: ReadonlySet<string>
  /**
   * Primary grouping axis for whatever is left after pinned + folders.
   * Defaults to `"date"` so an omitting caller keeps the historical shape; the
   * app's own default is `"workspace"` and lives in
   * `lib/chat/conversation-grouping.ts` (a *preference* default, not a model one).
   *
   * `"team"` produces the same sections as `"date"` — the guild rail does the
   * filtering for that mode, which is a caller concern.
   */
  groupBy?: ConversationGroupBy
  /**
   * Workspaces in display order, for `groupBy: "workspace"`. Any workspace not
   * listed here (or a session with no `projectId`) lands in the ungrouped
   * section rather than inventing a header from an id.
   */
  workspaces?: readonly ConversationGroup[]
  /** Agents/characters in display order, for `groupBy: "agent"`. */
  agents?: readonly ConversationGroup[]
  /**
   * The workspace whose section sorts first and starts expanded. Every other
   * workspace's section starts collapsed — the list would otherwise open as one
   * undifferentiated wall of every conversation the profile has ever held.
   */
  activeWorkspaceId?: string | null
  /**
   * Explicit per-group collapse choices, keyed like `conversationSectionKey`
   * (`workspace:<id>` / `agent:<id>`). A map rather than the set folders use
   * because a group's default is not uniform: every workspace except the active
   * one starts collapsed, so "the user expanded this one" has to be
   * representable too.
   */
  groupCollapseOverrides?: Readonly<Record<string, boolean>>
  /**
   * Optional set of session ids whose message *content* matched the query
   * (resolved async by the caller). In search mode a session matches when its
   * title matches OR its id is in this set. Undefined = title-only search.
   */
  contentMatchIds?: ReadonlySet<string>
  /**
   * Order applied inside every section. Defaults to `"recent"` — the historical
   * behavior, and the only mode that honors a drag-reordered `manualOrder`.
   */
  sortBy?: ConversationSortBy
  /**
   * Quick filters AND-ed on top of the archive view, applied *before* search
   * and grouping so section counts describe what is actually on screen.
   */
  filters?: ConversationFilters
  /**
   * Session ids carrying unread messages. Injected because unread counts live
   * in a separate Dexie table, not on the session — needed by both the
   * `unread` filter and the `unread` sort.
   */
  unreadIds?: ReadonlySet<string>
  /**
   * Model / provider fallback chain for the model + provider facets — the
   * effective value falls back through the bound character to the profile
   * defaults, none of which live on the session row. `now` is taken from the
   * option above, not from here.
   */
  filterContext?: Pick<ConversationFilterContext, "modelOf" | "providerOf">
}

export interface ConversationListModel {
  sections: ConversationSection[]
  /**
   * Sessions in the current view (after the archive filter, before quick
   * filters and search). `total === 0` means "this view is genuinely empty" —
   * which is what separates the first-run empty state from "your filters
   * matched nothing".
   */
  total: number
  /** Sessions actually shown (after quick filters *and* search). */
  filteredCount: number
  /** Flattened, render-ordered session ids — drives range selection. */
  orderedIds: string[]
  /** How many quick filters are narrowing the list (0 = unfiltered). */
  activeFilterCount: number
  /**
   * Search hits that matched only on message *content*, never on their title.
   * The row renders a distinct affordance for these — otherwise a result whose
   * title has nothing to do with the query reads as a bug.
   */
  contentOnlyIds: ReadonlySet<string>
}

const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>()

/**
 * Sort newest-first with stable tie-breakers.
 *
 * Dexie's index order is not a display-order contract when several rows share
 * the same millisecond activity timestamp. Without a total ordering, a live-query
 * refresh can hand us those equal rows in a different order, making the
 * conversation list visibly swap them while the user is creating or switching
 * chats.
 */
function activityAt(session: ChatSession): number {
  return session.lastMessageAt ?? session.updatedAt ?? 0
}

function byRecent(a: ChatSession, b: ChatSession): number {
  return (
    activityAt(b) - activityAt(a) ||
    (b.createdAt ?? 0) - (a.createdAt ?? 0) ||
    a.id.localeCompare(b.id)
  )
}

/**
 * Comparator for one sort mode.
 *
 * Every mode ends in `byRecent`, which is itself total (activity → created →
 * id). That matters as much as the primary key: without a total ordering, rows
 * that tie on the primary key can come back from a live-query refresh in a
 * different order and visibly swap while the user is reading the list.
 */
function comparatorFor(
  sortBy: ConversationSortBy,
  unreadIds: ReadonlySet<string> | undefined
): (a: ChatSession, b: ChatSession) => number {
  switch (sortBy) {
    case "oldest":
      return (a, b) =>
        activityAt(a) - activityAt(b) ||
        (a.createdAt ?? 0) - (b.createdAt ?? 0) ||
        a.id.localeCompare(b.id)
    case "created":
      return (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || byRecent(a, b)
    case "title":
      return (a, b) =>
        // `numeric` so "Draft 2" sorts before "Draft 10"; `base` sensitivity so
        // case and accents don't split otherwise-adjacent titles.
        (a.title ?? "").localeCompare(b.title ?? "", undefined, {
          numeric: true,
          sensitivity: "base",
        }) || byRecent(a, b)
    case "unread":
      return (a, b) => {
        const au = unreadIds?.has(a.id) ? 0 : 1
        const bu = unreadIds?.has(b.id) ? 0 : 1
        return au - bu || byRecent(a, b)
      }
    case "recent":
    default:
      return byRecent
  }
}

/**
 * Stable identity of one conversation-list section, stored alongside
 * `manualOrder` (see `ChatSession.manualOrderSection`) so a manual order only
 * applies inside the section it was dragged in. Without the key, an order set
 * in one date bucket would pin the session to the top of every bucket it later
 * migrates into (today → yesterday → …), permanently overriding recency.
 */
export function conversationSectionKey(
  section: Pick<ConversationSection, "kind"> & {
    folder?: SessionFolder
    bucket?: DateBucket
    axis?: "workspace" | "agent"
    group?: ConversationGroup
  }
): string {
  switch (section.kind) {
    case "pinned":
      return "pinned"
    case "folder":
      return `folder:${section.folder!.id}`
    case "date":
      return `date:${section.bucket!}`
    case "recent":
      return "recent"
    case "search":
      return "search"
    case "group":
      return `${section.axis!}:${section.group!.id}`
  }
}

/**
 * Comparator factory for one section: `manualOrder` (ascending) first —
 * honored only for rows whose `manualOrderSection` matches this section —
 * falling back to the active sort for un-dragged rows and for orders that were
 * set in a different section (legacy rows without a section key keep working
 * inside whichever section they sit in today).
 *
 * A manual order is honored **only under the default recency sort**. Every
 * other mode derives its order from session data, so letting a hand-placed row
 * jump the queue there would silently contradict the axis the user just chose.
 */
function bySectionOrder(
  sectionKey: string,
  sortBy: ConversationSortBy,
  unreadIds: ReadonlySet<string> | undefined
): (a: ChatSession, b: ChatSession) => number {
  const base = comparatorFor(sortBy, unreadIds)
  if (!sortSupportsManualOrder(sortBy)) return base
  const orderOf = (s: ChatSession): number =>
    s.manualOrder != null && (s.manualOrderSection == null || s.manualOrderSection === sectionKey)
      ? s.manualOrder
      : Number.POSITIVE_INFINITY
  return (a, b) => {
    const ao = orderOf(a)
    const bo = orderOf(b)
    if (ao !== bo) return ao - bo
    return base(a, b)
  }
}

/** Map a session activity timestamp to its relative date bucket (local calendar). */
export function dateBucketFor(now: number, activityTimestamp: number): DateBucket {
  // Future timestamps (clock skew) clamp to "today".
  const days = differenceInCalendarDays(now, activityTimestamp)
  if (days <= 0) return "today"
  if (days === 1) return "yesterday"
  if (days <= 7) return "prev7"
  if (days <= 30) return "prev30"
  return "older"
}

/**
 * How well a title matches, lower = better: 0 prefix, 1 word-start, 2 anywhere,
 * `null` no match.
 *
 * Substring search alone ranks "Reindex the corpus" the same as "Index" for the
 * query "index", which buries the conversation the user was almost certainly
 * reaching for. Prefix and word-start hits are the ones people mean.
 */
export function titleMatchRank(title: string, needle: string): number | null {
  const lower = (title ?? "").toLowerCase()
  const index = lower.indexOf(needle)
  if (index < 0) return null
  if (index === 0) return 0
  return /[\s\p{P}\p{S}]/u.test(lower[index - 1]!) ? 1 : 2
}

/** Rank assigned to a hit that matched message content but never its title. */
const CONTENT_ONLY_RANK = 3

const EMPTY_GROUPS: readonly ConversationGroup[] = []
const EMPTY_COLLAPSE_OVERRIDES: Readonly<Record<string, boolean>> = {}

/**
 * Collapse repeated ids to one row each, keeping the first position and the
 * freshest copy (highest `updatedAt`).
 *
 * The rows come from a live query. Between a write and the next clean read —
 * an optimistic re-emit while a reorder / rename / insert transaction is still
 * open, or two subscriptions overlapping across a workspace or account switch —
 * the same conversation can be handed to us twice. Every id downstream becomes
 * a React key and a section count, so a duplicate here fans out into "two
 * children with the same key" and a list that shows one chat twice. Owning the
 * invariant in the model keeps every consumer (desktop + mobile) honest, and
 * the common case pays a single Map pass.
 */
export function dedupeSessionsById<T extends Pick<ChatSession, "id" | "updatedAt">>(
  sessions: readonly T[]
): readonly T[] {
  const byId = new Map<string, T>()
  let duplicates = false
  for (const session of sessions) {
    const seen = byId.get(session.id)
    if (!seen) {
      byId.set(session.id, session)
    } else {
      duplicates = true
      // `Map.set` on an existing key keeps insertion order, so the freshest
      // copy takes the first copy's slot rather than jumping to the end.
      if ((session.updatedAt ?? 0) > (seen.updatedAt ?? 0)) byId.set(session.id, session)
    }
  }
  return duplicates ? Array.from(byId.values()) : sessions
}

/**
 * Workspace render order: the one you are working in first, the rest in the
 * order the caller supplied (the project store's own order).
 */
function orderWorkspaces(
  workspaces: readonly ConversationGroup[],
  activeWorkspaceId: string | null
): ConversationGroup[] {
  const active = activeWorkspaceId ? workspaces.find((w) => w.id === activeWorkspaceId) : undefined
  if (!active) return [...workspaces]
  return [active, ...workspaces.filter((w) => w.id !== active.id)]
}

/**
 * Split sessions into the caller-supplied groups, preserving `order` and
 * appending an ungrouped bucket for anything that didn't resolve.
 */
function groupSessions(
  sessions: readonly ChatSession[],
  order: readonly ConversationGroup[],
  groupIdOf: (session: ChatSession) => string | null | undefined
): Array<{ group: ConversationGroup; sessions: ChatSession[] }> {
  const known = new Map(order.map((g) => [g.id, g]))
  const buckets = new Map<string, ChatSession[]>()
  for (const session of sessions) {
    const raw = groupIdOf(session)
    const id = raw && known.has(raw) ? raw : UNGROUPED_ID
    const bucket = buckets.get(id)
    if (bucket) bucket.push(session)
    else buckets.set(id, [session])
  }
  const result: Array<{ group: ConversationGroup; sessions: ChatSession[] }> = []
  // A group id repeated in `order` (the caller's project / character list) must
  // not emit the same section — and the same rows — twice: the section key is
  // `${axis}:${id}`, so a repeat is a duplicate React key on top of a doubled
  // list. The first occurrence keeps its slot; `known` already resolved to it.
  const emitted = new Set<string>()
  for (const group of order) {
    if (emitted.has(group.id)) continue
    emitted.add(group.id)
    const list = buckets.get(group.id)
    if (list?.length) result.push({ group, sessions: list })
  }
  const ungrouped = buckets.get(UNGROUPED_ID)
  // `name` is empty on purpose: the renderer supplies a translated label rather
  // than the model inventing an English one.
  if (ungrouped?.length) result.push({ group: { id: UNGROUPED_ID, name: "" }, sessions: ungrouped })
  return result
}

/**
 * Build the ordered section list for the conversation list.
 *
 * Rules (precedence **pinned > folder > primary grouping**; each session in
 * exactly one section):
 * - `view` filters by archive state first, then `filters` narrows what's left.
 * - A non-empty `query` collapses everything to a single flat `search` section
 *   (title substring, case-insensitive, ranked prefix → word-start → anywhere →
 *   content-only) — no buckets/folders.
 * - Otherwise: pinned float to the top (incl. pinned-and-foldered); remaining
 *   foldered sessions group under their folder (folders always shown, even
 *   empty, in `order` then name); the rest go through `groupBy`.
 * - Empty date/group/pinned sections are omitted; folder sections are always
 *   emitted so the UI can render headers + empty states.
 *
 * `groupBy: "workspace"` additionally sorts the active workspace first and
 * starts every other workspace collapsed. Inside every section rows follow
 * `sortBy` (recency by default, the only mode honoring a manual drag order).
 */
export function buildConversationSections(
  sessions: readonly ChatSession[],
  folders: readonly SessionFolder[],
  opts: BuildSectionsOptions
): ConversationListModel {
  const {
    query,
    view,
    now,
    collapsedFolderIds,
    groupBy = "date",
    workspaces = EMPTY_GROUPS,
    agents = EMPTY_GROUPS,
    activeWorkspaceId = null,
    groupCollapseOverrides = EMPTY_COLLAPSE_OVERRIDES,
    contentMatchIds,
    sortBy = "recent",
    filters,
    unreadIds,
    filterContext,
  } = opts
  const needle = query.trim().toLowerCase()
  const resolvedFilters = filters ? resolveConversationFilters(filters) : EMPTY_CONVERSATION_FILTERS
  const activeFilterCount = countActiveConversationFilters(resolvedFilters)

  const viewed = dedupeSessionsById(sessions).filter(
    (s) =>
      // `subagent` sessions (ADR-0062) are hidden imported-subagent inner
      // transcripts — never listed, bucketed, or matched by search on any
      // surface (desktop + mobile both flow through here).
      s.kind !== "subagent" && (view === "archived" ? s.archivedAt != null : s.archivedAt == null)
  )
  // `total` counts the *view*, deliberately before quick filters: it is what
  // separates "you have no archived conversations" from "your filters matched
  // nothing", and those need different empty states.
  const total = viewed.length

  // Quick filters narrow everything downstream — search, buckets, and the
  // section counts alike — so a count on screen always describes what is on
  // screen.
  const candidates = activeFilterCount
    ? viewed.filter((s) =>
        matchesConversationFilters(s, resolvedFilters, unreadIds, {
          now,
          modelOf: filterContext?.modelOf,
          providerOf: filterContext?.providerOf,
        })
      )
    : viewed

  // Search mode: flat result list, no grouping. A session matches when its
  // title matches OR (content search) its id is in `contentMatchIds`, ranked
  // by how directly the title matched so the obvious hit is never buried.
  if (needle) {
    const contentOnly = new Set<string>()
    const ranked: Array<{ session: ChatSession; rank: number }> = []
    for (const session of candidates) {
      const titleRank = titleMatchRank(session.title ?? "", needle)
      if (titleRank !== null) {
        ranked.push({ session, rank: titleRank })
      } else if (contentMatchIds?.has(session.id)) {
        contentOnly.add(session.id)
        ranked.push({ session, rank: CONTENT_ONLY_RANK })
      }
    }
    const tiebreak = comparatorFor(sortBy, unreadIds)
    ranked.sort((a, b) => a.rank - b.rank || tiebreak(a.session, b.session))
    const matched = ranked.map((entry) => entry.session)
    return {
      sections: matched.length ? [{ kind: "search", sessions: matched }] : [],
      total,
      filteredCount: matched.length,
      orderedIds: matched.map((s) => s.id),
      activeFilterCount,
      contentOnlyIds: contentOnly,
    }
  }

  const sections: ConversationSection[] = []
  const sectionOrder = (key: string) => bySectionOrder(key, sortBy, unreadIds)

  // 1. Pinned float to the top (regardless of folder).
  const pinned = candidates.filter((s) => s.pinned).sort(sectionOrder("pinned"))
  if (pinned.length) sections.push({ kind: "pinned", sessions: pinned })

  const rest = candidates.filter((s) => !s.pinned)

  // 2. Folders (always shown, ordered) for non-pinned foldered sessions.
  const folderIds = new Set(folders.map((f) => f.id))
  const byFolder = new Map<string, ChatSession[]>()
  const loose: ChatSession[] = []
  for (const s of rest) {
    if (s.folderId && folderIds.has(s.folderId)) {
      const bucket = byFolder.get(s.folderId)
      if (bucket) bucket.push(s)
      else byFolder.set(s.folderId, [s])
    } else {
      // Loose, or pointing at a deleted folder → falls back to date buckets.
      loose.push(s)
    }
  }
  const orderedFolders = [...folders].sort(
    (a, b) => a.order - b.order || a.name.localeCompare(b.name)
  )
  for (const folder of orderedFolders) {
    sections.push({
      kind: "folder",
      folder,
      sessions: (byFolder.get(folder.id) ?? []).sort(sectionOrder(`folder:${folder.id}`)),
      collapsed: collapsedFolderIds.has(folder.id),
    })
  }

  // 3. Remaining loose sessions, along the chosen primary axis.
  if (groupBy === "none") {
    if (loose.length)
      sections.push({ kind: "recent", sessions: loose.sort(sectionOrder("recent")) })
  } else if (groupBy === "workspace" || groupBy === "agent") {
    const axis = groupBy
    const order =
      axis === "workspace" ? orderWorkspaces(workspaces, activeWorkspaceId) : [...agents]
    const grouped = groupSessions(loose, order, (s) =>
      axis === "workspace" ? s.projectId : s.characterId
    )
    for (const { group, sessions: members } of grouped) {
      const key = `${axis}:${group.id}`
      // Everything outside the workspace you are working in starts folded, so
      // switching to this mode doesn't dump the whole profile on screen. An
      // explicit choice — which needs a tri-state, hence a map rather than the
      // set folders use — wins in both directions.
      //
      // The ungrouped bucket is exempt: it holds pre-isolation rows, which are
      // grandfathered into *every* workspace, so folding them away by default
      // would make them look deleted rather than filed elsewhere.
      const collapsedByDefault =
        axis === "workspace" &&
        activeWorkspaceId != null &&
        group.id !== activeWorkspaceId &&
        group.id !== UNGROUPED_ID
      sections.push({
        kind: "group",
        axis,
        group,
        sessions: members.sort(sectionOrder(key)),
        collapsed: groupCollapseOverrides[key] ?? collapsedByDefault,
      })
    }
  } else {
    // `date` and `team` share the bucket layout — `team` differs only in which
    // sessions the caller hands us (the guild rail filters them).
    const buckets = new Map<DateBucket, ChatSession[]>()
    for (const s of loose) {
      const bucket = dateBucketFor(now, activityAt(s))
      const list = buckets.get(bucket)
      if (list) list.push(s)
      else buckets.set(bucket, [s])
    }
    for (const bucket of DATE_BUCKET_ORDER) {
      const list = buckets.get(bucket)
      if (list?.length)
        sections.push({
          kind: "date",
          bucket,
          sessions: list.sort(sectionOrder(`date:${bucket}`)),
        })
    }
  }

  // Flatten in render order for range-selection / keyboard nav — but skip the
  // members of a collapsed folder or group: they aren't rendered, so navigating
  // or range-selecting onto a hidden row would be surprising.
  const orderedIds: string[] = []
  for (const sec of sections) {
    if ((sec.kind === "folder" || sec.kind === "group") && sec.collapsed) continue
    for (const s of sec.sessions) orderedIds.push(s.id)
  }

  return {
    sections,
    total,
    filteredCount: candidates.length,
    orderedIds,
    activeFilterCount,
    contentOnlyIds: EMPTY_ID_SET,
  }
}
