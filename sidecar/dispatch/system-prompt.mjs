// Translators from cognia's sidecar-protocol prompt/thinking fields into the
// *typed* `@anthropic-ai/claude-agent-sdk` `query()` Options shape.
//
// Why this exists: the SDK 0.3.x public `Options` type no longer carries a
// top-level `appendSystemPrompt` field — it lives only on the internal control
// protocol now. Rather than rely on the runtime still tolerating the untyped
// field, we fold the stable base prompt and the dynamic appended sections into
// the typed `systemPrompt: string | string[]` form. The array form preserves
// the stable→dynamic ordering as separate system blocks (matching the
// stable/dynamic split `build-options.ts` builds for prompt-cache friendliness).
// Likewise the deprecated `maxThinkingTokens` option is translated into the
// typed `thinking` config (`ThinkingEnabled`).

/**
 * Fold a base system prompt and an appended block into the typed `systemPrompt`
 * shape. Emptiness is judged after trimming, but the original (untrimmed)
 * content is preserved. Returns:
 *   - `undefined`      when neither part has content (SDK keeps its default),
 *   - a `string`       when exactly one part has content,
 *   - `[base, append]` when both have content (stable→dynamic order).
 *
 * @param {unknown} base   stable base system prompt (`sendOptions.systemPrompt`)
 * @param {unknown} append dynamic appended sections (`sendOptions.appendSystemPrompt`)
 * @returns {string | string[] | undefined}
 */
export function foldSystemPrompt(base, append) {
  const b = typeof base === "string" ? base : ""
  const a = typeof append === "string" ? append : ""
  const parts = [b, a].filter((p) => p.trim().length > 0)
  if (parts.length === 0) return undefined
  if (parts.length === 1) return parts[0]
  return parts
}

/**
 * Translate the deprecated `maxThinkingTokens` budget into the typed `thinking`
 * config. A positive budget enables a fixed thinking budget; any other value
 * (0, missing, negative, non-number) yields `undefined` so the SDK keeps its
 * model default — preserving the prior "only forwarded when > 0" semantics.
 *
 * @param {unknown} maxThinkingTokens
 * @returns {{ type: "enabled", budgetTokens: number } | undefined}
 */
export function thinkingFromBudget(maxThinkingTokens) {
  if (typeof maxThinkingTokens === "number" && maxThinkingTokens > 0) {
    return { type: "enabled", budgetTokens: maxThinkingTokens }
  }
  return undefined
}
