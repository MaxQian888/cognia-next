import { differenceInCalendarDays } from "date-fns"

import {
  EMPTY_CONVERSATION_FILTERS,
  countActiveConversationFilters,
  matchesConversationFilters,
  resolveConversationFilters,
  resolveConversationTimeBasis,
  sortSupportsDateBuckets,
  sortSupportsManualOrder,
  type ConversationFilterContext,
  type ConversationTimeBasis,
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
 * an agent, a team). Kept deliberately thin so the model never has to import the
 * project, character or team stores and stays pure.
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

/**
 * Grouping axes that resolve their buckets from a caller-supplied entity list.
 *
 * `team` joined `workspace` and `agent` when team mode stopped being a *filter*
 * wearing a grouping's name: it used to emit plain date buckets and rely on the
 * desktop guild rail having already narrowed the list, which left the mobile
 * list — no rail — showing "grouped by team" over a list that was not grouped
 * at all. The rail is now a way to *jump* to a team's section; narrowing to one
 * team is the `teamIds` facet's job.
 */
export type ConversationGroupAxis = "workspace" | "agent" | "team"

export type ConversationSection =
  | { kind: "pinned"; sessions: ChatSession[] }
  | { kind: "folder"; folder: SessionFolder; sessions: ChatSession[]; collapsed: boolean }
  | { kind: "date"; bucket: DateBucket; sessions: ChatSession[] }
  // Flat "recent" list emitted instead of buckets when grouping is off.
  | { kind: "recent"; sessions: ChatSession[] }
  | { kind: "search"; sessions: ChatSession[] }
  // One per workspace / agent / team, under `groupBy: "workspace" | "agent" | "team"`.
  | {
      kind: "group"
      axis: ConversationGroupAxis
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
   * `"team"` is a real axis now ({@link ConversationGroupAxis}) and needs
   * `teams` supplied, the same way `"workspace"` needs `workspaces`.
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
   * Teams in display order, for `groupBy: "team"`. Direct conversations carry no
   * `teamId` and land in the ungrouped bucket, which the renderer labels
   * "Direct messages" on this axis — the model never invents the copy.
   */
  teams?: readonly ConversationGroup[]
  /**
   * The workspace whose section sorts first and starts expanded. Every other
   * workspace's section starts collapsed — the list would otherwise open as one
   * undifferentiated wall of every conversation the profile has ever held.
   */
  activeWorkspaceId?: string | null
  /**
   * Explicit per-group collapse choices, keyed like `conversationSectionKey`
   * (`workspace:<id>` / `agent:<id>` / `team:<id>`). A map rather than the set folders use
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
   * Let a query reach past the archive split, in whichever direction `view` is
   * pointing. Applies **only while `query` is non-empty**: browsing archived
   * conversations stays the view toggle's job, so the two controls never
   * describe the same thing. Rows that came from the other side still carry
   * `archivedAt`, which is how the row marks them.
   */
  searchIncludesArchived?: boolean
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
  /**
   * How well a title matches the query, higher = better, `null` = no match.
   *
   * Injected rather than imported because the shared ranker lives in
   * `lib/global-search/scoring.ts`, which already imports *this* module for
   * {@link titleMatchRank} — importing it back would close a cycle. The hook
   * wrapper supplies it (`hooks/chat/use-conversation-list-model.ts`), so the
   * sidebar and ⌘K rank the same query the same way; omitting it falls back to
   * the plain substring rank, which is what the pure model's own tests use.
   */
  scoreTitle?: ConversationTitleScorer
}

/**
 * Title relevance for one search hit: higher is better, `null` means the title
 * does not match at all. `timestamp` lets a ranker fold in recency.
 */
export type ConversationTitleScorer = (
  title: string,
  /** Already trimmed and lower-cased by the model. */
  needle: string,
  /** The row's timestamp, for rankers that fold in recency. */
  timestamp: number | undefined,
  /** The model's injected clock, so a recency term stays deterministic. */
  now: number
) => number | null

