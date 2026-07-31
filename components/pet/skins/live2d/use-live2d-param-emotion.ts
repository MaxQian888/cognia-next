// Drives per-frame parameter envelopes for the "AI at work" states
// (thinking / waiting / review) that otherwise collapse to a bare Idle motion
// on most Live2D models. Clones the lip-sync driver's `beforeModelUpdate`
// pattern: the hook writes AFTER motions/expressions set their parameters but
// BEFORE the core model commits, so the envelope wins over the idle motion.
// Engine-import-free — only the structural model surface is touched.

"use client"

import { useEffect } from "react"
import type { PetOneShot, PetVisualState } from "@/types/pet"
import { emotionParamsAt, PARAM_EMOTION_STATES } from "@/lib/pet/live2d/param-emotion"
import type { Live2dLipSyncModel } from "./use-live2d-lip-sync"

/** Same structural surface as the lip-sync driver. */
export type Live2dParamEmotionModel = Live2dLipSyncModel

const MODEL_UPDATE_EVENT = "beforeModelUpdate"

/** Stable default clock (see use-live2d-lip-sync). */
const defaultNow = (): number => Date.now()

/**
 * Animate the head/eyes while the pet sits in a covered state. One-shots and
 * reduced motion suspend the envelope (their motions own the parameters).
 */
export function useLive2dParamEmotion(
  model: Live2dParamEmotionModel | null,
  state: PetVisualState,
  oneShot: PetOneShot | null,
  reducedMotion: boolean,
  now: () => number = defaultNow
): void {
  const active = PARAM_EMOTION_STATES.has(state) && oneShot === null && !reducedMotion
  useEffect(() => {
    if (!model || !active) return
    const internal = model.internalModel
    const core = internal?.coreModel
    if (!internal?.on || !internal.off || !core?.setParameterValueById) return

    const start = now()
    const handler = () => {
      const writes = emotionParamsAt(state, now() - start)
      for (const write of writes) {
        try {
          core.setParameterValueById!(write.id, write.value)
        } catch {
          // A parameter write must never break the render frame.
        }
      }
    }
    internal.on(MODEL_UPDATE_EVENT, handler)
    return () => {
      internal.off!(MODEL_UPDATE_EVENT, handler)
      // No reset write needed: the next motion/idle frame re-owns the
      // parameters (unlike the mouth, these rest at the model's own pose).
    }
  }, [model, state, active, now])
}
