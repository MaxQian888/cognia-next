/**
 * The TUI's spinner, and the pulse the thinking indicator uses.
 *
 * Both draw from the shared {@link animationClock} rather than owning a timer,
 * which is what `ink-spinner` did. Two consequences the user can see: every
 * spinner on screen is on the same frame, and a resting session runs no timer
 * at all. Neither component is ever asserted on its frame, exactly as the
 * footer and the mascot are not.
 */
import React from "react"
import { Text } from "ink"

import { useAnimationTick } from "../render/use-animation-tick"
import { useTheme } from "../theme/context"

/** Braille dots, the cadence every other terminal agent uses. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

/** Frame interval. Fast enough to read as motion, slow enough not to strobe. */
export const SPINNER_MS = 80

/**
 * The reasoning indicator's glyph, a four-pointed star that opens and closes.
 *
 * The thinking line used to be the only busy surface on screen that did not
 * move, which read as a turn that had stalled rather than one that was working.
 */
export const PULSE_FRAMES = ["✻", "✼", "✽", "✼"] as const

/** Pulse interval. Deliberately much slower than the spinner: this is a breath,
 * not a progress indicator. */
export const PULSE_MS = 320

/** One frame of a cycle, for a tick that may be arbitrarily large. */
export function frameAt<T>(frames: readonly T[], tick: number): T {
  return frames[((tick % frames.length) + frames.length) % frames.length]
}

/** Whether rendered text carries a spinner frame. The frame itself is never
 * asserted (it is an animation), only that the surface is showing one. */
export function hasSpinnerFrame(text: string): boolean {
  return SPINNER_FRAMES.some((frame) => text.includes(frame))
}

export function Spinner({ color }: { color?: string }) {
  const tick = useAnimationTick(SPINNER_MS)
  return <Text color={color}>{frameAt(SPINNER_FRAMES, tick)}</Text>
}

export function ThinkingPulse({ color }: { color?: string }) {
  const theme = useTheme()
  const tick = useAnimationTick(PULSE_MS)
  return <Text color={color ?? theme.thinking}>{frameAt(PULSE_FRAMES, tick)}</Text>
}
