/** @jest-environment node */
import {
  validateBenchmarkSample,
  validateBenchmarkCall,
  validateBenchmarkTrial,
} from "./multiagentbench-validation"

const sample = () => ({
  output: "proposal",
  toolCalls: [],
  retrievedChunks: [],
  usage: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 1, cacheCreationTokens: 0 },
  costUsd: 0,
  latencyMs: 1,
  stepCount: 1,
  degraded: false,
  metricAvailability: { usage: "known" },
})

it.each([-1, NaN, Infinity, "12", null, undefined])(
  "refuses invalid recovered token counts: %p",
  (value) => {
    expect(() =>
      validateBenchmarkSample({ ...sample(), usage: { ...sample().usage, inputTokens: value } })
    ).toThrow()
  }
)
it.each(["usage", "toolCalls", "retrievedChunks", "latencyMs", "stepCount", "degraded"])(
  "requires projection field %s",
  (key) => {
    const value: Record<string, unknown> = sample()
    delete value[key]
    expect(() => validateBenchmarkSample(value)).toThrow()
  }
)
it("preserves valid partial accounting and rejects phase-incompatible identities", () => {
  expect(() =>
    validateBenchmarkSample({ ...sample(), metricAvailability: { usage: "partial" } })
  ).not.toThrow()
  expect(() =>
    validateBenchmarkCall({
      state: "admitted",
      phase: "judge",
      callId: "c",
      judgmentKind: "research",
    })
  ).not.toThrow()
  expect(() =>
    validateBenchmarkCall({
      state: "admitted",
      phase: "judge",
      callId: "c",
      judgmentKind: "research",
      agentId: "a",
    })
  ).toThrow()
  expect(() => validateBenchmarkCall({ state: "admitted", phase: "solver", callId: "c" })).toThrow()
  expect(() =>
    validateBenchmarkCall({
      state: "admitted",
      phase: "solver",
      callId: "c",
      agentId: "a",
      taskId: "t",
      sample: sample(),
    })
  ).toThrow()
})
it("rejects incomplete trials before projection", () => {
  expect(() =>
    validateBenchmarkTrial({ taskId: "1", variant: "single-agent", repetition: 1 })
  ).toThrow()
})
