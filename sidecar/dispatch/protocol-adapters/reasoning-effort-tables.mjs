// Single source of truth for HOW each wire surface expresses reasoning depth.
//
// A leaf module with ZERO imports, on purpose. These tables are needed by two
// very different consumers:
//
//   - downstream, the adapters that fold the app's effort onto the wire
//     (`ai-sdk-adapter.mjs`, `openai-compatible-variant-adapter.mjs`), and
//   - upstream, the renderer deciding which tiers to even OFFER
//     (`packages/provider-core/src/providers/reasoning-tiers.ts`).
//
// The upstream consumer runs in the browser bundle, and `ai-sdk-adapter.mjs`
// drags in the whole AI SDK — so the tables cannot live there and be imported
// from the UI. Keeping them here lets both sides read the same constants
// without either pulling the other's dependencies, which is the only way
// "which tiers we offer" and "what the wire accepts" stay in agreement.
//
// Same reasoning (and same directory) as `provider-protocol.mjs`.

/**
 * Fallback budget tiers for the budget-driven providers (anthropic / google)
 * when a thinking level is set but no explicit token budget is. Conservative,
 * round numbers — an explicit `maxThinkingTokens` always overrides.
 *
 * Doubles as the upstream authority on which tiers those surfaces can express:
 * a tier with no budget here would silently leave thinking OFF.
 */
export const EFFORT_TO_BUDGET = Object.freeze({
  low: 4096,
  medium: 12288,
  high: 24576,
  xhigh: 32768,
  max: 49152,
})

/**
 * Values OpenAI's `reasoningEffort` accepts. The app's union additionally
 * carries `max`, which OpenAI rejects (400) and which
 * `normalizeOpenAiEffort` folds down to `xhigh`.
 */
export const OPENAI_EFFORT_VALUES = Object.freeze(
  new Set(["none", "minimal", "low", "medium", "high", "xhigh"])
)

/**
 * Conservative app-effort → wire value map for generic openai-compatible
 * channels. Most one-api channels accept only `low|medium|high`, so the two
 * high tiers fold to `high` and `minimal` folds to `low` — a channel that truly
 * supports finer levels overrides this via `spec.reasoningEffortMap`.
 *
 * Note for the upstream consumer: several app tiers collapse onto ONE wire
 * value here, so offering all of them would be several controls with a single
 * effect.
 */
export const GENERIC_REASONING_EFFORT = Object.freeze({
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
})
