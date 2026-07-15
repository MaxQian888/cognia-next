"use client"

/**
 * Browse Open VSX from the marketplace's "VS Code" section.
 *
 * The cognia-registry twin of this hook is `use-plugin-marketplace.ts`; this
 * one exists rather than extending it because almost nothing is shared. That
 * hook fans out to four endpoints (search + featured/popular/recent) and pages
 * on the client over a fully-materialised list; Open VSX has one endpoint and
 * pages on the server. What *is* shared — `PluginMarketplaceEntry`, the card,
 * the skeleton, the error card, the empty state — is imported, not forked.
 *
 * ## Three guards
 *
 * - **Nothing is fetched until `enabled`.** Opening the Plugins page must not
 *   hit open-vsx.org. `use-plugin-marketplace.ts` documents why its own
 *   `autoLoad` flag exists (a `[plugin:marketplace] Search failed` on every
 *   page entry); the same reasoning applies with more force to a third-party
 *   registry, so the fetch waits for the user to actually open the section.
 * - **Server-side paging only.** `size` / `offset` go to the registry and pages
 *   accumulate; the list is never fetched whole. Open VSX has ~4k extensions.
 * - **The search box is debounced.** Un-debounced, a typed query is one request
 *   per keystroke against a rate-limited public registry.
 *
 * ## Why this deliberately does not write `openVsxCache`
 *
 * Priming the cache from search results looks free and is a bug.
 * `OpenVsxCacheRow.latestVersion` has no stability semantics, and search
 * returns the newest *published* version — which for `rust-lang.rust-analyzer`
 * is a pre-release. The update check reads `latestVersion` straight out of that
 * cache, so a user who merely *browsed* would afterwards be nagged to "update"
 * onto a pre-release they never opted into, while a user who didn't browse
 * would not. Only `updater.ts` writes the cache, and only ever with the
 * resolved newest-**stable** entry.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { getOpenVsxClient, type OpenVsxSearchEntry } from "@/lib/plugin/vscode-shim/openvsx-client"
import type { PluginMarketplaceEntry } from "./use-plugin-marketplace"

/** Milliseconds of quiet before a typed query is sent. */
export const OPEN_VSX_SEARCH_DEBOUNCE_MS = 350

export interface OpenVsxMarketplaceEntry extends PluginMarketplaceEntry {
  /**
   * Open VSX's `verified` flag — **its** claim that the publisher owns the
   * namespace. Rendered attributed ("Publisher verified by Open VSX"), never as
   * a bare "verified" and never as a safety claim.
   */
  verifiedPublisher: boolean
  /** Registry icon URL, host-pinned by the client. */
  iconUrl?: string
  /**
   * Deliberately the **literal** `"unknown"`, not `SignatureState`.
   *
   * We never verify a signature on this path, so the type makes the honest
   * value the only representable one: a future "just map verified to
   * signatureState" edit is a compile error, not a silently shipped lie.
   */
  signatureState: "unknown"
}

export type OpenVsxMarketplaceState =
  { kind: "idle" } | { kind: "loading" } | { kind: "ready" } | { kind: "error"; error: string }

export interface UseOpenVsxMarketplace {
  query: string
  setQuery: (q: string) => void
  state: OpenVsxMarketplaceState
  /** Every page fetched so far, in registry order. */
  entries: OpenVsxMarketplaceEntry[]
  /** `totalSize` from the registry — the full result count, not what's loaded. */
  total: number
  hasMore: boolean
  /** Fetch the next `pageSize` window. No-op while a page is in flight. */
  loadMore: () => void
  refresh: () => void
}

export interface UseOpenVsxMarketplaceOptions {
  /**
   * Whether the section is open. `false` means **no network at all** — see the
   * module doc.
   */
  enabled: boolean
  /** Registry `size`. Mirrors the marketplace grid's PAGE_SIZE. */
  pageSize: number
}

