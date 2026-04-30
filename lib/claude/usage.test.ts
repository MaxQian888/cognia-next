import type { UIMessage } from "ai"

import {
  DEFAULT_CONTEXT_WINDOW,
  getLatestUsage,
  getModelContextWindow,
  tokensInWindow,
} from "./usage"
import type { UsageInfo } from "./adapter"

function asUiMessage(role: UIMessage["role"], metadata?: Record<string, unknown>): UIMessage {
  return {
    id: `m-${Math.random().toString(36).slice(2, 8)}`,
    role,
    parts: [],
    ...(metadata ? ({ metadata } as Record<string, unknown>) : {}),
  } as UIMessage
}

describe("getModelContextWindow", () => {
  it("falls back to the documented default for an undefined id", () => {
    expect(getModelContextWindow(undefined)).toBe(DEFAULT_CONTEXT_WINDOW)
  })

  it("falls back to the default for an empty string", () => {
    // Empty string is falsy so the early return triggers — codifies that.
    expect(getModelContextWindow("")).toBe(DEFAULT_CONTEXT_WINDOW)
  })

  it("falls back to the default for an unknown model id", () => {
    expect(getModelContextWindow("gpt-5-turbo")).toBe(200_000)
  })

  it("returns 1M for sonnet-4-5/4-6/4-7 with the .1m suffix", () => {
    expect(getModelContextWindow("claude-sonnet-4-5-1m")).toBe(1_000_000)
    expect(getModelContextWindow("claude-sonnet-4-6.1m")).toBe(1_000_000)
    expect(getModelContextWindow("claude-sonnet-4-7-1m")).toBe(1_000_000)
  })

  it("returns 1M for ids ending in [1m]", () => {
    expect(getModelContextWindow("claude-opus-4-7[1m]")).toBe(1_000_000)
  })

  it("returns 200k for the standard frontier models", () => {
    expect(getModelContextWindow("claude-opus-4-7")).toBe(200_000)
    expect(getModelContextWindow("claude-sonnet-4-5")).toBe(200_000)
    expect(getModelContextWindow("claude-haiku-4-5")).toBe(200_000)
  })
})

describe("tokensInWindow", () => {
  it("sums input + output + cacheRead, ignoring cacheCreation", () => {
    const usage: UsageInfo = {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 999, // intentionally excluded
      cacheReadInputTokens: 25,
    }
    expect(tokensInWindow(usage)).toBe(175)
  })

  it("treats undefined fields as zero", () => {
    expect(tokensInWindow({})).toBe(0)
    expect(tokensInWindow({ inputTokens: 7 })).toBe(7)
  })
})

describe("getLatestUsage", () => {
  it("returns null on an empty list", () => {
    expect(getLatestUsage([])).toBeNull()
  })

  it("returns null when no assistant message has usage metadata", () => {
    const messages = [asUiMessage("user"), asUiMessage("assistant"), asUiMessage("user")]
    expect(getLatestUsage(messages)).toBeNull()
  })

  it("returns null when assistant metadata exists but lacks usage fields", () => {
    const messages = [asUiMessage("assistant", {})]
    expect(getLatestUsage(messages)).toBeNull()
  })

  it("returns null when usage exists but every recognised field is undefined", () => {
    const messages = [
      asUiMessage("assistant", {
        usage: { totalCostUsd: 0.001, durationMs: 10 } as UsageInfo,
      }),
    ]
    expect(getLatestUsage(messages)).toBeNull()
  })

  it("walks from the tail forward, picking the most recent assistant usage", () => {
    const usageOld: UsageInfo = { inputTokens: 1, outputTokens: 1 }
    const usageNew: UsageInfo = { inputTokens: 100, outputTokens: 50 }
    const messages = [
      asUiMessage("assistant", { usage: usageOld }),
      asUiMessage("user"),
      asUiMessage("assistant", { usage: usageNew }),
      asUiMessage("user"), // user messages are skipped — no metadata even if present
    ]
    expect(getLatestUsage(messages)).toEqual(usageNew)
  })

  it("accepts cacheReadInputTokens alone as a 'has usage' signal", () => {
    const usage: UsageInfo = { cacheReadInputTokens: 42 }
    expect(getLatestUsage([asUiMessage("assistant", { usage })])).toEqual(usage)
  })

  it("skips assistant messages without metadata and finds the next valid one", () => {
    const usage: UsageInfo = { inputTokens: 12 }
    const noMetaAssistant = asUiMessage("assistant")
    const messages = [asUiMessage("assistant", { usage }), noMetaAssistant]
    expect(getLatestUsage(messages)).toEqual(usage)
  })
})
