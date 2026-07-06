"use client"

// Fires once on app boot. Primes the OpenRouter live-models catalog cache from
// the persisted row, then background-refreshes from the live `/models` API if
// the cache is missing or stale (>24h). Failures are swallowed — the existing
// (or empty) catalog stays in place. Mirrors `models-dev-catalog-initializer.tsx`.
// See `lib/ai/providers/openrouter-catalog-sync.ts`.

import { useEffect, useRef } from "react"

import { refreshOpenRouterCatalogIfStale } from "@/lib/ai/providers/openrouter-catalog-sync"

export function OpenRouterCatalogInitializer() {
  const hasInitialized = useRef(false)

  useEffect(() => {
    if (hasInitialized.current) return
    hasInitialized.current = true
    void refreshOpenRouterCatalogIfStale()
  }, [])

  return null
}

export default OpenRouterCatalogInitializer
