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
 * section and the headers stay one control: title A–Z, creation newest first,
 * and last activity, which flips between newest and oldest on a second click.
 */
export function sortForColumn(
  current: ConversationSortBy,
  column: ConversationManagerSortColumn
): ConversationSortBy {
  switch (column) {
    case "title":
      return "title"
    case "created":
      return "created"
    case "activity":
      return current === "recent" ? "oldest" : "recent"
  }
}

/** `aria-sort` for `column`'s header under `sortBy`. */
export function ariaSortForColumn(
  sortBy: ConversationSortBy,
  column: ConversationManagerSortColumn
): "ascending" | "descending" | "none" {
  if (column === "title") return sortBy === "title" ? "ascending" : "none"
  if (column === "created") return sortBy === "created" ? "descending" : "none"
  if (sortBy === "recent") return "descending"
  if (sortBy === "oldest") return "ascending"
  return "none"
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
