import { differenceInCalendarDays } from "date-fns"

import type { ChatSession, SessionFolder } from "@cognia/agent-config-types"

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

export type ConversationSection =
  | { kind: "pinned"; sessions: ChatSession[] }
  | { kind: "folder"; folder: SessionFolder; sessions: ChatSession[]; collapsed: boolean }
  | { kind: "date"; bucket: DateBucket; sessions: ChatSession[] }
  // Flat "recent" list emitted instead of date buckets when `groupByDate` is off.
  | { kind: "recent"; sessions: ChatSession[] }
  | { kind: "search"; sessions: ChatSession[] }

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
   * Group loose sessions into relative date buckets. Defaults to `true`.
   * When `false`, loose sessions collapse into a single flat `recent` section.
   */
  groupByDate?: boolean
  /**
   * Optional set of session ids whose message *content* matched the query
   * (resolved async by the caller). In search mode a session matches when its
   * title matches OR its id is in this set. Undefined = title-only search.
   */
  contentMatchIds?: ReadonlySet<string>
}

export interface ConversationListModel {
  sections: ConversationSection[]
  /** Sessions in the current view (after archive filter, before search). */
  total: number
  /** Sessions actually shown (= matched when searching, else `total`). */
  filteredCount: number
  /** Flattened, render-ordered session ids — drives range selection. */
  orderedIds: string[]
}

/**
 * Sort newest-first with stable tie-breakers.
 *
 * Dexie's index order is not a display-order contract when several rows share
 * the same millisecond `updatedAt`. Without a total ordering, a live-query
 * refresh can hand us those equal rows in a different order, making the
 * conversation list visibly swap them while the user is creating or switching
 * chats.
 */
function byRecent(a: ChatSession, b: ChatSession): number {
  return (
    (b.updatedAt ?? 0) - (a.updatedAt ?? 0) ||
    (b.createdAt ?? 0) - (a.createdAt ?? 0) ||
    a.id.localeCompare(b.id)
  )
}

/**
 * Stable identity of one conversation-list section, stored alongside
 * `manualOrder` (see `ChatSession.manualOrderSection`) so a manual order only
 * applies inside the section it was dragged in. Without the key, an order set
 * in one date bucket would pin the session to the top of every bucket it later
 * migrates into (today → yesterday → …), permanently overriding recency.
 */
export function conversationSectionKey(
  section: Pick<ConversationSection, "kind"> & { folder?: SessionFolder; bucket?: DateBucket }
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
  }
}

/**
 * Comparator factory: sort a section by `manualOrder` (ascending) first —
 * honored only for rows whose `manualOrderSection` matches this section —
 * falling back to recency for un-dragged rows and for orders that were set in
 * a different section (legacy rows without a section key keep working inside
 * whichever section they sit in today).
 */
function byManualThenRecent(sectionKey: string): (a: ChatSession, b: ChatSession) => number {
  const orderOf = (s: ChatSession): number =>
    s.manualOrder != null && (s.manualOrderSection == null || s.manualOrderSection === sectionKey)
      ? s.manualOrder
      : Number.POSITIVE_INFINITY
  return (a, b) => {
    const ao = orderOf(a)
    const bo = orderOf(b)
    if (ao !== bo) return ao - bo
    return byRecent(a, b)
  }
}

/** Map a session's `updatedAt` to its relative date bucket (local calendar). */
export function dateBucketFor(now: number, updatedAt: number): DateBucket {
  // Future timestamps (clock skew) clamp to "today".
  const days = differenceInCalendarDays(now, updatedAt)
  if (days <= 0) return "today"
  if (days === 1) return "yesterday"
  if (days <= 7) return "prev7"
  if (days <= 30) return "prev30"
  return "older"
}

function matchesQuery(session: ChatSession, needle: string): boolean {
  return (session.title ?? "").toLowerCase().includes(needle)
}

/**
 * Build the ordered section list for the conversation list.
 *
 * Rules (precedence **pinned > folder > date**; each session in exactly one
 * section):
 * - `view` filters by archive state first.
 * - A non-empty `query` collapses everything to a single flat `search` section
 *   (title substring, case-insensitive), newest-first — no buckets/folders.
 * - Otherwise: pinned float to the top (incl. pinned-and-foldered); remaining
 *   foldered sessions group under their folder (folders always shown, even
 *   empty, in `order` then name); the rest fall into date buckets.
 * - Empty date/pinned sections are omitted; folder sections are always emitted
 *   so the UI can render headers + empty states.
 */
export function buildConversationSections(
  sessions: readonly ChatSession[],
  folders: readonly SessionFolder[],
  opts: BuildSectionsOptions
): ConversationListModel {
  const { query, view, now, collapsedFolderIds, groupByDate = true, contentMatchIds } = opts
  const needle = query.trim().toLowerCase()

  const viewed = sessions.filter(
    (s) =>
      // `subagent` sessions (ADR-0062) are hidden imported-subagent inner
      // transcripts — never listed, bucketed, or matched by search on any
      // surface (desktop + mobile both flow through here).
      s.kind !== "subagent" && (view === "archived" ? s.archivedAt != null : s.archivedAt == null)
  )
  const total = viewed.length

  // Search mode: flat result list, no grouping. A session matches when its
  // title matches OR (content search) its id is in `contentMatchIds`.
  if (needle) {
    const matched = viewed
      .filter((s) => matchesQuery(s, needle) || (contentMatchIds?.has(s.id) ?? false))
      .sort(byRecent)
    return {
      sections: matched.length ? [{ kind: "search", sessions: matched }] : [],
      total,
      filteredCount: matched.length,
      orderedIds: matched.map((s) => s.id),
    }
  }

  const sections: ConversationSection[] = []

  // 1. Pinned float to the top (regardless of folder).
  const pinned = viewed.filter((s) => s.pinned).sort(byManualThenRecent("pinned"))
  if (pinned.length) sections.push({ kind: "pinned", sessions: pinned })

  const rest = viewed.filter((s) => !s.pinned)

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
      sessions: (byFolder.get(folder.id) ?? []).sort(byManualThenRecent(`folder:${folder.id}`)),
      collapsed: collapsedFolderIds.has(folder.id),
    })
  }

  // 3. Remaining loose sessions: date buckets, or a single flat "recent" list
  //    when date grouping is disabled.
  if (!groupByDate) {
    if (loose.length)
      sections.push({ kind: "recent", sessions: loose.sort(byManualThenRecent("recent")) })
  } else {
    const buckets = new Map<DateBucket, ChatSession[]>()
    for (const s of loose) {
      const bucket = dateBucketFor(now, s.updatedAt ?? 0)
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
          sessions: list.sort(byManualThenRecent(`date:${bucket}`)),
        })
    }
  }

  // Flatten in render order for range-selection / keyboard nav — but skip the
  // members of a collapsed folder: they aren't rendered, so navigating or
  // range-selecting onto a hidden row would be surprising.
  const orderedIds: string[] = []
  for (const sec of sections) {
    if (sec.kind === "folder" && sec.collapsed) continue
    for (const s of sec.sessions) orderedIds.push(s.id)
  }

  return {
    sections,
    total,
    filteredCount: total,
    orderedIds,
  }
}
