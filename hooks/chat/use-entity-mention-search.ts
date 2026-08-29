"use client"

/**
 * Backing state for the composer's `@memory:` / `@issue:` / `@plan:` /
 * `@chat:` / `@artifact:` panel.
 *
 * Deliberately much thinner than `use-remote-doc-search.ts`: every source here
 * is local, so there is no account to pick, no host to be unsupported on, and
 * no network error taxonomy. What is left is a debounced call and the
 * discipline of not letting a stale response overwrite a newer one.
 *
 * The debounce is shorter than the document one (which crosses a network) but
 * non-zero all the same — the memory and issue sources read whole tables and
 * filter in memory, so a fast typist would otherwise re-scan on every keystroke.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import { loggers } from "@cognia/logging"
import { invalidateEntityMentionCaches } from "@/lib/chat/mentions/entity-cache"
import {
  getEntityMentionSourceByPrefix,
  searchEntityMentionCandidates,
  type EntityMentionCandidate,
  type EntityMentionContext,
  type EntityMentionSource,
} from "@/lib/chat/mentions/entity-sources"

/** Debounce before a local table scan runs. */
export const ENTITY_SEARCH_DEBOUNCE_MS = 120

export interface EntityMentionSearchInput {
  /** Namespace prefix from the trigger (`"issue:"`), or null when inactive. */
  namespace: string | null
  /** Text typed after the prefix. */
  query: string
  /** Workspace + conversation the composer sits in. */
  context: EntityMentionContext
}

export interface EntityMentionSearchState {
  source: EntityMentionSource | null
  items: readonly EntityMentionCandidate[]
  loading: boolean
  /** Message from a failed read; the panel shows it instead of "no matches". */
  error: string | null
}

export function useEntityMentionSearch({
  namespace,
  query,
  context,
}: EntityMentionSearchInput): EntityMentionSearchState {
  const source = useMemo(
    () => (namespace ? (getEntityMentionSourceByPrefix(namespace) ?? null) : null),
    [namespace]
  )
  const [items, setItems] = useState<readonly EntityMentionCandidate[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Which source the last effect run was for, so opening the panel (or
  // switching namespace inside it) can drop the candidate caches exactly once.
  const lastSourceRef = useRef<EntityMentionSource | null>(null)

  // `context` is a fresh object every render, so the effect keys off its two
  // primitive fields instead — otherwise the search would re-run on every
  // keystroke of the SURROUNDING message, not just this token.
  const projectId = context.projectId ?? null
  const sessionId = context.sessionId ?? null

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!source) {
      lastSourceRef.current = null
      setItems([])
      setLoading(false)
      setError(null)
      return
    }
    // The panel just opened on this source. Drop the cached candidate lists,
    // for the reason ⌘K drops its own on dialog open: within one picking
    // session a 15 s TTL is invisible, but a user who just created the record
    // they are about to reference must not have to wait it out.
    if (lastSourceRef.current !== source) {
      lastSourceRef.current = source
      invalidateEntityMentionCaches()
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    const handle = window.setTimeout(() => {
      void searchEntityMentionCandidates(source, query.trim(), { projectId, sessionId })
        .then((results) => {
          if (cancelled) return
          setItems(results)
          setLoading(false)
        })
        .catch((err: unknown) => {
          if (cancelled) return
          loggers.chat.warn("entity mention search failed", {
            entityKind: source.entityKind,
            err: err instanceof Error ? err.message : String(err),
          })
          setItems([])
          setError(err instanceof Error ? err.message : String(err))
          setLoading(false)
        })
    }, ENTITY_SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [source, query, projectId, sessionId])
  /* eslint-enable react-hooks/set-state-in-effect */

  // Memoized for the same reason `use-remote-doc-search.ts` memoizes its own
  // return: `composer-popover.tsx` builds its candidate list in a `useMemo`
  // whose dependency array holds this object, so a fresh identity every render
  // rebuilt the whole list each frame and reset the keyboard highlight
  // mid-typing.
  return useMemo(() => ({ source, items, loading, error }), [source, items, loading, error])
}
