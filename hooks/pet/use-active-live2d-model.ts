// Resolves the globally-active Live2D model for the pet skin, plus a cheap probe
// for whether the Cubism Core runtime is available. The model row is read
// reactively via `useLiveQuery` so importing/deleting a model updates the skin
// live. Core availability is a single module-cached HEAD against the public
// path — probing via `ensureCubismCore` here would inject + load the core
// eagerly for every user, which we explicitly avoid.

"use client"

import { useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { getPetModel, type PetModelRow } from "@/lib/db/pet-models"
import { CUBISM_CORE_PUBLIC_PATH } from "@/lib/pet/live2d/constants"
import type { PetSettings } from "@/types/pet"

export interface ActiveLive2dModel {
  modelId: string | undefined
  row: PetModelRow | undefined
  coreReady: boolean | undefined
}

// Module-level cache so the HEAD fires at most once per session across all
// consumers. `undefined` = not yet probed (initial render before fetch settles).
let corePromise: Promise<boolean> | null = null

function probeCubismCore(): Promise<boolean> {
  if (corePromise) return corePromise
  corePromise = (async () => {
    // Already injected (build script dropped it + a prior load ran)?
    if (
      typeof window !== "undefined" &&
      (window as { Live2DCubismCore?: unknown }).Live2DCubismCore
    ) {
      return true
    }
    try {
      const res = await fetch(CUBISM_CORE_PUBLIC_PATH, { method: "HEAD" })
      return res.ok
    } catch {
      return false
    }
  })()
  return corePromise
}

/** Test-only: forget the cached probe so each test starts clean. */
export function resetCubismCoreProbe(): void {
  corePromise = null
}

/**
 * One-shot probe for Cubism Core availability. Returns `undefined` until the
 * HEAD settles, then a stable boolean for the rest of the session.
 */
export function useCubismCoreAvailable(): boolean | undefined {
  const [ready, setReady] = useState<boolean | undefined>(undefined)
  useEffect(() => {
    let active = true
    void probeCubismCore().then((ok) => {
      if (active) setReady(ok)
    })
    return () => {
      active = false
    }
  }, [])
  return ready
}

/** Active model id + row (live) and the Cubism Core readiness probe. */
export function useActiveLive2dModel(settings: PetSettings): ActiveLive2dModel {
  const modelId = settings.activeLive2dModelId
  const row = useLiveQuery(
    () => (modelId ? getPetModel(modelId) : Promise.resolve(undefined)),
    [modelId],
    undefined
  )
  const coreReady = useCubismCoreAvailable()
  return { modelId, row, coreReady }
}
