/**
 * Sectioning for the Inbox conversation list.
 *
 * The sidebar's grouping toggle used to write `?view=` and nothing read it, so
 * the list was one flat run in every mode. This is the pure half of wiring it:
 * rows in, ordered sections out. The component only draws what comes back, so
 * the ordering rules below are pinned by tests rather than by snapshots.
 *
 * Rules, in order of precedence:
 *
 *  1. Archived and resolved conversations never mix into the live sections.
 *     Each becomes one collapsible TAIL section (archived last), collapsed
 *     unless the user opened it. They used to be two footer buttons; as
 *     sections they read as what they are.
 *  2. `status` grouping splits the live rows into Pinned / Unread / Read.
 *  3. `adapter` and `platform` grouping make one section per adapter or
 *     platform, and order each section's rows pinned → unread → read, so the
 *     triage priority survives the regrouping.
 *  4. Inside any bucket, newest activity first.
 *
 * Empty sections are dropped: a header announcing "Pinned · 0" is chrome.
 */

import type { ChatSession } from "@cognia/agent-config-types"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"
import type { InboxGrouping } from "./inbox-url-state"

/** One conversation as the list renders it. */
export interface ConversationRowItem {
  session: ChatSession
  override: ConversationOverrideRow | undefined
  unreadCount: number
  /** Plaintext snippet of the most recent message, when available. */
  lastMessagePreview?: string
  /** Wall-clock ms of the most recent message, for the relative-time stamp. */
  lastMessageAt?: number
}

export type ConversationSectionKind =
  "pinned" | "unread" | "read" | "adapter" | "platform" | "resolved" | "archived"

export interface ConversationSection {
  /** Stable across renders and sessions; the collapse state is keyed on it. */
  id: string
  kind: ConversationSectionKind
  /** Set on `adapter` sections. */
  adapterId?: string
  /** Set on `adapter` (the adapter's platform, when known) and `platform` sections. */
  platform?: string
  /** The adapter's display name, for `adapter` sections whose adapter row is known. */
  adapterName?: string
  rows: ConversationRowItem[]
  /** Rows with unread messages. */
  unreadCount: number
  /** Archived / resolved: always after the live sections, collapsed by default. */
  tail: boolean
  collapsed: boolean
}

/** The adapter facts grouping needs; `AdapterInstanceRow` satisfies it. */
export interface GroupingAdapter {
  id: string
  displayName: string
  type: string
}

export interface GroupConversationRowsOptions {
  /** Ordered as the sidebar shows them; sections follow the same order. */
  adapters?: readonly GroupingAdapter[]
  /**
   * The user's explicit collapse choices, by section id. A section with no
   * entry falls back to its default: tails collapsed, everything else open.
   */
  collapsed?: Readonly<Record<string, boolean>>
}

/** Section id helpers, exported so other surfaces can address one section. */
export const conversationSectionId = {
  status: (bucket: "pinned" | "unread" | "read") => `status:${bucket}`,
  adapter: (adapterId: string) => `adapter:${adapterId}`,
  platform: (platform: string) => `platform:${platform}`,
  tail: (kind: "resolved" | "archived") => kind,
} as const

/** Most-recent activity: the newest message when known, else the session row. */
export function conversationActivityAt(item: ConversationRowItem): number {
  return Math.max(item.lastMessageAt ?? 0, item.session.updatedAt ?? 0)
}

function byActivity(a: ConversationRowItem, b: ConversationRowItem): number {
  return conversationActivityAt(b) - conversationActivityAt(a)
}

function isArchived(item: ConversationRowItem): boolean {
  return item.session.archivedAt != null
}

function isResolved(item: ConversationRowItem): boolean {
  return item.override?.status === "resolved"
}

/** pinned → unread → read, each newest first. */
export function orderByTriagePriority(rows: readonly ConversationRowItem[]): ConversationRowItem[] {
  const pinned: ConversationRowItem[] = []
  const unread: ConversationRowItem[] = []
  const read: ConversationRowItem[] = []
  for (const row of rows) {
    if (row.session.pinned) pinned.push(row)
    else if (row.unreadCount > 0) unread.push(row)
    else read.push(row)
  }
  return [...pinned.sort(byActivity), ...unread.sort(byActivity), ...read.sort(byActivity)]
}

function countUnread(rows: readonly ConversationRowItem[]): number {
  return rows.reduce((total, row) => total + (row.unreadCount > 0 ? 1 : 0), 0)
}

function makeSection(
  base: Omit<ConversationSection, "unreadCount" | "collapsed">,
  collapsed: Readonly<Record<string, boolean>>
): ConversationSection {
  return {
    ...base,
    unreadCount: countUnread(base.rows),
    collapsed: collapsed[base.id] ?? base.tail,
  }
}

function platformOf(item: ConversationRowItem): string {
  return item.session.platformBinding?.platform ?? "unknown"
}

function adapterOf(item: ConversationRowItem): string {
  return item.session.platformBinding?.adapterId ?? ""
}

/**
 * Group keys in a stable order: the adapters list's order first (so the list
 * mirrors the sidebar), then any key the list does not know, alphabetically.
 * A conversation whose adapter was deleted still has to land somewhere.
 */
