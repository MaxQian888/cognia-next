// Pure emotion → motion resolver. Maps a semantic PetVisualState (+ optional
// one-shot, + reduced-motion flag) to a render-agnostic descriptor of how the
// body should move and what face to wear. The renderer turns this into
// framer-motion keyframes. Keeping it pure means the whole expression system is
// unit-tested without mounting anything.

import type { PetEyes, PetOneShot, PetVisualState } from "@/types/pet"

export type PetMouthShape = "neutral" | "smile" | "grin" | "open" | "frown" | "flat" | "o"

export interface PetBodyKeyframes {
  /** Uniform scale keyframes (resting value first). */
  scale: number[]
  /** Vertical bob in px (resting value first). */
  y: number[]
  /** Horizontal shake in px. */
  x: number[]
  /** Rotation in degrees. */
  rotate: number[]
}

export interface PetMotionSpec {
  /** Effective eye shape (emotion may override the bones default). */
  eyes: PetEyes
  mouth: PetMouthShape
  body: PetBodyKeyframes
  /** Seconds for one keyframe cycle. */
  durationSec: number
  /** Whether the body keyframes loop (false for one-shots / reduced motion). */
  loop: boolean
}

const STILL: PetBodyKeyframes = { scale: [1], y: [0], x: [0], rotate: [0] }

/** Resting-state expressions + body motion, keyed by visual state. */
function baseSpec(state: PetVisualState, bonesEyes: PetEyes): PetMotionSpec {
  switch (state) {
    case "idle":
      return {
        eyes: bonesEyes,
        mouth: "smile",
        body: { scale: [1, 1.04, 1], y: [0, -2, 0], x: [0], rotate: [0] },
        durationSec: 3.2,
        loop: true,
      }
    case "thinking":
      return {
        eyes: bonesEyes,
        mouth: "o",
        body: { scale: [1, 1.02, 1], y: [0, -1, 0], x: [0], rotate: [-2, 2, -2] },
        durationSec: 1.1,
        loop: true,
      }
    case "waiting":
      return {
        eyes: "wide",
        mouth: "o",
        body: { scale: [1], y: [0, -3, 0], x: [0], rotate: [0] },
        durationSec: 0.9,
        loop: true,
      }
    case "review":
      return {
        eyes: "wide",
        mouth: "neutral",
        body: { scale: [1], y: [0], x: [0], rotate: [-4, 4, -4] },
        durationSec: 1.6,
        loop: true,
      }
    case "happy":
      return {
        eyes: "wink",
        mouth: "grin",
        body: { scale: [1, 1.06, 1], y: [0, -10, 0], x: [0], rotate: [0] },
        durationSec: 0.6,
        loop: true,
      }
    case "sad":
      return {
        eyes: "sleepy",
        mouth: "frown",
        body: { scale: [1, 0.98, 1], y: [0, 1, 0], x: [0], rotate: [0] },
        durationSec: 3.6,
        loop: true,
      }
    case "error":
      return {
        eyes: "spiral",
        mouth: "flat",
        body: { scale: [1], y: [0], x: [-3, 3, -3, 3, 0], rotate: [0] },
        durationSec: 0.5,
        loop: true,
      }
    case "sleeping":
      return {
        eyes: "sleepy",
        mouth: "neutral",
        body: { scale: [1, 1.05, 1], y: [0, 1, 0], x: [0], rotate: [0] },
        durationSec: 4.5,
        loop: true,
      }
    case "greeting":
      return {
        eyes: "star",
        mouth: "grin",
        body: { scale: [1, 1.05, 1], y: [0, -6, 0], x: [0], rotate: [-6, 6, 0] },
        durationSec: 0.8,
        loop: true,
      }
    case "evolving":
      return {
        eyes: "star",
        mouth: "open",
        body: { scale: [1, 1.15, 0.95, 1.1, 1], y: [0], x: [0], rotate: [0, 8, -8, 0] },
        durationSec: 1.2,
        loop: true,
      }
    case "interacting":
      return {
        eyes: "wide",
        mouth: "smile",
        body: { scale: [1, 1.05, 1], y: [0, -3, 0], x: [0], rotate: [0] },
        durationSec: 0.7,
        loop: true,
      }
  }
}

