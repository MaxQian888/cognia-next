import type { AcpConfigOption, AcpConfigOptionValue } from "@/types/agent/external-agent"
import {
  DEVIN_THOUGHT_LEVEL_OPTION_ID,
  devinModelIdForLevel,
  devinThoughtLevelOption,
  withDevinThoughtLevelOption,
} from "./devin-model-axis"
import { flattenValues } from "../../session/session-models"

function option(value: string, name: string): AcpConfigOptionValue {
  return { value, name }
}

type SelectOption = Extract<AcpConfigOption, { type: "select" }>

function modelOption(currentValue: string, options: AcpConfigOptionValue[]): SelectOption {
  return {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue,
    options,
  }
}

function offeredLevels(option: AcpConfigOption | undefined): string[] {
  if (option?.type !== "select") return []
  return flattenValues(option.options).map((entry) => entry.value)
}

const CLAUDE_OPUS_5 = [
  option("claude-opus-5", "Claude Opus 5 High Thinking"),
  option("claude-opus-5-low", "Claude Opus 5 Low Thinking"),
  option("claude-opus-5-medium", "Claude Opus 5 Medium Thinking"),
  option("claude-opus-5-high", "Claude Opus 5 High Thinking"),
  option("claude-opus-5-xhigh", "Claude Opus 5 XHigh Thinking"),
  option("claude-opus-5-max", "Claude Opus 5 Max Thinking"),
]

const CLAUDE_OPUS_5_FAST = [
  option("claude-opus-5-fast", "Claude Opus 5 High Thinking Fast"),
  option("claude-opus-5-low-fast", "Claude Opus 5 Low Thinking Fast"),
  option("claude-opus-5-high-fast", "Claude Opus 5 High Thinking Fast"),
  option("claude-opus-5-max-fast", "Claude Opus 5 Max Thinking Fast"),
]

const SOL = [
  option("gpt-5-6-sol-none", "GPT-5.6 Sol No Thinking"),
  option("gpt-5-6-sol-low", "GPT-5.6 Sol Low Thinking"),
  option("gpt-5-6-sol-medium", "GPT-5.6 Sol Medium Thinking"),
  option("gpt-5-6-sol-high", "GPT-5.6 Sol High Thinking"),
  option("gpt-5-6-sol-xhigh", "GPT-5.6 Sol XHigh Thinking"),
  option("gpt-5-6-sol-max", "GPT-5.6 Sol Max Thinking"),
]

const MIXED = [
  option("swe-2-max", "SWE-2 Max"),
  option("swe-1-6", "SWE-1.6"),
  option("swe-1-7", "SWE-1.7 Max"),
  option("gpt-4-1", "GPT-4.1"),
  option("adaptive", "Adaptive"),
  option("kimi-k2-6", "Kimi K2.6"),
  option("glm-5-2", "GLM-5.2 High"),
  option("glm-5-2-max", "GLM-5.2 Max"),
  option("claude-4-6", "Claude Opus 4.6 Thinking"),
  option("claude-4-6-1m", "Claude Opus 4.6 Thinking 1M"),
  option("gemini-3-5-flash-minimal", "Gemini 3.5 Flash Minimal"),
  ...CLAUDE_OPUS_5,
  ...CLAUDE_OPUS_5_FAST,
  ...SOL,
]

