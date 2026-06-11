/**
 * Reasoning-effort ("thinking level") helpers for the CLI.
 *
 * Two concerns live here:
 *   1. {@link thinkingLevelToEffort} — map a {@link ThinkingLevel} to the SDK's
 *      `output_config.effort` value (or `undefined` for "off"/model default).
 *   2. {@link modelSupportsEffort} — decide whether the active provider+model
 *      actually honours an `effort` setting, so `to-build-context` only forwards
 *      it to a model that won't 400 on it. This is the "支持的模型" gate.
 *
 * Effort support facts (from the Anthropic API guidance):
 *   - Native Anthropic path: `effort` (low/medium/high/xhigh/max) is supported
 *     on Opus 4.5, 4.6, 4.7, 4.8, Sonnet 4.6, and Fable 5 / Mythos 5. It is NOT
 *     supported on Haiku, Sonnet 4.5 and earlier, or Opus 4.1/4.0 — those reject
 *     it with a 400.
 *   - Non-Anthropic (ai-sdk) path: reasoning models map effort to their own
 *     `reasoning_effort`. We treat a provider/model as effort-capable when the
 *     model id looks like a reasoning model (o-series, gpt-5, deepseek-reasoner,
 *     grok reasoning, gemini thinking, qwen/glm thinking, …). Non-reasoning
 *     models simply ignore the (un-forwarded) setting.
 */
import type { SendOptions } from "@/lib/claude/types"

import type { ThinkingLevel } from "./schema"

/** SDK effort tier, or `undefined` to leave the model at its own default. */
export type Effort = NonNullable<SendOptions["effort"]>

/** Translate a thinking level to an SDK effort value; `"off"` ⇒ `undefined`. */
export function thinkingLevelToEffort(level: ThinkingLevel | undefined): Effort | undefined {
  if (!level || level === "off") return undefined
  return level
}

/**
 * Anthropic model ids that accept `effort`. We match by the family fragment in
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
 * don't want to risk a 400 by guessing).
 */
export function modelSupportsEffort(provider: string, model: string | undefined): boolean {
  if (!model) return false
  const id = model.toLowerCase()
  if (provider === "anthropic") {
    return matchesAny(id, ANTHROPIC_EFFORT_FAMILIES)
  }
  return matchesAny(id, REASONING_MODEL_PATTERNS)
}
