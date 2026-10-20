import { buildCodexModelCatalog } from "./codex-model-catalog"
import vendored from "./codex-catalog/codex-catalog.json"
import golden from "./codex-catalog/fixtures/catalog.json"

const request = {
  models: [{ slug: "unknown", inputModalities: ["text"], reasoningEfforts: ["low", "unlisted"] }],
}

describe("buildCodexModelCatalog", () => {
  it("accepts the model, slug, numeric and effort bounds", () => {
    const models = Array.from({ length: 32 }, (_, i) => ({
      slug: "😀".repeat(254) + String(i),
      contextWindow: 10000000,
      autoCompactTokenLimit: 1,
      inputModalities: ["text"],
      reasoningEfforts: Array.from({ length: 16 }, (_, effort) => `effort_${effort}`),
    }))
    const output = JSON.parse(
      buildCodexModelCatalog({ models }, { fallbackInstructions: "prompt", models: [] })
    )
    expect(output.models).toHaveLength(32)
    expect(output.models[31]).toMatchObject({
      slug: models[31].slug,
      context_window: 10000000,
      max_context_window: 10000000,
      auto_compact_token_limit: 1,
    })
    expect(output.models[31].supported_reasoning_levels).toHaveLength(16)
  })

  it("matches the shared golden fixture byte for byte", () => {
    expect(buildCodexModelCatalog(golden.request)).toBe(golden.expectedOutput)
  })
  it("uses Codex's fallback instructions and effort descriptions for exact unknown slugs", () => {
    const output = buildCodexModelCatalog(request)
    const model = JSON.parse(output).models[0]
    expect(model).toMatchObject({
      slug: "unknown",
      display_name: "unknown",
      model_messages: { instructions_template: vendored.fallbackInstructions },
      supported_in_api: true,
      multi_agent_version: null,
      context_window: 272000,
      max_context_window: 272000,
      input_modalities: ["text"],
      supported_reasoning_levels: [
        { effort: "low", description: expect.any(String) },
        { effort: "unlisted", description: "unlisted" },
      ],
    })
    const low = vendored.models
      .flatMap((m) => m.supported_reasoning_levels)
      .find((e) => e.effort === "low")!
    expect(model.supported_reasoning_levels[0]).toEqual(low)
    expect(model).not.toHaveProperty("used_fallback_model_metadata")
    expect(output).toBe(JSON.stringify(JSON.parse(output), null, 2) + "\n")
  })

  it("preserves bundled metadata and instructions without mutating the vendor", () => {
    const before = JSON.stringify(vendored)
    const bundled = vendored.models.find((m) => m.slug === "gpt-6-luna")!
    const make = (contextWindow: number) =>
      JSON.parse(
        buildCodexModelCatalog({
          models: [
            {
              slug: bundled.slug,
              contextWindow,
              autoCompactTokenLimit: 1234,
              inputModalities: ["text"],
              reasoningEfforts: ["unlisted"],
            },
          ],
        })
      ).models[0]
    const levels = [
      ...bundled.supported_reasoning_levels,
      { effort: "unlisted", description: "unlisted" },
    ]
    expect(make(100000)).toEqual({
      ...bundled,
      context_window: 100000,
      auto_compact_token_limit: 1234,
      supported_reasoning_levels: levels,
    })
    expect(make(1000000)).toEqual({
      ...bundled,
      context_window: 1000000,
      max_context_window: 1000000,
      auto_compact_token_limit: 1234,
      supported_reasoning_levels: levels,
    })
    expect(JSON.stringify(vendored)).toBe(before)
  })

  it("overrides fallback windows and treats slug matching as case sensitive", () => {
    const model = JSON.parse(
      buildCodexModelCatalog({
        models: [
          {
            slug: "GPT-6-LUNA",
            inputModalities: ["text", "image"],
            contextWindow: 64000,
            autoCompactTokenLimit: 60000,
          },
        ],
      })
    ).models[0]
    expect(model).toMatchObject({
      context_window: 64000,
      max_context_window: 64000,
      auto_compact_token_limit: 60000,
      supported_reasoning_levels: [],
      input_modalities: ["text", "image"],
    })
  })

  it.each([
    null,
    {},
    { models: [] },
    { models: Array(33).fill(request.models[0]) },
    { ...request, extra: true },
    { models: [request.models[0], request.models[0]] },
    ...["", "x".repeat(257), "a\nb", "a\u007fb", "a\u0085b"].map((slug) => ({
      models: [{ ...request.models[0], slug }],
    })),
    ...[0, -1, 1.5, 10000001, null, "10"].flatMap((value) =>
      ["contextWindow", "autoCompactTokenLimit"].map((key) => ({
        models: [{ ...request.models[0], [key]: value }],
      }))
    ),
    ...[[], ["audio"], null, "text"].map((inputModalities) => ({
      models: [{ ...request.models[0], inputModalities }],
    })),
    ...[["High"], ["a".repeat(33)], ["a b"], Array(17).fill("low"), null].map(
      (reasoningEfforts) => ({ models: [{ ...request.models[0], reasoningEfforts }] })
    ),
    { models: [{ ...request.models[0], extra: true }] },
  ])("rejects invalid requests %#", (invalid) => {
    expect(() => buildCodexModelCatalog(invalid)).toThrow("Invalid gateway task configuration")
  })
  it("adds the efforts the routed provider accepts to a bundled entry, after its own", () => {
    const bundled = vendored.models.find((model) => model.slug === "gpt-5.5")!
    const [entry] = JSON.parse(
      buildCodexModelCatalog({
        models: [
          { slug: "gpt-5.5", inputModalities: ["text"], reasoningEfforts: ["minimal", "high"] },
        ],
      })
    ).models
    expect(
      entry.supported_reasoning_levels.map(({ effort }: { effort: string }) => effort)
    ).toEqual([...bundled.supported_reasoning_levels.map(({ effort }) => effort), "minimal"])
    // Without efforts the bundled entry is unchanged.
    expect(
      JSON.parse(
        buildCodexModelCatalog({ models: [{ slug: "gpt-5.5", inputModalities: ["text"] }] })
      ).models[0]
    ).toEqual(bundled)
  })
})
