/**
 * A horizontal reasoning-effort slider overlay (replaces the old vertical
 * thinking-level list). Renders a "Faster → Smarter" tick track over the non-off
 * effort tiers (`low … ultracode`), with a separate "use model default (off)"
 * checkbox above it.
 *
 * Controlled only for its SEED: the parent passes the initial `off` / `index`
 * derived from the persisted thinking level; live edits during the overlay live
 * in this component's own state and are reported back on confirm. This mirrors
 * the SelectList conventions (`useTheme`, `useInput`, `width`) but owns its
 * cursor because a slider is not a list (no reducer movement action).
 *
 * Keyboard: Tab/Shift+Tab switch focus (off ↔ slider) · Space toggles off (when
 * focused) · ←/→ move the slider (and auto-clear off) · Enter confirms · Esc
 * cancels.
 */
import React, { useState } from "react"
import { Box, Text, useInput } from "ink"

import { useTheme } from "../theme/context"
import { EFFORT_SLIDER_LEVELS } from "../../config/schema"

/** The result reported to the parent on confirm. */
export interface EffortSliderResult {
  off: boolean
  index: number
}

type Focus = "off" | "slider"

const LEVELS = EFFORT_SLIDER_LEVELS
const LAST = LEVELS.length - 1

export function EffortSlider({
  off: seedOff,
  index: seedIndex,
  width,
  onConfirm,
  onCancel,
  isActive = true,
}: {
  off: boolean
  index: number
  width?: number | string
  onConfirm: (result: EffortSliderResult) => void
  onCancel: () => void
  isActive?: boolean
}) {
  const theme = useTheme()
  const [off, setOff] = useState(seedOff)
  const [index, setIndex] = useState(() => Math.min(Math.max(seedIndex, 0), LAST))
  const [focus, setFocus] = useState<Focus>(seedOff ? "off" : "slider")

  useInput(
    (input, key) => {
      if (key.tab) {
        setFocus((f) => (f === "off" ? "slider" : "off"))
        return
      }
      if (key.return) {
        onConfirm({ off, index })
        return
      }
      if (key.escape) {
        onCancel()
        return
      }
      if (focus === "off" && input === " ") {
        setOff((v) => !v)
        return
      }
      if (focus === "slider") {
        if (key.leftArrow) {
          setOff(false)
          setIndex((i) => Math.max(0, i - 1))
        } else if (key.rightArrow) {
          setOff(false)
          setIndex((i) => Math.min(LAST, i + 1))
        }
      }
    },
    { isActive }
  )

  const activeLevel = LEVELS[index]

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border}
      paddingX={1}
      width={width}
    >
      <Text bold>Effort</Text>

      {/* off checkbox */}
      <Text color={focus === "off" ? theme.accent : undefined} bold={focus === "off"}>
        {focus === "off" ? "❯ " : "  "}
        {off ? "[✓]" : "[ ]"} Use model default (off)
      </Text>

      {/* Faster … Smarter caption */}
      <Box>
        <Text color={theme.muted}>Faster</Text>
        <Text> </Text>
        <Text color={theme.muted}>· Smarter</Text>
      </Box>

      {/* tick track */}
      <Text>
        {focus === "slider" ? "❯ " : "  "}
        {LEVELS.map((_, i) => (
          <Text key={i} color={!off && i === index ? theme.accent : theme.muted}>
            {!off && i === index ? "●" : "─"}
            {i < LAST ? "──" : ""}
          </Text>
        ))}
      </Text>

      {/* level labels */}
      <Text>
        {"  "}
        {LEVELS.map((lvl, i) => (
          <Text
            key={lvl}
            color={!off && i === index ? theme.accent : theme.muted}
            bold={!off && i === index}
          >
            {lvl}
            {i < LAST ? " " : ""}
          </Text>
        ))}
      </Text>

      {/* ultracode sublabel — shown for the top composite tier */}
      <Text color={theme.secondary}>
        {activeLevel === "ultracode" && !off
          ? "ultracode · xhigh + workflows"
          : "xhigh + workflows"}
      </Text>

      <Text color={theme.muted} dimColor>
        ←/→ to adjust · Tab to switch · Space to toggle off · Enter to confirm · Esc to cancel
      </Text>
    </Box>
  )
}
