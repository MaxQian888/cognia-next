// Normalization for the per-model render transform. Legacy `petModels` rows
// have no `transform` field; every consumer reads through `normalizeTransform`
// so the canvas/editor never see undefined or out-of-range values.

import { DEFAULT_LIVE2D_TRANSFORM, type Live2dTransform } from "@/types/pet"

export const TRANSFORM_SCALE_MIN = 0.5
export const TRANSFORM_SCALE_MAX = 2
export const TRANSFORM_OFFSET_MIN = -0.5
export const TRANSFORM_OFFSET_MAX = 0.5

export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value))
}

/** Coerce a possibly-absent/partial/out-of-range transform into a valid one. */
export function normalizeTransform(t?: Partial<Live2dTransform> | null): Live2dTransform {
  const scale = typeof t?.scale === "number" && Number.isFinite(t.scale) ? t.scale : 1
  const offsetX = typeof t?.offsetX === "number" && Number.isFinite(t.offsetX) ? t.offsetX : 0
  const offsetY = typeof t?.offsetY === "number" && Number.isFinite(t.offsetY) ? t.offsetY : 0
  return {
    scale: clamp(scale, TRANSFORM_SCALE_MIN, TRANSFORM_SCALE_MAX),
    offsetX: clamp(offsetX, TRANSFORM_OFFSET_MIN, TRANSFORM_OFFSET_MAX),
    offsetY: clamp(offsetY, TRANSFORM_OFFSET_MIN, TRANSFORM_OFFSET_MAX),
  }
}

/** True when the transform is the neutral default (nothing to persist). */
export function isDefaultTransform(t: Live2dTransform): boolean {
  return (
    t.scale === DEFAULT_LIVE2D_TRANSFORM.scale &&
    t.offsetX === DEFAULT_LIVE2D_TRANSFORM.offsetX &&
    t.offsetY === DEFAULT_LIVE2D_TRANSFORM.offsetY
  )
}
