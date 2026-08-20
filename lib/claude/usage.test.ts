import type { UIMessage } from "ai"

import {
  AUTO_COMPACT_FRACTION,
  computeContextWindowUsage,
  contextLevel,
  DEFAULT_CONTEXT_WINDOW,
  getLatestUsage,
  getModelContextWindow,
  sumSessionUsage,
  tokensInWindow,
} from "./usage"
import type { UsageInfo } from "./adapter"
import { getBuiltInProviderCatalog } from "@cognia/provider-types/built-in-provider-catalog"

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

  it("falls back to the conservative 128k default for an unknown model id", () => {
    expect(getModelContextWindow("gpt-5-turbo")).toBe(128_000)
    expect(getModelContextWindow("gpt-5-turbo")).toBe(DEFAULT_CONTEXT_WINDOW)
  })

  it("uses the reconciled 128k window for DeepSeek tiers", () => {
    expect(getModelContextWindow("deepseek-chat")).toBe(128_000)
    expect(getModelContextWindow("deepseek-reasoner")).toBe(128_000)
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

  it("prefers contextInputTokens (last leg) over the summed inputTokens for the window", () => {
    // ai-sdk agent loop: `inputTokens` sums every leg's prompt (billing), but the
    // window only holds the last leg's prompt — `contextInputTokens` reports it.
    const usage: UsageInfo = {
      inputTokens: 3000, // 3 legs × ~1000
      contextInputTokens: 1000, // last leg's prompt = actual window occupancy
      outputTokens: 50,
    }
    expect(tokensInWindow(usage)).toBe(1050)
  })

  it("prefers an authoritative live-context token count from an external agent", () => {
    expect(
      tokensInWindow({
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 2,
        contextTokens: 120_000,
      })
    ).toBe(120_000)
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

  it("recognises authoritative external context usage without billable fields", () => {
    const usage: UsageInfo = { contextTokens: 120_000, contextWindow: 272_000 }
    expect(getLatestUsage([asUiMessage("assistant", { usage })])).toEqual(usage)
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

describe("sumSessionUsage", () => {
  it("returns all-zero totals for an empty list", () => {
    expect(sumSessionUsage([])).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalCostUsd: 0,
      turns: 0,
    })
  })

  it("sums every assistant turn's token fields and cost, counting turns", () => {
    const a: UsageInfo = {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 5,
      totalCostUsd: 0.002,
    }
    const b: UsageInfo = { inputTokens: 200, outputTokens: 80, totalCostUsd: 0.003 }
    const messages = [
      asUiMessage("assistant", { usage: a }),
      asUiMessage("user"),
      asUiMessage("assistant", { usage: b }),
    ]
    expect(sumSessionUsage(messages)).toEqual({
      inputTokens: 300,
      outputTokens: 130,
      cacheCreationInputTokens: 5,
      cacheReadInputTokens: 10,
      totalCostUsd: 0.005,
      turns: 2,
    })
  })

  it("ignores user messages and assistant messages without usage metadata", () => {
    const a: UsageInfo = { inputTokens: 7 }
    const messages = [
      asUiMessage("user"),
      asUiMessage("assistant"),
      asUiMessage("assistant", {}),
      asUiMessage("assistant", { usage: a }),
    ]
    const total = sumSessionUsage(messages)
    expect(total.inputTokens).toBe(7)
    expect(total.turns).toBe(1)
  })

  it("counts a turn even when only cost is present (no token fields)", () => {
    // A result message can carry cost without token counts; it is still a turn.
    const messages = [asUiMessage("assistant", { usage: { totalCostUsd: 0.001 } as UsageInfo })]
    const total = sumSessionUsage(messages)
    expect(total.totalCostUsd).toBeCloseTo(0.001, 6)
    expect(total.turns).toBe(1)
  })
})

describe("Claude 5 context windows", () => {
  // The regex table is ordered, and the generic Claude fallback sits below the
  // 1M rows. Without an explicit Claude-5 row `claude-sonnet-5` matched the
  // fallback and reported 200k against a catalogued 1M, while `claude-fable-5`
  // matched nothing and fell to the 128k default. That only bites where
  // `getModelConfig` misses — gateway-prefixed ids and relay providers — which
  // is exactly where it will bite.
  it("reports 1M for every catalogued Claude-5 model", () => {
    for (const modelId of ["claude-opus-5", "claude-sonnet-5", "claude-fable-5"]) {
      expect(getModelContextWindow(modelId)).toBe(1_000_000)
    }
  })

  it("resolves vendor-prefixed and gateway-prefixed Claude-5 ids", () => {
    expect(getModelContextWindow("us.anthropic.claude-sonnet-5")).toBe(1_000_000)
    expect(getModelContextWindow("anthropic/claude-opus-5")).toBe(1_000_000)
    expect(getModelContextWindow("claude-sonnet-5@default")).toBe(1_000_000)
  })

  it("keeps Haiku 4.5 at 200k", () => {
    expect(getModelContextWindow("claude-haiku-4-5-20251001")).toBe(200_000)
  })
})

describe("catalog parity", () => {
  // Turns "add a model family, forget the regex row" from a silent 5x context
  // error into a red test.
  it("agrees with every Anthropic catalog entry that declares a context length", () => {
    const anthropic = getBuiltInProviderCatalog().find((p) => p.id === "anthropic")
    expect(anthropic).toBeDefined()
    for (const model of anthropic?.models ?? []) {
      if (!model.contextLength) continue
      expect({ id: model.id, window: getModelContextWindow(model.id) }).toEqual({
        id: model.id,
        window: model.contextLength,
      })
    }
  })
})
