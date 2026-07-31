import { deriveEffortSliderState, modelSupportsEffort, thinkingLevelToEffort } from "./thinking"
import { EFFORT_SLIDER_LEVELS } from "./schema"

describe("thinkingLevelToEffort", () => {
  it("maps each non-off level to the matching effort", () => {
    expect(thinkingLevelToEffort("low")).toBe("low")
    expect(thinkingLevelToEffort("medium")).toBe("medium")
    expect(thinkingLevelToEffort("high")).toBe("high")
    expect(thinkingLevelToEffort("xhigh")).toBe("xhigh")
    expect(thinkingLevelToEffort("max")).toBe("max")
  })

  it("maps ultracode to xhigh effort (the composite top tier)", () => {
    expect(thinkingLevelToEffort("ultracode")).toBe("xhigh")
  })

  it("returns undefined for off / unset (model default)", () => {
    expect(thinkingLevelToEffort("off")).toBeUndefined()
    expect(thinkingLevelToEffort(undefined)).toBeUndefined()
  })
})

describe("deriveEffortSliderState", () => {
  it("treats off / unset as the off checkbox, slider parked at low", () => {
    expect(deriveEffortSliderState("off")).toEqual({ off: true, index: 0 })
    expect(deriveEffortSliderState(undefined)).toEqual({ off: true, index: 0 })
  })

  it("maps each non-off level to its slider index with off unchecked", () => {
    for (const [i, level] of EFFORT_SLIDER_LEVELS.entries()) {
      expect(deriveEffortSliderState(level)).toEqual({ off: false, index: i })
    }
  })

  it("parks ultracode at the last slider index", () => {
    expect(deriveEffortSliderState("ultracode")).toEqual({
      off: false,
      index: EFFORT_SLIDER_LEVELS.length - 1,
    })
  })
})

describe("modelSupportsEffort — Anthropic", () => {
  it.each([
    "claude-opus-4-5",
    "claude-opus-4-6",
    "claude-opus-4-6-fast",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-sonnet-4-6",
    "claude-fable-5",
    "claude-mythos-5",
  ])("supports effort-capable model %s", (model) => {
    expect(modelSupportsEffort("anthropic", model)).toBe(true)
  })

  it.each(["claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-1", "claude-opus-4-0"])(
    "rejects effort on %s",
    (model) => {
      expect(modelSupportsEffort("anthropic", model)).toBe(false)
    }
  )
})

describe("modelSupportsEffort — non-Anthropic reasoning models", () => {
  it.each([
    ["openai", "o1"],
    ["openai", "o3-mini"],
    ["openai", "gpt-5"],
    ["deepseek", "deepseek-reasoner"],
    ["deepseek", "deepseek-r1"],
    ["google", "gemini-2.5-flash-thinking"],
    ["xai", "grok-4-reasoning"],
  ])("supports %s/%s", (provider, model) => {
    expect(modelSupportsEffort(provider, model)).toBe(true)
  })

  it.each([
    ["openai", "gpt-4o"],
    ["deepseek", "deepseek-chat"],
    ["google", "gemini-2.0-flash"],
  ])("does not force effort on non-reasoning %s/%s", (provider, model) => {
    expect(modelSupportsEffort(provider, model)).toBe(false)
  })
})

describe("modelSupportsEffort — no model", () => {
  it("returns false when the model is undefined", () => {
    expect(modelSupportsEffort("anthropic", undefined)).toBe(false)
  })
})
