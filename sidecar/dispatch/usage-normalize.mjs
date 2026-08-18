/**
 * Provider-usage alias normalization — the sidecar-side source.
 *
 * Every provider spells its usage block differently: AI SDK v6/v7, the
 * OpenAI-compatible protocol, DeepSeek's on-disk context cache, and Anthropic's
 * native shape all disagree on field names. This module collapses them into one
 * snake_case `usage` block matching the Claude Agent SDK `result` message.
 *
 * It lived in three hand-maintained copies before — `event-adapter.mjs`,
 * `feature-call.mjs`, and `lib/ai/chat/sdk-event-mapper.ts` — which is why the
 * Anthropic cache-TTL split (`cache_creation.ephemeral_5m_input_tokens` /
 * `ephemeral_1h_input_tokens`) and server-tool counters (`server_tool_use`)
 * reached none of them: adding a field meant remembering three files.
 *
 * The sidecar cannot import from `lib/`, so `lib/ai/chat/usage-normalize.ts`
 * mirrors this file and `lib/ai/chat/usage-normalize.parity.test.ts` pins the
 * two together. Keep both in step. Zero imports so Jest can transform it.
 */

/** First defined, finite, non-negative number among the candidates, else 0. */
function firstNumber(...candidates) {
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c) && c >= 0) return c
  }
  return 0
}

/**
 * Cache-creation tokens split by TTL.
 *
 * Anthropic reports `usage.cache_creation.ephemeral_5m_input_tokens` and
 * `ephemeral_1h_input_tokens` alongside the flat
 * `cache_creation_input_tokens` total. The two TTLs bill differently (1.25×
 * vs 2× base input), so collapsing them under-bills 1-hour writes. When only
 * the flat total is reported, it is left un-split and priced at the 5-minute
 * rate (Anthropic's default TTL) by the pricing layer.
 *
 * @returns {{ total: number, ephemeral5m: number, ephemeral1h: number }}
 */
export function normalizeCacheCreation(usage) {
  const detail = usage?.cache_creation ?? usage?.cacheCreation ?? undefined
  const ephemeral5m = firstNumber(detail?.ephemeral_5m_input_tokens, detail?.ephemeral5mInputTokens)
  const ephemeral1h = firstNumber(detail?.ephemeral_1h_input_tokens, detail?.ephemeral1hInputTokens)
  const flat = firstNumber(
    usage?.cacheCreationInputTokens,
    usage?.cache_creation_input_tokens,
    usage?.inputTokenDetails?.cacheWriteTokens
  )
  // Prefer the provider's own total when it reports one; otherwise derive it
  // from the split so the total is never smaller than its parts.
  const total = flat > 0 ? flat : ephemeral5m + ephemeral1h
  return { total, ephemeral5m, ephemeral1h }
}

/**
 * Server-side tool invocation counters (`usage.server_tool_use`). These are
 * billed per call independently of tokens — web search is $10/1,000 requests —
 * so dropping them made that spend structurally invisible.
 *
 * @returns {Record<string, number> | undefined} undefined when none reported.
 */
