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
 *     on Opus 4.5–4.9, Sonnet 4.6, and the whole Claude 5 family bar Haiku
 *     (Opus 5, Sonnet 5, Fable 5, Mythos 5). NOT on Haiku of any generation,
 *     Sonnet 4.5-and-earlier, or Opus 4.1/4.0.
 *   - Non-Anthropic (ai-sdk) path: reasoning models map effort to their own
 *     `reasoning_effort`. The authoritative signal is models.dev's per-model
 *     `reasoning` flag (read from the bundled snapshot); the id-pattern
 *     heuristic below is only the offline fallback for models the snapshot
 *     doesn't carry (synthetic `-thinking`/`-reasoning` variants, brand-new
 *     releases). Non-reasoning models simply ignore the (un-forwarded) setting.
 *
 * Why the Anthropic path stays id-based: models.dev marks Haiku and Sonnet 4.5
 * as `reasoning: true` (they DO think), yet those models reject the newer
 * `effort` parameter — so the `reasoning` flag over-matches there. `effort` is
 * an Anthropic-specific GA from Opus 4.5 / Sonnet 4.6 / Fable 5, which the
 * family table below captures precisely.
 */
import { snapshotModelReasoning } from "@/lib/ai/providers/models-dev-snapshot-lookup"

/**
 * Anthropic model ids that accept `effort`. Matched by the family fragment in
 * the id rather than the full string so date-suffixed and `-fast` variants
 * (e.g. `claude-opus-4-6-fast`) resolve the same way.
 */
const ANTHROPIC_EFFORT_FAMILIES = [
  /opus-4-(?:5|6|7|8|9)/, // Opus 4.5 → 4.9 (effort GA from 4.5)
  /sonnet-4-6/, // Sonnet 4.6
  // The Claude 5 family. Written as one alternation rather than four regexes
  // because every 5-series model except Haiku takes `effort`, and spelling the
  // shared `-5` suffix once is what makes that rule legible. Haiku is absent
  // deliberately: it reasons, but it still rejects the parameter.
  //
  // Anchoring on the family segment (not the whole id) is what makes the
  // vendor-prefixed ids resolve too — `us.anthropic.claude-opus-5` (Bedrock),
  // `claude-sonnet-5@default` (Vertex) and `anthropic/claude-opus-5` (gateways)
  // all carry the same fragment.
  /(?:opus|sonnet|fable|mythos)-5/, // Opus 5 / Sonnet 5 / Fable 5 / Mythos 5
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
  // models.dev is the source of truth when it carries the model; the id-pattern
  // heuristic is the offline fallback for ids the snapshot doesn't list.
  const reasoning = snapshotModelReasoning(provider, model)
  if (reasoning !== undefined) return reasoning
  return matchesAny(id, REASONING_MODEL_PATTERNS)
}
