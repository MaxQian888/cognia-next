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

import type { ChatSession, SendOptions } from "@cognia/agent-config-types"
import {
  reasoningTiersFor,
  tiersForSurface,
  type ReasoningSurfaceInput,
  type ReasoningTier,
} from "@cognia/provider-core/providers/reasoning-tiers"

/**
 * Every tier, ascending in depth. `satisfies` pins this list to the union
 * persisted on `ChatSession.thinkingLevel`, so adding a tier in only one of the
 * two places fails `pnpm typecheck` instead of silently persisting a value the
 * type says can't exist.
 */
export const THINKING_LEVELS = [
  "off",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultracode",
] as const satisfies readonly NonNullable<ChatSession["thinkingLevel"]>[]

export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

/** A tier that actually forwards something — every level except `"off"`. */
export type EffortTier = Exclude<ThinkingLevel, "off">

/**
 * The non-off tiers in slider order (`low` → `ultracode`). Both selector modes
 * index into this; `"off"` is rendered as its own "use model default" choice,
 * not as a tick on the track.
 */
export const EFFORT_SLIDER_LEVELS = THINKING_LEVELS.filter(
  (level): level is EffortTier => level !== "off"
)

/** SDK effort value, or `undefined` to leave the model at its own default. */
export type Effort = NonNullable<SendOptions["effort"]>

/**
 * The tiers that map 1:1 onto `output_config.effort`. Used where only a raw SDK
 * effort can be stored (presets, the app-level default) and the Cognia-specific
 * `off` / `ultracode` tiers have no representation.
 */
export const SDK_EFFORT_LEVELS = EFFORT_SLIDER_LEVELS.filter(
  (level): level is Effort => level !== "ultracode"
)

/**
 * Translate a tier to the SDK's `output_config.effort`. `"off"` (and unset)
 * forward nothing; `"ultracode"` forwards `"xhigh"` — its extra behaviour is
 * the workflow-tool coupling, not a deeper effort value.
 */
export function thinkingLevelToEffort(level: ThinkingLevel | undefined): Effort | undefined {
  if (!level || level === "off") return undefined
  if (level === "ultracode") return "xhigh"
  return level
}

/** Whether a tier carries the dynamic-workflow (`wf_*`) tool coupling. */
export function isUltracodeLevel(level: ThinkingLevel | undefined): boolean {
  return level === "ultracode"
}

/**
 * The tier a session sits on. Prefers the explicit `thinkingLevel`; falls back
 * to deriving it from `effort` for rows written before that field existed (and
 * for the IM / preset paths, which only ever set a raw effort). No tier at all
 * ⇒ `"off"`.
 *
 * Note the asymmetry this fallback implies: a legacy row holding `"xhigh"`
 * resolves to `"xhigh"`, never `"ultracode"`. That is correct — the workflow
 * coupling was never active for those rows, so inferring it would silently turn
 * a tool suite on.
 */
export function resolveThinkingLevel(
  session: Pick<ChatSession, "effort" | "thinkingLevel"> | null | undefined
): ThinkingLevel {
  if (!session) return "off"
  if (session.thinkingLevel) return session.thinkingLevel
  return session.effort ?? "off"
}

/**
 * The session patch for a chosen tier. Always writes BOTH fields so the two can
 * never disagree: `effort` stays the value every existing consumer already
 * reads (build-options' effort chain, the model-picker label, sync), and
 * `thinkingLevel` carries the tier identity those consumers can't express.
 */
export function thinkingLevelPatch(level: ThinkingLevel): {
  effort: Effort | undefined
  thinkingLevel: ThinkingLevel
} {
  return { effort: thinkingLevelToEffort(level), thinkingLevel: level }
}

/**
 * Index of a tier within {@link EFFORT_SLIDER_LEVELS}, or `-1` for `"off"` and
 * anything unrecognised. Callers rendering a track treat `-1` as "no marker".
 */
export function thinkingLevelIndex(level: ThinkingLevel | undefined): number {
  if (!level || level === "off") return -1
  return EFFORT_SLIDER_LEVELS.indexOf(level)
}

/**
 * Inverse of {@link thinkingLevelIndex}, clamped into range so arrow-key and
 * pointer-driven movement at either end is a no-op rather than an exception.
 */
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

