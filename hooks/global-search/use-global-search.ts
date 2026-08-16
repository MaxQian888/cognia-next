"use client"

/**
 * React bridge to the global-search engine (ADR-0129).
 *
 * Owns: input debouncing, abort of the superseded run, stale-response
 * suppression, the chat-index drain before a message search, and the empty
 * query's suggestions. Returns everything the dialog renders; the dialog never
 * calls the engine itself.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { UIMessage } from "ai"

import { drainSearchIndex, scheduleSearchIndexDrain } from "@/lib/chat/search/indexer"
import { projectSearchText } from "@/lib/chat/search/project-text"
import type { ChatSearchTextRow } from "@/lib/db/chat-search-text"
import { runGlobalSearch, runGlobalSearchSuggestions } from "@/lib/global-search/engine"
import { registerBuiltinGlobalSearchProviders } from "@/lib/global-search/providers"
import { parseGlobalSearchQuery } from "@/lib/global-search/query-parser"
import {
  getGlobalSearchRegistryRevision,
  subscribeGlobalSearchProviders,
} from "@/lib/global-search/registry"
import type {
  GlobalSearchContext,
  GlobalSearchGroup,
  GlobalSearchOutcome,
  ParsedGlobalSearchQuery,
} from "@/lib/global-search/types"
import { useChatStore } from "@/stores/chat"
import { useSyncExternalStore } from "react"

/** Keystroke → engine debounce. */
export const GLOBAL_SEARCH_DEBOUNCE_MS = 150

export interface UseGlobalSearchOptions {
  rawQuery: string
  ctx: GlobalSearchContext
  /** Run nothing while the dialog is closed. */
  enabled: boolean
  /** Per-group limit override (raised by "show more"). */
  limit?: number
}

export interface UseGlobalSearchResult {
  parsed: ParsedGlobalSearchQuery
  /** Groups for a non-empty query (empty while loading the first time). */
  outcome: GlobalSearchOutcome | null
  /** Groups for the empty query. */
  suggestions: GlobalSearchGroup[]
  loading: boolean
  error: Error | null
  /** Re-run the current query (after an action that changed data). */
  refresh: () => void
}

function createdAtOf(message: UIMessage): number {
  const value = (message.metadata as { createdAt?: unknown } | undefined)?.createdAt
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now()
}

/**
 * Project the open chat slices without touching Dexie — the streaming turn is
 * the message people most often search for and the one the idle index has not
 * written yet. Same projection the old palette hook used.
 */
export function pendingChatRows(): ChatSearchTextRow[] {
  const state = useChatStore.getState()
  const bySession = new Map<string, readonly UIMessage[]>()
  for (const [sessionId, slice] of Object.entries(state.sessions)) {
    bySession.set(sessionId, slice.messages)
  }
  if (state.activeSessionId) bySession.set(state.activeSessionId, state.messages)

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

export function useGlobalSearch({
  rawQuery,
  ctx,
  enabled,
  limit,
}: UseGlobalSearchOptions): UseGlobalSearchResult {
  const [debounced, setDebounced] = useState(rawQuery)
  const [outcome, setOutcome] = useState<GlobalSearchOutcome | null>(null)
  const [suggestions, setSuggestions] = useState<GlobalSearchGroup[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const requestRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  // Built-ins register once per renderer; a plugin registering later bumps the
  // revision, which re-runs the query below.
  useEffect(() => {
    registerBuiltinGlobalSearchProviders({ messages: { pendingRows: pendingChatRows } })
    scheduleSearchIndexDrain()
  }, [])
  const registryRevision = useSyncExternalStore(
    subscribeGlobalSearchProviders,
    getGlobalSearchRegistryRevision,
    getGlobalSearchRegistryRevision
  )

  // Debounce the raw input. An empty query and a programmatic seed apply at
  // once — waiting 150 ms to show suggestions reads as lag.
  useEffect(() => {
    if (rawQuery.trim() === "") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- immediate reset on clear
      setDebounced("")
      return
    }
    const handle = window.setTimeout(() => setDebounced(rawQuery), GLOBAL_SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [rawQuery])

  const parsed = useMemo(
    () => parseGlobalSearchQuery(debounced, { now: ctx.now }),
    [debounced, ctx.now]
  )
  const isEmpty = parsed.text.length === 0 && parsed.tokens.length === 0

  useEffect(() => {
    if (!enabled) return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const requestId = ++requestRef.current

    if (isEmpty) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset before an async run
      setOutcome(null)
      setError(null)
      setLoading(false)
      void runGlobalSearchSuggestions(ctx, { signal: controller.signal })
        .then((groups) => {
          if (requestRef.current !== requestId) return
          setSuggestions(groups)
        })
        .catch(() => undefined)
      return () => controller.abort()
    }

    setLoading(true)
    setError(null)
    void drainSearchIndex()
      .catch(() => undefined)
      .then(() => runGlobalSearch(parsed, ctx, { signal: controller.signal, limit }))
      .then((next) => {
        if (requestRef.current !== requestId || next.aborted) return
        setOutcome(next)
        setLoading(false)
      })
      .catch((cause: unknown) => {
        if (requestRef.current !== requestId) return
        setError(cause instanceof Error ? cause : new Error(String(cause)))
        setLoading(false)
      })
    return () => controller.abort()
    // `parsed` derives from `debounced`; ctx identity changes on every store
    // update we care about (scope, sessions, active ids).
  }, [enabled, parsed, isEmpty, ctx, limit, refreshNonce, registryRevision])

  const refresh = useCallback(() => setRefreshNonce((n) => n + 1), [])

  return { parsed, outcome, suggestions, loading, error, refresh }
}
