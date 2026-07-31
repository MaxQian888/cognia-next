import type { ModelConfig, UserProviderSettings } from "@cognia/provider-types"
import type {
  GlobalInferenceDefaults,
  ParameterDefinition,
  ProviderParameterSchema,
} from "@cognia/provider-types/provider-parameter-schema"

import {
  resolveInferenceParams,
  resolveProviderSpecificParams,
  setNestedValue,
  shouldShowParameter,
} from "./parameter-resolver"

const reasoningModel: ModelConfig = {
  id: "o3-mini",
  name: "o3 mini",
  contextLength: 200000,
  supportsTools: true,
  supportsVision: false,
  supportsAudio: false,
  supportsVideo: false,
  supportsStreaming: true,
  supportsReasoning: true,
}

describe("resolveInferenceParams", () => {
  it("applies session values before provider and global defaults", () => {
    const providerSettings: UserProviderSettings = {
      providerId: "openai",
      defaultModel: "gpt-4o",
      enabled: true,
      inferenceDefaults: { temperature: 0.3, maxTokens: 2048, topP: 0.8 },
    }

    expect(
      resolveInferenceParams({ temperature: 0.1 }, providerSettings, {
        defaultTemperature: 0.7,
        defaultMaxTokens: 4096,
        defaultTopP: 1,
        defaultFrequencyPenalty: 0,
        defaultPresencePenalty: 0,
      })
    ).toEqual({
      temperature: 0.1,
      maxTokens: 2048,
      topP: 0.8,
      frequencyPenalty: 0,
      presencePenalty: 0,
    })
  })

  it("uses provider defaults for every inference parameter when session values are absent", () => {
    const providerSettings: UserProviderSettings = {
      providerId: "anthropic",
      defaultModel: "claude-sonnet-4",
      enabled: true,
      inferenceDefaults: {
        temperature: 0.2,
        maxTokens: 8192,
        topP: 0.9,
        frequencyPenalty: 0.1,
        presencePenalty: 0.15,
      },
    }

    expect(
      resolveInferenceParams(undefined, providerSettings, {
        defaultTemperature: 0.7,
        defaultMaxTokens: 4096,
        defaultTopP: 1,
        defaultFrequencyPenalty: 0,
        defaultPresencePenalty: 0,
      })
    ).toEqual({
      temperature: 0.2,
      maxTokens: 8192,
      topP: 0.9,
      frequencyPenalty: 0.1,
      presencePenalty: 0.15,
    })
  })

  it("falls back to global defaults and then hardcoded defaults", () => {
    expect(
      resolveInferenceParams(undefined, undefined, {
        defaultTemperature: 0.5,
        defaultMaxTokens: 16384,
        defaultTopP: 0.95,
        defaultFrequencyPenalty: 0.2,
        defaultPresencePenalty: 0.25,
      })
    ).toEqual({
      temperature: 0.5,
      maxTokens: 16384,
      topP: 0.95,
      frequencyPenalty: 0.2,
      presencePenalty: 0.25,
    })

    expect(resolveInferenceParams(undefined, undefined, {} as GlobalInferenceDefaults)).toEqual({
      temperature: 0.7,
      maxTokens: 4096,
      topP: 1,
      frequencyPenalty: 0,
      presencePenalty: 0,
    })
  })
})

