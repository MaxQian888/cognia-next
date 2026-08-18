/**
 * Conversations by title (ADR-0129).
 *
 * Reads the cross-workspace session list the dialog already holds (no Dexie
 * read per keystroke), applies the exposure contract for global search, then
 * the archive / workspace filters, and ranks titles with the shared scorer.
 * The empty query suggests the most recently updated conversations.
 */

import { MessageSquareIcon, UsersIcon } from "lucide-react"
import type { ChatSession } from "@cognia/agent-config-types"

import { filterExposedSessions } from "@/lib/chat/session-exposure"
import { matchTitles } from "./helpers"
import type {
  GlobalSearchContext,
  GlobalSearchItem,
  GlobalSearchProvider,
  ParsedGlobalSearchQuery,
} from "../types"

export const SESSIONS_PROVIDER_ID = "builtin.sessions"

function isArchived(session: ChatSession): boolean {
  return (session as { archivedAt?: number | null }).archivedAt != null
}

function sessionTimestamp(session: ChatSession): number {
  const last = (session as { lastMessageAt?: number }).lastMessageAt
  return typeof last === "number" && last > session.updatedAt ? last : session.updatedAt
}

/**
 * Sessions the current query is allowed to see. Platform-bound (IM) sessions
 * are the inbox provider's (`./inbox`): they open in the Inbox route, and
 * listing them here too would show every IM conversation twice.
 */
export function visibleSessions(
  ctx: GlobalSearchContext,
  filters: ParsedGlobalSearchQuery["filters"]
): ChatSession[] {
  const exposed = filterExposedSessions(ctx.sessions, "global-search")
  return exposed.filter((session) => {
    if (session.platformBinding) return false
    if (!filters.archived && isArchived(session)) return false
    if (filters.workspace === "current" && ctx.activeProjectId) {
      if ((session.projectId ?? "") !== ctx.activeProjectId) return false
    }
    return true
  })
}

function workspaceName(
  ctx: GlobalSearchContext,
  projectId: string | undefined
): string | undefined {
  if (!projectId) return undefined
  return ctx.workspaces.find((p) => p.id === projectId)?.name
}

export function sessionToItem(
  session: ChatSession,
  ctx: GlobalSearchContext,
  score: number,
  titlePositions: readonly number[] = []
): GlobalSearchItem {
  const title = session.title?.trim() || ctx.t("globalSearch.untitledConversation")
  const preview = (session as { lastMessagePreview?: string }).lastMessagePreview
  const showWorkspace = ctx.workspaces.length > 1
  return {
    id: `session:${session.id}`,
    kind: "session",
    title,
    titlePositions,
    subtitle: preview?.trim() || undefined,
    meta: showWorkspace ? workspaceName(ctx, session.projectId) : undefined,
    icon: { lucide: session.kind === "team" ? UsersIcon : MessageSquareIcon },
    score,
    timestamp: sessionTimestamp(session),
    extra: {
      archived: isArchived(session),
      current: ctx.activeSessionId === session.id,
    },
    action: { type: "open-session", sessionId: session.id },
  }
}

export const sessionsProvider: GlobalSearchProvider = {
  id: SESSIONS_PROVIDER_ID,
  kind: "session",
  search({ query, ctx, limit }) {
    const rows = visibleSessions(ctx, query.filters)
    const { hits, total, truncated } = matchTitles(rows, query.needle, {
      getTitle: (s) => s.title ?? "",
      // The id is a legitimate secondary: people paste session ids from logs.
      getKeywords: (s) => [s.id],
      getTimestamp: sessionTimestamp,
      now: ctx.now,
      limit,
    })
    return {
      items: hits.map(({ row, match }) => sessionToItem(row, ctx, match.score, match.positions)),
      total,
      truncated,
    }
  },
  suggest({ ctx, limit }) {
    return visibleSessions(ctx, {})
      .slice()
      .sort((a, b) => sessionTimestamp(b) - sessionTimestamp(a))
      .slice(0, limit)
      .map((session, index) => sessionToItem(session, ctx, 1 - index / (limit + 1)))
  },
}
