import type { AcpConfigOption, AcpSessionModelState } from "@/types/agent/external-agent"

import {
  externalAgentIdFromProviderId,
  externalAgentProviderId,
  findModelConfigOption,
  isExternalAgentProviderId,
  resolveExternalAgentModels,
  EMPTY_THINKING_SURFACE,
  findThinkingConfigOption,
  resolveExternalAgentThinking,
} from "./session-models"

it("binds a persisted agent-model marker to one agent", () => {
  const marker = externalAgentProviderId("pi/one")
  expect(isExternalAgentProviderId(marker)).toBe(true)
  expect(externalAgentIdFromProviderId(marker)).toBe("pi/one")
  expect(externalAgentIdFromProviderId("cognia:external-agent")).toBeNull()
})

function modelOption(overrides: Partial<AcpConfigOption> = {}): AcpConfigOption {
  return {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "anthropic/claude-sonnet-4-5",
    options: [
      { value: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
      { value: "openai/gpt-5", name: "GPT-5", description: "via OpenAI" },
    ],
    ...overrides,
  } as AcpConfigOption
}

const SESSION_MODELS: AcpSessionModelState = {
  availableModels: [
    { modelId: "acp-one", name: "ACP One" },
    { modelId: "acp-two", name: "ACP Two", description: "the other one" },
  ],
  currentModelId: "acp-two",
}

describe("resolveExternalAgentModels", () => {
  it("reads a config option and says the write goes through it", () => {
    const surface = resolveExternalAgentModels({ configOptions: [modelOption()] })
    expect(surface.choices).toEqual([
      { modelId: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
      { modelId: "openai/gpt-5", name: "GPT-5", description: "via OpenAI" },
    ])
    expect(surface.currentModelId).toBe("anthropic/claude-sonnet-4-5")
    expect(surface.write).toEqual({ kind: "config-option", optionId: "model" })
  })

  it("flattens grouped values, which is how Pi packs providers", () => {
    const grouped = modelOption({
      options: [
        { group: "anthropic", name: "Anthropic", options: [{ value: "a/one", name: "One" }] },
        { group: "openai", name: "OpenAI", options: [{ value: "o/two", name: "Two" }] },
      ],
    } as Partial<AcpConfigOption>)
    expect(resolveExternalAgentModels({ configOptions: [grouped] }).choices).toEqual([
      { modelId: "a/one", name: "One" },
      { modelId: "o/two", name: "Two" },
    ])
  })

  it("falls back to session model state when no config option declares models", () => {
    const surface = resolveExternalAgentModels({ sessionModels: SESSION_MODELS })
    expect(surface.choices.map((c) => c.modelId)).toEqual(["acp-one", "acp-two"])
    expect(surface.currentModelId).toBe("acp-two")
    expect(surface.write).toEqual({ kind: "session-model" })
  })

  it("prefers the config option when an agent offers both", () => {
    // The agent's own declared control wins, matching the precedence
    // `applyModelToSession` already used. Two writers disagreeing about which
    // call reaches the agent is how a picker changes nothing.
    const surface = resolveExternalAgentModels({
      configOptions: [modelOption()],
      sessionModels: SESSION_MODELS,
    })
    expect(surface.write).toEqual({ kind: "config-option", optionId: "model" })
    expect(surface.choices.map((c) => c.modelId)).toContain("openai/gpt-5")
  })

  it("keeps the current model when the agent lists none to switch to", () => {
    // A read-only answer. Dropping the current id would leave the picker
    // showing the wrong active row while the agent runs something else.
    const surface = resolveExternalAgentModels({
      configOptions: [modelOption({ options: [] } as Partial<AcpConfigOption>)],
    })
    expect(surface.choices).toEqual([])
    expect(surface.currentModelId).toBe("anthropic/claude-sonnet-4-5")
    expect(surface.write).toEqual({ kind: "none" })
  })

  it("answers empty for an agent with no model concept at all", () => {
    expect(resolveExternalAgentModels({})).toEqual({
      choices: [],
      currentModelId: null,
      write: { kind: "none" },
    })
    expect(resolveExternalAgentModels({ configOptions: [] })).toEqual({
      choices: [],
      currentModelId: null,
      write: { kind: "none" },
    })
  })

  it("ignores config options of every other category", () => {
    const mode = modelOption({ id: "mode", category: "mode" } as Partial<AcpConfigOption>)
    const thought = modelOption({
      id: "thought",
      category: "thought_level",
    } as Partial<AcpConfigOption>)
    expect(resolveExternalAgentModels({ configOptions: [mode, thought] }).choices).toEqual([])
  })

  it("falls back to the value id when the agent gives no display name", () => {
    const unnamed = modelOption({
      options: [{ value: "bare-id", name: "" }],
    } as Partial<AcpConfigOption>)
    expect(resolveExternalAgentModels({ configOptions: [unnamed] }).choices).toEqual([
      { modelId: "bare-id", name: "bare-id" },
    ])
  })
})

describe("findModelConfigOption", () => {
  it("returns undefined for a boolean option that happens to be categorised model", () => {
    // Only a select carries a list to choose from. A boolean in that category
    // is some other switch and must not be mistaken for the picker.
    const boolish = {
      id: "model",
      name: "Model",
      category: "model",
      type: "boolean",
      currentValue: true,
    } as AcpConfigOption
    expect(findModelConfigOption([boolish])).toBeUndefined()
  })
})

describe("resolveExternalAgentThinking", () => {
  const thinkingOption = (over: Partial<AcpConfigOption> = {}): AcpConfigOption =>
    ({
      id: "thinking",
      name: "Thinking",
      category: "thought_level",
      type: "select",
      currentValue: "medium",
      options: [
        { value: "off", name: "Off" },
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "max", name: "Max" },
      ],
      ...over,
    }) as AcpConfigOption

  it("reads the agent's own vocabulary verbatim, in its own order", () => {
    // Not projected onto the app's tiers here. `off` has no EffortTier and
    // dropping it at this layer would hide from the caller that the agent
    // offers it, which is a different statement from the agent being silent.
    const surface = resolveExternalAgentThinking({ configOptions: [thinkingOption()] })
    expect(surface.levels).toEqual(["off", "low", "medium", "max"])
    expect(surface.currentLevel).toBe("medium")
    expect(surface.write).toEqual({ kind: "config-option", optionId: "thinking" })
  })

  it("answers the empty surface when the agent declares no thinking control", () => {
    // Absent, not broken: an agent with no depth axis still runs, and the
    // composer keeps offering its generic ladder for it.
    expect(resolveExternalAgentThinking({ configOptions: [] })).toEqual(EMPTY_THINKING_SURFACE)
    expect(resolveExternalAgentThinking({})).toEqual(EMPTY_THINKING_SURFACE)
  })

  it("keeps the current level but refuses the write when the list is empty", () => {
    // Same rule the model resolver keeps: dropping `currentLevel` would make
    // the control show the wrong active row, while a write has nowhere to go.
    const surface = resolveExternalAgentThinking({
      configOptions: [thinkingOption({ options: [] } as Partial<AcpConfigOption>)],
    })
    expect(surface.currentLevel).toBe("medium")
    expect(surface.write).toEqual({ kind: "none" })
  })

  it("does not mistake a model select for the thinking control", () => {
    const model = {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "sonnet",
      options: [{ value: "sonnet", name: "Sonnet" }],
    } as AcpConfigOption
    expect(resolveExternalAgentThinking({ configOptions: [model] })).toEqual(EMPTY_THINKING_SURFACE)
  })
})

describe("findThinkingConfigOption", () => {
  it("ignores a boolean in the thought_level category", () => {
    // Only a select carries a ladder. A boolean there is some other switch.
    const boolish = {
      id: "thinking",
      name: "Thinking",
      category: "thought_level",
      type: "boolean",
      currentValue: true,
    } as AcpConfigOption
    expect(findThinkingConfigOption([boolish])).toBeUndefined()
  })
})