export function normalizeServerToolUse(usage) {
  const raw = usage?.server_tool_use ?? usage?.serverToolUse
  if (!raw || typeof raw !== "object") return undefined
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue
    // `web_search_requests` → `web_search`; the unit is already "requests".
    out[key.replace(/_requests$/, "")] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Normalize any provider usage block into the snake_case shape the renderer
 * consumes off a `result` message.
 *
 * @param {any} usage
 * @returns {Record<string, unknown>}
 */
export function normalizeUsageBlock(usage) {
  const u = usage ?? {}
  const cacheCreation = normalizeCacheCreation(u)
  const serverToolUse = normalizeServerToolUse(u)
  return {
    input_tokens: firstNumber(u.promptTokens, u.inputTokens, u.input_tokens),
    output_tokens: firstNumber(u.completionTokens, u.outputTokens, u.output_tokens),
    // Window-prompt size (last agent-loop leg) when it differs from the summed
    // `input_tokens`; lets the renderer report true context-window occupancy
    // instead of the cumulative-billing total. Omitted on single-leg turns.
    ...(typeof u.contextInputTokens === "number"
      ? { context_input_tokens: u.contextInputTokens }
      : {}),
    cache_creation_input_tokens: cacheCreation.total,
    // Only emitted when the provider actually reported the split, so a
    // consumer can tell "no 1h writes" from "TTL not reported".
    ...(cacheCreation.ephemeral5m > 0 || cacheCreation.ephemeral1h > 0
      ? {
          cache_creation: {
            ephemeral_5m_input_tokens: cacheCreation.ephemeral5m,
            ephemeral_1h_input_tokens: cacheCreation.ephemeral1h,
          },
        }
      : {}),
    // Cache-read candidates, most-normalized first: AI SDK v6 maps
    // OpenAI-compatible `prompt_tokens_details.cached_tokens` to
    // `cachedInputTokens`; DeepSeek additionally reports raw
    // `prompt_cache_hit_tokens` (their context-caching-on-disk hit counter).
    // Surfacing these makes per-turn cache hit rate observable for every
    // openai-protocol provider.
    cache_read_input_tokens: firstNumber(
      u.cacheReadInputTokens,
      u.cache_read_input_tokens,
      u.cachedInputTokens,
      u.inputTokenDetails?.cacheReadTokens,
      u.prompt_cache_hit_tokens,
      u.promptCacheHitTokens
    ),
    // Reasoning / "thinking" tokens, when the provider breaks them out (AI SDK
    // v6 surfaces `reasoningTokens` for OpenAI o-series/gpt-5,
    // DeepSeek-reasoner, …). A SUBSET of output_tokens — already billed at the
    // output rate — surfaced for observability. 0 when absent.
    reasoning_tokens: firstNumber(
      u.reasoningTokens,
      u.reasoning_tokens,
      u.outputTokenDetails?.reasoningTokens
    ),
    ...(serverToolUse ? { server_tool_use: serverToolUse } : {}),
  }
}

/**
 * First defined finite number among the candidates, or `undefined`.
 *
 * Distinct from {@link firstNumber}: the nested `LanguageModelUsage` shape
 * below must preserve "not reported" as `undefined` rather than collapsing it
 * to 0, because 0 there means "the provider reported zero".
 */
function firstNumberOrUndefined(...candidates) {
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c
  }
  return undefined
}

/**
 * Normalize any provider usage block into the AI SDK v7 nested
 * `LanguageModelUsage` shape used by the feature-call path.
 *
 * Shares the alias table with {@link normalizeUsageBlock} — the two differ only
 * in output shape, not in which provider spellings they understand, which is
 * exactly the drift that kept the third hand-maintained copy out of step.
 *
 * `cachedInputTokens` / `cacheCreationInputTokens` / `reasoningTokens` are the
 * AI SDK's deprecated top-level mirrors, removed in v7 — kept as the first
 * candidate for adapter payloads that still use those names, falling through to
 * the canonical `*TokenDetails` objects (populated since v6) and then the
 * repo's own nested shape.
 */
export function toLanguageModelUsage(usage = {}) {
  const u = usage ?? {}
  const input = firstNumberOrUndefined(u.promptTokens, u.inputTokens?.total, u.inputTokens)
  const output = firstNumberOrUndefined(u.completionTokens, u.outputTokens?.total, u.outputTokens)
  const cacheRead = firstNumberOrUndefined(
    u.cachedInputTokens,
    u.inputTokenDetails?.cacheReadTokens,
    u.inputTokens?.cacheRead,
    u.cacheReadInputTokens,
    u.prompt_cache_hit_tokens,
    u.promptCacheHitTokens
  )
  const cacheWrite = firstNumberOrUndefined(
    u.cacheCreationInputTokens,
    u.inputTokenDetails?.cacheWriteTokens,
    u.inputTokens?.cacheWrite
  )
  const reasoning = firstNumberOrUndefined(
    u.reasoningTokens,
    u.outputTokenDetails?.reasoningTokens,
    u.outputTokens?.reasoning
  )
  return {
    inputTokens: {
      total: input,
      noCache: input === undefined ? undefined : Math.max(0, input - (cacheRead ?? 0)),
      cacheRead,
      cacheWrite,
    },
    outputTokens: {
      total: output,
      text: output === undefined ? undefined : Math.max(0, output - (reasoning ?? 0)),
      reasoning,
    },
  }
}
