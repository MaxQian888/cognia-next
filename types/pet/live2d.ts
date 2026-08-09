// User-authored Live2D customization persisted on `petModels` rows
// (`lib/db/pet-models.ts`). Pipeline-internal currency (manifest, capabilities,
// motion plans) stays in `lib/pet/live2d/types.ts`; these types cross the
// data-model boundary, so they live with the other pet types.

/**
 * Per-model render transform applied on top of the fit-to-fill placement.
 * Offsets are fractions of the canvas size so they hold across the different
 * render sizes (widget, overlay, settings preview).
 */
export interface Live2dTransform {
  /** Multiplier on the fit scale. Clamped to [0.5, 2]. */
  scale: number
  /** Horizontal offset as a fraction of canvas size. Clamped to [-0.5, 0.5]. */
  offsetX: number
  /** Vertical offset as a fraction of canvas size. Clamped to [-0.5, 0.5]. */
  offsetY: number
}

/** Single source of truth for the neutral transform (normalization + reset). */
export const DEFAULT_LIVE2D_TRANSFORM: Live2dTransform = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
}

/**
 * One user-authored mapping entry for a single visual state or one-shot. A
 * present entry fully governs that key (no merge with the naming-convention
 * tables); an empty `{}` means "engine default" — no motion, no expression,
 * let breathing/eye-blink carry the pet.
 */
export interface Live2dMotionOverride {
  /** Motion group to play, validated against the model's capabilities. */
  motionGroup?: string
  /** Index within the group; unset = random pick each play. */
  motionIndex?: number
  /** Expression id to apply, validated against the model's capabilities. */
  expressionId?: string
}

/**
 * Per-model override table keyed by `PetVisualState | PetOneShot` strings.
 * Unset keys fall back to the naming-convention resolver.
 */
export type Live2dMotionOverrides = Partial<Record<string, Live2dMotionOverride>>

export type Live2dParameterRole =
  "headX" | "headY" | "headZ" | "eyeX" | "eyeY" | "bodyX" | "bodyY" | "mouthOpen"

/** A null entry explicitly disables a role for a non-standard model. */
export type Live2dParameterMapping = Partial<Record<Live2dParameterRole, string | null>>
