import type {
  GlobalInferenceDefaults,
  ParameterDefinition,
  ProviderParameterSchema,
  ResolvedInferenceParams,
} from "./provider-parameter-schema"

describe("provider parameter schema contract", () => {
  it("describes inference, provider-specific, connection, and advanced parameters", () => {
    const schema: ProviderParameterSchema = {
      providerId: "openai",
      providerName: "OpenAI",
      parameters: [
        {
          key: "temperature",
          label: "temperature",
          description: "temperature description",
          type: "slider",
          category: "inference",
          defaultValue: 0.7,
          validation: { min: 0, max: 2, step: 0.1 },
        },
        {
          key: "openai.reasoningEffort",
          nativeKey: "reasoning_effort",
          label: "reasoning",
          description: "reasoning description",
          type: "select",
          category: "provider-specific",
          defaultValue: "medium",
          condition: { modelCapability: "supportsReasoning" },
        },
      ],
    } satisfies ProviderParameterSchema

    const resolved: ResolvedInferenceParams = {
      temperature: 0.7,
      maxTokens: 4096,
      topP: 1,
      frequencyPenalty: 0,
      presencePenalty: 0,
    }
    const defaults: GlobalInferenceDefaults = {
      defaultTemperature: 0.7,
      defaultMaxTokens: 4096,
      defaultTopP: 1,
      defaultFrequencyPenalty: 0,
      defaultPresencePenalty: 0,
    }

    expect((schema.parameters[1] as ParameterDefinition).nativeKey).toBe("reasoning_effort")
    expect(resolved.maxTokens).toBe(defaults.defaultMaxTokens)
  })
})
