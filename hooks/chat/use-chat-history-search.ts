"use client"

import { useEffect, useRef, useState } from "react"
import type { UIMessage } from "ai"

import {
  searchChatHistory,
  type ChatSearchOutcome,
  type ChatSearchQuery,
} from "@/lib/chat/search/engine"
import { projectSearchText } from "@/lib/chat/search/project-text"
import { drainSearchIndex, scheduleSearchIndexDrain } from "@/lib/chat/search/indexer"
import { CONTENT_SEARCH_MIN_QUERY } from "@/lib/chat/conversation-search-scope"
import type { ChatSearchTextRow } from "@/lib/db/chat-search-text"
import { useChatStore } from "@/stores/chat"

const EMPTY_OUTCOME: ChatSearchOutcome = {
  results: [],
  moreOlderHistory: false,
  indexIncomplete: false,
}

export interface UseChatHistorySearchOptions extends Omit<ChatSearchQuery, "query"> {
  /** Do not run while a palette is closed or content search is disabled. */
  enabled?: boolean
  /** Avoid broad, noisy one-character history scans. */
  minQueryLength?: number
}

export interface UseChatHistorySearchResult extends ChatSearchOutcome {
  loading: boolean
  error: Error | null
}

function createdAtOf(message: UIMessage): number {
  const value = (message.metadata as { createdAt?: unknown } | undefined)?.createdAt
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now()
}

/**
 * Project the open chat slices without touching Dexie.
 *
 * The idle index deliberately trails streaming writes. Searching these small
 * in-memory slices first makes the newest partial turn findable immediately;
 * the engine de-duplicates their message ids against the resident corpus.
 */
function pendingRows(): ChatSearchTextRow[] {
  const state = useChatStore.getState()
  const bySession = new Map<string, readonly UIMessage[]>()
  for (const [sessionId, slice] of Object.entries(state.sessions)) {
    bySession.set(sessionId, slice.messages)
  }
  if (state.activeSessionId) {
    bySession.set(state.activeSessionId, state.messages)
  }

  const rows: ChatSearchTextRow[] = []
  const seen = new Set<string>()
  for (const [sessionId, messages] of bySession) {
    for (const message of messages) {
      if (!message.id || seen.has(message.id)) continue
      seen.add(message.id)
      const text = projectSearchText(message.parts)
      if (!text) continue
      rows.push({
        messageId: message.id,
        sessionId,
        projectId: "",
        role: message.role,
        createdAt: createdAtOf(message),
        text,
      })
    }
  }
  return rows
}

/**
 * Race-safe UI bridge to the shared indexed chat-history engine.
 *
 * Callers own input debouncing because the sidebar also feeds the same
 * debounced value to its title/grouping model. This hook owns index freshness,
 * stale-response suppression, and the streaming-message fallback.
 */
export function useChatHistorySearch(
  query: string,
  {
    enabled = true,
    minQueryLength = CONTENT_SEARCH_MIN_QUERY,
    limit,
    projectId,
    includeArchived,
    collapseBySession,
  }: UseChatHistorySearchOptions = {}
): UseChatHistorySearchResult {
  const requestRef = useRef(0)
  const [state, setState] = useState<UseChatHistorySearchResult>({
    ...EMPTY_OUTCOME,
    loading: false,
    error: null,
  })

  // Begin the lazy backfill as soon as a search-capable surface mounts. Work is
  // split into idle batches by the indexer, so this never blocks first paint.
  useEffect(() => {
    scheduleSearchIndexDrain()
  }, [])

  useEffect(() => {
    const trimmed = query.trim()
    const requestId = ++requestRef.current
    if (!enabled || trimmed.length < minQueryLength) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState({ ...EMPTY_OUTCOME, loading: false, error: null })
      return
    }

    // Clear old offsets immediately: keeping prior snippets while a new query
    // is loading would highlight positions computed for different text.
    setState({ ...EMPTY_OUTCOME, loading: true, error: null })

    // `{ backfill: false }` — the query only needs the DIRTY sessions flushed
    // (so a just-sent message is findable). A backfill step reads 500 whole
    // message rows with their `parts`, and paying that per keystroke is what
    // made typing here cost more than the search it serves. The idle scheduler
    // still advances coverage.
    void drainSearchIndex(undefined, { backfill: false })
      .catch(() => undefined)
      .then(() =>
        searchChatHistory(
          {
            query: trimmed,
            limit,
            projectId,
            includeArchived,
            collapseBySession,
          },
          { pendingRows }
        )
      )
      .then((outcome) => {
        if (requestRef.current !== requestId) return
        setState({ ...outcome, loading: false, error: null })
      })
      .catch((cause: unknown) => {
        if (requestRef.current !== requestId) return
        const error = cause instanceof Error ? cause : new Error(String(cause))
        setState({ ...EMPTY_OUTCOME, loading: false, error })
      })
  }, [query, enabled, minQueryLength, limit, projectId, includeArchived, collapseBySession])

  return state
}