export interface ConversationListModel {
  sections: ConversationSection[]
  /**
   * Sessions in the current view (after the archive filter, before quick
   * filters and search). `total === 0` means "this view is genuinely empty" —
   * which is what separates the first-run empty state from "your filters
   * matched nothing".
   */
  total: number
  /**
   * Sessions that survived the quick filters *and* search — whether or not the
   * section holding them is folded open.
   *
   * This, not {@link visibleCount}, is what decides between "your filters
   * matched nothing" and "there is something here": collapsing every group
   * would otherwise read as an empty result and offer to clear filters that
   * were never the problem.
   */
  filteredCount: number
  /**
   * Sessions actually on screen — {@link orderedIds} length, so rows inside a
   * collapsed folder or group are excluded. This is the number the "showing
   * N of M" chip reports; `filteredCount` counts rows the user cannot see.
   */
  visibleCount: number
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
    axis?: ConversationGroupAxis
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
 * Whether `session` carries a manual rank that applies inside `sectionKey`.
 *
 * A rank tagged with another section is ignored — otherwise an order set in one
 * date bucket would pin the session to the top of every bucket it later
 * migrates into. Legacy rows written before the tag existed (`manualOrderSection
 * == null`) keep working inside whichever section they sit in today.
 */
function manualRankIn(session: ChatSession, sectionKey: string): number | null {
  if (session.manualOrder == null) return null
  if (session.manualOrderSection != null && session.manualOrderSection !== sectionKey) return null
  return session.manualOrder
}

/**
 * Order one section's rows: the hand-dragged arrangement first, with everything
 * that arrived after it slotted in by the active sort.
 *
 * A manual order covers exactly the rows that were on screen when the user made
 * it — `setSessionOrder` renumbers the whole section — so a row *without* a rank
 * for this section arrived later: a conversation that was just created, just
 * pinned, just filed into this folder, just un-archived, or one a quick filter
 * was hiding while the drag happened.
 *
 * Such a row is inserted where the active sort puts it **relative to the ranked
 * rows** (a conversation newer than every ranked row lands first), rather than
 * appended after them. Appending is what made a brand-new chat show up at the
 * *bottom* of a bucket that had ever been dragged, and a freshly pinned one at
 * the bottom of the Pinned block — the opposite of what recency promises.
 *
 * Only recency honors a manual order at all ({@link sortSupportsManualOrder});
 * every other mode derives its order from session data, so a hand-placed row
 * would silently contradict the axis the user just chose.
 *
 * Sorts `sessions` in place and returns it — every caller passes an array it
 * just built.
 */
function orderSectionSessions(
  sessions: ChatSession[],
  sectionKey: string,
  sortBy: ConversationSortBy,
  unreadIds: ReadonlySet<string> | undefined
): ChatSession[] {
  const base = comparatorFor(sortBy, unreadIds)
  if (!sortSupportsManualOrder(sortBy)) return sessions.sort(base)

  const ranked: ChatSession[] = []
  const loose: ChatSession[] = []
  for (const session of sessions) {
    if (manualRankIn(session, sectionKey) != null) ranked.push(session)
    else loose.push(session)
  }
  // Nothing to interleave — one comparator decides the whole section.
  if (ranked.length === 0) return sessions.sort(base)
  const byRank = (a: ChatSession, b: ChatSession) =>
    manualRankIn(a, sectionKey)! - manualRankIn(b, sectionKey)! || base(a, b)
  if (loose.length === 0) return sessions.sort(byRank)

  ranked.sort(byRank)
  loose.sort(base)
  // Each un-ranked row goes just before the first arranged row it outranks
  // under the active sort — so a conversation newer than every arranged row
  // opens the section, and one older than all of them closes it. `loose` is
  // sorted, and the slot it resolves to only ever moves forward as the rows get
  // older, so one shared pointer walks the arranged block exactly once.
  const slotOf = new Map<string, number>()
  let slot = 0
  for (const session of loose) {
    while (slot < ranked.length && base(ranked[slot]!, session) < 0) slot += 1
    slotOf.set(session.id, slot)
  }
  const merged: ChatSession[] = []
  let next = 0
  for (let i = 0; i <= ranked.length; i++) {
    while (next < loose.length && slotOf.get(loose[next]!.id) === i) merged.push(loose[next++]!)
    if (i < ranked.length) merged.push(ranked[i]!)
  }
  return merged
}

/**
 * The timestamp the list reads this session's "when" from, under `basis`.
 *
 * Creation time falls back to activity when a legacy row carries no
 * `createdAt`: a bucket header is better slightly wrong than absent, and the
 * row would otherwise land in "older" forever.
 */
export function conversationTimeOf(session: ChatSession, basis: ConversationTimeBasis): number {
  if (basis === "created") return session.createdAt ?? activityAt(session)
  return activityAt(session)
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

/**
 * Result tiers. Every title hit outranks every content-only hit, whatever the
 * scores inside each tier — a fuzzy title hit scoring 0.2 must still beat a
 * strong message match, because the user typed a name, not a sentence.
 */
const TIER_TITLE = 0
const TIER_CONTENT_ONLY = 1

/**
 * Fallback ranker used when no {@link ConversationTitleScorer} is injected:
 * the plain substring rank, inverted so higher stays better.
 */
function substringScore(title: string, needle: string): number | null {
  const rank = titleMatchRank(title, needle)
  return rank === null ? null : 2 - rank
}

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
 * Whether `folder` may hold `session`.
 *
 * A folder is workspace-scoped (`listFolders` reads one workspace's rows), so
 * the list only ever carries the active workspace's folders while the session
 * list may span every workspace (`groupBy: "workspace"`). Without this check a
 * conversation filed — by drag or menu — into another workspace's folder would
 * render under that folder here and vanish from it the moment the user switched
 * workspaces. Both sides are optional (folders and sessions both predate
 * workspace isolation), so the check only rejects when the two are known and
 * disagree.
 */
function folderAcceptsSession(folder: SessionFolder, session: ChatSession): boolean {
  return !folder.projectId || !session.projectId || folder.projectId === session.projectId
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
 * - A non-empty `query` collapses everything to a single flat `search` section,
 *   title hits ranked ahead of content-only hits and ordered inside each tier by
 *   `scoreTitle` (the shared ⌘K ranker when injected, plain substring rank
 *   otherwise) — no buckets/folders.
 * - Otherwise: pinned float to the top (incl. pinned-and-foldered); remaining
 *   foldered sessions group under their folder (folders always shown, even
 *   empty, in `order` then name); the rest go through `groupBy`.
 * - Empty date/group/pinned sections are omitted; folder sections are always
 *   emitted so the UI can render headers + empty states.
 *
 * Date buckets follow the sort axis, never a second one of their own: `created`
 * buckets by creation time (and the renderer says so in the header), `oldest`
 * reverses the header order along with the rows, and `title` / `unread` — which
 * have no date axis at all — fall back to one flat `recent` section.
 *
 * `groupBy: "workspace"` additionally sorts the active workspace first and
 * starts every other workspace collapsed. Inside every section rows follow
 * `sortBy` (recency by default, the only mode honoring a manual drag order);
 * a row with no rank for the section it renders in — one that arrived after the
 * drag — is slotted in by that sort rather than appended (see
 * {@link orderSectionSessions}).
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
    teams = EMPTY_GROUPS,
    activeWorkspaceId = null,
    groupCollapseOverrides = EMPTY_COLLAPSE_OVERRIDES,
    contentMatchIds,
    searchIncludesArchived = false,
    sortBy = "recent",
    filters,
    unreadIds,
    filterContext,
    scoreTitle,
  } = opts
  const needle = query.trim().toLowerCase()
  // Which timestamp everything downstream reads: the buckets, their headers,
  // and the activity filter all follow the sort axis so they cannot disagree.
  const timeBasis = resolveConversationTimeBasis(sortBy)
  const resolvedFilters = filters ? resolveConversationFilters(filters) : EMPTY_CONVERSATION_FILTERS
  const activeFilterCount = countActiveConversationFilters(resolvedFilters)

  // `subagent` sessions (ADR-0062) are hidden imported-subagent inner
  // transcripts — never listed, bucketed, or matched by search on any surface
  // (desktop + mobile both flow through here).
  const listable = dedupeSessionsById(sessions).filter((s) => s.kind !== "subagent")
  const viewed = listable.filter((s) =>
    view === "archived" ? s.archivedAt != null : s.archivedAt == null
  )
  // `total` counts the *view*, deliberately before quick filters: it is what
  // separates "you have no archived conversations" from "your filters matched
  // nothing", and those need different empty states. It stays the view's own
  // count even when a query reaches past the archive split — a hit from the
  // other side is not evidence that this view has something in it.
  const total = viewed.length

  // A query may reach past the archive split; browsing never does. Keeping the
  // two apart is what stops the archived *view* and the search *reach* from
  // being two controls for one thing: one decides what you are looking at, the
  // other decides what a query is allowed to find.
  const pool = needle && searchIncludesArchived ? listable : viewed

  // Quick filters narrow everything downstream — search, buckets, and the
  // section counts alike — so a count on screen always describes what is on
  // screen.
  const candidates = activeFilterCount
    ? pool.filter((s) =>
        matchesConversationFilters(s, resolvedFilters, unreadIds, {
          now,
          timeBasis,
          modelOf: filterContext?.modelOf,
          providerOf: filterContext?.providerOf,
        })
      )
    : pool

  // Search mode: flat result list, no grouping. A session matches when its
  // title matches OR (content search) its id is in `contentMatchIds`, ranked
  // by how directly the title matched so the obvious hit is never buried.
  if (needle) {
    const contentOnly = new Set<string>()
    const ranked: Array<{ session: ChatSession; tier: number; score: number }> = []
    for (const session of candidates) {
      const score = scoreTitle
        ? scoreTitle(session.title ?? "", needle, activityAt(session), now)
        : substringScore(session.title ?? "", needle)
      if (score !== null) {
        ranked.push({ session, tier: TIER_TITLE, score })
      } else if (contentMatchIds?.has(session.id)) {
        contentOnly.add(session.id)
        ranked.push({ session, tier: TIER_CONTENT_ONLY, score: 0 })
      }
    }
    const tiebreak = comparatorFor(sortBy, unreadIds)
    ranked.sort((a, b) => a.tier - b.tier || b.score - a.score || tiebreak(a.session, b.session))
    const matched = ranked.map((entry) => entry.session)
    return {
      sections: matched.length ? [{ kind: "search", sessions: matched }] : [],
      total,
      filteredCount: matched.length,
      visibleCount: matched.length,
      orderedIds: matched.map((s) => s.id),
      activeFilterCount,
      contentOnlyIds: contentOnly,
    }
  }

  const sections: ConversationSection[] = []
  const orderIn = (list: ChatSession[], key: string) =>
    orderSectionSessions(list, key, sortBy, unreadIds)

  // 1. Pinned float to the top (regardless of folder).
  const pinned = orderIn(
    candidates.filter((s) => s.pinned),
    "pinned"
  )
  if (pinned.length) sections.push({ kind: "pinned", sessions: pinned })

  const rest = candidates.filter((s) => !s.pinned)

  // 2. Folders (always shown, ordered) for non-pinned foldered sessions.
  const folderById = new Map(folders.map((f) => [f.id, f]))
  const byFolder = new Map<string, ChatSession[]>()
  const loose: ChatSession[] = []
  for (const s of rest) {
    const folder = s.folderId ? folderById.get(s.folderId) : undefined
    if (folder && folderAcceptsSession(folder, s)) {
      const bucket = byFolder.get(folder.id)
      if (bucket) bucket.push(s)
      else byFolder.set(folder.id, [s])
    } else {
      // Loose, pointing at a deleted folder, or filed into a folder that
      // belongs to another workspace → falls back to the primary grouping.
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
      sessions: orderIn(byFolder.get(folder.id) ?? [], `folder:${folder.id}`),
      collapsed: collapsedFolderIds.has(folder.id),
    })
  }

  // 3. Remaining loose sessions, along the chosen primary axis.
  // `title` and `unread` have no date axis, so date buckets would put headers on
  // a list they do not explain — those modes render one flat section instead.
  const dateAxisApplies = sortSupportsDateBuckets(sortBy)
  if (groupBy === "none" || (groupBy === "date" && !dateAxisApplies)) {
    if (loose.length) sections.push({ kind: "recent", sessions: orderIn(loose, "recent") })
  } else if (groupBy === "workspace" || groupBy === "agent" || groupBy === "team") {
    const axis: ConversationGroupAxis = groupBy
    const order =
      axis === "workspace"
        ? orderWorkspaces(workspaces, activeWorkspaceId)
        : axis === "agent"
          ? [...agents]
          : [...teams]
    const grouped = groupSessions(loose, order, (s) =>
      axis === "workspace" ? s.projectId : axis === "agent" ? s.characterId : s.teamId
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
        sessions: orderIn(members, key),
        collapsed: groupCollapseOverrides[key] ?? collapsedByDefault,
      })
    }
  } else {
    const buckets = new Map<DateBucket, ChatSession[]>()
    for (const s of loose) {
      const bucket = dateBucketFor(now, conversationTimeOf(s, timeBasis))
      const list = buckets.get(bucket)
      if (list) list.push(s)
      else buckets.set(bucket, [s])
    }
    // Oldest-first orders the rows *and* the headers: leaving "Today" on top
    // while the rows under it ran oldest-first was the same disagreement the
    // basis fixes one level down.
    const bucketOrder = sortBy === "oldest" ? [...DATE_BUCKET_ORDER].reverse() : DATE_BUCKET_ORDER
    for (const bucket of bucketOrder) {
      const list = buckets.get(bucket)
      if (list?.length)
        sections.push({
          kind: "date",
          bucket,
          sessions: orderIn(list, `date:${bucket}`),
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
    visibleCount: orderedIds.length,
    orderedIds,
    activeFilterCount,
    contentOnlyIds: EMPTY_ID_SET,
  }
}
