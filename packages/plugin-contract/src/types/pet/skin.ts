// Render-skin interface — the reserved seam for alternative renderers. Only the
// SVG skin ships now (`components/pet/skins/svg-skin.tsx`); Lottie/Rive/sprite
// packs could register later without touching the state or event layers.

import type { ReactNode } from "react"
import type { PetBones } from "./bones"
import type { PetEvolutionFlavor, PetStage } from "./profile"
import type { PetMood, PetOneShot, PetVisualState } from "./visual-state"

/** Horizontal facing of the pet while it moves (or after its last walk). */
export type PetFacing = "left" | "right"

/** Renderer families supported by the desktop-pet subsystem. */
export type PetSkinId = "svg" | "live2d" | "sprite-v2"

/** Durable asset selection resolved before a skin is asked to render. */
export type PetSkinSelection =
  | { skinId: "svg" }
  | { skinId: "live2d"; modelId: string }
  | { skinId: "sprite-v2"; packId: string }

/** Expensive renderer budget assigned by the per-WebView skin runtime. */
export type PetRenderMode = "live" | "snapshot" | "placeholder"

/** Normalized pointer target. Values are clamped to the render box. */
export interface PetLookTarget {
  x: number
  y: number
  /** Epoch milliseconds of the most recent pointer sample. */
  updatedAt: number
  source: "window" | "screen"
}

/** Stable capability vocabulary shared by every renderer family. */
export interface PetSkinCapabilities {
  semanticStates: boolean
  oneShots: boolean
  locomotion: boolean
  facing: boolean
  heldPose: boolean
  speaking: boolean
  mood: boolean
  flavor: boolean
  gaze: boolean
  pause: boolean
  reducedMotion: boolean
  lowPower: boolean
}

export type PetAssetDiagnosticCode =
  | "unknownSkin"
  | "assetMissing"
  | "runtimeUnavailable"
  | "invalidSettings"
  | "missingRequiredResource"
  | "missingOptionalResource"
  | "ambiguousPath"
  | "duplicatePath"
  | "pathTraversal"
  | "corruptTexture"
  | "cubism2Unsupported"
  | "assetTooLarge"
  | "contextLost"
  | "renderFailed"

/** Machine-readable compatibility/recovery finding; UI localizes `code`. */
export interface PetAssetDiagnostic {
  code: PetAssetDiagnosticCode
  severity: "info" | "warning" | "error"
  path?: string
  detail?: string
  recoverable: boolean
}

/**
 * Desktop-overlay locomotion descriptor, parallel to (NOT part of)
 * `PetVisualState` — the in-app widget never walks, so skins treat an absent
 * value as "resting, facing right".
 */
export interface PetLocomotion {
  mode: "resting" | "walking" | "falling" | "climbing"
  facing: PetFacing
  /**
   * Current horizontal speed while walking (physical px/s, after any
   * accel/decel shaping). Skins sync the walk-bob cadence to it; absent
   * reads as the default cadence.
   */
  speedPxPerSec?: number
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
  /** Care-quality evolution flavor (cosmetic accent). Absent = normal. */
  flavor?: PetEvolutionFlavor
  /** Coarse mood — flavors the idle loop (lonely slows, happy quickens). */
  mood?: PetMood
  /** A speech bubble is showing — skins may animate the mouth (lip flap). */
  speaking?: boolean
  /** The user is holding/dragging the pet — dangle pose overrides resting. */
  held?: boolean
  /** Resolved asset selection. Legacy callers may omit it and receive SVG. */
  selection?: PetSkinSelection
  /** Whether this surface owns the per-WebView real-time renderer lease. */
  renderMode?: PetRenderMode
  /** Latest normalized gaze sample, when gaze following is enabled. */
  lookTarget?: PetLookTarget | null
  /** Low-power behavior is explicit instead of being read from settings. */
  lowPower?: boolean
}

export interface PetSkin {
  /** Registry key. Built-ins use PetSkinId; plugins may register custom keys. */
  id: string
  capabilities: PetSkinCapabilities
  render(props: PetSkinRenderProps): ReactNode
}
