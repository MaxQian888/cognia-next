// Single source of truth for HOW each wire surface expresses reasoning depth.
//
// A leaf module with ZERO imports, on purpose. These tables are needed by two
// very different consumers:
//
//   - downstream, the adapters that fold the app's effort onto the wire
//     (`ai-sdk-adapter`, `openai-compatible-variant-adapter`), and
//   - upstream, the renderer deciding which tiers to even OFFER
//     (`packages/provider-core/src/providers/reasoning-tiers.ts`).
//
// The upstream consumer runs in the browser bundle, and `ai-sdk-adapter`
// drags in the whole AI SDK — so the tables cannot live there and be imported
// from the UI. Keeping them here lets both sides read the same constants
// without either pulling the other's dependencies, which is the only way
// "which tiers we offer" and "what the wire accepts" stay in agreement.
//
// Same reasoning (and same directory) as `provider-protocol.ts`; isomorphic
// for the same reason.

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
 * Legacy OpenAI effort values. GPT-6 uses the model-aware set below; older
 * models keep the existing `max` → `xhigh` compatibility behavior.
 */
export const OPENAI_EFFORT_VALUES: ReadonlySet<string> = Object.freeze(
  new Set(["none", "minimal", "low", "medium", "high", "xhigh"])
)

/** GPT-6 API model pages, verified 2026-10-19. Sol/Astra require reasoning;
 * Luna additionally permits `none`. All accept `max` and reject `minimal`. */
const GPT6_EFFORT_VALUES: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"])
const GPT6_LUNA_EFFORT_VALUES: ReadonlySet<string> = new Set(["none", ...GPT6_EFFORT_VALUES])

export function openAiEffortValuesForModel(modelId?: string): ReadonlySet<string> {
  const id = modelId?.toLowerCase() ?? ""
  if (!/\bgpt-6(?:[.-]|$)/.test(id)) return OPENAI_EFFORT_VALUES
  return /\bgpt-6-luna(?:[-@:/]|$)/.test(id) ? GPT6_LUNA_EFFORT_VALUES : GPT6_EFFORT_VALUES
}

/** New Claude 5.5 models use effort instead of token budgets and reject sampling. */
const CLAUDE55_CAPABILITIES = Object.freeze({
  supportsSampling: false,
  effortValues: Object.freeze(["low", "medium", "high", "xhigh", "max"]),
})

export function claude55CapabilitiesForModel(modelId?: string) {
  return /\bclaude-(?:opus|sonnet|haiku)-5[-.]5(?:$|[-@:/])/.test(modelId?.toLowerCase() ?? "")
    ? CLAUDE55_CAPABILITIES
    : undefined
}

/** Gemini 3.8 Flash / 4 Argon require levels, without an xhigh/max budget tier. */
const GEMINI_THINKING_LEVELS = ["low", "medium", "high"] as const

export function geminiThinkingLevelsForModel(modelId?: string): readonly string[] | undefined {
  return /\bgemini-(?:3\.8-flash|4-argon)(?:$|[-@:/])/.test(modelId?.toLowerCase() ?? "")
    ? GEMINI_THINKING_LEVELS
    : undefined
}

/** First-party model documentation, verified 2026-10-19:
 * https://docs.x.ai/developers/model-capabilities/text/reasoning
 * https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions/
 * https://docs.z.ai/guides/llm/glm-5.3
 * https://github.com/MoonshotAI/Kimi-K3
 * An empty ladder means thinking exists but has no effort control. Keep this
 * distinct from undefined, which preserves legacy handling for unknown models.
 */
export function compatibleEffortValuesForModel(modelId?: string): readonly string[] | undefined {
  const id = modelId?.toLowerCase() ?? ""
  if (/\bgrok-4\.7(?:$|[-@:/])/.test(id)) return ["low", "medium", "high", "xhigh"]
  if (/\bqwen3\.8-max(?:$|[-@:/])/.test(id)) return ["low", "medium", "xhigh"]
  if (/\b(?:glm-5\.3|kimi-k3)(?:$|[-@:/])/.test(id)) return ["low", "high", "max"]
  if (/\b(?:minimax-m3|kimi-k2\.7)(?:$|[-@:/])/.test(id)) return []
  return undefined
}

/** Fold unsupported saved values only at execution, never rewrite preferences. */
export function normalizeCompatibleEffort(
  modelId: string | undefined,
  effort: string
): string | undefined {
  const accepted = compatibleEffortValuesForModel(modelId)
  if (!accepted?.length) return undefined
  if (accepted.includes(effort)) return effort
  if (effort === "none" || effort === "minimal") return "low"
  const order = ["low", "medium", "high", "xhigh", "max"]
  const requested = order.indexOf(effort)
  if (requested < 0) return accepted.includes("high") ? "high" : accepted[accepted.length - 1]
  // Missing intermediate tiers round up; requests beyond the model's ceiling
  // clamp down (Qwen high → xhigh, GLM medium → high, Grok max → xhigh).
  return (
    accepted.find((value) => order.indexOf(value) >= requested) ?? accepted[accepted.length - 1]
  )
}

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
