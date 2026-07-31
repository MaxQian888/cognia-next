"use client"

// Reads the saved GitHub "marketplace repo" sources (Dexie) and fetches their
// catalogs into browse-grid entries. Keeps the source list reactive via
// `useLiveQuery`; refetches catalog entries whenever the set of sources
// changes.
//
// Entries and errors are held **per source reference** rather than as one
// merged pile. That is what makes single-source refresh exact (re-fetch one
// catalog, replace one bucket) and what lets a source that stops failing clear
// its own error — with a flat merged list, the only way to drop a stale error
// is to refetch everything, which costs GitHub API budget we don't have.
//
// Every fetch outcome is also written back to the row (`recordSourceSync`), so
// the sources UI can show plugin count / last-synced / last-error without
// re-fetching, and so a failure survives the dialog being closed and reopened.

import { useEffect, useMemo, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import {
  listMarketplaceSources,
  addMarketplaceSource,
  removeMarketplaceSource,
  recordSourceSync,
} from "@/lib/db/plugin-marketplace-sources"
import {
  fetchAllSourceEntries,
  fetchMarketplaceCatalog,
  type GithubMarketplaceEntry,
  type MarketplaceCatalog,
  type SourceFetchResult,
} from "@/lib/plugin/package/github-marketplace"
import { parseGithubPluginRef } from "@/lib/plugin/package/github-source"
import type { PluginMarketplaceSourceRow } from "@/lib/db/plugin-types"

export interface UseGithubMarketplaceSources {
  sources: PluginMarketplaceSourceRow[]
  entries: GithubMarketplaceEntry[]
  loading: boolean
  errors: Array<{ repoRef: string; message: string }>
  /** Source ids whose catalog is being fetched right now. */
  syncingIds: ReadonlySet<string>
  /** Fetch a catalog **without** persisting anything — the preview step. */
  preview: (repoRef: string) => Promise<MarketplaceCatalog>
  /** Persist a source from a catalog already fetched by `preview`. */
  commitPreview: (repoRef: string, catalog: MarketplaceCatalog) => Promise<void>
  /** Validate + persist a new source in one step. Throws when it has no catalog. */
  add: (repoRef: string) => Promise<void>
  remove: (id: string) => Promise<void>
  /** Re-fetch all source catalogs. */
  refresh: () => Promise<void>
  /** Re-fetch one source's catalog. */
  refreshSource: (id: string) => Promise<void>
}

/** Canonical `owner/repo[@ref]` id for a source reference. */
export function canonicalSourceId(repoRef: string): string {
  const ref = parseGithubPluginRef(repoRef)
  return `${ref.owner}/${ref.repo}${ref.ref ? `@${ref.ref}` : ""}`
}

export function useGithubMarketplaceSources(): UseGithubMarketplaceSources {
  const sources = useLiveQuery(() => listMarketplaceSources(), [], [])
  const [entriesByRef, setEntriesByRef] = useState<Record<string, GithubMarketplaceEntry[]>>({})
  const [errorsByRef, setErrorsByRef] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [syncingIds, setSyncingIds] = useState<ReadonlySet<string>>(new Set())
  const [reloadKey, setReloadKey] = useState(0)

  const repoRefs = useMemo(() => (sources ?? []).map((s) => s.repoRef), [sources])
  const repoRefsKey = repoRefs.join("|")
  // Monotonic request id so a slow in-flight fetch can't overwrite the results
  // of a newer one (the effect kicks off `loadEntries`, which keeps the actual
  // setState out of the effect body).
  const requestIdRef = useRef(0)
  const rows = sources ?? []

  /**
   * Write one fetch outcome back to its row.
   *
   * `rows` is this render's snapshot, which can be stale by the time a fetch
   * resolves — that's fine: `recordSourceSync` no-ops on a row that's gone, so
   * a refresh racing a removal can't resurrect the source.
   */
  const persistResult = async (result: SourceFetchResult) => {
    const row = rows.find((r) => r.repoRef === result.repoRef)
    if (!row) return
    try {
      await recordSourceSync(
        row.id,
        result.ok
          ? { ok: true, pluginCount: result.catalog.entries.length, name: result.catalog.name }
          : { ok: false, message: result.message }
      )
    } catch (err) {
      // Health is bookkeeping about the fetch, not the fetch itself. The
      // catalog entries are already in state by now, so a failed write costs a
      // stale "last synced" line — letting it reject would instead take down
      // the whole load and blank the browse grid.
      console.warn("marketplace source health write failed", row.id, err)
    }
  }

  const applyResults = (results: SourceFetchResult[]) => {
    setEntriesByRef((prev) => {
      const next = { ...prev }
      for (const r of results) next[r.repoRef] = r.ok ? r.catalog.entries : []
      return next
    })
    setErrorsByRef((prev) => {
      const next = { ...prev }
      for (const r of results) {
        if (r.ok) delete next[r.repoRef]
        else next[r.repoRef] = r.message
      }
      return next
    })
  }

  const loadEntries = async (refs: string[]) => {
    // Detach from the effect's synchronous tick so the rule against synchronous
    // setState-in-effect is satisfied — nothing below runs in the same tick as
    // the effect body that kicks this off.
    await Promise.resolve()
    const id = ++requestIdRef.current
    setLoading(true)
    try {
      const result = await fetchAllSourceEntries(refs)
      if (id !== requestIdRef.current) return
      applyResults(result.results)
      await Promise.all(result.results.map(persistResult))
    } finally {
      if (id === requestIdRef.current) setLoading(false)
    }
  }

  useEffect(() => {
    // Schedule the fetch on a microtask (mirrors use-system-scheduler) so the
    // effect body never synchronously traces into a setState call.
    if (repoRefs.length > 0) void Promise.resolve().then(() => loadEntries(repoRefs))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoRefsKey, reloadKey])

  // With no sources there is nothing to fetch, so any previously-fetched
  // entries/errors are stale — mask them to empty rather than clearing state
  // synchronously inside the effect.
  const hasSources = repoRefs.length > 0

  // Ordered by the source list rather than by whichever fetch won the race, so
  // the browse grid doesn't reshuffle between refreshes.
  const entries = useMemo(
    () => (hasSources ? repoRefs.flatMap((ref) => entriesByRef[ref] ?? []) : []),
    [hasSources, repoRefs, entriesByRef]
  )
  const errors = useMemo(
    () =>
      hasSources
        ? repoRefs
            .filter((ref) => errorsByRef[ref] !== undefined)
            .map((ref) => ({ repoRef: ref, message: errorsByRef[ref] }))
        : [],
    [hasSources, repoRefs, errorsByRef]
  )

  return useMemo(
    () => ({
      sources: sources ?? [],
      entries,
      loading,
      errors,
      syncingIds,
      preview: (repoRef: string) => fetchMarketplaceCatalog(repoRef),
      commitPreview: async (repoRef: string, catalog: MarketplaceCatalog) => {
        await addMarketplaceSource({
          id: canonicalSourceId(repoRef),
          repoRef,
          name: catalog.name,
          pluginCount: catalog.entries.length,
          lastSyncedAt: Date.now(),
        })
      },
      add: async (repoRef: string) => {
        const id = canonicalSourceId(repoRef)
        // Validate the repo actually hosts a catalog before persisting.
        const catalog = await fetchMarketplaceCatalog(repoRef)
        await addMarketplaceSource({
          id,
          repoRef,
          name: catalog.name,
          pluginCount: catalog.entries.length,
          lastSyncedAt: Date.now(),
        })
      },
      remove: async (id: string) => {
        await removeMarketplaceSource(id)
      },
      refresh: async () => setReloadKey((k) => k + 1),
      refreshSource: async (id: string) => {
        const row = rows.find((r) => r.id === id)
        if (!row) return
        // Invalidate any in-flight full load: it started with older data for
        // this source and would otherwise land on top of the fresh result.
        // Dropping it leaves the other sources on their previous entries —
        // stale-but-present rather than blank.
        requestIdRef.current++
        setSyncingIds((prev) => new Set(prev).add(id))
        try {
          let result: SourceFetchResult
          try {
            const catalog = await fetchMarketplaceCatalog(row.repoRef)
            result = { repoRef: row.repoRef, ok: true, catalog }
          } catch (err) {
            result = {
              repoRef: row.repoRef,
              ok: false,
              message: err instanceof Error ? err.message : String(err),
            }
          }
          applyResults([result])
          await persistResult(result)
        } finally {
          setSyncingIds((prev) => {
            const next = new Set(prev)
            next.delete(id)
            return next
          })
        }
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sources, entries, loading, errors, syncingIds]
  )
}