function orderedKeys(present: Iterable<string>, preferred: readonly string[]): string[] {
  const remaining = new Set(present)
  const out: string[] = []
  for (const key of preferred) {
    if (remaining.delete(key)) out.push(key)
  }
  return [...out, ...[...remaining].sort((a, b) => a.localeCompare(b))]
}

function bucketBy(
  rows: readonly ConversationRowItem[],
  keyOf: (item: ConversationRowItem) => string
): Map<string, ConversationRowItem[]> {
  const map = new Map<string, ConversationRowItem[]>()
  for (const row of rows) {
    const key = keyOf(row)
    const bucket = map.get(key)
    if (bucket) bucket.push(row)
    else map.set(key, [row])
  }
  return map
}

export function groupConversationRows(
  rows: readonly ConversationRowItem[],
  mode: InboxGrouping,
  options: GroupConversationRowsOptions = {}
): ConversationSection[] {
  const collapsed = options.collapsed ?? {}
  const adapters = options.adapters ?? []

  const live: ConversationRowItem[] = []
  const resolved: ConversationRowItem[] = []
  const archived: ConversationRowItem[] = []
  for (const row of rows) {
    // Archived wins over resolved: an archived conversation is out of the
    // inbox altogether, whatever its lifecycle status says.
    if (isArchived(row)) archived.push(row)
    else if (isResolved(row)) resolved.push(row)
    else live.push(row)
  }

  const sections: ConversationSection[] = []

  if (mode === "status") {
    const pinned = live.filter((row) => row.session.pinned).sort(byActivity)
    const unread = live.filter((row) => !row.session.pinned && row.unreadCount > 0).sort(byActivity)
    const read = live.filter((row) => !row.session.pinned && row.unreadCount <= 0).sort(byActivity)
    for (const [kind, bucket] of [
      ["pinned", pinned],
      ["unread", unread],
      ["read", read],
    ] as const) {
      if (bucket.length === 0) continue
      sections.push(
        makeSection(
          { id: conversationSectionId.status(kind), kind, rows: bucket, tail: false },
          collapsed
        )
      )
    }
  } else if (mode === "adapter") {
    const byAdapter = bucketBy(live, adapterOf)
    const known = new Map(adapters.map((adapter) => [adapter.id, adapter]))
    for (const adapterId of orderedKeys(
      byAdapter.keys(),
      adapters.map((adapter) => adapter.id)
    )) {
      const bucket = byAdapter.get(adapterId) ?? []
      const adapter = known.get(adapterId)
      sections.push(
        makeSection(
          {
            id: conversationSectionId.adapter(adapterId),
            kind: "adapter",
            adapterId,
            adapterName: adapter?.displayName,
            platform: adapter?.type ?? bucket[0]?.session.platformBinding?.platform,
            rows: orderByTriagePriority(bucket),
            tail: false,
          },
          collapsed
        )
      )
    }
  } else {
    const byPlatform = bucketBy(live, platformOf)
    const preferred: string[] = []
    for (const adapter of adapters) {
      if (!preferred.includes(adapter.type)) preferred.push(adapter.type)
    }
    for (const platform of orderedKeys(byPlatform.keys(), preferred)) {
      sections.push(
        makeSection(
          {
            id: conversationSectionId.platform(platform),
            kind: "platform",
            platform,
            rows: orderByTriagePriority(byPlatform.get(platform) ?? []),
            tail: false,
          },
          collapsed
        )
      )
    }
  }

  if (resolved.length > 0) {
    sections.push(
      makeSection(
        {
          id: conversationSectionId.tail("resolved"),
          kind: "resolved",
          rows: resolved.sort(byActivity),
          tail: true,
        },
        collapsed
      )
    )
  }
  if (archived.length > 0) {
    sections.push(
      makeSection(
        {
          id: conversationSectionId.tail("archived"),
          kind: "archived",
          rows: archived.sort(byActivity),
          tail: true,
        },
        collapsed
      )
    )
  }

  return sections
}

/**
 * The rows a reader can currently see, top to bottom: every row of every
 * expanded section, in section order. The keyboard model moves along exactly
 * this sequence, so collapsed sections are skipped rather than walked blind.
 */
export function visibleConversationRows(
  sections: readonly ConversationSection[]
): ConversationRowItem[] {
  return sections.flatMap((section) => (section.collapsed ? [] : section.rows))
}

/** Counts the triage pane's empty state summarises. Tails excluded. */
export interface ConversationListSummary {
  total: number
  unread: number
  pending: number
  snoozed: number
}

export function summarizeConversationRows(
  rows: readonly ConversationRowItem[]
): ConversationListSummary {
  const summary: ConversationListSummary = { total: 0, unread: 0, pending: 0, snoozed: 0 }
  for (const row of rows) {
    if (isArchived(row) || isResolved(row)) continue
    summary.total += 1
    if (row.unreadCount > 0) summary.unread += 1
    if (row.override?.status === "pending") summary.pending += 1
    if (row.override?.status === "snoozed") summary.snoozed += 1
  }
  return summary
}
