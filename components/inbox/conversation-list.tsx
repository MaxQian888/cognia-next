"use client"

/**
 * Conversation list for the Inbox middle pane.
 *
 * Sort order:
 *  1. Pinned (conversationOverrides.pinned === true) — sorted by updatedAt desc.
 *  2. Unread (unreadCount > 0) — sorted by updatedAt desc.
 *  3. Read — sorted by updatedAt desc.
 *  4. Archived — hidden by default; toggle at bottom to show.
 *
 * Each session is enriched (via the `[sessionId+createdAt]` index) with the
 * latest-message preview + timestamp and a real unread count (messages newer
 * than the last-read pointer). Pending-draft counts come from the shared
 * `usePendingDraftCounts` subscriber so rows can badge without each opening
 * their own query. Rows render with a reduced-motion-aware stagger.
 */

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import Dexie from "dexie"
import { motion, useReducedMotion } from "motion/react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import { Toggle } from "@/components/ui/toggle"
import { getDb } from "@/lib/db/schema"
import { extractPlainText } from "@/lib/inbox/extract-plain-text"
import { STAGGER_CONTAINER, STAGGER_CHILD } from "@/lib/ui/motion"
import { usePendingDraftCounts } from "@/hooks/connectors/use-pending-drafts"
import { ConversationSearchInput } from "./search/conversation-search-input"
import { ConversationRow, type ConversationRowItem } from "./conversation-row"

type FilterChip = "unread" | "pinned"

interface ConversationListProps {
  adapterId?: string
  platformKind?: string
  activeConversationKey?: string
}

/**
 * Predicate factory used by the render-time filter. Combines:
 *   - text query (case-insensitive substring over title, conversationKey, and
 *     last-message preview);
 *   - active filter chips (unread / pinned), AND-combined when both set.
 */
function buildFilterPredicate(
  query: string,
  chips: Set<FilterChip>
): (item: ConversationRowItem) => boolean {
  const needle = query.trim().toLowerCase()
  const wantUnread = chips.has("unread")
  const wantPinned = chips.has("pinned")
  return (item) => {
    if (wantUnread && item.unreadCount <= 0) return false
    if (wantPinned && !item.override?.pinned) return false
    if (!needle) return true
    const ck = item.session.platformBinding?.conversationKey ?? ""
    const hay = [item.session.title, ck, item.lastMessagePreview ?? ""]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
    return hay.includes(needle)
  }
}

