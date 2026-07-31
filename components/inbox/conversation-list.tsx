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
import { ChevronRightIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"
import { getDb } from "@/lib/db/schema"
import { useProjectStore } from "@/stores/project/project-store"
import { extractPlainText } from "@/lib/inbox/extract-plain-text"
import { STAGGER_CONTAINER, STAGGER_CHILD } from "@/lib/ui/motion"
import { usePendingDraftCounts } from "@/hooks/connectors/use-pending-drafts"
import { ConversationSearchInput } from "./search/conversation-search-input"
import { ConversationRow, type ConversationRowItem } from "./conversation-row"
import {
  ConversationListFilterMenu,
  type ConversationFilterChip,
} from "./conversation-list-filter-menu"
import { StateCard } from "./state/state-card"

type FilterChip = ConversationFilterChip

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
  const wantPending = chips.has("pending")
  const wantSnoozed = chips.has("snoozed")
  return (item) => {
    if (wantUnread && item.unreadCount <= 0) return false
    if (wantPinned && !item.override?.pinned) return false
    if (wantPending && item.override?.status !== "pending") return false
    if (wantSnoozed && item.override?.status !== "snoozed") return false
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
  // Workspace isolation (Dexie v86): only show conversations whose session
  // belongs to the active workspace. Legacy sessions (no projectId) are
  // grandfathered. Re-runs the live query on a project switch (it's in the deps).
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const draftCounts = usePendingDraftCounts()
  const [showArchived, setShowArchived] = useState(false)
  const [showResolved, setShowResolved] = useState(false)
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
    if (activeProjectId) {
      sessions = sessions.filter((s) => !s.projectId || s.projectId === activeProjectId)
    }
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
  }, [adapterId, platformKind, activeProjectId])

  const buckets = useMemo(() => {
    if (!enriched) return null
    const predicate = buildFilterPredicate(searchQuery, activeChips)
    const filtered = enriched.filter(predicate)

    const pinned: ConversationRowItem[] = []
    const unread: ConversationRowItem[] = []
    const read: ConversationRowItem[] = []
    const archived: ConversationRowItem[] = []
    const resolved: ConversationRowItem[] = []
    for (const item of filtered) {
      // Hidden buckets first: archived, then resolved (a resolved conversation
      // drops out of the active list like an archived one until revealed).
      if (item.override?.archived) archived.push(item)
      else if (item.override?.status === "resolved") resolved.push(item)
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
    resolved.sort(sortByUpdated)
    return { pinned, unread, read, archived, resolved }
  }, [enriched, searchQuery, activeChips])

  const toggleChip = (chip: FilterChip) => {
    setActiveChips((prev) => {
      const next = new Set(prev)
      if (next.has(chip)) next.delete(chip)
      else next.add(chip)
      return next
    })
  }

  // One 48px row — matching `conversation-header.tsx`'s `h-9` seam plus the
  // rail — then a removable-pill strip only while filters are on. This
  // replaces a stacked micro-heading + search + four permanent Toggle chips
  // (~110px of chrome before the first conversation).
  const header = (
    <>
      <div className="flex h-12 shrink-0 items-center gap-1.5 border-b px-2 md:px-3">
        <SidebarTrigger
          className="-ms-1 size-9 shrink-0 md:hidden"
          aria-label={t("openSidebar")}
          data-testid="conversation-list-open-sidebar"
        />
        <ConversationSearchInput
          value={searchQuery}
          onDebouncedChange={setSearchQuery}
          className="min-w-0 flex-1"
        />
        <ConversationListFilterMenu
          active={activeChips}
          onToggle={toggleChip}
          onClear={() => setActiveChips(new Set())}
        />
      </div>
      {activeChips.size > 0 && (
        <div
          className="flex shrink-0 flex-wrap items-center gap-1 border-b px-3 py-1.5"
          role="group"
          aria-label={t("filter.aria")}
          data-testid="conversation-filter-chips"
        >
          {[...activeChips].map((chip) => (
            <Button
              key={chip}
              type="button"
              variant="secondary"
              size="sm"
              className="h-6 gap-1 rounded-full px-2 text-[11px]"
              onClick={() => toggleChip(chip)}
              aria-label={t("filter.remove", { label: t(`filter.${chip}`) })}
              data-testid={`conversation-filter-chip-${chip}`}
            >
              {t(`filter.${chip}`)}
              <XIcon className="size-3" aria-hidden />
            </Button>
          ))}
        </div>
      )}
    </>
  )

  // The header renders during loading too. It used to sit below this early
  // return, so search + filters popped in and shoved the list down on every
  // Inbox open and every project switch.
  if (!enriched || !buckets) {
    return (
      <div className="@container/conversation-list flex h-full min-h-0 flex-col">
        {header}
        <div className="min-h-0 flex-1" data-testid="conversation-list-loading">
          <StateCard.Loading rows={6} />
        </div>
      </div>
    )
  }

  const { pinned, unread, read, archived, resolved } = buckets
  const visibleRows = [
    ...pinned,
    ...unread,
    ...read,
    ...(showResolved ? resolved : []),
    ...(showArchived ? archived : []),
  ]

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

  const handleSelect = (ck: string) => {
    router.push(`/inbox/c?key=${encodeURIComponent(ck)}`)
  }

  return (
    <div className="@container/conversation-list flex h-full min-h-0 flex-col">
      {header}

      <ScrollArea className="flex-1 [&_[data-slot=scroll-area-scrollbar]]:hidden">
        {emptyState ? (
          <div className="px-3 py-4" data-testid="conversation-list-empty">
            <StateCard.Empty title={emptyState.primary} description={emptyState.secondary ?? ""} />
            {emptyState.reset && (
              <Button
                variant="link"
                size="sm"
                className="mt-2 h-6 w-full px-1 text-xs"
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
            aria-label={t("header")}
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

        {/* Hidden buckets live INSIDE the scroller, on one shared seam. As two
            pinned footers they cost ~82px of permanent chrome and read as two
            identical mystery buttons; the disclosure chevron makes them
            collapsed sections instead. */}
        {(resolved.length > 0 || archived.length > 0) && (
          <div className="mt-1 flex flex-wrap items-center gap-1 border-t px-2 py-1.5">
            {resolved.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs font-normal text-muted-foreground"
                onClick={() => setShowResolved((v) => !v)}
                data-testid="conversation-list-toggle-resolved"
              >
                <ChevronRightIcon
                  className={cn("size-3 transition-transform", showResolved && "rotate-90")}
                  aria-hidden
                />
                {showResolved ? t("hideResolved") : t("showResolved", { count: resolved.length })}
              </Button>
            )}
            {archived.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs font-normal text-muted-foreground"
                onClick={() => setShowArchived((v) => !v)}
                data-testid="conversation-list-toggle-archived"
              >
                <ChevronRightIcon
                  className={cn("size-3 transition-transform", showArchived && "rotate-90")}
                  aria-hidden
                />
                {showArchived ? t("hideArchived") : t("showArchived", { count: archived.length })}
              </Button>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
