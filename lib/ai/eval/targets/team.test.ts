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
  it("runs the team with a fresh trace id and assembles a sample from trace spans", async () => {
    const runTeam = jest.fn(async ({ traceId }: { traceId: string }) => ({
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
    const sample = await target.run(evalCase)
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
