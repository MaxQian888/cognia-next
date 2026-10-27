import { createTeamTarget } from "./team"
import type { AgentTraceSpan } from "@/types/agent-trace/span"
import type { EvalCase } from "@/types/eval/eval"

function span(over: Partial<AgentTraceSpan>): AgentTraceSpan {
  return {
    id: "s",
    traceId: "t",
    sessionId: "x",
    operationName: "invoke_agent",
    startTime: 1,
    surface: "agent-team",
    providerName: "cognia.team",
    ...over,
  } as AgentTraceSpan
}

const evalCase: EvalCase = {
  id: "c1",
  datasetId: "d",
  input: "go",
  capability: "team",
  source: "handwritten",
  createdAt: 0,
  updatedAt: 0,
}

describe("createTeamTarget", () => {
  it.each(["failed", "cancelled"])(
    "preserves a %s lifecycle outcome even with a matching answer",
    async (status) => {
      const target = createTeamTarget(
        { label: "t", teamId: "tm1" },
        {
          runTeam: async ({ traceId }) => ({ runId: "r", status, text: "success marker", traceId }),
          fetchSpansByTrace: async () => [],
          isToolCapable: () => true,
        }
      )
      const sample = await target.run(evalCase)
      expect(sample.executionStatus).toBe(status)
      expect(sample.error).toMatch(new RegExp(status))
    }
  )

  it("passes the same history and text parts as the Chat target", async () => {
    const runTeam = jest.fn(async ({ traceId }: { traceId: string }) => ({
      runId: "r",
      status: "completed",
      text: "done",
      traceId,
    }))
    const target = createTeamTarget(
      { label: "t", teamId: "tm1" },
      {
        runTeam,
        fetchSpansByTrace: async () => [],
        isToolCapable: () => true,
      }
    )
    await target.run({
      ...evalCase,
      input: "legacy",
      history: [{ role: "user", content: "Earlier context" }],
      contentParts: [
        { type: "text", text: "Part one" },
        { type: "text", text: "Part two" },
      ],
    })
    expect(runTeam).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "USER: Earlier context\n\nPart one\nPart two" })
    )
  })

  it("refuses unsupported assets before any model work", async () => {
    const runTeam = jest.fn()
    const target = createTeamTarget(
      { label: "t", teamId: "tm1" },
      {
        runTeam,
        fetchSpansByTrace: async () => [],
        isToolCapable: () => true,
      }
    )
    const sample = await target.run({
      ...evalCase,
      contentParts: [
        { type: "asset", assetId: "image", mediaType: "image/png", privacy: "scanned" },
      ],
    })
    expect(runTeam).not.toHaveBeenCalled()
    expect(sample.executionStatus).toBe("blocked")
    expect(sample.error).toMatch(/asset/i)
  })

  it("enforces the evaluation deadline and aborts the dispatched run", async () => {
    jest.useFakeTimers()
    let dispatchedSignal: AbortSignal | undefined
    try {
      const target = createTeamTarget(
        { label: "t", teamId: "tm1", timeoutMs: 25 },
        {
          runTeam: ({ signal }) => {
            dispatchedSignal = signal
            return new Promise(() => {})
          },
          fetchSpansByTrace: async () => [],
          isToolCapable: () => true,
        }
      )
      const run = target.run(evalCase)
      await jest.advanceTimersByTimeAsync(25)
      const sample = await run
      expect(dispatchedSignal?.aborted).toBe(true)
      expect(sample.executionStatus).toBe("timed_out")
      expect(sample.error).toMatch(/deadline|timed out/i)
      expect(sample.latencyMs).toBe(25)
    } finally {
      jest.useRealTimers()
    }
  })

  it("retains already-settled call accounting when a later call exceeds the deadline", async () => {
    jest.useFakeTimers()
    try {
      const target = createTeamTarget(
        { label: "t", teamId: "tm1", timeoutMs: 25 },
        {
          runTeam: ({ onSpan }) => {
            onSpan?.(
              span({
                id: "settled-call",
                spanId: "settled-call",
                usage: {
                  inputTokens: 7,
                  outputTokens: 2,
                  cacheReadTokens: 0,
                  cacheCreationTokens: 0,
                },
                costUsdEstimate: 0.01,
              })
            )
            return new Promise(() => {})
          },
          fetchSpansByTrace: async () => [],
          isToolCapable: () => false,
        }
      )
      const pending = target.run(evalCase)
      await jest.advanceTimersByTimeAsync(25)
      const sample = await pending
      expect(sample.executionStatus).toBe("timed_out")
      expect(sample.costUsd).toBe(0.01)
      expect(sample.usage.inputTokens).toBe(7)
      expect(sample.metricAvailability?.cost).toBe("partial")
    } finally {
      jest.useRealTimers()
    }
  })

  it("uses run-owned captured spans instead of racing the persisted trace query", async () => {
    const fetchSpansByTrace = jest.fn(async () => [])
    const target = createTeamTarget(
      { label: "t", teamId: "tm1" },
      {
        runTeam: async ({ traceId }) => ({
          runId: "r",
          status: "completed",
          text: "done",
          traceId,
          spans: [
            span({
              usage: {
                inputTokens: 17,
                outputTokens: 3,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
              },
              costUsdEstimate: 0.02,
            }),
          ],
        }),
        fetchSpansByTrace,
        isToolCapable: () => true,
      }
    )
    const sample = await target.run(evalCase)
    expect(sample.usage.inputTokens).toBe(17)
    expect(sample.costUsd).toBe(0.02)
    expect(fetchSpansByTrace).not.toHaveBeenCalled()
  })
  it("runs the team with a fresh trace id and assembles a sample from trace spans", async () => {
    const runTeam = jest.fn(async ({ traceId }: { traceId: string; signal?: AbortSignal }) => ({
      runId: "r",
      status: "completed",
      text: "done",
      traceId,
    }))
    const fetchSpansByTrace = jest.fn(async () => [
      span({
        usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 },
        costUsdEstimate: 0.01,
      }),
    ])
    const target = createTeamTarget(
      { label: "team-x", teamId: "tm1" },
      { runTeam, fetchSpansByTrace, isToolCapable: () => true }
    )
    const ac = new AbortController()
    const sample = await target.run(evalCase, ac.signal)
    expect(runTeam.mock.calls[0][0].signal).toBe(ac.signal)
    expect(sample.output).toBe("done")
    expect(sample.usage.inputTokens).toBe(5)
    expect(sample.costUsd).toBeCloseTo(0.01)
    expect(sample.degraded).toBe(false)
    // run + fetch share the same generated trace id
    const usedTrace = runTeam.mock.calls[0][0].traceId
    expect(fetchSpansByTrace).toHaveBeenCalledWith(usedTrace)
    expect(usedTrace).toMatch(/^evtrace_/)
  })

  it("marks the sample degraded when tools are unavailable", async () => {
    const target = createTeamTarget(
      { label: "t", teamId: "tm1", timeoutMs: 1000 },
      {
        runTeam: async ({ traceId }) => ({ runId: "r", status: "completed", text: "x", traceId }),
        fetchSpansByTrace: async () => [],
        isToolCapable: () => false,
      }
    )
    const sample = await target.run(evalCase)
    expect(sample.degraded).toBe(true)
  })
})
