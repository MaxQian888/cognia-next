// Render-skin interface — the reserved seam for alternative renderers. Only the
// SVG skin ships now (`components/pet/skins/svg-skin.tsx`); Lottie/Rive/sprite
// packs could register later without touching the state or event layers.

import type { ReactNode } from "react"
import type { PetBones } from "./bones"
import type { PetStage } from "./profile"
import type { PetOneShot, PetVisualState } from "./visual-state"

/** Horizontal facing of the pet while it moves (or after its last walk). */
export type PetFacing = "left" | "right"

/**
 * Desktop-overlay locomotion descriptor, parallel to (NOT part of)
 * `PetVisualState` — the in-app widget never walks, so skins treat an absent
 * value as "resting, facing right".
 */
export interface PetLocomotion {
  mode: "resting" | "walking" | "falling"
  facing: PetFacing
}

export interface PetSkinRenderProps {
  bones: PetBones
  stage: PetStage
  state: PetVisualState
  /** Active one-shot, or null when only the resting state animates. */
  oneShot: PetOneShot | null
  /** When true, disable looping motion (reduced-motion / paused). */
  reducedMotion: boolean
  /** Pixel size of the square render box. */
  size: number
  /** Overlay-only locomotion (walk/fall + facing). Absent = resting. */
  locomotion?: PetLocomotion
  /** Render a still frame (window hidden / widget minimized). */
  paused?: boolean
}

export interface PetSkin {
  id: string
  render(props: PetSkinRenderProps): ReactNode
}
