"use client"

/**
 * Desktop Draft Approval Center.
 *
 * A cross-conversation queue of every pending `ConnectorDraftRow`, grouped by
 * conversation. Each draft reuses the existing `<DraftEditor />` (which already
 * owns the approve → enqueueOutbound + reject flow), so approving/rejecting
 * flips the row's status and the live `usePendingDrafts` subscriber drops it
 * from the queue. Rendered in the Inbox detail pane at `/inbox/drafts`.
 *
 * The mobile counterpart is `components/mobile/connector/draft-approval-panel`.
 */

import { useMemo } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { motion, useReducedMotion } from "motion/react"
import { InboxIcon } from "lucide-react"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { getDb } from "@/lib/db/schema"
import { STAGGER_CONTAINER, STAGGER_CHILD } from "@/lib/ui/motion"
import { usePendingDrafts } from "@/hooks/connectors/use-pending-drafts"
import { parseConversationKey } from "@/types/connectors/event"
import type { ChatSession } from "@cognia/agent-config-types"
import type { ConnectorDraftRow } from "@/lib/db/connector-types"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import { DraftEditor } from "./draft-editor"
import { PlatformBadge } from "./platform-badge"

export function DraftCenter() {
  const t = useTranslations("inbox.draftCenter")
  const router = useRouter()
  const reduce = useReducedMotion()
  const drafts = usePendingDrafts()

  const sessionsResult = useLiveQuery<ChatSession[]>(
    () =>
      typeof window === "undefined"
        ? Promise.resolve([])
        : getDb()
            .sessions.filter((s) => s.platformBinding != null)
            .toArray(),
    []
  )
  const sessions = useMemo(() => sessionsResult ?? [], [sessionsResult])

  const titleByKey = useMemo(() => {
    const map = new Map<string, string>()
    for (const s of sessions) {
      const ck = s.platformBinding?.conversationKey
      if (ck) map.set(ck, s.title || ck)
    }
    return map
  }, [sessions])

  const groups = useMemo(() => {
    const map = new Map<string, ConnectorDraftRow[]>()
    for (const draft of drafts) {
      const arr = map.get(draft.conversationKey) ?? []
      arr.push(draft)
      map.set(draft.conversationKey, arr)
    }
    return Array.from(map.entries())
  }, [drafts])

  if (drafts.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6" data-testid="draft-center-empty">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <InboxIcon />
            </EmptyMedia>
            <EmptyTitle>{t("empty")}</EmptyTitle>
            <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    )
  }

  return (
    <ScrollArea className="flex-1">
      <motion.div
        className="flex flex-col gap-4 p-4"
        initial={reduce ? false : "initial"}
        animate="animate"
        variants={STAGGER_CONTAINER}
        data-testid="draft-center"
      >
        {groups.map(([ck, rows]) => {
          let platform: PlatformKind | null = null
          try {
            platform = parseConversationKey(ck).platform
          } catch {
            platform = null
          }
          return (
            <motion.section
              key={ck}
              variants={STAGGER_CHILD}
              className="overflow-hidden rounded-lg border"
              data-testid={`draft-group-${ck}`}
            >
              <header className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
                {platform && <PlatformBadge platform={platform} iconOnly />}
                <span className="truncate text-sm font-medium">{titleByKey.get(ck) ?? ck}</span>
                <Badge variant="secondary" className="ml-auto text-[10px]">
                  {t("group", { count: rows.length })}
                </Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => router.push(`/inbox/c?key=${encodeURIComponent(ck)}`)}
                  data-testid={`draft-group-open-${ck}`}
                >
                  {t("open")}
                </Button>
              </header>
              <div className="flex flex-col gap-3 p-3">
                {rows.map((row) => (
                  <div
                    key={row.id}
                    className="rounded-md border bg-muted/20 p-3"
                    data-testid={`draft-card-${row.id}`}
                  >
                    <DraftEditor draft={row} onClose={() => {}} />
                  </div>
                ))}
              </div>
            </motion.section>
          )
        })}
      </motion.div>
    </ScrollArea>
  )
}
