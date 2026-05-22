"use client"

/**
 * Conversation list for the Inbox middle pane.
 *
 * Sort order:
 *  1. Pinned (conversationOverrides.pinned === true) — sorted by updatedAt desc.
 *  2. Unread (lastReadAt < session.updatedAt) — sorted by updatedAt desc.
 *  3. Read — sorted by updatedAt desc.
 *  4. Archived — hidden by default; toggle at bottom to show.
 */

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { PinIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import { Toggle } from "@/components/ui/toggle"
import { cn } from "@/lib/utils"
import { getDb } from "@/lib/db/schema"
import { extractPlainText } from "@/lib/inbox/extract-plain-text"
import type { ChatSession } from "@/lib/claude/types"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"
import { PlatformBadge } from "./platform-badge"
import { UnreadPill } from "./unread-pill"
import { ComputerUseChip } from "./computer-use-chip"
import { ConversationSearchInput } from "./search/conversation-search-input"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"

type FilterChip = "unread" | "pinned"

interface ConversationListProps {
  adapterId?: string
  platformKind?: string
  activeConversationKey?: string
}

interface EnrichedSession {
  session: ChatSession
  override: ConversationOverrideRow | undefined
  unreadCount: number
  /** Lazy plaintext snippet of the latest message; populated only when
   *  the operator is searching. */
  lastMessagePreview?: string
}

/**
 * Predicate factory used by the live-query → render-time filter. Combines:
 *   - text query (case-insensitive substring over title, conversationKey
 *     segments, and last-message preview);
 *   - active filter chips (unread / pinned), AND-combined when both set.
 */
function buildFilterPredicate(
  query: string,
  chips: Set<FilterChip>
): (item: EnrichedSession) => boolean {
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
  const [showArchived, setShowArchived] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [activeChips, setActiveChips] = useState<Set<FilterChip>>(() => new Set())

  // Load all platform-bound sessions + their overrides.
  // When `searchQuery` is non-empty we additionally hydrate a plaintext
  // snippet of each session's most recent message so the search can hit
  // message content, not just metadata. The cost is paid only when the
  // operator is actively searching — the no-search default path stays
  // metadata-only to keep the live query cheap.
  const enriched = useLiveQuery<EnrichedSession[]>(async () => {
    if (typeof window === "undefined") return []
    const db = getDb()

    let sessions = await db.sessions.filter((s) => s.platformBinding != null).toArray()

    // Apply adapter / platform filters when scoped.
    if (adapterId) {
      sessions = sessions.filter((s) => s.platformBinding?.adapterId === adapterId)
    }
    if (platformKind) {
      sessions = sessions.filter((s) => s.platformBinding?.platform === platformKind)
    }

    const overrides = await db.conversationOverrides.toArray()
    const overrideMap = new Map(overrides.map((o) => [o.conversationKey, o]))

    // Resolve a per-session last-message preview only when the operator
    // is actively searching. Walks `messages` ordered by `createdAt`
    // descending and stops at the first hit per session so the index
    // does the heavy lifting.
    const previewBySession = new Map<string, string>()
    if (searchQuery.trim()) {
      const seen = new Set<string>()
      const sessionIds = new Set(sessions.map((s) => s.id))
      await db.messages
        .orderBy("createdAt")
        .reverse()
        .until(() => seen.size >= sessions.length, true)
        .each((msg) => {
          if (seen.has(msg.sessionId)) return
          if (!sessionIds.has(msg.sessionId)) return
          const text = extractPlainText(msg.parts).slice(0, 240)
          previewBySession.set(msg.sessionId, text)
          seen.add(msg.sessionId)
        })
    }

    return sessions.map((session) => {
      const ck = session.platformBinding!.conversationKey
      const override = overrideMap.get(ck)
      const lastReadAt = override?.lastReadAt ?? 0
      const unreadCount = lastReadAt < session.updatedAt ? 1 : 0
      return {
        session,
        override,
        unreadCount,
        lastMessagePreview: previewBySession.get(session.id),
      }
    })
  }, [adapterId, platformKind, searchQuery])

  if (!enriched) {
    return (
      <div className="flex flex-col gap-1 p-3" data-testid="conversation-list-loading">
        {Array.from({ length: 6 }).map((_, idx) => (
          <Skeleton key={idx} className="h-12 w-full rounded-md" />
        ))}
      </div>
    )
  }

  const predicate = buildFilterPredicate(searchQuery, activeChips)
  const filtered = enriched.filter(predicate)

  // Separate by bucket
  const pinned: EnrichedSession[] = []
  const unread: EnrichedSession[] = []
  const read: EnrichedSession[] = []
  const archived: EnrichedSession[] = []

  for (const item of filtered) {
    if (item.override?.archived) {
      archived.push(item)
    } else if (item.override?.pinned) {
      pinned.push(item)
    } else if (item.unreadCount > 0) {
      unread.push(item)
    } else {
      read.push(item)
    }
  }

  const sortByUpdated = (a: EnrichedSession, b: EnrichedSession) =>
    b.session.updatedAt - a.session.updatedAt

  pinned.sort(sortByUpdated)
  unread.sort(sortByUpdated)
  read.sort(sortByUpdated)
  archived.sort(sortByUpdated)

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
        <div className="py-1">
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
            visibleRows.map((item) => (
              <ConversationRow
                key={item.session.id}
                item={item}
                isActive={item.session.platformBinding?.conversationKey === activeConversationKey}
                onSelect={handleSelect}
              />
            ))
          )}
        </div>
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

