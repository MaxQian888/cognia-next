import { buildModelInferenceParams } from "./inference-params"

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
