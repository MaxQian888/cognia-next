/**
 * Flat render model for the virtualized mobile conversation list.
 *
 * `useConversationListModel` answers in sections (pinned → folders → the
 * chosen axis, or one flat result list while searching). A windowed list needs
 * one addressable sequence instead: a section cannot wrap its rows once most of
 * those rows are not in the DOM. This module flattens the sections into
 * `notice | header | row | folder-empty` items, which is the only shape the
 * virtualizer sees, and it is where the list's visibility rules live:
 *
 *   - A folder with nothing in it is hidden while the list is narrowed (a query
 *     or a quick filter). Its header next to "nothing matched" read as a result.
 *   - The same folder, expanded and un-narrowed, keeps its header and says it
 *     is empty, so a folder the user just made is not an unexplained heading.
 *   - Collapsed folders and groups keep their header and drop their rows.
 *   - Every header carries its row count.
 *
 * Pure and React-free so the rules are testable without a DOM.
 */

import type { ChatSession } from "@cognia/agent-config-types"

import { conversationSectionKey, type ConversationSection } from "@/lib/chat/conversation-list-model"

/** Status lines that sit above the rows, inside the same scroll container. */
export type MobileChannelNotice = "truncated" | "pending" | "empty"

export type MobileChannelListItem =
  | { kind: "notice"; key: string; notice: MobileChannelNotice }
  | {
      kind: "header"
      key: string
      /** `conversationSectionKey` of the section this header opens. */
      sectionKey: string
      section: ConversationSection
      /** Rows the section holds — shown on the header even while collapsed. */
      count: number
    }
  | { kind: "row"; key: string; sectionKey: string; session: ChatSession }
  | { kind: "folder-empty"; key: string; folderId: string }

export interface BuildMobileChannelListItemsInput {
  sections: readonly ConversationSection[]
  /** A query or at least one quick filter is narrowing the list. */
  narrowed: boolean
  /** The message-content search capped or could not finish. */
  truncated: boolean
  /** Nothing to show yet, but the message index is still answering. */
  pending: boolean
  /** Nothing to show, and nothing is still coming. */
  empty: boolean
}

export function rowItemKey(sessionId: string): string {
  return `row:${sessionId}`
}

export function buildMobileChannelListItems({
  sections,
  narrowed,
  truncated,
  pending,
  empty,
}: BuildMobileChannelListItemsInput): MobileChannelListItem[] {
  const items: MobileChannelListItem[] = []
  if (truncated) items.push({ kind: "notice", key: "notice:truncated", notice: "truncated" })
  if (pending) items.push({ kind: "notice", key: "notice:pending", notice: "pending" })
  else if (empty) items.push({ kind: "notice", key: "notice:empty", notice: "empty" })

  for (const section of sections) {
    const sectionKey = conversationSectionKey(section)
    const count = section.sessions.length
    if (count === 0) {
      // Only folders are emitted empty by the model (groups need
      // `emitEmptyGroups`, which this surface does not ask for).
      if (section.kind !== "folder" || narrowed) continue
      items.push({ kind: "header", key: `header:${sectionKey}`, sectionKey, section, count })
      if (!section.collapsed) {
        items.push({
          kind: "folder-empty",
          key: `folder-empty:${section.folder.id}`,
          folderId: section.folder.id,
        })
      }
      continue
    }
    items.push({ kind: "header", key: `header:${sectionKey}`, sectionKey, section, count })
    if ((section.kind === "folder" || section.kind === "group") && section.collapsed) continue
    for (const session of section.sessions) {
      items.push({ kind: "row", key: rowItemKey(session.id), sectionKey, session })
    }
  }
  return items
}

/** Index of a conversation's row in `items`, or -1 when it is not rendered. */
export function findRowIndex(items: readonly MobileChannelListItem[], sessionId: string): number {
  const key = rowItemKey(sessionId)
  return items.findIndex((item) => item.key === key)
}