function ConversationRow({
  item,
  isActive,
  onSelect,
}: {
  item: EnrichedSession
  isActive: boolean
  onSelect: (conversationKey: string) => void
}) {
  const { session, override, unreadCount } = item
  const ck = session.platformBinding!.conversationKey
  const platform = session.platformBinding!.platform as PlatformKind
  const adapterId = session.platformBinding!.adapterId

  // Row uses a flex container with a click-target button on the left and a
  // plugin actions zone on the right. Keeping the actions out of the
  // <button> prevents nested-interactive accessibility violations and lets
  // plugin contributions (archive, mute, mark-as-read, etc.) own their
  // own click handling.
  return (
    <div
      className={cn(
        "w-full flex items-center gap-2 px-3 py-2 min-h-11 hover:bg-muted/60 transition-colors",
        "md:min-h-9 md:py-1.5",
        isActive && "bg-muted"
      )}
      data-testid={`conversation-row-${ck}`}
    >
      <button
        type="button"
        className="flex-1 min-w-0 flex items-center gap-2 text-left"
        onClick={() => onSelect(ck)}
        data-testid={`conversation-row-button-${ck}`}
      >
        {/* Platform badge */}
        <PlatformBadge platform={platform} className="shrink-0" />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1">
            {override?.pinned && <PinIcon className="h-3 w-3 shrink-0 text-muted-foreground" />}
            <span className="text-sm font-medium truncate">{session.title}</span>
          </div>
          <p className="text-xs text-muted-foreground truncate">{ck}</p>
        </div>

        <UnreadPill count={unreadCount} />
        {/* v49 — read-only chip flagging the elevated-permission flag
         * on this conversation so operators can pick out IM channels
         * with Computer Use granted without opening the override dialog. */}
        <ComputerUseChip active={override?.allowComputerUse === true} />
      </button>

      {/* Plugin contributions: per-row actions (archive, mute, transfer to
       * workflow, …). Hidden when no plugin contributes.
       */}
      <PluginExtensionSlot
        point="inbox.conversation.actions"
        className="ml-auto flex items-center gap-1 empty:hidden"
        context={{
          conversationKey: ck,
          adapterId,
          platform,
          sessionId: session.id,
          pinned: !!override?.pinned,
          archived: !!override?.archived,
        }}
      />
    </div>
  )
}
