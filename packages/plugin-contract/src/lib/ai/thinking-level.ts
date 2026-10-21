/**
 * Thinking levels ("reasoning effort tiers") — the ONE source of truth for the
 * tier set, its order, and how a tier maps onto what the SDK actually receives.
 *
 * Three surfaces used to own their own copy of this ladder and drifted:
 *   - the CLI effort slider (`cli/src/config/schema.ts`) had 7 tiers including
 *     `"ultracode"`,
 *   - the composer selector (`components/settings/presets/editor-sections/constants.ts`)
 *     had 5, and
 *   - `cli/src/config/thinking.ts` owned the level→effort mapping alone.
 * All three now re-export from here, so adding a tier is a one-file change.
 *
 * Two of the tiers are NOT plain `output_config.effort` values:
 *   - `"off"` means "forward nothing; leave the model at its own default". It
 *     exists as a tier (rather than `undefined`) so a user who explicitly opts
 *     out is distinguishable from one who never touched the control.
 *   - `"ultracode"` is Cognia's composite top tier: it maps DOWN to `"xhigh"`
 *     effort and additionally exposes the dynamic-workflow (`wf_*`) tool suite
 *     for the turn. The effort half is {@link thinkingLevelToEffort}; the tools
 *     half is applied by `lib/claude/build-options.ts` (desktop/web) and the
 *     `pluginTools` config gate (CLI).
 *
 * Whether the resolved model will HONOUR an effort at all is a separate
 * question, answered by `lib/ai/reasoning-capability.ts:modelSupportsEffort`.
 * Keep the two apart: this module is pure data + mapping, that one reads the
 * models.dev snapshot.
 */

import type { ChatSession } from "@cognia/agent-config-types"
import {
  reasoningTiersFor,
  tiersForSurface,
  type ReasoningSurfaceInput,
  type ReasoningTier,
} from "@cognia/provider-core/providers/reasoning-tiers"
import type { SendOptions } from "@cognia/agent-config-types"

export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

/** A tier that actually forwards something — every level except `"off"`. */
export type EffortTier = Exclude<ThinkingLevel, "off">

/** SDK effort value, or `undefined` to leave the model at its own default. */
export type Effort = NonNullable<SendOptions["effort"]>

export const THINKING_LEVELS = [
  "off",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultracode",
] as const satisfies readonly NonNullable<ChatSession["thinkingLevel"]>[]

export const EFFORT_SLIDER_LEVELS = THINKING_LEVELS.filter(
  (level): level is EffortTier => level !== "off"
)

export const SDK_EFFORT_LEVELS = EFFORT_SLIDER_LEVELS.filter(
  (level): level is Effort => level !== "ultracode"
)

export function thinkingLevelToEffort(level: ThinkingLevel | undefined): Effort | undefined {
  if (!level || level === "off") return undefined
  if (level === "ultracode") return "xhigh"
  return level
}

export function isUltracodeLevel(level: ThinkingLevel | undefined): boolean {
  return level === "ultracode"
}

export function resolveThinkingLevel(
  session: Pick<ChatSession, "effort" | "thinkingLevel"> | null | undefined
): ThinkingLevel {
  if (!session) return "off"
  if (session.thinkingLevel) return session.thinkingLevel
  return session.effort ?? "off"
}

export function thinkingLevelPatch(level: ThinkingLevel): {
  effort: Effort | undefined
  thinkingLevel: ThinkingLevel
} {
  return { effort: thinkingLevelToEffort(level), thinkingLevel: level }
}

export function thinkingLevelIndex(level: ThinkingLevel | undefined): number {
  if (!level || level === "off") return -1
  return EFFORT_SLIDER_LEVELS.indexOf(level)
}

export function thinkingLevelAtIndex(
  index: number,
  levels: readonly EffortTier[] = EFFORT_SLIDER_LEVELS
): EffortTier {
  const last = levels.length - 1
  // NaN survives both `Math.min` and `Math.max` and would index the array to
  // `undefined` — a "tier" that type-checks but isn't one, and that callers
  // would happily persist. Collapse it to the fast end instead.
  if (!Number.isFinite(index)) return levels[0]
  return levels[Math.min(Math.max(index, 0), last)]
}

export function availableThinkingLevels(input: ReasoningSurfaceInput): EffortTier[] {
  return appLadderFromTiers(reasoningTiersFor(input))
}

function appLadderFromTiers(tiers: readonly ReasoningTier[]): EffortTier[] {
  const levels = tiers.filter((tier): tier is Effort => tier !== "minimal")
  if (levels.length === 0) return []
  return levels.includes("xhigh") ? [...levels, "ultracode"] : levels
}

export function externalAgentThinkingLevels(published?: readonly string[]): EffortTier[] {
  const declared = projectAgentLevels(published)
  if (declared.length > 0) return declared
  // An agent whose whole vocabulary is the app's own, and that offers no depth
  // in it, has answered: this model does not think (Pi publishes just `off`
  // for a model without reasoning). Inventing `low | medium | high` there put
  // a dial on the toolbar that the adapter then clamped to nothing.
  if (published && published.length > 0 && published.every(isKnownAgentLevel)) return []
  return appLadderFromTiers(tiersForSurface("generic-effort"))
}

function isKnownAgentLevel(level: string): boolean {
  return (
    level === "off" ||
    level === "minimal" ||
    (EFFORT_SLIDER_LEVELS as readonly string[]).includes(level)
  )
}

export function projectAgentLevels(published: readonly string[] | undefined): EffortTier[] {
  if (!published || published.length === 0) return []
  const declared = new Set(published)
  return EFFORT_SLIDER_LEVELS.filter(
    (level): level is EffortTier => level !== "ultracode" && declared.has(level)
  )
}

export function visibleThinkingLevels(
  available: readonly EffortTier[],
  hidden: readonly EffortTier[] | undefined
): EffortTier[] {
  if (!hidden || hidden.length === 0) return [...available]
  const hiddenSet = new Set(hidden)
  const visible = available.filter((level) => !hiddenSet.has(level))
  return visible.length > 0 ? visible : [...available]
}

export function clampThinkingLevel(
  level: ThinkingLevel,
  available: readonly EffortTier[]
): ThinkingLevel {
  if (level === "off" || available.length === 0) return "off"
  if (available.includes(level)) return level
  const wanted = EFFORT_SLIDER_LEVELS.indexOf(level)
  if (wanted < 0) return available[0]
  let best: EffortTier | undefined
  for (const candidate of available) {
    if (EFFORT_SLIDER_LEVELS.indexOf(candidate) <= wanted) best = candidate
  }
  return best ?? available[0]
}
