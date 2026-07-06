/**
 * The terminal mascot — a small creature that lives just above the footer and
 * reacts to the agent's state (idle / thinking / working / stopping). All the
 * art + mood logic is the pure {@link ../mascot/mascot} module; this component
 * owns only the animation ticker (an interval that advances the frame), which is
 * never asserted — mirroring how the footer treats its spinner.
 *
 * The ticker runs ONLY while the mood is animated (thinking/working); idle and
 * stopping are static, so a resting session costs zero re-renders.
 */
import React, { useEffect, useState } from "react"
import { Box, Text } from "ink"

import { mascotView, type MascotMood } from "../mascot/mascot"
import { useTheme } from "../theme/context"
import type { ThemePalette } from "../theme/palette"
import type { MascotStyle } from "../../config/schema"

/** Frame interval — slow enough to be calm, fast enough to feel alive. */
const TICK_MS = 420

/** Map a mascot mood to its themed colour token (classic = the historic colours). */
const MOOD_TOKEN: Record<MascotMood, keyof ThemePalette> = {
  idle: "mascotIdle",
  thinking: "mascotThinking",
  working: "mascotWorking",
  stopping: "mascotStopping",
}

function MascotImpl({
  mood,
  style,
  enabled,
}: {
  mood: MascotMood
  style: MascotStyle
  enabled: boolean
}) {
  const theme = useTheme()
  const [tick, setTick] = useState(0)
  const view = mascotView(style, mood, tick)
  const animated = view.animated

  useEffect(() => {
    // Animate only while the mood is animated (and shown): a resting session
    // runs no interval and costs zero re-renders. A stale tick carried across a
    // mood change is harmless — `mascotView` wraps it, and static moods have a
    // single frame — so there is no reset (which would also be a banned
    // synchronous setState-in-effect).
    if (!enabled || !animated) return
    const id = setInterval(() => setTick((t) => t + 1), TICK_MS)
    return () => clearInterval(id)
  }, [enabled, animated])

  if (!enabled) return null

  const dots = animated ? ".".repeat(tick % 4) : ""
  return (
    <Box flexShrink={0}>
      <Text color={theme[MOOD_TOKEN[mood]] as string}>
        {view.creature}
        {view.word ? `  ${view.word}${dots}` : ""}
      </Text>
    </Box>
  )
}

// Memoized: all props are primitives, so this skips re-render on every streaming
// delta and re-renders only when mood/style/enabled actually change.
export const Mascot = React.memo(MascotImpl)
