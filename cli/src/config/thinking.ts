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
import { thinkingLevelToEffort, type Effort } from "@/lib/ai/thinking-level"

import { EFFORT_SLIDER_LEVELS, type ThinkingLevel } from "./schema"

export { modelSupportsEffort, thinkingLevelToEffort, type Effort }

/**
 * Seed state for the effort-slider overlay from the persisted thinking level.
 * `"off"`/unset → the off checkbox is checked and the slider parks at `low`
 * (index 0); any other level → off unchecked and the slider points at that
 * level's index in {@link EFFORT_SLIDER_LEVELS}.
 */
export function deriveEffortSliderState(level: ThinkingLevel | undefined): {
  off: boolean
  index: number
} {
  if (!level || level === "off") return { off: true, index: 0 }
  const index = EFFORT_SLIDER_LEVELS.indexOf(level)
  return { off: false, index: index >= 0 ? index : 0 }
}
