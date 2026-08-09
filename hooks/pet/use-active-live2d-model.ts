// Resolves the globally-active Live2D model for the pet skin, plus the Cubism
// Core readiness gate. The model row is read reactively via `useLiveQuery` so
// importing/deleting a model updates the skin live. Core readiness is resolved
// through the SAME path the model actually loads — `ensureCubismCore` (a
// `<script src>` injection of the locally-bundled core) — and only when the
// Live2D skin is genuinely in use, so SVG users never pull the core.

"use client"

import { useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { getPetModel, type PetModelRow } from "@/lib/db/pet-models"
import { ensureCubismCore, resetCubismCoreLoaderForTests } from "@/lib/pet/live2d/core-loader"
import type { PetSettings, PetSkinSelection } from "@/types/pet"

export interface ActiveLive2dModel {
  modelId: string | undefined
  row: PetModelRow | undefined
  coreReady: boolean | undefined
}

/** Test-only: forget the cached core load so each test starts clean. */
export function resetCubismCoreProbe(): void {
  resetCubismCoreLoaderForTests()
}

/**
 * Cubism Core availability gate. Returns `undefined` until it resolves, then a
 * stable boolean.
 *
 * It probes through `ensureCubismCore` — the same `<script src>` injection the
 * canvas loader uses — rather than a separate `fetch(HEAD)`. Under Tauri's
 * custom asset protocol a HEAD fetch is unreliable: it answers to `connect-src`
 * and the protocol need not implement HEAD, so a perfectly loadable core can
 * report "missing" and the skin silently degrades to SVG forever. Script
 * injection is governed by `script-src 'self'` and is exactly how the model
 * pulls the core in, so the gate can never disagree with whether the model can
 * actually render — and the injected core is reused by the loader instantly.
 *
 * `enabled` gates the injection so SVG users never pay the ~200KB core download:
 * pass `true` only when the Live2D skin is actually selected / in use.
 */
export function useCubismCoreAvailable(enabled = true): boolean | undefined {
  const [ready, setReady] = useState<boolean | undefined>(undefined)
  // When the gate turns off (skin switched away), reset readiness to "unknown"
  // during render so a stale `true` can't leak across the switch — React's
  // documented "adjust state during render" pattern, which avoids a
  // setState-in-effect cascade.
  const [prevEnabled, setPrevEnabled] = useState(enabled)
  if (prevEnabled !== enabled) {
    setPrevEnabled(enabled)
    if (!enabled) setReady(undefined)
  }
  useEffect(() => {
    // Not in use → never inject the core (SVG users don't pay the download).
    if (!enabled) return
    let active = true
    void ensureCubismCore().then((ok) => {
      if (active) setReady(ok)
    })
    return () => {
      active = false
    }
  }, [enabled])
  return ready
}

/** Active model id + row (live) and the Cubism Core readiness gate. */
export function useActiveLive2dModel(
  settings: PetSettings,
  selection?: PetSkinSelection
): ActiveLive2dModel {
  const selectedSkinId = selection?.skinId ?? settings.skinId
  const modelId =
    selection?.skinId === "live2d"
      ? selection.modelId
      : selection
        ? undefined
        : settings.activeLive2dModelId
  const row = useLiveQuery(
    () => (modelId ? getPetModel(modelId) : Promise.resolve(undefined)),
    [modelId],
    undefined
  )
  // Only load the core when this user has the Live2D skin selected AND an active
  // model — otherwise the gate is moot (`resolveEffectiveSkin` returns "svg")
  // and SVG users must not download the core.
  const coreReady = useCubismCoreAvailable(selectedSkinId === "live2d" && Boolean(modelId))
  return { modelId, row, coreReady }
}
