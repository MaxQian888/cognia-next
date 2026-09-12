// Translators from cognia's sidecar-protocol prompt/thinking fields into the
// *typed* `@anthropic-ai/claude-agent-sdk` `query()` Options shape.
//
// Why this exists: the SDK 0.3.x public `Options` type no longer carries a
// top-level `appendSystemPrompt` field — it lives only on the internal control
// protocol now. Rather than rely on the runtime still tolerating the untyped
// field, we fold the stable base prompt and the dynamic appended sections into
// the typed custom-prompt form with snapshot:false. The array content preserves
// the stable→dynamic ordering as separate system blocks (matching the
// stable/dynamic split `build-options.ts` builds for prompt-cache friendliness).
// Likewise the deprecated `maxThinkingTokens` option is translated into the
// typed `thinking` config (`ThinkingEnabled`).

/**
 * Fold a base system prompt and an appended block into the typed `systemPrompt`
 * shape. Emptiness is judged after trimming, but the original (untrimmed)
 * content is preserved. Returns:
 *   - `undefined`      when neither part has content (SDK keeps its default),
 *   - a custom prompt with snapshot:false for Cognia-generated instructions,
 *   - an explicit SDK custom/preset object preserving its snapshot policy.
 *
 * @param {unknown} base   stable base system prompt (`sendOptions.systemPrompt`)
 * @param {unknown} append dynamic appended sections (`sendOptions.appendSystemPrompt`)
 * @returns {import("@anthropic-ai/claude-agent-sdk").Options["systemPrompt"]}
 */
export function foldSystemPrompt(base, append) {
  if (base && typeof base === "object" && !Array.isArray(base)) {
    if (base.type === "custom")
      return { ...base, prompt: foldPromptParts(base.prompt, append) ?? "" }
    if (base.type === "preset") {
      const folded = foldPromptParts(base.append, append)
      return {
        ...base,
        ...(folded === undefined
          ? {}
          : { append: Array.isArray(folded) ? folded.join("\n\n") : folded }),
      }
    }
  }
  const prompt = foldPromptParts(base, append)
  return prompt === undefined ? undefined : { type: "custom", prompt, snapshot: false }
}

function foldPromptParts(base, append) {
  const b = Array.isArray(base)
    ? base.filter((part) => typeof part === "string")
    : [typeof base === "string" ? base : ""]
  const a = typeof append === "string" ? append : ""
  const parts = [...b, a].filter((p) => p.trim().length > 0)
  if (parts.length === 0) return undefined
  if (parts.length === 1) return parts[0]
  return parts
}

/**
 * Translate the deprecated `maxThinkingTokens` budget into the typed `thinking`
 * config. Zero explicitly disables thinking; invalid or omitted budgets leave
 * the model default intact.
 *
 * @param {unknown} maxThinkingTokens
 * @returns {{ type: "enabled", budgetTokens: number } | { type: "disabled" } | undefined}
 */
export function thinkingFromBudget(maxThinkingTokens) {
  if (maxThinkingTokens === 0) return { type: "disabled" }
  if (Number.isInteger(maxThinkingTokens) && maxThinkingTokens > 0) {
    return { type: "enabled", budgetTokens: maxThinkingTokens }
  }
  return undefined
}
