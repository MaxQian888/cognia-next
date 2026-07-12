// Pure blink resolver for the SVG skin. The skin header always promised a
// blink loop ("a separate group blinks the eyes") — this delivers it: a
// periodic lid close rendered as a scaleY dip on the eyes group. Deterministic
// from a seed (never Math.random in render paths) and suppressed for eye
// shapes where a lid read wrong (closed/expressive shapes) and for still
// frames (reduced motion / paused / quiescent).

import type { PetEyes } from "@/types/pet"

export interface BlinkSpec {
  /** Full cycle length in seconds (open → blink → open). */
  intervalSec: number
  /** scaleY keyframes over the cycle (mostly open, brief dip closed). */
  scaleY: number[]
  /** Keyframe time offsets (0–1) matching `scaleY`. */
  times: number[]
}

/** Eye shapes with a visible open eye worth blinking. */
const BLINKABLE: ReadonlySet<PetEyes> = new Set(["dot", "wide"] as PetEyes[])

const MIN_INTERVAL_SEC = 3
const MAX_INTERVAL_SEC = 7
/** The lid dip lasts ~120ms regardless of interval. */
const BLINK_SEC = 0.12

/**
 * Resolve the blink loop, or null when blinking is off (still frame,
 * non-blinkable eye shape). The interval derives deterministically from
 * `seed` so two pets don't blink in metronomic sync.
 */
export function resolveBlink(eyes: PetEyes, still: boolean, seed: number): BlinkSpec | null {
  if (still || !BLINKABLE.has(eyes)) return null
  const s = Math.abs(Math.trunc(seed))
  const intervalSec = MIN_INTERVAL_SEC + (s % 1000) * ((MAX_INTERVAL_SEC - MIN_INTERVAL_SEC) / 1000)
  // The blink occupies the tail of the cycle: open for most of it, close
  // fast, reopen.
  const blinkFrac = Math.min(0.2, BLINK_SEC / intervalSec)
  return {
    intervalSec,
    scaleY: [1, 1, 0.08, 1],
    times: [0, 1 - blinkFrac * 2, 1 - blinkFrac, 1],
  }
}
