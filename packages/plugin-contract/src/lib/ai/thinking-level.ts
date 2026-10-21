/**
 * The plugin contract's share of `lib/ai/thinking-level.ts`, which re-exports these.
 */
import type { SendOptions } from "@cognia/agent-config-types"
import type { THINKING_LEVELS } from "@/lib/ai/thinking-level"

export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

/** A tier that actually forwards something — every level except `"off"`. */
export type EffortTier = Exclude<ThinkingLevel, "off">

/** SDK effort value, or `undefined` to leave the model at its own default. */
export type Effort = NonNullable<SendOptions["effort"]>
