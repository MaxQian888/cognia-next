import { createWorkflowTarget } from "./workflow"
import type { AgentTraceSpan } from "@/types/agent-trace/span"
import type { EvalCase } from "@/types/eval/eval"

function span(over: Partial<AgentTraceSpan>): AgentTraceSpan {
  return {
    id: "s",
    traceId: "t",
    sessionId: "x",
    operationName: "chat",
    startTime: 1,
    surface: "workflow",
    providerName: "cognia.workflow",
    ...over,
  } as AgentTraceSpan
}

function caseRow(over: Partial<EvalCase>): EvalCase {
  return {
    id: "c1",
    datasetId: "d",
    input: "go",
    capability: "workflow",
    source: "handwritten",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

describe("createWorkflowTarget", () => {
  it("passes inputVars as the trigger payload and stringifies object output", async () => {
    const runWorkflow = jest.fn(
      async (input: { workflowId: string; payload: Record<string, unknown>; traceId: string }) => ({
        runId: "r",
        status: "succeeded",
        output: { result: 42 } as unknown,
        traceId: input.traceId,
      })
    )
    const target = createWorkflowTarget(
      { label: "wf-x", workflowId: "wf1" },
      { runWorkflow, fetchSpansByTrace: async () => [span({})] }
    )
    const sample = await target.run(caseRow({ inputVars: { a: 1 } }))
    expect(runWorkflow.mock.calls[0][0].payload).toEqual({ a: 1 })
    expect(sample.output).toBe('{"result":42}')
    expect(sample.degraded).toBe(false)
  })

  it("falls back to { input } when no inputVars and keeps string output", async () => {
    const runWorkflow = jest.fn(
      async (input: { workflowId: string; payload: Record<string, unknown>; traceId: string }) => ({
        runId: "r",
        status: "succeeded",
        output: "plain text" as unknown,
        traceId: input.traceId,
      })
    )
    const target = createWorkflowTarget(
      { label: "wf", workflowId: "wf1" },
      { runWorkflow, fetchSpansByTrace: async () => [] }
    )
    const sample = await target.run(caseRow({ input: "hello" }))
    expect(runWorkflow.mock.calls[0][0].payload).toEqual({ input: "hello" })
    expect(sample.output).toBe("plain text")
  })

  it("threads timeoutMs + abort signal and treats undefined output as empty", async () => {
    const runWorkflow = jest.fn(
      async (input: {
        workflowId: string
        payload: Record<string, unknown>
        traceId: string
        timeoutMs?: number
        signal?: AbortSignal
      }) => ({
        runId: "r",
        status: "succeeded",
        output: undefined as unknown,
        traceId: input.traceId,
      })
    )
    const target = createWorkflowTarget(
      { label: "wf", workflowId: "wf1", timeoutMs: 4000 },
      { runWorkflow, fetchSpansByTrace: async () => [] }
    )
    const ac = new AbortController()
    const sample = await target.run(caseRow({ input: "hello" }), ac.signal)
    expect(runWorkflow.mock.calls[0][0].timeoutMs).toBe(4000)
    expect(runWorkflow.mock.calls[0][0].signal).toBe(ac.signal)
    expect(sample.output).toBe("")
  })
})
