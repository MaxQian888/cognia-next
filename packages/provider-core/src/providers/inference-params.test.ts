import { buildModelInferenceParams } from "./inference-params"
import { getSchemaForProvider } from "./provider-parameter-schemas"

describe("buildModelInferenceParams", () => {
  it("returns undefined when nothing is configured", () => {
    expect(buildModelInferenceParams(undefined)).toBeUndefined()
    expect(buildModelInferenceParams({})).toBeUndefined()
    expect(
      buildModelInferenceParams({ inferenceDefaults: {}, connectionParams: {}, advancedParams: {} })
    ).toBeUndefined()
  })

  it("maps inference defaults to AI SDK v6 call-option names", () => {
    expect(
      buildModelInferenceParams({
        inferenceDefaults: {
          temperature: 0.5,
          maxTokens: 800,
          topP: 0.9,
          frequencyPenalty: 0.1,
          presencePenalty: 0.2,
        },
      })
    ).toEqual({
      temperature: 0.5,
      maxOutputTokens: 800,
      topP: 0.9,
      frequencyPenalty: 0.1,
      presencePenalty: 0.2,
    })
  })

  it("maps maxRetries from connection params and topK/seed/stopSequences from advanced params", () => {
    expect(
      buildModelInferenceParams({
        connectionParams: { maxRetries: 5, timeout: 1000 },
        advancedParams: { topK: 40, seed: 7, stopSequences: ["\n\n", "END"] },
      })
    ).toEqual({ maxRetries: 5, topK: 40, seed: 7, stopSequences: ["\n\n", "END"] })
  })

  it("reads the schema-namespaced keys the Parameters tab writes", () => {
    // The tab persists under the schema key ("connection.maxRetries",
    // "openai.seed", "togetherAi.topK"); older rows use bare leaves. Both work.
    expect(
      buildModelInferenceParams({
        connectionParams: { "connection.maxRetries": 3 } as never,
        advancedParams: { "openai.seed": 11, "togetherAi.topK": 20 },
      })
    ).toEqual({ maxRetries: 3, seed: 11, topK: 20 })
  })

  it("projects providerSpecificParams into providerOptions through the schema", () => {
    const schema = getSchemaForProvider("openai")
    const params = buildModelInferenceParams(
      {
        providerSpecificParams: { "openai.reasoningEffort": "high", "openai.store": false },
      },
      {
        providerId: "openai",
        schema,
        modelConfig: { id: "o3", name: "o3", supportsReasoning: true } as never,
      }
    )
    expect(params?.providerOptions?.openai).toMatchObject({ reasoning_effort: "high" })
    // Without a schema nothing is projected (and no empty block is attached).
    expect(
      buildModelInferenceParams({ providerSpecificParams: { "openai.reasoningEffort": "high" } })
    ).toBeUndefined()
  })

  it("drops non-finite numbers and malformed advanced values", () => {
    expect(
      buildModelInferenceParams({
        inferenceDefaults: { temperature: Number.NaN, maxTokens: 100, topP: Infinity },
        advancedParams: { topK: "big", seed: 3, stopSequences: "nope" },
      })
    ).toEqual({ maxOutputTokens: 100, seed: 3 })
  })

  it("keeps temperature 0 (a meaningful value, not a missing one)", () => {
    expect(buildModelInferenceParams({ inferenceDefaults: { temperature: 0 } })).toEqual({
      temperature: 0,
    })
  })

  it("ignores an empty stopSequences array", () => {
    expect(buildModelInferenceParams({ advancedParams: { stopSequences: [] } })).toBeUndefined()
  })
})