/** One-shot overrides (play once, no loop). */
function oneShotSpec(shot: PetOneShot, base: PetMotionSpec): PetMotionSpec {
  switch (shot) {
    case "wave":
      return {
        ...base,
        mouth: "grin",
        body: { scale: [1], y: [0], x: [0], rotate: [0, -12, 12, -8, 0] },
        durationSec: 0.9,
        loop: false,
      }
    case "happy":
      return {
        ...base,
        eyes: "wink",
        mouth: "grin",
        body: { scale: [1, 1.1, 1], y: [0, -16, 0, -8, 0], x: [0], rotate: [0] },
        durationSec: 0.9,
        loop: false,
      }
    case "fed":
      return {
        ...base,
        mouth: "open",
        body: { scale: [1, 1.12, 0.96, 1], y: [0], x: [0], rotate: [0] },
        durationSec: 0.6,
        loop: false,
      }
    case "petted":
      return {
        ...base,
        eyes: "wink",
        mouth: "smile",
        body: { scale: [1, 0.9, 1.04, 1], y: [0, 2, 0], x: [0], rotate: [0] },
        durationSec: 0.5,
        loop: false,
      }
    case "evolving":
      return {
        ...base,
        eyes: "star",
        mouth: "open",
        body: { scale: [1, 1.3, 0.8, 1.15, 1], y: [0], x: [0], rotate: [0, 360] },
        durationSec: 1.4,
        loop: false,
      }
    case "levelUp":
      return {
        ...base,
        eyes: "star",
        mouth: "grin",
        body: { scale: [1, 1.2, 1], y: [0, -20, 0], x: [0], rotate: [0] },
        durationSec: 1,
        loop: false,
      }
    case "sad":
      return {
        ...base,
        eyes: "sleepy",
        mouth: "frown",
        body: { scale: [1, 0.96, 0.98], y: [0, 4, 3], x: [0], rotate: [0] },
        durationSec: 1.4,
        loop: false,
      }
    case "surprised":
      return {
        ...base,
        eyes: "wide",
        mouth: "o",
        body: { scale: [1, 1.15, 1], y: [0, -12, 0], x: [0], rotate: [0] },
        durationSec: 0.5,
        loop: false,
      }
    case "love":
      return {
        ...base,
        eyes: "star",
        mouth: "smile",
        body: { scale: [1, 1.06, 1], y: [0, -4, 0], x: [0], rotate: [0, -6, 6, -4, 0] },
        durationSec: 1,
        loop: false,
      }
    case "sleepy":
      return {
        ...base,
        eyes: "sleepy",
        mouth: "neutral",
        body: { scale: [1, 1.02, 1], y: [0, 2, 4], x: [0], rotate: [0] },
        durationSec: 1.8,
        loop: false,
      }
  }
}

export interface ResolvePetMotionOptions {
  /**
   * Low-power mode: halve the cadence of LOOPING specs (idle breathing etc.)
   * so the always-on widget animates at half rate. One-shots keep full speed —
   * interaction feedback must stay snappy.
   */
  lowPower?: boolean
}

/**
 * Resolve the full motion spec. When `reducedMotion` is set, all keyframes
 * collapse to their resting value and looping is disabled — the face still
 * reflects the emotion, but nothing moves.
 */
export function resolvePetMotion(
  state: PetVisualState,
  oneShot: PetOneShot | null,
  reducedMotion: boolean,
  bonesEyes: PetEyes,
  options: ResolvePetMotionOptions = {}
): PetMotionSpec {
  const base = baseSpec(state, bonesEyes)
  let spec = oneShot ? oneShotSpec(oneShot, base) : base
  if (options.lowPower && spec.loop) {
    spec = { ...spec, durationSec: spec.durationSec * 2 }
  }
  if (!reducedMotion) return spec
  return {
    ...spec,
    body: {
      scale: [spec.body.scale[0]],
      y: [STILL.y[0]],
      x: [STILL.x[0]],
      rotate: [STILL.rotate[0]],
    },
    loop: false,
  }
}
