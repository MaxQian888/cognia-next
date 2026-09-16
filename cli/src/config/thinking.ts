/**
 * Reasoning-effort ("thinking level") helpers for the CLI. Both of the pieces
 * this module surfaces are re-exports of shared root modules, so the CLI and the
 * desktop/web build pipeline can never gate or map differently:
 *
 *   1. {@link thinkingLevelToEffort} / {@link Effort} — from
 *      `@/lib/ai/thinking-level`, which owns the tier ladder and the mapping to
 *      the SDK's `output_config.effort` (`"off"` ⇒ `undefined`, `"ultracode"` ⇒
 *      `"xhigh"` plus the separate `config.pluginTools` coupling).
 *   2. {@link modelSupportsEffort} — from `@/lib/ai/reasoning-capability`, the
 *      single source of truth for which models honour `effort` at all.
 *
 * {@link deriveEffortSliderState} is the one CLI-specific piece: it seeds the
 * Ink overlay's off-checkbox + track index from the persisted level.
 */
import { modelSupportsEffort } from "@/lib/ai/reasoning-capability"
import {
  clampThinkingLevel,
  thinkingLevelToEffort,
  type Effort,
  type EffortTier,
} from "@/lib/ai/thinking-level"

import { EFFORT_SLIDER_LEVELS, type ThinkingLevel } from "./schema"

export { modelSupportsEffort, thinkingLevelToEffort, type Effort }

/**
 * Seed state for the effort-slider overlay from the persisted thinking level.
 * `"off"`/unset → the off checkbox is checked and the slider parks at the first
 * rung; any other level → off unchecked and the slider points at that level's
 * index in the offered ladder.
 *
 * `levels` is what the overlay will offer — the full app ladder by default, or
 * the live session's published rungs on an external agent. A persisted pick
 * the ladder does not carry (say `ultracode` on a Devin `swe-2-*` family)
 * folds down to the nearest offered rung, the same direction the write path
 * folds, instead of silently landing on the lowest tier.
 */
export function deriveEffortSliderState(
  level: ThinkingLevel | undefined,
  levels: readonly EffortTier[] = EFFORT_SLIDER_LEVELS
): {
  off: boolean
  index: number
} {
  if (!level || level === "off" || levels.length === 0) return { off: true, index: 0 }
  const folded = clampThinkingLevel(level, levels)
  const index = folded === "off" ? -1 : levels.indexOf(folded as EffortTier)
  return { off: false, index: index >= 0 ? index : 0 }
}
