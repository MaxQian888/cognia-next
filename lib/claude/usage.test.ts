import type { UIMessage } from "ai"

import {
  AUTO_COMPACT_FRACTION,
  computeContextWindowUsage,
  contextLevel,
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

  it("returns 1M for any model carrying the .1m / -1m build suffix", () => {
    expect(getModelContextWindow("claude-sonnet-4-5-1m")).toBe(1_000_000)
    expect(getModelContextWindow("claude-sonnet-4-6.1m")).toBe(1_000_000)
    expect(getModelContextWindow("claude-haiku-4-5-1m")).toBe(1_000_000)
  })

  it("returns 1M for ids ending in [1m]", () => {
    expect(getModelContextWindow("claude-opus-4-8[1m]")).toBe(1_000_000)
  })

  it("returns 1M for the Claude 4.6+ Opus / Sonnet 1M tier", () => {
    expect(getModelContextWindow("claude-opus-4-6")).toBe(1_000_000)
    expect(getModelContextWindow("claude-opus-4-8")).toBe(1_000_000)
    expect(getModelContextWindow("claude-sonnet-4-6")).toBe(1_000_000)
  })

  it("returns 200k for the 200k-tier Claude models", () => {
    expect(getModelContextWindow("claude-opus-4-1-20250414")).toBe(200_000)
    expect(getModelContextWindow("claude-sonnet-4-5")).toBe(200_000)
    expect(getModelContextWindow("claude-haiku-4-5")).toBe(200_000)
    expect(getModelContextWindow("claude-3-5-sonnet-20241022")).toBe(200_000)
    expect(getModelContextWindow("claude-3-opus-20240229")).toBe(200_000)
  })

  it("knows common non-Claude windows", () => {
    expect(getModelContextWindow("gpt-4o-mini")).toBe(128_000)
    expect(getModelContextWindow("gpt-4.1")).toBe(1_000_000)
    expect(getModelContextWindow("o3-mini")).toBe(200_000)
    expect(getModelContextWindow("gemini-2.5-pro")).toBe(1_000_000)
  })
})

describe("tokensInWindow", () => {
  it("sums input + output + cacheRead + cacheCreation (full turn occupancy)", () => {
    const usage: UsageInfo = {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 999,
      cacheReadInputTokens: 25,
    }
    expect(tokensInWindow(usage)).toBe(1174)
  })

  it("treats undefined fields as zero", () => {
    expect(tokensInWindow({})).toBe(0)
    expect(tokensInWindow({ inputTokens: 7 })).toBe(7)
  })
})

describe("contextLevel", () => {
  it("buckets fractions into ok / warn / crit", () => {
    expect(contextLevel(0)).toBe("ok")
    expect(contextLevel(0.59)).toBe("ok")
    expect(contextLevel(0.6)).toBe("warn")
    expect(contextLevel(0.83)).toBe("warn")
    expect(contextLevel(AUTO_COMPACT_FRACTION)).toBe("crit")
    expect(contextLevel(1)).toBe("crit")
  })
})

describe("computeContextWindowUsage", () => {
  it("returns a fresh-window snapshot when usage is null", () => {
    const r = computeContextWindowUsage(null, "claude-opus-4-8")
    expect(r.max).toBe(1_000_000)
    expect(r.used).toBe(0)
    expect(r.fraction).toBe(0)
    expect(r.remaining).toBe(1_000_000)
    expect(r.level).toBe("ok")
    expect(r.compactThresholdTokens).toBe(Math.round(1_000_000 * AUTO_COMPACT_FRACTION))
  })

  it("computes fraction / remaining / level from the latest turn", () => {
    const usage: UsageInfo = { inputTokens: 170_000, outputTokens: 0 }
    const r = computeContextWindowUsage(usage, "claude-sonnet-4-5") // 200k window
    expect(r.used).toBe(170_000)
    expect(r.fraction).toBeCloseTo(0.85, 5)
    expect(r.remaining).toBe(30_000)
    expect(r.level).toBe("crit") // past the 83.5% compact threshold
  })

  it("clamps fraction at 1 when the turn overflows the window", () => {
    const usage: UsageInfo = { inputTokens: 500_000 }
    const r = computeContextWindowUsage(usage, "gpt-4o", undefined) // 128k window
    expect(r.fraction).toBe(1)
    expect(r.remaining).toBe(0)
  })

  it("honours a maxOverride", () => {
    const usage: UsageInfo = { inputTokens: 2048 }
    const r = computeContextWindowUsage(usage, "claude-opus-4-8", 4096)
    expect(r.max).toBe(4096)
    expect(r.fraction).toBeCloseTo(0.5, 5)
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