describe("devinThoughtLevelOption", () => {
  it("synthesizes the family's effort ladder in canonical order", () => {
    const synthetic = devinThoughtLevelOption(modelOption("claude-opus-5-max", [...MIXED]))
    expect(synthetic?.category).toBe("thought_level")
    expect(synthetic?.id).toBe(DEVIN_THOUGHT_LEVEL_OPTION_ID)
    expect(synthetic?.currentValue).toBe("max")
    expect(offeredLevels(synthetic)).toEqual(["low", "medium", "high", "xhigh", "max"])
  })

  it("reads the effort of a bare id from its display name", () => {
    const synthetic = devinThoughtLevelOption(modelOption("swe-1-7", MIXED))
    expect(synthetic?.currentValue).toBe("max")
    expect(offeredLevels(synthetic)).toEqual(["max"])
  })

  it("returns no axis for a family whose variants carry no effort rungs", () => {
    // "Thinking" is a boolean variant, not a ladder rung; "1M" is serving tier.
    expect(devinThoughtLevelOption(modelOption("claude-4-6", MIXED))).toBeUndefined()
    expect(devinThoughtLevelOption(modelOption("adaptive", MIXED))).toBeUndefined()
    expect(devinThoughtLevelOption(modelOption("swe-1-6", MIXED))).toBeUndefined()
  })

  it("keeps serving-tier modifiers in the family so fast variants do not mix", () => {
    const synthetic = devinThoughtLevelOption(modelOption("claude-opus-5-high-fast", MIXED))
    expect(synthetic?.currentValue).toBe("high")
    expect(offeredLevels(synthetic)).toEqual(["low", "high", "max"])
  })

  it("offers sub-ladder rungs like none and minimal when the family has them", () => {
    const sol = devinThoughtLevelOption(modelOption("gpt-5-6-sol-low", MIXED))
    expect(offeredLevels(sol)).toEqual(["none", "low", "medium", "high", "xhigh", "max"])
    const gemini = devinThoughtLevelOption(modelOption("gemini-3-5-flash-minimal", MIXED))
    expect(gemini?.currentValue).toBe("minimal")
  })

  it("keys a fusion axis on the lead's base plus the fixed sidekick", () => {
    const fusion = [
      option(
        "fusion-claude-opus-5-max-sidekick-glm-5-2",
        "Fusion (Claude Opus 5 Max + GLM-5.2 High)"
      ),
      option(
        "fusion-claude-opus-5-low-sidekick-glm-5-2",
        "Fusion (Claude Opus 5 Low Thinking + GLM-5.2 High)"
      ),
      option("fusion-claude-opus-5-max-sidekick-kimi-k3", "Fusion (Claude Opus 5 Max + Kimi K3)"),
    ]
    const synthetic = devinThoughtLevelOption(
      modelOption("fusion-claude-opus-5-max-sidekick-glm-5-2", fusion)
    )
    expect(synthetic?.currentValue).toBe("max")
    // The other sidekick's recipe is a different family — its ids must not leak in.
    expect(offeredLevels(synthetic)).toEqual(["low", "max"])
  })

  it("returns undefined for a missing or non-select model option", () => {
    expect(devinThoughtLevelOption(undefined)).toBeUndefined()
    expect(
      devinThoughtLevelOption({
        id: "model",
        name: "Model",
        category: "model",
        type: "boolean",
        currentValue: true,
      })
    ).toBeUndefined()
    expect(devinThoughtLevelOption(modelOption("ghost", MIXED))).toBeUndefined()
  })
})

describe("devinModelIdForLevel", () => {
  const model = modelOption("claude-opus-5-high", MIXED)

  it("maps a level to the family member carrying it", () => {
    expect(devinModelIdForLevel(model, "low")).toBe("claude-opus-5-low")
    expect(devinModelIdForLevel(model, "max")).toBe("claude-opus-5-max")
    // `claude-opus-5` and `claude-opus-5-high` are the same rung; the session's
    // own id wins so a no-change write never hops to a sibling alias.
    expect(devinModelIdForLevel(model, "high")).toBe("claude-opus-5-high")
    expect(devinModelIdForLevel(modelOption("claude-opus-5", MIXED), "high")).toBe("claude-opus-5")
  })

  it("stays inside the serving tier the user picked", () => {
    const fast = modelOption("claude-opus-5-high-fast", MIXED)
    expect(devinModelIdForLevel(fast, "max")).toBe("claude-opus-5-max-fast")
    // `xhigh` exists only in the standard tier — a fast-tier session cannot reach it.
    expect(devinModelIdForLevel(fast, "xhigh")).toBeUndefined()
  })

  it("returns undefined for levels the family does not carry", () => {
    expect(devinModelIdForLevel(model, "none")).toBeUndefined()
    expect(devinModelIdForLevel(modelOption("swe-1-7", MIXED), "low")).toBeUndefined()
    expect(devinModelIdForLevel(modelOption("adaptive", MIXED), "high")).toBeUndefined()
    expect(devinModelIdForLevel(undefined, "high")).toBeUndefined()
  })
})

describe("withDevinThoughtLevelOption", () => {
  it("appends the synthesized option without touching the wire list", () => {
    const raw: AcpConfigOption[] = [
      modelOption("gpt-5-6-sol-high", MIXED),
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "smart",
        options: [option("smart", "Smart")],
      },
    ]
    const out = withDevinThoughtLevelOption(raw)
    expect(out).toHaveLength(3)
    expect(raw).toHaveLength(2)
    expect(out?.[2].id).toBe(DEVIN_THOUGHT_LEVEL_OPTION_ID)
  })

  it("defers to a real thought_level select the agent published itself", () => {
    const native: AcpConfigOption = {
      id: "thought_level",
      name: "Thinking level",
      category: "thought_level",
      type: "select",
      currentValue: "medium",
      options: [option("medium", "Medium")],
    }
    const raw = [modelOption("gpt-5-6-sol-high", MIXED), native]
    expect(withDevinThoughtLevelOption(raw)).toBe(raw)
  })

  it("passes through when the family has no ladder or the list is absent", () => {
    const noLadder = [modelOption("adaptive", MIXED)]
    expect(withDevinThoughtLevelOption(noLadder)).toBe(noLadder)
    expect(withDevinThoughtLevelOption(undefined)).toBeUndefined()
  })
})
