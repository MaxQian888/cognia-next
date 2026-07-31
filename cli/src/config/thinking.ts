/**
 * Reasoning-effort ("thinking level") helpers for the CLI.
 *
 *   1. {@link thinkingLevelToEffort} — map a {@link ThinkingLevel} to the SDK's
 *      `output_config.effort` value (or `undefined` for "off"/model default).
 *   2. {@link modelSupportsEffort} — re-exported from the shared
 *      `@/lib/ai/reasoning-capability` module so the CLI and the desktop/web
 *      build pipeline gate on the SAME predicate (a single source of truth for
 *      which models honour `effort`).
 */
import type { SendOptions } from "@cognia/agent-config-types"

import { modelSupportsEffort } from "@/lib/ai/reasoning-capability"

import { EFFORT_SLIDER_LEVELS, type ThinkingLevel } from "./schema"

export { modelSupportsEffort }

/** SDK effort tier, or `undefined` to leave the model at its own default. */
export type Effort = NonNullable<SendOptions["effort"]>

/**
 * Translate a thinking level to an SDK effort value; `"off"` ⇒ `undefined`.
 * `"ultracode"` is the composite top tier — it maps to `"xhigh"` effort (the
 * extra "+ workflows" behaviour is handled separately via `config.pluginTools`).
 */
export function thinkingLevelToEffort(level: ThinkingLevel | undefined): Effort | undefined {
  if (!level || level === "off") return undefined
  if (level === "ultracode") return "xhigh"
  return level
}

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
