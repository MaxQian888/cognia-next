"use client"

import { useEffect, useRef } from "react"
import { hydrateA2UISurfaceCache } from "@/stores/a2ui/a2ui-store"

/** Hydrate the A2UI ready-surface cache from its authoritative Dexie table. */
export function A2UISurfacePersistenceInitializer() {
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    void hydrateA2UISurfaceCache()
  }, [])

  return null
}
