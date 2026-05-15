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

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { PinIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { getDb } from "@/lib/db/schema"
import type { ChatSession } from "@/lib/claude/types"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"
import { PlatformBadge } from "./platform-badge"
import { UnreadPill } from "./unread-pill"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"

interface ConversationListProps {
  adapterId?: string
  platformKind?: string
  activeConversationKey?: string
}

interface EnrichedSession {
  session: ChatSession
  override: ConversationOverrideRow | undefined
  unreadCount: number
}

export function ConversationList({
  adapterId,
  platformKind,
  activeConversationKey,
}: ConversationListProps) {
  const router = useRouter()
  const t = useTranslations("inbox.conversationList")
  const [showArchived, setShowArchived] = useState(false)

  // Load all platform-bound sessions + their overrides.
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

    return sessions.map((session) => {
      const ck = session.platformBinding!.conversationKey
      const override = overrideMap.get(ck)
      const lastReadAt = override?.lastReadAt ?? 0
      const unreadCount = lastReadAt < session.updatedAt ? 1 : 0
      return { session, override, unreadCount }
    })
  }, [adapterId, platformKind])

  if (!enriched) {
    return (
      <div className="flex flex-col gap-1 p-3">
        <div className="h-12 animate-pulse rounded-md bg-muted" />
        <div className="h-12 animate-pulse rounded-md bg-muted" />
      </div>
    )
  }

  // Separate by bucket
  const pinned: EnrichedSession[] = []
  const unread: EnrichedSession[] = []
  const read: EnrichedSession[] = []
  const archived: EnrichedSession[] = []

  for (const item of enriched) {
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

  const handleSelect = (ck: string) => {
    router.push(`/inbox/c/${encodeURIComponent(ck)}`)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 border-b px-3 py-2">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("header")}
        </h3>
      </div>

      <ScrollArea className="flex-1">
        <div className="py-1">
          {visibleRows.length === 0 ? (
            <p className="px-3 py-4 text-xs text-muted-foreground text-center">{t("empty")}</p>
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
        "w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/60 transition-colors",
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
