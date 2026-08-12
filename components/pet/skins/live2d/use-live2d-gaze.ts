"use client"

import { useEffect } from "react"
import type { PetLookTarget } from "@/types/pet"
import type { Live2dLipSyncModel } from "./use-live2d-lip-sync"

export type Live2dGazeModel = Live2dLipSyncModel

const MODEL_UPDATE_EVENT = "beforeModelUpdate"

export function useLive2dGaze(
  model: Live2dGazeModel | null,
  target: PetLookTarget | null | undefined,
  mapping: Readonly<Record<string, string>>,
  active: boolean
): void {
  useEffect(() => {
    if (!model || !target || !active) return
    const internal = model.internalModel
    const core = internal?.coreModel
    if (!internal?.on || !internal.off || !core?.setParameterValueById) return
    const writes: Array<[string | undefined, number]> = [
      [mapping.headX, target.x * 12],
      [mapping.headY, -target.y * 10],
      [mapping.headZ, target.x * 3],
      [mapping.eyeX, target.x],
      [mapping.eyeY, -target.y],
      [mapping.bodyX, target.x * 4],
      [mapping.bodyY, -target.y * 2],
    ]
    const handler = () => {
      for (const [id, value] of writes) {
        if (!id) continue
        try {
          core.setParameterValueById!(id, value)
        } catch {
          // Non-standard models may reject a nominally present parameter.
        }
      }
    }
    internal.on(MODEL_UPDATE_EVENT, handler)
    return () => {
      internal.off!(MODEL_UPDATE_EVENT, handler)
    }
  }, [active, mapping, model, target])
}
