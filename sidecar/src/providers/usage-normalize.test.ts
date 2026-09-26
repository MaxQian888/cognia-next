// The renderer mirror is pinned against this module by
// lib/ai/chat/usage-normalize.parity.test.ts; these cases cover the sidecar
// side on its own.

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  normalizeCacheCreation,
  normalizeServerToolUse,
  normalizeUsageBlock,
  toLanguageModelUsage,
} from "./usage-normalize.ts"

test("normalizeUsageBlock reads every provider's spelling into one snake_case block", () => {
  const expected = {
    input_tokens: 10,
    output_tokens: 4,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 3,
    reasoning_tokens: 2,
  }
  assert.deepEqual(
    normalizeUsageBlock({
      inputTokens: 10,
      outputTokens: 4,
      cachedInputTokens: 3,
      reasoningTokens: 2,
    }),
    expected
  )
  assert.deepEqual(
    normalizeUsageBlock({
      input_tokens: 10,
      output_tokens: 4,
      prompt_cache_hit_tokens: 3,
      outputTokenDetails: { reasoningTokens: 2 },
    }),
    expected
  )
})

test("normalizeUsageBlock tolerates a missing or non-object block", () => {
  const zero = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    reasoning_tokens: 0,
  }
  assert.deepEqual(normalizeUsageBlock(undefined), zero)
  assert.deepEqual(normalizeUsageBlock(null), zero)
  assert.deepEqual(normalizeUsageBlock(42), zero)
})

test("negative, NaN and non-number counters read as 0", () => {
  const block = normalizeUsageBlock({
    inputTokens: -1,
    outputTokens: Number.NaN,
    cachedInputTokens: "7",
  })
  assert.equal(block.input_tokens, 0)
  assert.equal(block.output_tokens, 0)
  assert.equal(block.cache_read_input_tokens, 0)
})

test("the cache-creation TTL split is kept, and only emitted when reported", () => {
  assert.deepEqual(
    normalizeCacheCreation({
      cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 7 },
    }),
    { total: 12, ephemeral5m: 5, ephemeral1h: 7 }
  )
  // The provider's own flat total wins over the derived one.
  assert.equal(
    normalizeCacheCreation({
      cache_creation_input_tokens: 20,
      cacheCreation: { ephemeral5mInputTokens: 5 },
    }).total,
    20
  )
  assert.equal("cache_creation" in normalizeUsageBlock({ cache_creation_input_tokens: 9 }), false)
  assert.deepEqual(
    normalizeUsageBlock({ cache_creation: { ephemeral_1h_input_tokens: 4 } }).cache_creation,
    { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 4 }
  )
})

test("server tool counters drop the _requests suffix and skip zero or junk values", () => {
  assert.deepEqual(
    normalizeServerToolUse({
      server_tool_use: { web_search_requests: 3, web_fetch_requests: 0, other: "x" },
    }),
    { web_search: 3 }
  )
  assert.equal(normalizeServerToolUse({ serverToolUse: { web_search_requests: 0 } }), undefined)
  assert.equal(normalizeServerToolUse({}), undefined)
})

test("toLanguageModelUsage keeps 'not reported' as undefined, unlike 0", () => {
  assert.deepEqual(toLanguageModelUsage({}), {
    inputTokens: {
      total: undefined,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  })
  assert.deepEqual(
    toLanguageModelUsage({
      inputTokens: { total: 10, cacheRead: 4 },
      outputTokens: { total: 6, reasoning: 2 },
    }),
    {
      inputTokens: { total: 10, noCache: 6, cacheRead: 4, cacheWrite: undefined },
      outputTokens: { total: 6, text: 4, reasoning: 2 },
    }
  )
  assert.equal(toLanguageModelUsage({ promptTokens: 0 }).inputTokens.total, 0)
})
