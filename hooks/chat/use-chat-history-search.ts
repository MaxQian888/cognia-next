"use client"

import { useEffect, useRef, useState } from "react"

import {
  searchChatHistory,
  type ChatSearchOutcome,
  type ChatSearchQuery,
} from "@/lib/chat/search/engine"
import { pendingSearchRows } from "@/lib/chat/search/pending-rows"
import { drainSearchIndex, scheduleSearchIndexDrain } from "@/lib/chat/search/indexer"
import { CONTENT_SEARCH_MIN_QUERY } from "@/lib/chat/conversation-search-scope"

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
          { pendingRows: pendingSearchRows }
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
