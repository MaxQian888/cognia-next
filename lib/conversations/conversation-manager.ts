/**
 * The conversation manager page (`/conversations`, ADR-0213) — the pure rules
 * its tabs, deep links and sortable columns follow. The rows themselves come
 * from the shared list model (`buildConversationSections`, `flat` mode).
 */

import type { ChatSession, ConversationSortBy } from "@cognia/agent-config-types"

export const CONVERSATION_MANAGER_ROUTE = "/conversations"

/** Active conversations, then the archive — the same split the lists browse. */
export const CONVERSATION_MANAGER_TABS = ["active", "archived"] as const
export type ConversationManagerTab = (typeof CONVERSATION_MANAGER_TABS)[number]

export function isConversationManagerTab(value: unknown): value is ConversationManagerTab {
  return (
    typeof value === "string" && (CONVERSATION_MANAGER_TABS as readonly string[]).includes(value)
  )
}

/** The deep link to a tab. The active tab is the page's own address. */
export function conversationManagerHref(tab: ConversationManagerTab = "active"): string {
  return tab === "archived"
    ? `${CONVERSATION_MANAGER_ROUTE}?tab=archived`
    : CONVERSATION_MANAGER_ROUTE
}

/** Rows drawn per "Show more" step; keeps a long history's first paint cheap. */
export const CONVERSATION_MANAGER_PAGE_SIZE = 100

/** The columns a header click sorts by. */
export const CONVERSATION_MANAGER_SORT_COLUMNS = ["title", "activity", "created"] as const
export type ConversationManagerSortColumn = (typeof CONVERSATION_MANAGER_SORT_COLUMNS)[number]

/**
 * The order a click on `column`'s header asks for. Every column maps onto the
 * list model's own sorts (`ConversationSortBy`), so the filter menu's sort
 * section and the headers stay one control. A first click picks the column's
 * natural order — title A–Z, newest created, most recent activity — and a
 * click on the column already sorting reverses it.
 */
export function sortForColumn(
  current: ConversationSortBy,
  column: ConversationManagerSortColumn
): ConversationSortBy {
  switch (column) {
    case "title":
      return current === "title" ? "titleDesc" : "title"
    case "created":
      return current === "created" ? "createdAsc" : "created"
    case "activity":
      return current === "recent" ? "oldest" : "recent"
  }
}

/**
 * The archive's own order: when conversations were archived. Only the
 * Archived tab has the axis, so it lives beside the shared sorts instead of in
 * them — the sidebar and saved views never see it. While it is set it takes
 * over the order; picking any shared sort clears it.
 */
export type ConversationArchiveOrder = "archived" | "archivedAsc"

/** A click on the Archived header: newest first, then the reverse. */
export function archiveOrderForClick(
  current: ConversationArchiveOrder | null
): ConversationArchiveOrder {
  return current === "archived" ? "archivedAsc" : "archived"
}

/** `aria-sort` for the Archived header; unsorted while a query ranks rows. */
export function ariaSortForArchive(
  order: ConversationArchiveOrder | null,
  ranked = false
): "ascending" | "descending" | "none" {
  if (ranked || !order) return "none"
  return order === "archived" ? "descending" : "ascending"
}

/**
 * Re-order rows by when they were archived. Stable: rows archived at the same
 * instant (a bulk archive) keep the order the list model gave them.
 */
export function orderByArchivedAt<T extends Pick<ChatSession, "archivedAt">>(
  rows: readonly T[],
  order: ConversationArchiveOrder
): T[] {
  const sign = order === "archived" ? -1 : 1
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => sign * ((a.row.archivedAt ?? 0) - (b.row.archivedAt ?? 0)) || a.index - b.index)
    .map(({ row }) => row)
}

/**
 * `aria-sort` for `column`'s header under `sortBy`. `ranked` (a search query
 * is ordering rows by relevance, with the sort only breaking ties) leaves every
 * header unsorted, so a header never claims an order the rows do not follow.
 */
export function ariaSortForColumn(
  sortBy: ConversationSortBy,
  column: ConversationManagerSortColumn,
  ranked = false
): "ascending" | "descending" | "none" {
  if (ranked) return "none"
  switch (column) {
    case "title":
      return sortBy === "title" ? "ascending" : sortBy === "titleDesc" ? "descending" : "none"
    case "created":
      return sortBy === "created" ? "descending" : sortBy === "createdAsc" ? "ascending" : "none"
    case "activity":
      return sortBy === "recent" ? "descending" : sortBy === "oldest" ? "ascending" : "none"
  }
}

export interface ConversationManagerCounts {
  active: number
  archived: number
}

/**
 * How many conversations each tab holds, before search and filters — what the
 * tabs and the header say. Hidden subagent transcripts are never listed by any
 * surface (the list model drops them too), so they are not counted.
 */
export function countConversationsByTab(
  sessions: readonly Pick<ChatSession, "archivedAt" | "kind">[]
): ConversationManagerCounts {
  let active = 0
  let archived = 0
  for (const session of sessions) {
    if (session.kind === "subagent") continue
    if (session.archivedAt != null) archived += 1
    else active += 1
  }
  return { active, archived }
}
