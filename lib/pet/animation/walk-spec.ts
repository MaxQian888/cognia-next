// Locomotion overlays for the SVG skin. Locomotion lives OUTSIDE the semantic
// PetVisualState (the in-app widget never walks), so these body motions are
// layered onto whatever resting spec the emotion system resolved — the face
// keeps expressing the emotion while the legs do the walking (falling and
// climbing override the face too: mid-air composure would look wrong).

import type { PetMotionSpec } from "./motion-spec"

/** Default walk-bob cycle when no speed is known (px/s → two bobs per step). */
const DEFAULT_WALK_BOB_SEC = 0.5
/** Distance one bob cycle covers — cadence follows ground speed. */
const PX_PER_BOB_CYCLE = 24
/** Cadence clamp so extreme tunings stay readable. */
const MIN_BOB_SEC = 0.35
const MAX_BOB_SEC = 0.8

/**
 * Replace the body keyframes of a resolved spec with a walk bob whose cadence
 * tracks the actual ground speed — a calm 36 px/s pet ambles, a lively 64 px/s
 * one scampers, instead of both bobbing at one hardcoded beat. Under reduced
 * motion the spec is returned untouched (wandering is disabled there anyway —
 * `resolvePetMotion` has already collapsed the keyframes).
 */
export function resolveWalkMotion(
  base: PetMotionSpec,
  reducedMotion: boolean,
  speedPxPerSec?: number
): PetMotionSpec {
  if (reducedMotion) return base
  const durationSec =
    speedPxPerSec && speedPxPerSec > 0
      ? Math.min(MAX_BOB_SEC, Math.max(MIN_BOB_SEC, PX_PER_BOB_CYCLE / speedPxPerSec))
      : DEFAULT_WALK_BOB_SEC
  return {
    ...base,
    body: {
      scale: [1, 1.03, 1],
      y: [0, -4, 0],
      x: [0],
      rotate: [-3, 3, -3],
    },
    durationSec,
    loop: true,
  }
}

/**
 * Mid-air flail while falling/thrown: wide eyes, "o" mouth, quick rotation
 * wobble. Replaces the emotion spec entirely — a pet calmly breathing with a
 * smile while plummeting was the audit's most jarring gap.
 */
export function resolveFallMotion(base: PetMotionSpec, reducedMotion: boolean): PetMotionSpec {
  if (reducedMotion) return base
  return {
    ...base,
    eyes: "wide",
    mouth: "o",
    body: { scale: [1], y: [0], x: [0], rotate: [-10, 10, -10] },
    durationSec: 0.25,
    loop: true,
  }
}

/** Determined little hop-scramble while climbing onto a perch. */
export function resolveClimbMotion(base: PetMotionSpec, reducedMotion: boolean): PetMotionSpec {
  if (reducedMotion) return base
  return {
    ...base,
    eyes: "wide",
    mouth: "o",
    body: { scale: [1, 1.04, 1], y: [0, -2, 0], x: [-1, 1, -1], rotate: [-5, 5, -5] },
    durationSec: 0.3,
    loop: true,
  }
}
