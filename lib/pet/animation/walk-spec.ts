// Walk-cycle overlay for the SVG skin. Locomotion lives OUTSIDE the semantic
// PetVisualState (the in-app widget never walks), so the walking body motion
// is layered onto whatever resting spec the emotion system resolved — the face
// keeps expressing the emotion while the legs do the walking.

import type { PetMotionSpec } from "./motion-spec"

/**
 * Replace the body keyframes of a resolved spec with a brisk walk bob. Under
 * reduced motion the spec is returned untouched (wandering is disabled there
 * anyway — `resolvePetMotion` has already collapsed the keyframes).
 */
export function resolveWalkMotion(base: PetMotionSpec, reducedMotion: boolean): PetMotionSpec {
  if (reducedMotion) return base
  return {
    ...base,
    body: {
      scale: [1, 1.03, 1],
      y: [0, -4, 0],
      x: [0],
      rotate: [-3, 3, -3],
    },
    durationSec: 0.5,
    loop: true,
  }
}
