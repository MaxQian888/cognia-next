"use client"

// Reactive access to the cached models.dev catalog (Dexie v60). Live-queries the
// singleton row so the sync card updates the moment a sync completes, and primes
// the synchronous in-memory cache (`models-dev-sync`) that UI render paths read.

import { useCallback, useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { getDb, type ModelsDevCatalogRow } from "@/lib/db/schema"
import {
  primeModelsDevCatalogCache,
  syncModelsDevCatalog,
} from "@/lib/ai/providers/models-dev-sync"

export interface UseModelsDevCatalogResult {
  row: ModelsDevCatalogRow | undefined
  providerCount: number
  modelCount: number
  isSyncing: boolean
  /**
   * True until the Dexie read settles. Distinct from `row === undefined`, which
   * conflates "still reading" with "no cached catalog" — callers that render
   * model metadata need the difference, otherwise they paint a bare model list
   * and then silently grow capability/pricing chips into it once the row lands.
   */
  isLoading: boolean
  error: string | null
  sync: () => Promise<void>
}

export function useModelsDevCatalog(): UseModelsDevCatalogResult {
  // Wrapped in an object so `undefined` unambiguously means "query pending":
  // a resolved-but-absent row comes back as `{ row: undefined }`.
  const resolved = useLiveQuery(
    async () => ({ row: await getDb().modelsDevCatalog.get("singleton") }),
    []
  )
  const row = resolved?.row
  const [isSyncing, setIsSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Keep the synchronous cache (used by getCatalogModelsForProvider) in sync.
  useEffect(() => {
    primeModelsDevCatalogCache(row ?? null)
  }, [row])

  const sync = useCallback(async () => {
    setIsSyncing(true)
    setError(null)
    try {
      await syncModelsDevCatalog()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setIsSyncing(false)
    }
  }, [])

  const providers = row?.providers ?? {}
  const providerCount = Object.keys(providers).length
  const modelCount = Object.values(providers).reduce((sum, p) => sum + p.models.length, 0)

  return {
    row,
    providerCount,
    modelCount,
    isSyncing,
    isLoading: resolved === undefined,
    error,
    sync,
  }
}
