/**
 * A responsive reasoning-effort slider overlay. Renders a proportional gauge
 * ("Faster → Smarter") over the non-off effort tiers (`low … ultracode`), with a
 * separate "use model default (off)" checkbox above it and a one-line
 * description of the focused tier below it.
 *
 * Responsive: on a wide terminal the full inline tier scale (every level
 * labelled) is shown under the gauge; on a narrow one it collapses to a compact
 * "N/total · level" readout so the scale never wraps into noise. The gauge width
 * itself scales with the overlay width. All of that math lives in the pure
 * {@link ./effort-slider-view} helpers so it stays unit-testable.
 *
 * Controlled only for its SEED: the parent passes the initial `off` / `index`
 * derived from the persisted thinking level; live edits during the overlay live
 * in this component's own state and are reported back on confirm.
 *
 * Keyboard: ←/→ move the slider (auto-clears off) · 1-9 jump to a tier · 0
 * selects off · Home/End jump to the fastest/smartest tier · Tab switches focus
 * (off ↔ slider) · Space toggles off when the checkbox has focus · Enter
 * confirms · Esc cancels.
 *
 * When `supported === false` the slider still works (the choice persists and
 * re-applies on a reasoning-capable model) but shows an inline warning so the
 * user isn't surprised by a no-op.
 */
import React, { useState } from "react"
import { Box, Text, useInput } from "ink"

import { useTheme } from "../theme/context"
import { EFFORT_SLIDER_LEVELS } from "../../config/schema"
import {
  EFFORT_LEVEL_DESCRIPTIONS,
  effortGaugeCells,
  effortGaugeWidth,
  effortKeyToIndex,
  effortLayout,
  effortPositionLabel,
} from "./effort-slider-view"

/** The result reported to the parent on confirm. */
export interface EffortSliderResult {
  off: boolean
  index: number
}

type Focus = "off" | "slider"

const LEVELS = EFFORT_SLIDER_LEVELS
const LAST = LEVELS.length - 1

/** Glyph for one gauge cell. */
const GAUGE_GLYPH = { filled: "█", marker: "◉", empty: "░" } as const

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

  /** Jump to a specific tier and engage the slider (clears off, focuses track). */
  const jump = (to: number) => {
    setOff(false)
    setFocus("slider")
    setIndex(Math.min(LAST, Math.max(0, to)))
  }
  const move = (delta: number) => jump(index + delta)

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
      if (key.leftArrow) return move(-1)
      if (key.rightArrow) return move(1)
      // "0" selects off; 1-9 jump to a tier (1-based).
      if (input === "0") {
        setOff(true)
        setFocus("off")
        return
      }
      const tier = effortKeyToIndex(input)
      if (tier !== null) return jump(tier)
      // Space toggles off only while the checkbox has focus (so an accidental
      // Space on the slider can't silently disable thinking).
      if (focus === "off" && input === " ") setOff((v) => !v)
    },
    { isActive }
  )

  const activeLevel = LEVELS[index]
  const layout = effortLayout(typeof width === "number" ? width : undefined)
  const gaugeWidth = effortGaugeWidth(typeof width === "number" ? width : undefined)
  const cells = effortGaugeCells(index, LAST, gaugeWidth)

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border}
      paddingX={1}
      width={width}
    >
      <Text bold>Reasoning effort</Text>

      {/* off checkbox */}
      <Text color={focus === "off" ? theme.accent : undefined} bold={focus === "off"}>
        {focus === "off" ? "❯ " : "  "}
        {off ? "[✓]" : "[ ]"} Use model default (off)
      </Text>

      {/* Gauge: Faster ▕███◉░░░▏ Smarter. Dimmed entirely while off. */}
      <Box>
        <Text color={focus === "slider" && !off ? theme.accent : undefined}>
          {focus === "slider" ? "❯ " : "  "}
        </Text>
        <Text color={theme.muted}>Faster </Text>
        <Text>
          {cells.map((cell, i) => {
            const dim = off
            const color = dim ? theme.muted : cell === "empty" ? theme.muted : theme.accent
            return (
              <Text key={i} color={color} bold={!dim && cell === "marker"} dimColor={dim}>
                {GAUGE_GLYPH[cell]}
              </Text>
            )
          })}
        </Text>
        <Text color={theme.muted}> Smarter</Text>
      </Box>

      {layout === "wide" ? (
        // Full inline tier scale — each tier labelled, the active one accented.
        <Text>
          {"  "}
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
      ) : (
        // Compact: position readout instead of the (too-wide) inline scale.
        <Text color={theme.muted}>
          {"  "}Tier{" "}
          <Text color={off ? theme.muted : theme.accent} bold={!off}>
            {effortPositionLabel(index, off)}
          </Text>
        </Text>
      )}

      {/* Description of the focused tier (or the off default). */}
      <Text color={theme.secondary}>
        {"  "}
        {off
          ? "model default — no thinking level forwarded"
          : EFFORT_LEVEL_DESCRIPTIONS[activeLevel]}
      </Text>

      {/* Inline warning when the active model won't honour effort. */}
      {!supported && !off ? (
        <Text color={theme.warning}>
          {`  ⚠ ${modelLabel ?? "the current model"} doesn't support thinking levels — applies on a reasoning model (Opus 4.5+, Sonnet 4.6, o-series, …)`}
        </Text>
      ) : null}

      <Text color={theme.muted} dimColor>
        ←/→ adjust · 1-{LEVELS.length} jump · 0 off · Tab focus · Enter confirm · Esc cancel
      </Text>
    </Box>
  )
}
