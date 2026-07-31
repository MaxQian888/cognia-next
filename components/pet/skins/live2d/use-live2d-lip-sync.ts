// Drives a loaded Live2D model's mouth while the pet is "speaking" (a bubble is
// visible). The engine runs its own per-frame update loop and emits lifecycle
// events on the internal model; we hook `beforeModelUpdate` — which fires AFTER
// motions/expressions have set their parameters but BEFORE the core model commits
// them to the renderer — and overwrite the mouth-open parameter with the synthetic
// lip-sync envelope. Writing there guarantees our value wins over any motion that
// also touches the mouth. The engine import never enters this module (it only
// touches the structural model surface), so it stays bundle-light + test-friendly.

"use client"

import { useEffect } from "react"
import { LIP_SYNC_PARAM, LIP_SYNC_REST, mouthOpenAt } from "@/lib/pet/live2d/lip-sync"

/** The slice of a loaded model the lip-sync driver needs. */
export interface Live2dLipSyncModel {
  internalModel?: {
    on?(event: string, handler: () => void): unknown
    off?(event: string, handler: () => void): unknown
    coreModel?: {
      setParameterValueById?(id: string, value: number, weight?: number): void
    }
  }
}

/** The engine event fired each frame after motions, before the model commits. */
const MODEL_UPDATE_EVENT = "beforeModelUpdate"

/** Stable default clock so the unused-by-default `now` arg keeps effect identity. */
const defaultNow = (): number => Date.now()

/**
 * Animate the mouth while `speaking` is true. Reduced motion holds the mouth shut.
 * `now` is injectable for deterministic tests; the default is a module-level
 * constant so passing nothing keeps a stable identity and never re-registers the
 * frame handler on re-render.
 */
export function useLive2dLipSync(
  model: Live2dLipSyncModel | null,
  speaking: boolean,
  reducedMotion: boolean,
  now: () => number = defaultNow
): void {
  useEffect(() => {
    if (!model || reducedMotion || !speaking) return
    const internal = model.internalModel
    const core = internal?.coreModel
    // Feature-detect the engine surface; if the model doesn't expose the event
    // emitter or the parameter setter there is nothing to drive (the pet still
    // renders, just without mouth motion).
    if (!internal?.on || !internal.off || !core?.setParameterValueById) return

    const setMouth = (value: number) => {
      try {
        core.setParameterValueById!(LIP_SYNC_PARAM, value)
      } catch {
        // A parameter write must never break the render frame.
      }
    }

    const start = now()
    const handler = () => setMouth(mouthOpenAt(now() - start))
    internal.on(MODEL_UPDATE_EVENT, handler)

    return () => {
      internal.off!(MODEL_UPDATE_EVENT, handler)
      // Close the mouth when speech ends so it doesn't freeze mid-flap; the next
      // motion frame resumes normal control of the parameter.
      setMouth(LIP_SYNC_REST)
    }
  }, [model, speaking, reducedMotion, now])
}
