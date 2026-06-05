import { scoreDifficulty, createDifficultySelector } from "./difficulty-router"
import { makeTelemetrySnapshot } from "./strategies/built-in"
import type { DifficultyRoutingSettings } from "@/types/routing/tool-route"

const telemetry = makeTelemetrySnapshot({
  getHealthMetrics: () => undefined,
  getPricing: () => undefined,
})

const ENTRIES = [
  { providerId: "openai", modelId: "gpt-4o-mini" },
  { providerId: "anthropic", modelId: "claude-opus" },
  { providerId: "anthropic", modelId: "claude-haiku" },
]

const SETTINGS: DifficultyRoutingSettings = {
  enabled: true,
  weakModel: { providerId: "openai", modelId: "gpt-4o-mini" },
  strongModel: { providerId: "anthropic", modelId: "claude-opus" },
  threshold: 0.4,
}

describe("scoreDifficulty", () => {
  it("scores trivial prompts low and complex prompts high", () => {
    const trivial = scoreDifficulty("hi")
    const complex = scoreDifficulty(
      "Analyze this algorithm step by step and prove its complexity:\n```python\n" +
        "def f(n):\n    return f(n-1) + f(n-2)\n```\n" +
        "Then refactor it, optimize the architecture, and debug the edge cases. " +
        "Why? How? What about memoization? Explain. Compare. Conclude."
    )
    expect(trivial).toBeLessThan(0.2)
    expect(complex).toBeGreaterThan(0.6)
    expect(complex).toBeLessThanOrEqual(1)
  })

  it("recognizes Chinese reasoning keywords and empty input", () => {
    expect(scoreDifficulty("")).toBe(0)
    expect(scoreDifficulty("请推理并证明这个算法的复杂度,然后给出优化方案")).toBeGreaterThan(0.2)
  })
})

describe("difficulty selector", () => {
  it("routes complex prompts to the strong model and trivial ones to the weak", () => {
    const selector = createDifficultySelector(() => SETTINGS)
    const strong = selector.select(ENTRIES, telemetry, {
      promptText:
        "Prove this theorem step by step and analyze the algorithm:\n```\ncode\n```\n" +
        "Then implement, refactor, optimize and debug it carefully.",
    })
    expect(strong?.modelId).toBe("claude-opus")

    const weak = selector.select(ENTRIES, telemetry, { promptText: "hi" })
    expect(weak?.modelId).toBe("gpt-4o-mini")
  })

  it("falls back to chain order when disabled or unconfigured", () => {
    const disabled = createDifficultySelector(() => ({ ...SETTINGS, enabled: false }))
    expect(disabled.select(ENTRIES, telemetry, { promptText: "hi" })?.providerId).toBe("openai")

    const unconfigured = createDifficultySelector(() => ({
      enabled: true,
      threshold: 0.5,
    }))
    expect(unconfigured.select(ENTRIES, telemetry, { promptText: "hi" })?.providerId).toBe("openai")

    const noSettings = createDifficultySelector(() => undefined)
    expect(noSettings.select(ENTRIES, telemetry)?.providerId).toBe("openai")
  })

  it("degrades to same-provider then chain order when the target is not in the chain", () => {
    const selector = createDifficultySelector(() => ({
      ...SETTINGS,
      strongModel: { providerId: "anthropic", modelId: "claude-sonnet" }, // not in chain
    }))
    const result = selector.select(ENTRIES, telemetry, {
      promptText: "Prove and analyze this algorithm step by step ```code``` then optimize it.",
    })
    expect(result?.providerId).toBe("anthropic")

    const ghost = createDifficultySelector(() => ({
      ...SETTINGS,
      weakModel: { providerId: "ghost", modelId: "nope" },
    }))
    expect(ghost.select(ENTRIES, telemetry, { promptText: "hi" })?.providerId).toBe("openai")
  })

  it("returns null on empty chains", () => {
    const selector = createDifficultySelector(() => SETTINGS)
    expect(selector.select([], telemetry, { promptText: "hi" })).toBeNull()
  })
})