describe("shouldShowParameter", () => {
  it("shows unconditional parameters and defers model checks when model config is unavailable", () => {
    expect(
      shouldShowParameter(
        {
          key: "temperature",
          label: "Temperature",
          description: "Controls response randomness",
          type: "slider",
          category: "inference",
          defaultValue: 0.7,
        },
        undefined
      )
    ).toBe(true)

    expect(
      shouldShowParameter(
        {
          key: "openai.reasoningEffort",
          label: "Reasoning effort",
          description: "Controls reasoning depth",
          type: "select",
          category: "provider-specific",
          defaultValue: "medium",
          condition: {
            modelCapability: "supportsReasoning",
            modelIdPattern: "^o3",
          },
        },
        undefined
      )
    ).toBe(true)
  })

  it("requires matching capability, model id pattern, and dependency values", () => {
    const definition: ParameterDefinition = {
      key: "openai.reasoningEffort",
      label: "Reasoning effort",
      description: "Controls reasoning depth",
      type: "select",
      category: "provider-specific",
      defaultValue: "medium",
      condition: {
        modelCapability: "supportsReasoning",
        modelIdPattern: "^o3",
        dependsOn: { key: "openai.reasoningEnabled", value: true },
      },
    }

    expect(
      shouldShowParameter(definition, reasoningModel, { "openai.reasoningEnabled": true })
    ).toBe(true)
    expect(
      shouldShowParameter(definition, reasoningModel, { "openai.reasoningEnabled": false })
    ).toBe(false)
    expect(
      shouldShowParameter(
        definition,
        { ...reasoningModel, supportsReasoning: false },
        {
          "openai.reasoningEnabled": true,
        }
      )
    ).toBe(false)
  })

  it("rejects mismatched model id patterns and defers dependency checks without current values", () => {
    const definition: ParameterDefinition = {
      key: "openai.reasoningEffort",
      label: "Reasoning effort",
      description: "Controls reasoning depth",
      type: "select",
      category: "provider-specific",
      defaultValue: "medium",
      condition: {
        modelIdPattern: "^gpt",
        dependsOn: { key: "openai.reasoningEnabled", value: true },
      },
    }

    expect(shouldShowParameter(definition, reasoningModel)).toBe(false)

    expect(
      shouldShowParameter(
        {
          ...definition,
          condition: {
            dependsOn: { key: "openai.reasoningEnabled", value: true },
          },
        },
        reasoningModel
      )
    ).toBe(true)
  })
})

describe("resolveProviderSpecificParams", () => {
  it("filters by category and writes provider-native nested keys", () => {
    const schema: ProviderParameterSchema = {
      providerId: "openai",
      providerName: "OpenAI",
      parameters: [
        {
          key: "openai.reasoningEffort",
          nativeKey: "reasoning_effort",
          label: "Reasoning effort",
          description: "Controls reasoning depth",
          type: "select",
          category: "provider-specific",
          defaultValue: "medium",
          condition: { modelCapability: "supportsReasoning" },
        },
        {
          key: "temperature",
          label: "Temperature",
          description: "Controls response randomness",
          type: "slider",
          category: "inference",
          defaultValue: 0.7,
        },
      ],
    }

    const result = resolveProviderSpecificParams(
      "openai",
      {
        providerId: "openai",
        defaultModel: "o3-mini",
        enabled: true,
        providerSpecificParams: { "openai.reasoningEffort": "high" },
      },
      reasoningModel,
      schema
    )

    expect(result).toEqual({ openai: { reasoning_effort: "high" } })
  })

  it("applies visible defaults and skips missing, hidden, and non-provider-specific values", () => {
    const schema: ProviderParameterSchema = {
      providerId: "openai",
      providerName: "OpenAI",
      parameters: [
        {
          key: "openai.reasoningEffort",
          nativeKey: "reasoning_effort",
          label: "Reasoning effort",
          description: "Controls reasoning depth",
          type: "select",
          category: "provider-specific",
          defaultValue: "medium",
        },
        {
          key: "openai.unspecified",
          label: "Unspecified",
          description: "Has no default",
          type: "text",
          category: "provider-specific",
          defaultValue: undefined,
        },
        {
          key: "openai.hidden",
          label: "Hidden",
          description: "Hidden for non-GPT models",
          type: "toggle",
          category: "provider-specific",
          defaultValue: true,
          condition: { modelIdPattern: "^gpt" },
        },
        {
          key: "temperature",
          label: "Temperature",
          description: "Controls response randomness",
          type: "slider",
          category: "inference",
          defaultValue: 0.7,
        },
      ],
    }

    expect(resolveProviderSpecificParams("openai", undefined, reasoningModel, schema)).toEqual({
      openai: { reasoning_effort: "medium" },
    })
  })
})

describe("setNestedValue", () => {
  it("writes plain, provider-level, and deeply nested values", () => {
    const out: Record<string, unknown> = {}

    setNestedValue(out, "seed", 123)
    setNestedValue(out, "openai.reasoningEffort", "high", "reasoning_effort")
    setNestedValue(out, "anthropic.thinking.budgetTokens", 4096, "budget_tokens")

    expect(out).toEqual({
      seed: 123,
      openai: { reasoning_effort: "high" },
      anthropic: { thinking: { budget_tokens: 4096 } },
    })
  })

  it("reuses existing nested objects and applies native keys to plain values", () => {
    const out: Record<string, unknown> = { openai: { existing: true } }

    setNestedValue(out, "responseFormat", "json", "response_format")
    setNestedValue(out, "openai.seed", 123)

    expect(out).toEqual({
      response_format: "json",
      openai: { existing: true, seed: 123 },
    })
  })
})
