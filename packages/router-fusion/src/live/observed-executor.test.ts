import type { RoleCallExecutor, RoleCallRequest, RoleCallResponse } from "../workflows/ports"
import { observeExecutor } from "./observed-executor"

function request(overrides: Partial<RoleCallRequest> = {}): RoleCallRequest {
  return {
    runId: "run-1",
    logicalStepId: "direct:solver",
    attemptId: "attempt-1",
    role: "solver",
    deploymentId: "openai::gpt-4o",
    messages: [{ role: "user", content: "hi" }],
    maxOutputTokens: 16,
    toolPolicyId: null,
    ...overrides,
  }
}

function clock(...times: number[]): () => number {
  let index = 0
  return () => times[Math.min(index++, times.length - 1)]
}

describe("observeExecutor", () => {
  it("passes a successful call through unchanged and records its request id, usage and latency", async () => {
    const response: RoleCallResponse = {
      outcome: "ok",
      text: "answer",
      usage: { inputTokens: 10, outputTokens: 2 },
      semantics: {
        inputIncludesCacheRead: true,
        inputIncludesCacheWrite: false,
        outputIncludesReasoning: true,
      },
      providerRequestId: "req_1",
      finishReason: "stop",
    }
    const inner: RoleCallExecutor = { call: jest.fn(async () => response) }
    const observed = observeExecutor(inner, clock(100, 145))
    const signal = new AbortController().signal
    await expect(observed.executor.call(request(), signal)).resolves.toBe(response)
    expect(inner.call).toHaveBeenCalledWith(request(), signal)
    expect(observed.calls).toEqual([
      {
        runId: "run-1",
        logicalStepId: "direct:solver",
        attemptId: "attempt-1",
        role: "solver",
        deploymentId: "openai::gpt-4o",
        startedAt: 100,
        latencyMs: 45,
        outcome: "ok",
        errorClass: null,
        retryAfterMs: null,
        providerRequestId: "req_1",
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 2 },
      },
    ])
  })

  it("records a provider error with its retry-after hint", async () => {
    const inner: RoleCallExecutor = {
      call: async () => ({
        outcome: "error",
        errorClass: "rate_limited",
        message: "429",
        retryAfterMs: 1_500,
        providerRequestId: "req_2",
      }),
    }
    const observed = observeExecutor(inner, clock(0, 7))
    await observed.executor.call(request({ attemptId: "attempt-2" }), new AbortController().signal)
    expect(observed.calls[0]).toMatchObject({
      attemptId: "attempt-2",
      outcome: "error",
      errorClass: "rate_limited",
      retryAfterMs: 1_500,
      providerRequestId: "req_2",
      usage: null,
      latencyMs: 7,
    })
  })

  it("records a call that threw and rethrows it", async () => {
    const boom = new TypeError("adapter crashed")
    const observed = observeExecutor(
      {
        call: async () => {
          throw boom
        },
      },
      clock(0, 1)
    )
    await expect(observed.executor.call(request(), new AbortController().signal)).rejects.toBe(boom)
    expect(observed.calls[0]).toMatchObject({ outcome: "threw", errorClass: "TypeError" })
  })
})