export function ConversationList({
  adapterId,
  platformKind,
  activeConversationKey,
}: ConversationListProps) {
  const router = useRouter()
  const t = useTranslations("inbox.conversationList")
  const reduce = useReducedMotion()
  const draftCounts = usePendingDraftCounts()
  const [showArchived, setShowArchived] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [activeChips, setActiveChips] = useState<Set<FilterChip>>(() => new Set())

  // Load all platform-bound sessions + their overrides, then enrich each with
  // the latest message (preview + timestamp) and a real unread count using the
  // `[sessionId+createdAt]` index. Re-runs when the scope or any sessions /
  // overrides / messages change.
  const enriched = useLiveQuery<ConversationRowItem[]>(async () => {
    if (typeof window === "undefined") return []
    const db = getDb()

    let sessions = await db.sessions.filter((s) => s.platformBinding != null).toArray()
    if (adapterId) {
      sessions = sessions.filter((s) => s.platformBinding?.adapterId === adapterId)
    }
    if (platformKind) {
      sessions = sessions.filter((s) => s.platformBinding?.platform === platformKind)
    }

    const overrides = await db.conversationOverrides.toArray()
    const overrideMap = new Map(overrides.map((o) => [o.conversationKey, o]))

    const items: ConversationRowItem[] = []
    for (const session of sessions) {
      const ck = session.platformBinding!.conversationKey
      const override = overrideMap.get(ck)
      const lastReadAt = override?.lastReadAt ?? 0

      const latest = await db.messages
        .where("[sessionId+createdAt]")
        .between([session.id, Dexie.minKey], [session.id, Dexie.maxKey])
        .last()

      // Messages strictly newer than the last-read pointer (lowerOpen=true).
      const unreadCount = await db.messages
        .where("[sessionId+createdAt]")
        .between([session.id, lastReadAt], [session.id, Dexie.maxKey], false, true)
        .count()

      items.push({
        session,
        override,
        unreadCount,
        lastMessagePreview: latest ? extractPlainText(latest.parts).slice(0, 240) : undefined,
        lastMessageAt: latest?.createdAt,
      })
    }
    return items
  }, [adapterId, platformKind])

  const buckets = useMemo(() => {
    if (!enriched) return null
    const predicate = buildFilterPredicate(searchQuery, activeChips)
    const filtered = enriched.filter(predicate)

    const pinned: ConversationRowItem[] = []
    const unread: ConversationRowItem[] = []
    const read: ConversationRowItem[] = []
    const archived: ConversationRowItem[] = []
    for (const item of filtered) {
      if (item.override?.archived) archived.push(item)
      else if (item.override?.pinned) pinned.push(item)
      else if (item.unreadCount > 0) unread.push(item)
      else read.push(item)
    }
    const sortByUpdated = (a: ConversationRowItem, b: ConversationRowItem) =>
      b.session.updatedAt - a.session.updatedAt
    pinned.sort(sortByUpdated)
    unread.sort(sortByUpdated)
    read.sort(sortByUpdated)
    archived.sort(sortByUpdated)
    return { pinned, unread, read, archived }
  }, [enriched, searchQuery, activeChips])

  if (!enriched || !buckets) {
    return (
      <div className="flex flex-col gap-1 p-3" data-testid="conversation-list-loading">
        {Array.from({ length: 6 }).map((_, idx) => (
          <Skeleton key={idx} className="h-12 w-full rounded-md" />
        ))}
      </div>
    )
  }

  const { pinned, unread, read, archived } = buckets
  const visibleRows = [...pinned, ...unread, ...read, ...(showArchived ? archived : [])]

  const isFiltering = Boolean(searchQuery.trim()) || activeChips.size > 0
  const emptyState =
    visibleRows.length === 0
      ? isFiltering
        ? {
            primary: t("emptyFiltered.title"),
            secondary: t("emptyFiltered.description"),
            reset: () => {
              setSearchQuery("")
              setActiveChips(new Set())
            },
          }
        : { primary: t("empty"), secondary: null, reset: null }
      : null

  const toggleChip = (chip: FilterChip) => {
    setActiveChips((prev) => {
      const next = new Set(prev)
      if (next.has(chip)) next.delete(chip)
      else next.add(chip)
      return next
    })
  }

  const handleSelect = (ck: string) => {
    router.push(`/inbox/c/${encodeURIComponent(ck)}`)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 flex flex-col gap-2 border-b px-3 py-2">
        <div className="flex items-center gap-1">
          <SidebarTrigger
            className="-ml-1 size-9 md:hidden"
            aria-label={t("openSidebar")}
            data-testid="conversation-list-open-sidebar"
          />
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {t("header")}
          </h3>
        </div>
        <ConversationSearchInput value={searchQuery} onDebouncedChange={setSearchQuery} />
        <div
          className="flex flex-wrap items-center gap-1"
          role="group"
          aria-label={t("filter.aria")}
          data-testid="conversation-filter-chips"
        >
          <Toggle
            size="sm"
            pressed={activeChips.has("unread")}
            onPressedChange={() => toggleChip("unread")}
            aria-label={t("filter.tooltip.unread")}
            data-testid="conversation-filter-unread"
            className="h-6 px-2 text-xs data-[state=on]:bg-primary/15"
          >
            {t("filter.unread")}
          </Toggle>
          <Toggle
            size="sm"
            pressed={activeChips.has("pinned")}
            onPressedChange={() => toggleChip("pinned")}
            aria-label={t("filter.tooltip.pinned")}
            data-testid="conversation-filter-pinned"
            className="h-6 px-2 text-xs data-[state=on]:bg-primary/15"
          >
            {t("filter.pinned")}
          </Toggle>
        </div>
      </div>

      <ScrollArea className="flex-1">
        {emptyState ? (
          <div className="px-3 py-4 text-center" data-testid="conversation-list-empty">
            <p className="text-xs text-muted-foreground">{emptyState.primary}</p>
            {emptyState.secondary && (
              <p className="mt-1 text-[11px] text-muted-foreground/80">{emptyState.secondary}</p>
            )}
            {emptyState.reset && (
              <Button
                variant="link"
                size="sm"
                className="mt-2 h-6 px-1 text-xs"
                onClick={emptyState.reset}
                data-testid="conversation-filter-reset"
              >
                {t("emptyFiltered.reset")}
              </Button>
            )}
          </div>
        ) : (
          <motion.ul
            className="py-1"
            initial={reduce ? false : "initial"}
            animate="animate"
            variants={STAGGER_CONTAINER}
            data-testid="conversation-list"
          >
            {visibleRows.map((item) => {
              const ck = item.session.platformBinding!.conversationKey
              return (
                <motion.li key={item.session.id} variants={STAGGER_CHILD}>
                  <ConversationRow
                    item={item}
                    draftCount={draftCounts.get(ck) ?? 0}
                    isActive={ck === activeConversationKey}
                    onSelect={handleSelect}
                  />
                </motion.li>
              )
            })}
          </motion.ul>
        )}
      </ScrollArea>

      {archived.length > 0 && (
        <div className="shrink-0 border-t px-3 py-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-xs"
            onClick={() => setShowArchived((v) => !v)}
          >
            {showArchived ? t("hideArchived") : t("showArchived", { count: archived.length })}
          </Button>
        </div>
      )}
    </div>
  )
}
