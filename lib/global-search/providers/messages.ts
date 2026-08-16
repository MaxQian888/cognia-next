/**
 * Message history hits (ADR-0129), on top of the ADR-0099 engine.
 *
 * Two projections of the same search:
 *   - `chats` scope   → one row per conversation ("conversations mentioning …")
 *   - `messages`/`all` → every message hit, deepest list, role + time chips
 *
 * The engine already handles exposure, archive, workspace, branch dedupe and
 * absolute scoring; this provider only translates the query's filters, maps
 * the outcome onto items, and reports coverage honestly (a backfill in flight
 * is `indexing`; older history left unscanned is `partial`).
 */

import { MessageSquareTextIcon } from "lucide-react"

import {
  searchChatHistory,
  type ChatSearchDeps,
  type ChatSearchOutcome,
  type ChatSearchQuery,
  type ChatSearchResult,
} from "@/lib/chat/search/engine"
import type { ChatSearchTextRow } from "@/lib/db/chat-search-text"
import { normalizeMessageScore } from "../scoring"
import type {
  GlobalSearchContext,
  GlobalSearchCoverage,
  GlobalSearchItem,
  GlobalSearchProvider,
  ParsedGlobalSearchQuery,
} from "../types"

export const MESSAGES_PROVIDER_ID = "builtin.messages"

/** Below this the engine would scan the whole corpus for one letter. */
export const MIN_MESSAGE_QUERY_LENGTH = 2

export interface MessagesProviderDeps {
  /** Defaults to the ADR-0099 engine. */
  search?: (
    query: ChatSearchQuery,
    overrides?: Partial<ChatSearchDeps>
  ) => Promise<ChatSearchOutcome>
  /** Streaming / not-yet-indexed rows — the dialog supplies these from the chat store. */
  pendingRows?: () => readonly ChatSearchTextRow[]
}

/** Translate parsed filters + scope into an engine query. */
export function toChatSearchQuery(
  parsed: ParsedGlobalSearchQuery,
  ctx: GlobalSearchContext,
  limit: number
): ChatSearchQuery {
  const f = parsed.filters
  return {
    query: parsed.text,
    limit,
    includeArchived: f.archived === true,
    projectId: f.workspace === "current" && ctx.activeProjectId ? ctx.activeProjectId : undefined,
    collapseBySession: ctx.scope === "chats",
    roles: f.roles && f.roles.length > 0 ? f.roles : undefined,
    after: f.after,
    before: f.before,
  }
}

export function messageResultToItem(
  result: ChatSearchResult,
  ctx: GlobalSearchContext
): GlobalSearchItem {
  const roleLabel = ctx.t(`globalSearch.roles.${roleKey(result.role)}`)
  return {
    id: `message:${result.messageId}`,
    kind: "message",
    title: result.sessionTitle?.trim() || ctx.t("globalSearch.untitledConversation"),
    subtitle: result.snippet.text,
    subtitlePositions: result.snippet.positions,
    meta: roleLabel,
    icon: { lucide: MessageSquareTextIcon },
    score: normalizeMessageScore(result.score),
    timestamp: result.createdAt,
    extra: {
      role: result.role,
      archived: result.archived,
      otherBranchCount: result.otherBranchCount,
      occurrenceCount: result.count,
      snippet: result.snippet,
    },
    action: { type: "open-session", sessionId: result.sessionId, messageId: result.messageId },
  }
}

function roleKey(role: string): "user" | "assistant" | "system" | "other" {
  if (role === "user" || role === "assistant" || role === "system") return role
  return "other"
}

export function coverageOf(outcome: ChatSearchOutcome): GlobalSearchCoverage {
  if (outcome.indexIncomplete) return "indexing"
  if (outcome.moreOlderHistory) return "partial"
  return "complete"
}

export function createMessagesProvider(deps: MessagesProviderDeps = {}): GlobalSearchProvider {
  const search = deps.search ?? searchChatHistory
  return {
    id: MESSAGES_PROVIDER_ID,
    kind: "message",
    async search({ query, ctx, limit, signal }) {
      if (query.filters.titleOnly || query.text.length < MIN_MESSAGE_QUERY_LENGTH) {
        return { items: [] }
      }
      const outcome = await search(
        toChatSearchQuery(query, ctx, limit),
        deps.pendingRows ? { pendingRows: deps.pendingRows } : undefined
      )
      if (signal.aborted) return { items: [] }
      return {
        items: outcome.results.map((r) => messageResultToItem(r, ctx)),
        // The engine reports "more exists" without a count; surface it as truncation.
        truncated: outcome.moreOlderHistory,
        coverage: coverageOf(outcome),
      }
    },
  }
}