/**
 * Map a registry search entry onto the shared card entry type.
 *
 * ## `verified` must not become `signed`
 *
 * `PluginMarketplaceCard` renders `signed: true` as
 * `PluginSignatureBadge state="verified"` — a ShieldCheck whose tooltip reads
 * "Publisher signature verified." We do not verify a signature. We fetch a
 * SHA-256 digest over the same TLS connection, from the same host, as the
 * `.vsix` itself; that proves the bytes weren't corrupted in transit and
 * **nothing** about a compromised registry, a registry insider, or a malicious
 * publisher — each of whom controls the file and the digest together.
 *
 * So `signatureState` is pinned to `"unknown"` **explicitly**, rather than left
 * to the card's `entry.signed ? "verified" : "unverified"` fallback: `signed`
 * is simply never set here, and pinning the state makes that a decision rather
 * than an omission a later refactor could reverse by accident.
 * `checksum_badge_does_not_claim_publisher_verification` pins it.
 */
export function toMarketplaceEntry(entry: OpenVsxSearchEntry): OpenVsxMarketplaceEntry {
  return {
    id: `${entry.namespace}.${entry.name}`,
    name: entry.displayName ?? entry.name,
    version: entry.version,
    description: entry.description,
    author: entry.namespace,
    rating: entry.averageRating,
    downloads: entry.downloadCount,
    type: "vscode-extension",
    // `PluginRow.source` vocabulary — it has no "openvsx" member; that value
    // lives on `manifest.vscodeExtension.source`. Two fields, same name,
    // different domains.
    source: "marketplace",
    signatureState: "unknown",
    verifiedPublisher: entry.verified === true,
    iconUrl: entry.files.icon,
  }
}

export function useOpenVsxMarketplace(
  options: UseOpenVsxMarketplaceOptions
): UseOpenVsxMarketplace {
  const { enabled, pageSize } = options
  const [query, setQuery] = useState("")
  const [debouncedQuery, setDebouncedQuery] = useState("")
  const [state, setState] = useState<OpenVsxMarketplaceState>({ kind: "idle" })
  const [entries, setEntries] = useState<OpenVsxMarketplaceEntry[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  /** Bumped by `refresh()` to force a re-fetch of the current window. */
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), OPEN_VSX_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])

  // Reset paging whenever the query or the gate changes. Done as the
  // documented prev-value compare during render rather than in an effect —
  // `react-hooks/set-state-in-effect` blocks the effect spelling, and an extra
  // render pass here would fetch page 2 of the *previous* query first.
  const viewKey = `${enabled}|${debouncedQuery}|${nonce}`
  const [trackedView, setTrackedView] = useState(viewKey)
  if (trackedView !== viewKey) {
    setTrackedView(viewKey)
    setOffset(0)
    setEntries([])
    setTotal(0)
  }

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    // Deferred by a tick so the state writes land outside the effect body
    // (same shape as use-plugin-marketplace's initial load).
    const timer = setTimeout(() => {
      void (async () => {
        setState({ kind: "loading" })
        try {
          const response = await getOpenVsxClient().searchExtensions({
            ...(debouncedQuery.trim() ? { query: debouncedQuery.trim() } : {}),
            size: pageSize,
            offset,
          })
          if (cancelled) return
          const mapped = response.extensions.map(toMarketplaceEntry)
          // Append for a page-2+ fetch, replace for a fresh window. Deduped by
          // id: the registry can shift an entry across the page boundary
          // between requests, and React would throw on the duplicate key.
          setEntries((prev) => {
            const merged = offset === 0 ? mapped : [...prev, ...mapped]
            const seen = new Set<string>()
            return merged.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
          })
          setTotal(response.totalSize)
          setState({ kind: "ready" })
        } catch (error) {
          if (cancelled) return
          setState({
            kind: "error",
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })()
    }, 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [enabled, debouncedQuery, offset, pageSize, nonce])

  const loadMore = useCallback(() => {
    setState((current) => {
      // Guard inside the setter so the decision reads the committed state
      // rather than a value closed over one render ago — a double-click would
      // otherwise skip a page.
      if (current.kind === "loading") return current
      setOffset((o) => o + pageSize)
      return current
    })
  }, [pageSize])

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  const hasMore = entries.length < total

  return useMemo(
    () => ({ query, setQuery, state, entries, total, hasMore, loadMore, refresh }),
    [query, state, entries, total, hasMore, loadMore, refresh]
  )
}
