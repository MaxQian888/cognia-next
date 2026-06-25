import { differenceInCalendarDays } from "date-fns"

import type { ChatSession, SessionFolder } from "@/lib/claude/types"

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

/** Sort newest-first by `updatedAt`. */
function byRecent(a: ChatSession, b: ChatSession): number {
  return (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
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
  const { query, view, now, collapsedFolderIds } = opts
  const needle = query.trim().toLowerCase()

  const viewed = sessions.filter((s) =>
    view === "archived" ? s.archivedAt != null : s.archivedAt == null
  )
  const total = viewed.length

  // Search mode: flat result list, no grouping.
  if (needle) {
    const matched = viewed.filter((s) => matchesQuery(s, needle)).sort(byRecent)
    return {
      sections: matched.length ? [{ kind: "search", sessions: matched }] : [],
      total,
      filteredCount: matched.length,
      orderedIds: matched.map((s) => s.id),
    }
  }

  const sections: ConversationSection[] = []

  // 1. Pinned float to the top (regardless of folder).
  const pinned = viewed.filter((s) => s.pinned).sort(byRecent)
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
      sessions: (byFolder.get(folder.id) ?? []).sort(byRecent),
      collapsed: collapsedFolderIds.has(folder.id),
    })
  }

  // 3. Date buckets for the remaining loose sessions.
  const buckets = new Map<DateBucket, ChatSession[]>()
  for (const s of loose) {
    const bucket = dateBucketFor(now, s.updatedAt ?? 0)
    const list = buckets.get(bucket)
    if (list) list.push(s)
    else buckets.set(bucket, [s])
  }
  for (const bucket of DATE_BUCKET_ORDER) {
    const list = buckets.get(bucket)
    if (list?.length) sections.push({ kind: "date", bucket, sessions: list.sort(byRecent) })
  }

  return {
    sections,
    total,
    filteredCount: total,
    orderedIds: sections.flatMap((sec) => sec.sessions.map((s) => s.id)),
  }
}
