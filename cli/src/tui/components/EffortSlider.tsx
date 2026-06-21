/**
 * A horizontal reasoning-effort slider overlay (replaces the old vertical
 * thinking-level list). Renders a "Faster → Smarter" track over the non-off
 * effort tiers (`low … ultracode`), with a separate "use model default (off)"
 * checkbox above it and a one-line description of the focused tier below it.
 *
 * Controlled only for its SEED: the parent passes the initial `off` / `index`
 * derived from the persisted thinking level; live edits during the overlay live
 * in this component's own state and are reported back on confirm. This mirrors
 * the SelectList conventions (`useTheme`, `useInput`, `width`) but owns its
 * cursor because a slider is not a list (no reducer movement action).
 *
 * Keyboard: ←/→ move the slider (and auto-clear off, always — regardless of
 * which control has focus, since moving implies engaging the slider) · Tab
 * switches focus (off ↔ slider) · Space toggles off when focused · Enter
 * confirms · Esc cancels.
 *
 * When `supported === false` the slider still works (the choice persists and
 * re-applies on a reasoning-capable model) but shows an inline warning so the
 * user isn't surprised by a no-op — the same fact the post-confirm notice gave,
 * surfaced up-front.
 */
import React, { useState } from "react"
import { Box, Text, useInput } from "ink"

import { useTheme } from "../theme/context"
import { EFFORT_SLIDER_LEVELS, type ThinkingLevel } from "../../config/schema"

/** The result reported to the parent on confirm. */
export interface EffortSliderResult {
  off: boolean
  index: number
}

type Focus = "off" | "slider"

const LEVELS = EFFORT_SLIDER_LEVELS
const LAST = LEVELS.length - 1

/** One-line description of what each tier does — replaces the old sublabel that
 * always read "xhigh + workflows" regardless of the selected tier. */
const LEVEL_DESCRIPTIONS: Record<Exclude<ThinkingLevel, "off">, string> = {
  low: "minimal extra reasoning — fastest",
  medium: "balanced reasoning depth",
  high: "deeper reasoning — slower",
  xhigh: "near-maximum reasoning depth",
  max: "maximum reasoning budget",
  ultracode: "xhigh effort + dynamic workflow tools",
}

export function EffortSlider({
  off: seedOff,
  index: seedIndex,
  width,
  supported = true,
  modelLabel,
  onConfirm,
  onCancel,
  isActive = true,
}: {
  off: boolean
  index: number
  width?: number | string
  /** Whether the active model honours `effort`. `false` shows an inline hint. */
  supported?: boolean
  /** Active model id, for the unsupported-model hint. */
  modelLabel?: string
  onConfirm: (result: EffortSliderResult) => void
  onCancel: () => void
  isActive?: boolean
}) {
  const theme = useTheme()
  const [off, setOff] = useState(seedOff)
  const [index, setIndex] = useState(() => Math.min(Math.max(seedIndex, 0), LAST))
  const [focus, setFocus] = useState<Focus>(seedOff ? "off" : "slider")

  /** Move the slider and engage it — moving always clears off and focuses the
   * track, so an arrow press does the obvious thing from either control. */
  const move = (delta: number) => {
    setOff(false)
    setFocus("slider")
    setIndex((i) => Math.min(LAST, Math.max(0, i + delta)))
  }

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
      if (key.leftArrow) {
        move(-1)
        return
      }
      if (key.rightArrow) {
        move(1)
        return
      }
      // Space toggles off only while the checkbox has focus (so an accidental
      // Space on the slider can't silently disable thinking).
      if (focus === "off" && input === " ") {
        setOff((v) => !v)
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
      <Text color={theme.muted}>{"  "}Faster · Smarter</Text>

      {/* Single inline track: each tier is its own label, the active one marked
          with ● and accented. Self-aligning — no separate tick/label rows to
          drift out of sync (the old layout's misalignment). */}
      <Text>
        {focus === "slider" ? "❯ " : "  "}
        {LEVELS.map((lvl, i) => {
          const isActiveTier = !off && i === index
          return (
            <Text key={lvl}>
              <Text color={isActiveTier ? theme.accent : theme.muted} bold={isActiveTier}>
                {isActiveTier ? "●" : "○"}
                {lvl}
              </Text>
              {i < LAST ? <Text color={theme.muted}> ─ </Text> : null}
            </Text>
          )
        })}
      </Text>

      {/* Description of the focused tier (or the off default). */}
      <Text color={theme.secondary}>
        {"  "}
        {off ? "model default — no thinking level forwarded" : LEVEL_DESCRIPTIONS[activeLevel]}
      </Text>

      {/* Inline warning when the active model won't honour effort. */}
      {!supported && !off ? (
        <Text color={theme.warning}>
          {`  ⚠ ${modelLabel ?? "the current model"} doesn't support thinking levels — applies on a reasoning model (Opus 4.5+, Sonnet 4.6, o-series, …)`}
        </Text>
      ) : null}

      <Text color={theme.muted} dimColor>
        ←/→ to adjust · Tab to switch · Space to toggle off · Enter to confirm · Esc to cancel
      </Text>
    </Box>
  )
}
