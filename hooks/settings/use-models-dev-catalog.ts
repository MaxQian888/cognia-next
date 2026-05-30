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
  error: string | null
  sync: () => Promise<void>
}

export function useModelsDevCatalog(): UseModelsDevCatalogResult {
  const row = useLiveQuery(() => getDb().modelsDevCatalog.get("singleton"), [])
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

  return { row, providerCount, modelCount, isSyncing, error, sync }
}