/**
 * The tiers to OFFER for a given provider + model, ascending — the ladder
 * `EFFORT_SLIDER_LEVELS` narrowed to what this particular wire surface can
 * actually distinguish (see `@cognia/provider-core/providers/reasoning-tiers`).
 * Empty when the surface has no depth control at all, which is the selector's
 * self-gate.
 *
 * Two adjustments turn a wire tier list into an app ladder:
 *   - `minimal` is dropped. It exists on the OpenAI surface but not in
 *     `SendOptions["effort"]`, so the app has no way to persist or forward it.
 *   - `ultracode` is appended only where `xhigh` survives to the wire. It IS
 *     `xhigh` plus the workflow tool suite, so on a channel that folds `xhigh`
 *     into `high` its name would promise depth the request never carries.
 */
export function availableThinkingLevels(input: ReasoningSurfaceInput): EffortTier[] {
  return appLadderFromTiers(reasoningTiersFor(input))
}

/**
 * The two adjustments that turn a WIRE tier list into an APP ladder, factored
 * out so every entry point applies them identically — see
 * {@link availableThinkingLevels} for what they are and why.
 */
function appLadderFromTiers(tiers: readonly ReasoningTier[]): EffortTier[] {
  const levels = tiers.filter((tier): tier is Effort => tier !== "minimal")
  if (levels.length === 0) return []
  return levels.includes("xhigh") ? [...levels, "ultracode"] : levels
}

/**
 * The ladder to offer while an EXTERNAL agent runtime drives the turn.
 *
 * The other entry point keys off a provider + model, which is the wrong pair
 * here: an external agent (Codex, Gemini CLI, …) brings its own model, and the
 * renderer never learns which one — the composer's model chip describes the
 * built-in runtime's model, not the agent's. Reading that chip produced two
 * wrong answers depending on what it happened to hold: a six-tier ladder no ACP
 * agent publishes, or no control at all on a session that merely defaulted to
 * Haiku.
 *
 * So the honest answer is the generic OpenAI-dialect surface — the same
 * `low | medium | high` that `GENERIC_REASONING_EFFORT` folds to, and exactly
 * the ladder the Codex client falls back to (`DEFAULT_REASONING_EFFORTS`) before
 * its model catalog loads. Derived rather than restated, so a change to the fold
 * map moves this with it. `ultracode` is correctly absent: that surface folds
 * `xhigh` into `high`, so the tier's name would promise depth the request cannot
 * carry, and its workflow-tool half belongs to the built-in runtime anyway.
 *
 * Each adapter still clamps what it receives onto its own published ladder, so
 * offering the intersection is safe rather than merely conservative.
 */
export function externalAgentThinkingLevels(): EffortTier[] {
  return appLadderFromTiers(tiersForSurface("generic-effort"))
}

/**
 * Narrow an offered ladder by the user's hidden-tier preference
 * (`composerBehavior.hiddenEffortTiers`).
 *
 * Presentation only. Hiding a tier removes it from what the control OFFERS; it
 * never touches what a session holds or sends, so a conversation already
 * sitting on a hidden tier keeps running at that depth and merely displays as
 * the nearest visible one (via {@link clampThinkingLevel}, the same folding the
 * model-capability narrowing already uses).
 *
 * Two things this refuses to do, both because the alternative is a control the
 * user cannot recover from:
 *   - empty the ladder. Hiding every offered tier returns the full ladder
 *     rather than nothing, because an empty ladder is the selector's own
 *     "this surface has no depth control" signal — it would remove the control
 *     from the composer, and with it the only way to unhide anything.
 *   - hide `"off"`. It is not a depth and never appears in `available`; it is
 *     the way back to the model's own default and stays reachable always.
 */
export function visibleThinkingLevels(
  available: readonly EffortTier[],
  hidden: readonly EffortTier[] | undefined
): EffortTier[] {
  if (!hidden || hidden.length === 0) return [...available]
  const hiddenSet = new Set(hidden)
  const visible = available.filter((level) => !hiddenSet.has(level))
  return visible.length > 0 ? visible : [...available]
}

/**
 * Project a persisted tier onto what the ACTIVE model offers, for display.
 *
 * A session set to `max` on Opus and then switched to a gateway that folds
 * everything above `high` is really going to send `high`; showing `max` would
 * misreport the turn. Resolves to the deepest offered tier at or below the
 * requested one (the same direction every downstream normalizer folds), or the
 * shallowest offered tier when the request sits below the whole list.
 *
 * Display only — the caller must NOT persist this. The user's actual choice
 * stays on the session and reapplies verbatim once a capable model is active.
 */
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
