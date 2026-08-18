/**
 * Cross-boundary parity guard.
 *
 * The sidecar cannot import `lib/`, so `sidecar/dispatch/usage-normalize.mjs`
 * hand-mirrors `lib/ai/chat/usage-normalize.ts`. This test imports BOTH (it
 * lives under `lib/`, so Jest runs it; the `.mjs` has zero imports so it
 * transforms cleanly) and asserts they agree across a provider matrix. Edit one
 * alias list without the other and this goes red.
 *
 * The matrix is the point: these are the real spellings the three former copies
 * disagreed about.
 */

import {
  normalizeUsageBlock,
  normalizeCacheCreation,
  normalizeServerToolUse,
  toLanguageModelUsage,
} from "./usage-normalize"
import {
  normalizeUsageBlock as sidecarNormalizeUsageBlock,
  normalizeCacheCreation as sidecarNormalizeCacheCreation,
  normalizeServerToolUse as sidecarNormalizeServerToolUse,
  toLanguageModelUsage as sidecarToLanguageModelUsage,
} from "../../../sidecar/dispatch/usage-normalize.mjs"

const USAGE_MATRIX: Array<[string, Record<string, unknown>]> = [
  ["empty", {}],
  ["anthropic native", { input_tokens: 120, output_tokens: 40 }],
  [
    "anthropic with cache TTL split",
    {
      input_tokens: 86,
      output_tokens: 12,
      cache_creation_input_tokens: 7345,
      cache_creation: {
        ephemeral_5m_input_tokens: 5000,
        ephemeral_1h_input_tokens: 2345,
      },
      cache_read_input_tokens: 17_817,
    },
  ],
  [
    "anthropic TTL split with no flat total",
    {
      input_tokens: 10,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
    },
  ],
  [
    "anthropic server tool use",
    {
      input_tokens: 105,
      output_tokens: 6039,
      server_tool_use: { web_search_requests: 3, code_execution_requests: 1 },
    },
  ],
  ["ai-sdk v6 prompt/completion", { promptTokens: 500, completionTokens: 250 }],
  [
    "ai-sdk v6 token details",
    {
      promptTokens: 500,
      completionTokens: 250,
      inputTokenDetails: { cacheReadTokens: 300, cacheWriteTokens: 50 },
      outputTokenDetails: { reasoningTokens: 90 },
    },
  ],
  [
    "ai-sdk deprecated top-level mirrors",
    {
      inputTokens: 400,
      outputTokens: 200,
      cachedInputTokens: 120,
      cacheCreationInputTokens: 60,
      reasoningTokens: 30,
    },
  ],
  ["deepseek raw cache hit", { promptTokens: 900, prompt_cache_hit_tokens: 640 }],
  ["deepseek camel cache hit", { promptTokens: 900, promptCacheHitTokens: 640 }],
  ["multi-leg context window", { promptTokens: 9000, contextInputTokens: 3000 }],
  ["nested ai-sdk v7 shape", { inputTokens: { total: 700, cacheRead: 200, cacheWrite: 25 } }],
  ["nested output shape", { outputTokens: { total: 300, reasoning: 111 } }],
  ["zero server tool counts are dropped", { server_tool_use: { web_search_requests: 0 } }],
  ["negative values are ignored", { input_tokens: -5, output_tokens: 10 }],
  ["non-finite values are ignored", { input_tokens: Number.NaN, output_tokens: 10 }],
]

describe("usage-normalize TS ⇄ MJS parity", () => {
  it.each(USAGE_MATRIX)("normalizeUsageBlock agrees on %s", (_label, usage) => {
    expect(normalizeUsageBlock(usage)).toEqual(sidecarNormalizeUsageBlock(usage))
  })

  it.each(USAGE_MATRIX)("normalizeCacheCreation agrees on %s", (_label, usage) => {
    expect(normalizeCacheCreation(usage)).toEqual(sidecarNormalizeCacheCreation(usage))
  })

  it.each(USAGE_MATRIX)("normalizeServerToolUse agrees on %s", (_label, usage) => {
    expect(normalizeServerToolUse(usage)).toEqual(sidecarNormalizeServerToolUse(usage))
  })

  it.each(USAGE_MATRIX)("toLanguageModelUsage agrees on %s", (_label, usage) => {
    expect(toLanguageModelUsage(usage)).toEqual(sidecarToLanguageModelUsage(usage))
  })

  it("agrees when handed nothing at all", () => {
    expect(normalizeUsageBlock(undefined)).toEqual(sidecarNormalizeUsageBlock(undefined))
    expect(toLanguageModelUsage(undefined)).toEqual(sidecarToLanguageModelUsage(undefined))
  })
})

describe("normalizeCacheCreation", () => {
  it("keeps the provider's own flat total when it reports one", () => {
    const split = normalizeCacheCreation({
      cache_creation_input_tokens: 7345,
      cache_creation: { ephemeral_5m_input_tokens: 5000, ephemeral_1h_input_tokens: 2345 },
    })
    expect(split).toEqual({ total: 7345, ephemeral5m: 5000, ephemeral1h: 2345 })
  })

  it("derives the total from the split when no flat total is reported", () => {
    // The total must never be smaller than its parts, or downstream pricing
    // would bill less than the TTL buckets say was written.
    expect(
      normalizeCacheCreation({
        cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
      })
    ).toEqual({ total: 300, ephemeral5m: 100, ephemeral1h: 200 })
  })

  it("leaves an un-split flat total un-split", () => {
    expect(normalizeCacheCreation({ cache_creation_input_tokens: 500 })).toEqual({
      total: 500,
      ephemeral5m: 0,
      ephemeral1h: 0,
    })
  })
})

describe("normalizeUsageBlock", () => {
  it("omits cache_creation entirely when the provider reported no TTL split", () => {
    // Absent vs zeroed matters: it is how a consumer tells "no 1h writes" from
    // "this provider does not report the TTL".
    const block = normalizeUsageBlock({ cache_creation_input_tokens: 500 })
    expect(block.cache_creation).toBeUndefined()
    expect(block.cache_creation_input_tokens).toBe(500)
  })

  it("carries the TTL split through when reported", () => {
    const block = normalizeUsageBlock({
      cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
    })
    expect(block.cache_creation).toEqual({
      ephemeral_5m_input_tokens: 10,
      ephemeral_1h_input_tokens: 20,
    })
  })

  it("strips the _requests suffix from server tool counters", () => {
    const block = normalizeUsageBlock({
      server_tool_use: { web_search_requests: 3, code_execution_requests: 1 },
    })
    expect(block.server_tool_use).toEqual({ web_search: 3, code_execution: 1 })
  })

  it("omits server_tool_use when every counter is zero", () => {
    expect(
      normalizeUsageBlock({ server_tool_use: { web_search_requests: 0 } }).server_tool_use
    ).toBeUndefined()
  })
})
