import type { ProviderDiagnosticSample } from "@cognia/provider-types"

import { summarizeProviderDiagnosticSamples } from "./statistics"

function sample(
  id: string,
  ttftMs: number | undefined,
  overrides: Partial<ProviderDiagnosticSample> = {}
): ProviderDiagnosticSample {
  return {
    id,
    jobId: "job-1",
    targetId: "openai:gpt-5:key-1:api.openai.com",
    providerId: "openai",
    modelId: "gpt-5",
    credentialFingerprint: "credential:key-1",
    endpoint: "https://api.openai.com/v1",
    capability: "text-generation",
    promptVersion: "provider-diagnostics-text-v1",
    sampleRole: "measured",
    status: "completed",
    startedAt: 1_000,
    completedAt: 2_000,
    metrics: ttftMs === undefined ? undefined : { ttftMs, totalDurationMs: 1_000 },
    ...overrides,
  }
}

describe("summarizeProviderDiagnosticSamples", () => {
  it("excludes warm-ups and reports measured median, bounds, and failures", () => {
    const summary = summarizeProviderDiagnosticSamples([
      sample("warmup", 900, { sampleRole: "warmup" }),
      sample("a", 100),
      sample("b", 300),
      sample("c", 200),
      sample("failed", undefined, {
        status: "failed",
        failure: { code: "timeout", retryable: true, message: "timed out" },
      }),
    ])

    expect(summary).toEqual({
      measuredSamples: 4,
      successfulSamples: 3,
      failedSamples: 1,
      ttftMs: { median: 200, min: 100, max: 300 },
      totalDurationMs: { median: 1_000, min: 1_000, max: 1_000 },
    })
  })

  it("does not claim P95 until twenty comparable successful samples exist", () => {
    const nineteen = Array.from({ length: 19 }, (_, index) => sample(String(index), index + 1))
    expect(summarizeProviderDiagnosticSamples(nineteen).ttftMs?.p95).toBeUndefined()

    const twenty = [...nineteen, sample("19", 20)]
    expect(summarizeProviderDiagnosticSamples(twenty).ttftMs?.p95).toBe(19)
  })

  it("rejects samples from another target or prompt version", () => {
    expect(() =>
      summarizeProviderDiagnosticSamples([
        sample("a", 100),
        sample("b", 200, { promptVersion: "provider-diagnostics-text-v2" }),
      ])
    ).toThrow("comparable target")
  })
})
