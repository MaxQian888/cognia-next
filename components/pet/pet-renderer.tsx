// Public render entry for the pet. Presentational and pure-ish: pick a skin and
// draw the given bones in the given visual state. Reduced motion resolves from
// the explicit prop when provided, otherwise from the OS preference — so the
// renderer honors `prefers-reduced-motion` even when a caller forgets to pass it.

"use client"

import { useReducedMotion } from "motion/react"
import type { PetBones, PetLocomotion, PetOneShot, PetStage, PetVisualState } from "@/types/pet"
import { getSkin } from "./skins/registry"

export interface PetRendererProps {
  bones: PetBones
  stage: PetStage
  state: PetVisualState
  oneShot?: PetOneShot | null
  /** Force reduced motion. When undefined, falls back to the OS preference. */
  reducedMotion?: boolean
  size?: number
  skinId?: string
  /** Overlay-only locomotion (walk/fall + facing). Absent = resting. */
  locomotion?: PetLocomotion | null
  /** Render a still frame (window hidden / widget minimized). */
  paused?: boolean
}

export function PetRenderer({
  bones,
  stage,
  state,
  oneShot = null,
  reducedMotion,
  size = 96,
  skinId,
  locomotion,
  paused,
}: PetRendererProps) {
  const osReduced = useReducedMotion()
  const reduced = reducedMotion ?? osReduced ?? false
  const skin = getSkin(skinId)
  return (
    <>
      {skin.render({
        bones,
        stage,
        state,
        oneShot,
        reducedMotion: reduced,
        size,
        locomotion: locomotion ?? undefined,
        paused,
      })}
    </>
  )
}
