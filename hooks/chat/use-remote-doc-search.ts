"use client"

/**
 * Backing state for the composer's `@lark:` / `@gdoc:` panel (ADR-0134).
 *
 * Lives outside `composer-popover.tsx` because it owns three things the
 * popover's other branches do not: an account list, a pure link-recognition
 * fast path, and a provider that may not implement search at all.
 *
 * Two ways to reach a document, in priority order:
 *   1. the typed query IS a document link or token — `matchRef` resolves it
 *      synchronously with no network and no account required to *see* it;
 *   2. otherwise, keyword search through the connected account, when the
 *      provider implements it.
 *
 * A provider without `search` is not an error: the panel simply says "paste a
 * link", which is a complete answer for a user who has the link.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { loggers } from "@cognia/logging"
import {
  DocsProviderError,
  getDocsProviderByPrefix,
  isDocsProviderHostSupported,
  type DocsProvider,
  type DocsProviderAccount,
  type DocsProviderErrorCode,
  type RemoteDocRef,
} from "@/lib/docs-providers"

/** Debounce before a keyword search leaves the device. */
export const DOC_SEARCH_DEBOUNCE_MS = 250

/** How many hits to ask a provider for. */
export const DOC_SEARCH_LIMIT = 20

export interface RemoteDocSearchInput {
  /** The namespace prefix from the trigger (`"lark:"`), or null when inactive. */
  namespace: string | null
  /** Text typed after the prefix. */
  query: string
}

export interface RemoteDocSearchState {
  provider: DocsProvider | null
  /** False on web/mobile — the panel renders an explanatory empty state. */
  hostSupported: boolean
  /** `null` while the account list is loading. */
  accounts: readonly DocsProviderAccount[] | null
  accountId: string | null
  setAccountId: (id: string) => void
  items: readonly RemoteDocRef[]
  loading: boolean
  /** Set when the last attempt failed; drives the localized message. */
  error: { code: DocsProviderErrorCode; params?: Record<string, string> } | null
  /** True when the only way forward is pasting a link (no search capability). */
  linkOnly: boolean
}

function toError(err: unknown): { code: DocsProviderErrorCode; params?: Record<string, string> } {
  if (err instanceof DocsProviderError) return { code: err.code, params: err.params }
  return { code: "network", params: { reason: err instanceof Error ? err.message : String(err) } }
}

export function useRemoteDocSearch({
  namespace,
  query,
}: RemoteDocSearchInput): RemoteDocSearchState {
  const provider = useMemo(
    () => (namespace ? (getDocsProviderByPrefix(namespace) ?? null) : null),
    [namespace]
  )
  const hostSupported = provider ? isDocsProviderHostSupported(provider) : false

  const [accounts, setAccounts] = useState<readonly DocsProviderAccount[] | null>(null)
  const [accountId, setAccountId] = useState<string | null>(null)
  const [items, setItems] = useState<readonly RemoteDocRef[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<RemoteDocSearchState["error"]>(null)

  // Account list — reloaded whenever the panel opens for a different provider.
  // Deliberately not cached across opens: connecting an account in Settings
  // while the composer is mounted must be visible on the next `@` without a reload.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!provider || !hostSupported) {
      setAccounts(null)
      setAccountId(null)
      return
    }
    let cancelled = false
    setAccounts(null)
    void provider
      .listAccounts()
      .then((list) => {
        if (cancelled) return
        setAccounts(list)
        setAccountId((current) =>
          current && list.some((a) => a.id === current) ? current : (list[0]?.id ?? null)
        )
      })
      .catch((err) => {
        if (cancelled) return
        setAccounts([])
        setError(toError(err))
      })
    return () => {
      cancelled = true
    }
  }, [provider, hostSupported])

  const matched = useMemo(() => {
    if (!provider) return null
    const hit = provider.matchRef(query)
    if (!hit) return null
    return {
      providerId: provider.id,
      title: hit.id,
      ...hit,
    } satisfies RemoteDocRef
  }, [provider, query])

  const searchable = Boolean(provider?.search) && hostSupported
  const trimmed = query.trim()
  const requestSeq = useRef(0)

  useEffect(() => {
    if (!provider || !hostSupported) {
      setItems([])
      setLoading(false)
      return
    }
    // A recognized link wins outright: it needs no network and works even
    // before an account finishes loading.
    if (matched) {
      setItems([matched])
      setLoading(false)
      setError(null)
      return
    }
    if (!searchable || !trimmed || !accountId) {
      setItems([])
      setLoading(false)
      return
    }
    const seq = ++requestSeq.current
    setLoading(true)
    setError(null)
    const handle = window.setTimeout(() => {
      void provider
        .search?.(trimmed, { accountId, limit: DOC_SEARCH_LIMIT })
        .then((hits) => {
          if (requestSeq.current !== seq) return
          setItems(hits ?? [])
          setLoading(false)
        })
        .catch((err) => {
          if (requestSeq.current !== seq) return
          loggers.chat.warn("remote doc search failed", {
            provider: provider.id,
            err: err instanceof Error ? err.message : String(err),
          })
          setItems([])
          setError(toError(err))
          setLoading(false)
        })
    }, DOC_SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [provider, hostSupported, matched, searchable, trimmed, accountId])
  /* eslint-enable react-hooks/set-state-in-effect */

  const chooseAccount = useCallback((id: string) => setAccountId(id), [])

  // Memoised: the composer popover lists this object in a `useMemo` dependency
  // array, so a fresh identity on every render would invalidate the whole
  // candidate list each frame and reset the keyboard highlight mid-typing.
  return useMemo(
    () => ({
      provider,
      hostSupported,
      accounts,
      accountId,
      setAccountId: chooseAccount,
      items,
      loading,
      error,
      linkOnly: Boolean(provider) && hostSupported && !searchable,
    }),
    [provider, hostSupported, accounts, accountId, chooseAccount, items, loading, error, searchable]
  )
}
