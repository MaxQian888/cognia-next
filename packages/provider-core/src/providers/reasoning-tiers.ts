/**
 * Which reasoning-effort tiers a given provider + model actually OFFERS.
 *
 * Every other reasoning table in this repo is a downstream normalizer: they
 * take whatever the app sends and clamp, fold, or translate it for the wire.
 * None of them answers the upstream question — "what should the UI let the user
 * pick?" — so the composer offered the same six tiers everywhere and three of
 * them were lies on most providers:
 *
 *   - OpenAI-native rejects `max` (folded to `xhigh` by `normalizeOpenAiEffort`)
 *     but does support a `minimal` tier below `low`.
 *   - Generic OpenAI-compatible channels fold `xhigh` AND `max` down to `high`,
 *     so offering all three is three controls with one effect.
 *   - Anthropic-native only accepts `effort` at all on the GA families; the
 *     budget-driven path (anthropic/google via the AI SDK) maps every tier to a
 *     token budget, so there the full ladder is real.
 *
 * This module is that upstream answer, and it DERIVES from the same sidecar
 * constants that do the folding (`OPENAI_EFFORT_VALUES`,
 * `GENERIC_REASONING_EFFORT`, `EFFORT_TO_BUDGET`) rather than restating them.
 * Offering and folding therefore cannot drift: delete a tier from the wire map
 * and it stops being offered.
 *
 * Deliberately free of `@/` imports — this package builds standalone
 * (`pnpm build:packages`) and is consumed by the desktop composer, the
 * models.dev catalog normalizer, and the CLI alike. The "does this model reason
 * at all" question is NOT answered here: callers pass it in, because its owner
 * is `lib/ai/reasoning-capability.ts` (which reads the models.dev snapshot).
 */

import {
  EFFORT_TO_BUDGET,
  GENERIC_REASONING_EFFORT,
  OPENAI_EFFORT_VALUES,
} from "../../../../sidecar/dispatch/protocol-adapters/reasoning-effort-tables.mjs"

/**
 * A reasoning tier as the APP names it. Superset of any single provider's
 * vocabulary — `minimal` exists only on OpenAI-native, `max` only on the
 * Anthropic/budget surfaces.
 */
export type ReasoningTier = "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

/** Canonical order, shallowest → deepest. Every returned list follows it. */
export const REASONING_TIER_ORDER: readonly ReasoningTier[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]

/**
 * The wire surface a provider presents for reasoning depth. This — not the
 * provider id — is what decides the tier set, which is why two providers on the
 * same protocol get the same answer.
 *
 *  - `anthropic-effort`  native Anthropic `output_config.effort` (GA families).
 *  - `budget`            anthropic/google via the AI SDK: effort → token budget.
 *  - `openai-effort`     OpenAI-native `reasoning_effort`.
 *  - `generic-effort`    OpenAI-compatible gateway with a coarse effort field.
 *  - `none`              no reasoning-depth control on this surface.
 */
export type ReasoningSurface =
  "anthropic-effort" | "budget" | "openai-effort" | "generic-effort" | "none"

/**
 * Anthropic model ids that accept native `effort`. Mirrors
 * `ANTHROPIC_EFFORT_FAMILIES` in `lib/ai/reasoning-capability.ts`; kept here as
 * well because that module cannot be imported from this package (it reaches
 * into `@/lib`), and pinned to it by
 * `reasoning-tiers.capability-parity.test.ts`.
 */
const ANTHROPIC_EFFORT_FAMILIES = [/opus-4-(?:5|6|7|8|9)/, /sonnet-4-6/, /(?:fable|mythos)-5/]

/** Tiers the OpenAI-native surface accepts, in canonical order. `none` is not a
 * tier here — the app expresses "no reasoning" as its own `off` level. */
const OPENAI_TIERS: readonly ReasoningTier[] = REASONING_TIER_ORDER.filter((tier) =>
  (OPENAI_EFFORT_VALUES as Set<string>).has(tier)
)

/**
 * Tiers a generic OpenAI-compatible channel keeps DISTINCT. Several app tiers
 * collapse onto the same wire value there, so only the first tier reaching each
 * distinct value is offered — otherwise the user picks between identical
 * outcomes.
 */
