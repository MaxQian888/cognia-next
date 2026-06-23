// Pure lip-sync envelope for the Live2D pet. The pet "talks" by showing a speech
// bubble, but the Cubism mouth never moved — the canvas only drove motions and
// expressions, so a talking pet sat mouth-shut. This module produces a natural
// mouth-open value over time; the hook (`use-live2d-lip-sync.ts`) writes it onto
// the standard Cubism mouth parameter each frame while a bubble is visible.
//
// We have no audio to lip-sync against (bubbles are text), so the envelope is a
// synthetic talking mouth: two detuned sines summed and rectified give an
// irregular open/close that reads as speech rather than a metronome. Kept pure
// (deterministic in its single time argument) so it is fully unit-testable.

/**
 * The Cubism mouth-open parameter id. Matches the engine's own lip-sync target
 * (`lipSyncIds = ["ParamMouthOpenY"]` in untitled-pixi-live2d-engine), so models
 * that follow the Cubism naming convention animate without extra mapping.
 */
export const LIP_SYNC_PARAM = "ParamMouthOpenY"

/** Resting mouth value applied when speech ends (mouth fully closed). */
export const LIP_SYNC_REST = 0

/** Primary mouth-flap frequency (Hz). */
const PRIMARY_HZ = 4.3
/** Detuned secondary frequency (Hz) — breaks the regularity of a single sine. */
const SECONDARY_HZ = 7.1
/** Phase offset (radians) so the two waves don't start aligned. */
const SECONDARY_PHASE = 1.3
/** Blend weights for the two waves (sum ≤ 1 to stay in range before clamp). */
const PRIMARY_WEIGHT = 0.6
const SECONDARY_WEIGHT = 0.4

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

/**
 * Mouth-open amount in [0, 1] for the given elapsed speaking time (ms). Rectified
 * (|·|) so the mouth only opens (never "negative"), and clamped to the Cubism
 * parameter range.
 */
export function mouthOpenAt(elapsedMs: number): number {
  const t = Math.max(0, elapsedMs) / 1000
  const a = Math.sin(t * 2 * Math.PI * PRIMARY_HZ)
  const b = Math.sin(t * 2 * Math.PI * SECONDARY_HZ + SECONDARY_PHASE)
  return clamp01(Math.abs(a * PRIMARY_WEIGHT + b * SECONDARY_WEIGHT))
}
