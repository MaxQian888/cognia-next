/**
 * Whether a given provider+model actually honours a reasoning `effort`
 * ("thinking level") setting. Shared by BOTH execution surfaces so they gate
 * identically:
 *   - the desktop/web build pipeline (`lib/claude/build-options.ts`), and
 *   - the CLI (`cli/src/config/to-build-context.ts`, re-exported via
 *     `cli/src/config/thinking.ts`).
 *
 * Sending `effort` to a model that rejects it (Haiku, Sonnet 4.5 and earlier,
 * Opus 4.1/4.0, or any non-reasoning model on the ai-sdk path) returns a 400.
 * Before this gate existed the desktop path forwarded effort unconditionally,
 * so picking a thinking level and then switching to Haiku broke the next turn.
 *
 * Effort support facts (from the Anthropic API guidance):
 *   - Native Anthropic path: `effort` (low/medium/high/xhigh/max) is supported
 *     on Opus 4.5–4.9, Sonnet 4.6, and Fable 5 / Mythos 5. NOT on Haiku,
 *     Sonnet 4.5-and-earlier, or Opus 4.1/4.0.
 *   - Non-Anthropic (ai-sdk) path: reasoning models map effort to their own
 *     `reasoning_effort`. We treat a model as effort-capable when its id looks
 *     like a reasoning model (o-series, gpt-5, deepseek-reasoner, grok
 *     reasoning, gemini/qwen/glm thinking, deepseek-r1, …). Non-reasoning
 *     models simply ignore the (un-forwarded) setting.
 */

/**
 * Anthropic model ids that accept `effort`. Matched by the family fragment in
 * the id rather than the full string so date-suffixed and `-fast` variants
 * (e.g. `claude-opus-4-6-fast`) resolve the same way.
 */
const ANTHROPIC_EFFORT_FAMILIES = [
  /opus-4-(?:5|6|7|8|9)/, // Opus 4.5 → 4.9 (effort GA from 4.5)
  /sonnet-4-6/, // Sonnet 4.6
  /(?:fable|mythos)-5/, // Fable 5 / Mythos 5
]

/** Reasoning-model id fragments on the non-Anthropic (ai-sdk) path. */
const REASONING_MODEL_PATTERNS = [
  /(?:^|[^a-z])o[1-9]\b/, // OpenAI o1 / o3 / o4 …
  /gpt-5/, // GPT-5 family (reasoning)
  /deepseek-reasoner/,
  /reason/, // generic "*-reasoner" / "*-reasoning"
  /thinking/, // gemini-*-thinking, qwen-*-thinking, glm-*-thinking
  /\br1\b/, // deepseek-r1 and friends
]

function matchesAny(haystack: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(haystack))
}

/**
 * Whether `effort` should be forwarded for the given provider+model. Returns
 * `false` when no model is resolved (the SDK will pick its own default and we
 * don't want to risk a 400 by guessing). A falsy/unknown provider is treated as
 * `"anthropic"` (the native path's default dispatcher).
 */
export function modelSupportsEffort(
  provider: string | undefined,
  model: string | undefined
): boolean {
  if (!model) return false
  const id = model.toLowerCase()
  if (!provider || provider === "anthropic") {
    return matchesAny(id, ANTHROPIC_EFFORT_FAMILIES)
  }
  return matchesAny(id, REASONING_MODEL_PATTERNS)
}