const GENERIC_TIERS: readonly ReasoningTier[] = (() => {
  // Group the app tiers by the wire value they fold to, keeping canonical order.
  const byWire = new Map<string, ReasoningTier[]>()
  for (const tier of REASONING_TIER_ORDER) {
    const wire = (GENERIC_REASONING_EFFORT as Record<string, string>)[tier]
    if (!wire) continue
    const group = byWire.get(wire)
    if (group) group.push(tier)
    else byWire.set(wire, [tier])
  }
  // One tier per wire value. Prefer the tier whose own NAME is that value —
  // `minimal` and `low` both fold to wire `low`, and labelling that choice
  // "minimal" would misdescribe what the channel actually receives.
  return [...byWire.entries()].map(
    ([wire, group]) => group.find((tier) => tier === wire) ?? group[0]
  )
})()

/** Tiers the budget-driven surfaces can express as a distinct token budget. */
const BUDGET_TIERS: readonly ReasoningTier[] = REASONING_TIER_ORDER.filter(
  (tier) => (EFFORT_TO_BUDGET as Record<string, number>)[tier] !== undefined
)

/**
 * Anthropic's native `effort` ladder. The budget map is the authority on which
 * levels are meaningful; `minimal` has no budget tier and is not part of the
 * Anthropic vocabulary.
 */
const ANTHROPIC_TIERS: readonly ReasoningTier[] = BUDGET_TIERS

export interface ReasoningSurfaceInput {
  /** Internal provider id (`anthropic`, `openai`, `deepseek`, a custom id, …). */
  providerId: string | undefined
  /** Concrete model id. */
  modelId: string | undefined
  /**
   * The dispatch protocol, when the caller knows it (`anthropic` | `openai` |
   * `google` | …). Omit and the provider id is used as the protocol, which is
   * correct for every built-in provider.
   */
  protocol?: string
  /**
   * Whether the model reasons at all, per `lib/ai/reasoning-capability.ts` /
   * the models.dev catalog. `false` ⇒ no surface. `undefined` ⇒ unknown, and
   * the provider's surface is reported anyway (the caller's own capability gate
   * decides whether to render it).
   */
  reasoning?: boolean
  /**
   * True for an OpenAI-native endpoint (api.openai.com, the ChatGPT backend, a
   * Codex relay). The sidecar only emits `reasoning_effort` for these; any other
   * OpenAI-dialect endpoint is a generic gateway. Defaults to `true` for the
   * `openai` provider id and `false` for anything else on that protocol.
   */
  openAiNative?: boolean
}

/** Which reasoning surface a provider + model presents. */
export function reasoningSurfaceFor(input: ReasoningSurfaceInput): ReasoningSurface {
  const { providerId, modelId, reasoning } = input
  if (!modelId) return "none"
  if (reasoning === false) return "none"

  const protocol = (input.protocol ?? providerId ?? "anthropic").toLowerCase()
  const id = modelId.toLowerCase()

  if (protocol === "anthropic") {
    // Native Anthropic dispatch accepts `effort` only on the GA families; older
    // models 400 on the parameter, so they present no depth control at all.
    return ANTHROPIC_EFFORT_FAMILIES.some((re) => re.test(id)) ? "anthropic-effort" : "none"
  }
  if (protocol === "google" || protocol === "gemini") return "budget"
  if (protocol === "openai") {
    const native = input.openAiNative ?? providerId === "openai"
    return native ? "openai-effort" : "generic-effort"
  }
  // Everything else rides the OpenAI dialect through a gateway.
  return "generic-effort"
}

/** The tiers a surface offers, in canonical order. */
export function tiersForSurface(surface: ReasoningSurface): readonly ReasoningTier[] {
  switch (surface) {
    case "anthropic-effort":
      return ANTHROPIC_TIERS
    case "budget":
      return BUDGET_TIERS
    case "openai-effort":
      return OPENAI_TIERS
    case "generic-effort":
      return GENERIC_TIERS
    case "none":
      return []
  }
}

/**
 * The reasoning tiers a provider + model actually offers, in canonical order.
 * Empty when the surface has no depth control — callers render nothing rather
 * than a dead widget.
 */
export function reasoningTiersFor(input: ReasoningSurfaceInput): readonly ReasoningTier[] {
  return tiersForSurface(reasoningSurfaceFor(input))
}

/**
 * Whether a surface preserves the DISTINCTION between `xhigh` and the tiers
 * around it. Cognia's composite `ultracode` tier is `xhigh` + the workflow tool
 * suite, so on a surface that folds `xhigh` into `high` its name promises depth
 * it cannot deliver — callers use this to decide whether to offer it.
 */
export function surfaceKeepsXhigh(surface: ReasoningSurface): boolean {
  return tiersForSurface(surface).includes("xhigh")
}
