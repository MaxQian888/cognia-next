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

import { useCallback, useEffect, useMemo, useState } from "react"
import { loggers } from "@cognia/logging"
import { useHostProfile } from "@/hooks/use-host-profile"
import { docsProviderReach, type DocsProviderReach } from "@/lib/docs-providers/reach"
import { bindRemoteDocRef } from "@/lib/docs-providers/account-binding"
import {
  DocsProviderError,
  getDocsProviderByPrefix,
  type DocsProvider,
  type DocsProviderAccount,
  type DocsProviderErrorCode,
  type RemoteDocRef,
} from "@/lib/docs-providers"

/**
 * Reach when no namespace is active at all. Not a block the user can act on:
 * the panel is closed, so nothing renders it.
 */
const UNAVAILABLE_NO_PROVIDER: DocsProviderReach = Object.freeze({ available: false })

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
  /** False on web/mobile. The panel renders an explanatory empty state. */
  hostSupported: boolean
  /**
   * WHY the panel is unavailable, when it is. `hostSupported` alone cannot
   * distinguish a standalone browser (nothing anywhere can read this) from a
   * companion (the paired host can, this client has no route to it), and the
   * two deserve different sentences.
   */
  reach: DocsProviderReach
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
  const hostProfile = useHostProfile()
  const reach = useMemo<DocsProviderReach>(
    () => (provider ? docsProviderReach(provider, hostProfile) : UNAVAILABLE_NO_PROVIDER),
    [provider, hostProfile]
  )
  const hostSupported = reach.available

  const [accountSnapshot, setAccountSnapshot] = useState<{
    provider: DocsProvider
    accounts: readonly DocsProviderAccount[]
    error: RemoteDocSearchState["error"]
  } | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const accounts = provider === accountSnapshot?.provider ? accountSnapshot.accounts : null
  const account = accounts?.find((a) => a.id === selectedId) ?? accounts?.[0] ?? null
  const accountId = account?.id ?? null
  const epoch = account?.authorizationEpoch
  const [result, setResult] = useState<{
    provider: DocsProvider
    query: string
    accountId: string
    epoch?: string
    items: readonly RemoteDocRef[]
    error: RemoteDocSearchState["error"]
  } | null>(null)

  // Account list — reloaded whenever the panel opens for a different provider.
  // Deliberately not cached across opens: connecting an account in Settings
  // while the composer is mounted must be visible on the next `@` without a reload.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!provider || !hostSupported) {
      setAccountSnapshot(null)
      return
    }
    let cancelled = false
    let version = 0
    const reload = () => {
      const attempt = ++version
      setAccountSnapshot(null)
      setResult(null)
      void provider.listAccounts().then(
        (list) => {
          if (!cancelled && attempt === version)
            setAccountSnapshot({ provider, accounts: list, error: null })
        },
        (err) => {
          if (!cancelled && attempt === version)
            setAccountSnapshot({ provider, accounts: [], error: toError(err) })
        }
      )
    }
    const unsubscribe = provider.subscribeAccounts?.(reload)
    reload()
    return () => {
      cancelled = true
      unsubscribe?.()
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

  useEffect(() => {
    setResult(null)
    if (!provider || !hostSupported) return
    // A recognized link wins outright: it needs no network and works even
    // before an account finishes loading.
    if (matched) {
      return
    }
    if (!searchable || !trimmed || !accountId) {
      return
    }
    // Cleanup must invalidate searches even when the next render takes a
    // synchronous link/empty/unavailable branch and starts no replacement.
    let cancelled = false
    const controller = new AbortController()
    const handle = window.setTimeout(() => {
      void provider
        .search?.(trimmed, {
          accountId,
          ...(epoch ? { expectedAuthorizationEpoch: epoch } : {}),
          limit: DOC_SEARCH_LIMIT,
          signal: controller.signal,
        })
        .then((hits) => {
          if (cancelled) return
          setResult({
            provider,
            query: trimmed,
            accountId,
            epoch,
            items: (hits ?? []).map((ref) => {
              if (ref.providerId !== provider.id) throw new DocsProviderError("invalidRef")
              return bindRemoteDocRef(ref, { id: accountId, label: "", authorizationEpoch: epoch })
            }),
            error: null,
          })
        })
        .catch((err) => {
          if (cancelled) return
          loggers.chat.warn("remote doc search failed", {
            provider: provider.id,
            err: err instanceof Error ? err.message : String(err),
          })
          setResult({ provider, query: trimmed, accountId, epoch, items: [], error: toError(err) })
        })
    }, DOC_SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      controller.abort()
      window.clearTimeout(handle)
    }
  }, [provider, hostSupported, matched, searchable, trimmed, accountId, epoch])
  /* eslint-enable react-hooks/set-state-in-effect */

  const chooseAccount = useCallback((id: string) => setSelectedId(id), [])
  const currentResult =
    result?.provider === provider &&
    result.query === trimmed &&
    result.accountId === accountId &&
    result.epoch === epoch
      ? result
      : null
  const items = useMemo(() => {
    if (!hostSupported) return []
    if (matched) return [account ? bindRemoteDocRef(matched, account) : matched]
    return currentResult?.items ?? []
  }, [hostSupported, matched, account, currentResult])
  const loading = Boolean(
    provider && hostSupported && !matched && searchable && trimmed && accountId && !currentResult
  )
  const error =
    (provider === accountSnapshot?.provider ? accountSnapshot.error : null) ??
    currentResult?.error ??
    null

  // Memoised: the composer popover lists this object in a `useMemo` dependency
  // array, so a fresh identity on every render would invalidate the whole
  // candidate list each frame and reset the keyboard highlight mid-typing.
  return useMemo(
    () => ({
      provider,
      hostSupported,
      reach,
      accounts,
      accountId,
      setAccountId: chooseAccount,
      items,
      loading,
      error,
      linkOnly: Boolean(provider) && hostSupported && !searchable,
    }),
    [
      provider,
      hostSupported,
      reach,
      accounts,
      accountId,
      chooseAccount,
      items,
      loading,
      error,
      searchable,
    ]
  )
}
