import {
  abortableStreamModel,
  drainRejectionReports,
  simulateWebviewRuntime,
  truncatedStreamModel,
} from "@/lib/ai/webview-stream-fixtures"
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
          usage: Promise.resolve({
            inputTokens: 10,
            outputTokens: 5,
            // v7: the top-level `reasoningTokens` mirror is gone.
            outputTokenDetails: { reasoningTokens: 2 },
          }),
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

  // The REAL `streamText` on the webview runtime the provider settings UI runs
  // in. A failed or cancelled probe must not leak the SDK's tracing
  // `completion` promise as an unhandled rejection (see
  // `webview-safe-telemetry.ts`).
  describe("with the real AI SDK stream (webview runtime)", () => {
    let restoreRuntime: () => void
    beforeEach(() => {
      restoreRuntime = simulateWebviewRuntime()
    })
    afterEach(() => restoreRuntime())

    it("measures a stream cut off mid-response without leaking an unhandled rejection", async () => {
      // The SDK's default `onError` logs the stream error.
      const consoleError = jest.spyOn(console, "error").mockImplementation(() => {})

      const result = await runProviderTextBenchmark({
        model: truncatedStreamModel(),
        maxOutputTokens: 64,
      })
      await drainRejectionReports()

      expect(result.metrics).not.toHaveProperty("ttftMs")
      expect(result.metrics.usageEstimated).toBe(true)
      expect(consoleError).toHaveBeenCalled()
      consoleError.mockRestore()
    })

    it("stops on a mid-stream cancel without leaking an unhandled rejection", async () => {
      const abort = new AbortController()
      // The benchmark reads the clock as each chunk lands; cancel right after
      // the first one (the second reading, after the start time).
      let readings = 0
      const now = () => {
        readings += 1
        if (readings === 2) abort.abort()
        return readings * 10
      }

      const result = await runProviderTextBenchmark(
        { model: abortableStreamModel(), maxOutputTokens: 64, signal: abort.signal },
        { now }
      )
      await drainRejectionReports()

      expect(abort.signal.aborted).toBe(true)
      expect(result.metrics.ttftMs).toBe(10)
      expect(result.metrics.usageEstimated).toBe(true)
    })
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
