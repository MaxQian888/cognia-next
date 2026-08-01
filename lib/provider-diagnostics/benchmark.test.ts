import {
  runProviderEmbeddingBenchmark,
  runProviderTextBenchmark,
  PROVIDER_DIAGNOSTIC_EMBEDDING_PROMPT_VERSION,
  PROVIDER_DIAGNOSTIC_TEXT_PROMPT_VERSION,
} from "./benchmark"

async function* chunks(values: string[]) {
  for (const value of values) yield value
}

describe("runProviderTextBenchmark", () => {
  it("measures TTFT from the first non-empty content chunk and provider usage", async () => {
    const times = [1_000, 1_010, 1_050, 1_150, 1_250]
    const result = await runProviderTextBenchmark(
      {
        maxOutputTokens: 64,
        price: { inputPerMillionUsd: 1, outputPerMillionUsd: 2, version: "2026-08-01" },
      },
      {
        now: () => times.shift() ?? 1_250,
        streamTextImpl: () => ({
          textStream: chunks(["", "PONG", "!"]),
          usage: Promise.resolve({ inputTokens: 10, outputTokens: 5, reasoningTokens: 2 }),
        }),
      }
    )

    expect(result.promptVersion).toBe(PROVIDER_DIAGNOSTIC_TEXT_PROMPT_VERSION)
    expect(result.pricingVersion).toBe("2026-08-01")
    expect(result.metrics).toEqual({
      ttftMs: 50,
      totalDurationMs: 250,
      generationDurationMs: 200,
      outputTokensPerSecond: 25,
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 2,
      usageEstimated: false,
      estimatedCostUsd: 0.00002,
    })
  })

  it("labels tokenizer fallback usage as estimated", async () => {
    const result = await runProviderTextBenchmark(
      { maxOutputTokens: 64 },
      {
        now: (() => {
          let value = 0
          return () => (value += 100)
        })(),
        streamTextImpl: () => ({ textStream: chunks(["eight chars"]), usage: Promise.resolve({}) }),
      }
    )

    expect(result.metrics.outputTokens).toBe(3)
    expect(result.metrics.usageEstimated).toBe(true)
  })

  it("fails closed if the versioned diagnostic prompt trips the PII gate", async () => {
    await expect(
      runProviderTextBenchmark(
        { maxOutputTokens: 64 },
        {
          piiGate: () => false,
          streamTextImpl: () => ({ textStream: chunks([]), usage: Promise.resolve({}) }),
        }
      )
    ).rejects.toThrow("PII gate")
  })
})

describe("runProviderEmbeddingBenchmark", () => {
  it("measures a fixed batch without persisting vector contents", async () => {
    const times = [1_000, 1_400]
    const result = await runProviderEmbeddingBenchmark(
      {},
      {
        now: () => times.shift() ?? 1_400,
        embedManyImpl: async ({ values }) => ({
          embeddings: values.map(() => [0.1, 0.2, 0.3]),
          usage: { tokens: 24 },
        }),
      }
    )

    expect(result.promptVersion).toBe(PROVIDER_DIAGNOSTIC_EMBEDDING_PROMPT_VERSION)
    expect(result.metrics).toEqual({
      totalDurationMs: 400,
      inputTokens: 24,
      usageEstimated: false,
      embeddingBatchSize: 8,
      embeddingItemsPerSecond: 20,
      embeddingDimensions: 3,
    })
    expect(result).not.toHaveProperty("embeddings")
  })
})
