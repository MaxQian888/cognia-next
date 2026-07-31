// Pure pointer-to-body-zone resolution for the overlay pet. A tap on a different
// part of the pet plays a different visual reaction (head → love, belly → happy,
// tail → surprised, body → petted). Zones are simple normalized bands derived
// from the 100×100 SVG body geometry (`components/pet/skins/svg/pet-body.tsx`:
// body centered at CX=50, BODY_CY≈58, tail anchored lower-right). The art faces
// right by default and mirrors horizontally when walking left, so the resolver
// flips X for a left facing. XP accounting is unaffected — callers still send the
// existing "petted" interaction; only the local flourish differs.

import type { PetFacing, PetOneShot } from "@/types/pet"

export type PetHitZone = "head" | "body" | "belly" | "tail"

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0.5
  return Math.max(0, Math.min(1, v))
}

/** Classify a local pointer offset (px, relative to the pet box top-left). */
export function resolveHitZone(
  localX: number,
  localY: number,
  boxSize: number,
  facing: PetFacing = "right"
): PetHitZone {
  const rawX = boxSize > 0 ? localX / boxSize : 0.5
  const ny = clamp01(boxSize > 0 ? localY / boxSize : 0.5)
  // Mirror X when the art faces left so the tail/head stay on the right body part.
  const nx = facing === "left" ? 1 - clamp01(rawX) : clamp01(rawX)

  if (ny < 0.4) return "head"
  if (nx > 0.68 && ny > 0.55) return "tail"
  if (ny >= 0.62 && nx > 0.3 && nx < 0.7) return "belly"
  return "body"
}

/** The one-shot reaction a zone tap plays. */
export function reactionForZone(zone: PetHitZone): PetOneShot {
  switch (zone) {
    case "head":
      return "love"
    case "belly":
      return "happy"
    case "tail":
      return "surprised"
    case "body":
      return "petted"
  }
}
