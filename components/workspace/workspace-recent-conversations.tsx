"use client"

/**
 * `/workspace`'s conversations: the newest few, and the way to start another.
 *
 * ADR-0144 made the workspace the unit of work, and conversations are most of
 * that work, yet the page about a workspace listed its issues, members and
 * environments and not one of its conversations. The chat list at `/` is
 * already scoped to the active workspace, so this is a summary that links
 * there, not a second list to keep in step with it.
 *
 * Reads `listWorkspaceSessions`, the same read the scoped chat list uses, so a
 * conversation with no workspace (a paired client's history, a pre-workspace
 * chat) shows here exactly as it does there. IM conversations belong to the
 * Inbox, and embedded ones are never listed (`session-exposure.ts`).
 */

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useFormatter, useNow, useTranslations } from "next-intl"
import { toast } from "sonner"
import { ArrowUpRightIcon, MessageSquareIcon, PlusIcon } from "lucide-react"

import { ConsoleSection } from "@/components/surface/console-section"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useClientLiveQuery } from "@/hooks/data"
import { listWorkspaceSessions } from "@/lib/db/sessions"
import { filterExposedSessions } from "@/lib/chat/session-exposure"
import { startNewSession } from "@/lib/chat/start-session"
import { sessionHref } from "@/lib/issues/run/agent-task-adapter"
import type { ChatSession } from "@cognia/agent-config-types"

/** How many rows the card holds before it hands off to the chat list. */
export const RECENT_CONVERSATION_LIMIT = 5

function lastActivity(session: ChatSession): number {
  const last = (session as { lastMessageAt?: number }).lastMessageAt
  return typeof last === "number" && last > session.updatedAt ? last : session.updatedAt
}

/** The conversations this card may show, newest first. */
export function recentConversations(sessions: readonly ChatSession[]): ChatSession[] {
  return filterExposedSessions(sessions, "main-list")
    .filter(
      (session) =>
        !session.platformBinding && (session as { archivedAt?: number | null }).archivedAt == null
    )
    .sort((a, b) => lastActivity(b) - lastActivity(a))
}

export interface WorkspaceRecentConversationsProps {
  workspaceId: string | null
}

export function WorkspaceRecentConversations({ workspaceId }: WorkspaceRecentConversationsProps) {
  const t = useTranslations("workspace.conversations")
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const router = useRouter()
  const [starting, setStarting] = useState(false)

  const sessions = useClientLiveQuery(
    () => (workspaceId ? listWorkspaceSessions(workspaceId) : Promise.resolve([])),
    [workspaceId],
    [] as ChatSession[]
  )
  const visible = sessions ? recentConversations(sessions) : undefined

  const startConversation = async () => {
    if (!workspaceId || starting) return
    setStarting(true)
    try {
      // Named explicitly: this card is about THIS workspace, whatever the
      // pointer says by the time the click lands.
      await startNewSession({ projectId: workspaceId })
      router.push("/")
    } catch (error) {
      toast.error(
        t("startFailed", { error: error instanceof Error ? error.message : String(error) })
      )
    } finally {
      setStarting(false)
    }
  }

  return (
    <ConsoleSection
      id="conversations"
      pane="workspace-pane"
      idPrefix="workspace-section"
      icon={MessageSquareIcon}
      title={t("title")}
      meta={
        <Button
          size="sm"
          variant="ghost"
          className="-my-1 h-7 gap-1"
          onClick={() => void startConversation()}
          disabled={!workspaceId || starting}
          data-testid="workspace-conversations-new"
        >
          <PlusIcon aria-hidden className="size-3.5" />
          {t("new")}
        </Button>
      }
    >
      {visible === undefined ? (
        <ul
          className="flex flex-col gap-2"
          role="status"
          aria-busy="true"
          aria-label={t("loading")}
          data-testid="workspace-conversations-loading"
        >
          {[0, 1, 2].map((row) => (
            <li key={row}>
              <Skeleton className="h-8 w-full" />
            </li>
          ))}
        </ul>
      ) : visible.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="workspace-conversations-empty">
          {t("empty")}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <ul className="flex flex-col gap-1" data-testid="workspace-conversations-list">
            {visible.slice(0, RECENT_CONVERSATION_LIMIT).map((session) => (
              <li key={session.id}>
                <Link
                  href={sessionHref(session.id)}
                  className="flex items-center gap-2 rounded-control px-2 py-1.5 text-sm transition-colors hover:bg-accent/50"
                  data-testid={`workspace-conversation-${session.id}`}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {session.title?.trim() || t("untitled")}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {format.relativeTime(lastActivity(session), now)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <Link
            href="/"
            className="inline-flex items-center gap-1 self-start px-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
            data-testid="workspace-conversations-all"
          >
            {t("viewAll", { count: visible.length })}
            <ArrowUpRightIcon aria-hidden className="size-3" />
          </Link>
        </div>
      )}
    </ConsoleSection>
  )
}
