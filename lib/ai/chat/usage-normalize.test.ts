/**
 * Unit coverage for the renderer-side usage normalizer.
 *
 * Complements `usage-normalize.parity.test.ts`, which asserts that this module
 * and its sidecar twin agree on a provider matrix. That test proves the two
 * copies *match*; this one proves the alias table is *right* — precedence
 * between competing spellings, the guards that reject junk numbers, and the two
 * output shapes' deliberately different cache-read orders. A bug in either
 * would be mirrored faithfully into the sidecar and sail through parity.
 */

import {
  normalizeCacheCreation,
  normalizeServerToolUse,
  normalizeUsageBlock,
  toLanguageModelUsage,
} from "./usage-normalize"

describe("normalizeUsageBlock — alias precedence", () => {
  it("prefers camelCase promptTokens/completionTokens over every other spelling", () => {
    const out = normalizeUsageBlock({
      promptTokens: 1,
      inputTokens: 2,
      input_tokens: 3,
      completionTokens: 4,
      outputTokens: 5,
      output_tokens: 6,
    })
    expect(out.input_tokens).toBe(1)
    expect(out.output_tokens).toBe(4)
  })

  it("falls through the cache-read chain in the documented order", () => {
    expect(
      normalizeUsageBlock({ cacheReadInputTokens: 9, cachedInputTokens: 8 }).cache_read_input_tokens
    ).toBe(9)
    expect(
      normalizeUsageBlock({ cachedInputTokens: 8, prompt_cache_hit_tokens: 7 })
        .cache_read_input_tokens
    ).toBe(8)
    // Bottom of the chain: DeepSeek-style snake_case is still picked up.
    expect(normalizeUsageBlock({ promptCacheHitTokens: 7 }).cache_read_input_tokens).toBe(7)
  })

  it("reads reasoning tokens from the nested outputTokenDetails when flat spellings are absent", () => {
    expect(
      normalizeUsageBlock({ outputTokenDetails: { reasoningTokens: 42 } }).reasoning_tokens
    ).toBe(42)
    expect(
      normalizeUsageBlock({ reasoningTokens: 1, outputTokenDetails: { reasoningTokens: 42 } })
        .reasoning_tokens
    ).toBe(1)
  })
})

describe("normalizeUsageBlock — junk guards", () => {
  it("skips a negative or non-finite candidate and keeps looking", () => {
    expect(normalizeUsageBlock({ promptTokens: -5, inputTokens: 12 }).input_tokens).toBe(12)
    expect(normalizeUsageBlock({ promptTokens: Number.NaN, input_tokens: 3 }).input_tokens).toBe(3)
    expect(
      normalizeUsageBlock({ completionTokens: Number.POSITIVE_INFINITY, outputTokens: 8 })
        .output_tokens
    ).toBe(8)
  })

  it("collapses to zero when nothing usable was reported", () => {
    expect(normalizeUsageBlock(undefined)).toMatchObject({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      reasoning_tokens: 0,
    })
  })

  it("omits context_input_tokens unless the provider reported a number", () => {
    expect(normalizeUsageBlock({}).context_input_tokens).toBeUndefined()
    // 0 is a report, not an absence.
    expect(normalizeUsageBlock({ contextInputTokens: 0 }).context_input_tokens).toBe(0)
  })
})

describe("normalizeCacheCreation", () => {
  it("reads the camelCase nested split as well as the snake_case one", () => {
    expect(
      normalizeCacheCreation({
        cacheCreation: { ephemeral5mInputTokens: 30, ephemeral1hInputTokens: 70 },
      })
    ).toEqual({ total: 100, ephemeral5m: 30, ephemeral1h: 70 })
  })

  it("falls back to the AI SDK's inputTokenDetails.cacheWriteTokens for the flat total", () => {
    expect(normalizeCacheCreation({ inputTokenDetails: { cacheWriteTokens: 55 } })).toEqual({
      total: 55,
      ephemeral5m: 0,
      ephemeral1h: 0,
    })
  })
})

describe("normalizeServerToolUse", () => {
  it("drops zero, negative and non-numeric counters", () => {
    expect(
      normalizeServerToolUse({
        server_tool_use: {
          web_search_requests: 3,
          zero_requests: 0,
          negative_requests: -1,
          bogus: "nope" as unknown as number,
        },
      })
    ).toEqual({ web_search: 3 })
  })

  it("returns undefined rather than an empty object when nothing survives", () => {
    expect(normalizeServerToolUse({ server_tool_use: {} })).toBeUndefined()
    expect(normalizeServerToolUse({})).toBeUndefined()
  })
})

describe("toLanguageModelUsage", () => {
  it("accepts the nested AI SDK v7 shape as well as the flat one", () => {
    expect(
      toLanguageModelUsage({
        inputTokens: { total: 100, cacheRead: 40, cacheWrite: 10 },
        outputTokens: { total: 30, reasoning: 12 },
      } as never)
    ).toEqual({
      inputTokens: { total: 100, noCache: 60, cacheRead: 40, cacheWrite: 10 },
      outputTokens: { total: 30, text: 18, reasoning: 12 },
    })
  })

  it("puts cachedInputTokens ahead of cacheReadInputTokens — the reverse of normalizeUsageBlock", () => {
    const raw = { cachedInputTokens: 8, cacheReadInputTokens: 9 }
    expect(toLanguageModelUsage(raw).inputTokens.cacheRead).toBe(8)
    expect(normalizeUsageBlock(raw).cache_read_input_tokens).toBe(9)
  })

  it("preserves 'not reported' as undefined instead of collapsing it to 0", () => {
    const out = toLanguageModelUsage({})
    expect(out.inputTokens.total).toBeUndefined()
    expect(out.inputTokens.noCache).toBeUndefined()
    expect(out.outputTokens.total).toBeUndefined()
    expect(out.outputTokens.text).toBeUndefined()
  })

  it("reports a genuine zero as zero", () => {
    const out = toLanguageModelUsage({ promptTokens: 0, completionTokens: 0 })
    expect(out.inputTokens.total).toBe(0)
    expect(out.outputTokens.total).toBe(0)
  })

  it("never lets the derived noCache/text fields go negative", () => {
    const out = toLanguageModelUsage({
      promptTokens: 10,
      cachedInputTokens: 25,
      completionTokens: 5,
      reasoningTokens: 20,
    })
    expect(out.inputTokens.noCache).toBe(0)
    expect(out.outputTokens.text).toBe(0)
  })
})
