"use client"

// Fires once on app boot. Seeds the bundled models.dev snapshot on first run so
// the provider catalog is never empty, then background-refreshes from the live
// API if the cache is stale (>7d). Failures are swallowed — the bundled/older
// catalog stays in place. See `lib/ai/providers/models-dev-sync.ts`.

import { useEffect, useRef } from "react"

import { refreshModelsDevCatalogIfStale } from "@/lib/ai/providers/models-dev-sync"

export function ModelsDevCatalogInitializer() {
  const hasInitialized = useRef(false)

  useEffect(() => {
    if (hasInitialized.current) return
    hasInitialized.current = true
    void refreshModelsDevCatalogIfStale()
  }, [])

  return null
}

export default ModelsDevCatalogInitializer
