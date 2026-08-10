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
/**
 * A reasoning tier as the APP names it. Superset of any single provider's
 * vocabulary — `minimal` exists only on OpenAI-native, `max` only on the
 * Anthropic/budget surfaces.
 */
type ReasoningTier = "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
/** Canonical order, shallowest → deepest. Every returned list follows it. */
declare const REASONING_TIER_ORDER: readonly ReasoningTier[]
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
type ReasoningSurface = "anthropic-effort" | "budget" | "openai-effort" | "generic-effort" | "none"
interface ReasoningSurfaceInput {
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
declare function reasoningSurfaceFor(input: ReasoningSurfaceInput): ReasoningSurface
/** The tiers a surface offers, in canonical order. */
declare function tiersForSurface(surface: ReasoningSurface): readonly ReasoningTier[]
/**
 * The reasoning tiers a provider + model actually offers, in canonical order.
 * Empty when the surface has no depth control — callers render nothing rather
 * than a dead widget.
 */
declare function reasoningTiersFor(input: ReasoningSurfaceInput): readonly ReasoningTier[]
/**
 * Whether a surface preserves the DISTINCTION between `xhigh` and the tiers
 * around it. Cognia's composite `ultracode` tier is `xhigh` + the workflow tool
 * suite, so on a surface that folds `xhigh` into `high` its name promises depth
 * it cannot deliver — callers use this to decide whether to offer it.
 */
declare function surfaceKeepsXhigh(surface: ReasoningSurface): boolean

export {
  REASONING_TIER_ORDER,
  type ReasoningSurface,
  type ReasoningSurfaceInput,
  type ReasoningTier,
  reasoningSurfaceFor,
  reasoningTiersFor,
  surfaceKeepsXhigh,
  tiersForSurface,
}
