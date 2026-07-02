const mockExecuteAgent = jest.fn()
jest.mock("@/lib/ai/agent/agent-executor", () => ({
  executeAgent: (...a: unknown[]) => mockExecuteAgent(...(a as [])),
}))
jest.mock("@/lib/db/settings", () => ({
  getSettings: jest.fn(async () => ({
    defaultProvider: "openai",
    providerSettings: {},
    customProviders: [],
  })),
}))
const mockCouncilRunPrompt = jest.fn(async () => ({ completion: "merged-by-council" }))
jest.mock("@/lib/ai/council/run-council", () => ({
  defaultCouncilRunPrompt: jest.fn(async () => mockCouncilRunPrompt),
}))
const mockGetWorkflow = jest.fn()
jest.mock("@/lib/db/workflows", () => ({
  getWorkflow: (...a: unknown[]) => mockGetWorkflow(...(a as [])),
}))
const mockRunWorkflow = jest.fn()
jest.mock("@/lib/workflow/runtime/orchestrator", () => ({
  runWorkflow: (...a: unknown[]) => mockRunWorkflow(...(a as [])),
}))

import { executeAiEnsemble, defaultAiEnsembleDeps, type AiEnsembleDeps } from "./ai-ensemble"
import type { StepExecutionContext } from "@/types/workflow/visual"

function makeCtx(params: Record<string, unknown>): StepExecutionContext {
  return {
    runId: "run1",
    workflowId: "wf1",
    stepId: "n1",
    params,
    upstream: {},
    trigger: { workflowId: "wf1", kind: "trigger.manual", payload: {}, originAt: 0 },
    signal: new AbortController().signal,
    log: jest.fn(),
    resolveSecret: async () => undefined,
  } as StepExecutionContext
}

function makeDeps(over: Partial<AiEnsembleDeps> = {}): AiEnsembleDeps {
  return {
    runAgent: jest.fn(async () => ({ object: { verdict: "yes" } })),
    runSubworkflow: jest.fn(async () => ({ object: { ok: true } })),
    runPrompt: jest.fn(async () => ({ completion: "merged" })),
    ...over,
  }
}

describe("executeAiEnsemble", () => {
  it("rejects n < 1", async () => {
    const deps = makeDeps()
    await expect(
      executeAiEnsemble(
        makeCtx({ prompt: "go", n: 0, aggregation: { kind: "majority-vote-on-field" } }),
        async () => deps
      )
    ).rejects.toThrow(/'n' must be/)
  })

  it("rejects a missing aggregation policy", async () => {
    await expect(
      executeAiEnsemble(makeCtx({ prompt: "go", n: 3 }), async () => makeDeps())
    ).rejects.toThrow(/aggregation/)
  })

  it("rejects an empty prompt for an agent.turn target", async () => {
    await expect(
      executeAiEnsemble(
        makeCtx({ prompt: "  ", n: 3, aggregation: { kind: "majority-vote-on-field" } }),
        async () => makeDeps()
      )
    ).rejects.toThrow(/non-empty 'prompt'/)
  })

  it("runs the agent target N times and votes on a field", async () => {
    const runAgent = jest
      .fn()
      .mockResolvedValueOnce({ object: { v: "a" } })
      .mockResolvedValueOnce({ object: { v: "b" } })
      .mockResolvedValueOnce({ object: { v: "a" } })
    const deps = makeDeps({ runAgent })
    const result = await executeAiEnsemble(
      makeCtx({
        prompt: "judge",
        n: 3,
        target: {
          kind: "agent.turn",
          outputSchema: { type: "object", properties: { v: { type: "string" } } },
        },
        aggregation: { kind: "majority-vote-on-field", field: "v" },
      }),
      async () => deps
    )
    const out = result.output as { result: unknown; samples: unknown[] }
    expect(runAgent).toHaveBeenCalledTimes(3)
    expect(out.result).toEqual({ value: "a", count: 2, total: 3 })
    expect(out.samples).toHaveLength(3)
  })

  it("applies a lens by prepending it to each sample prompt", async () => {
    const runAgent = jest.fn(async (_input: Parameters<AiEnsembleDeps["runAgent"]>[0]) => ({
      object: { v: "x" },
    }))
    await executeAiEnsemble(
      makeCtx({
        prompt: "claim",
        n: 2,
        lens: ["FOR", "AGAINST"],
        aggregation: { kind: "majority-vote-on-field", field: "v" },
      }),
      async () => makeDeps({ runAgent })
    )
    expect(runAgent.mock.calls[0][0].prompt).toMatch(/^FOR/)
    expect(runAgent.mock.calls[1][0].prompt).toMatch(/^AGAINST/)
  })

  it("runs a subworkflow target with the prompt in the payload", async () => {
    const runSubworkflow = jest.fn(
      async (_input: Parameters<AiEnsembleDeps["runSubworkflow"]>[0]) => ({ object: { score: 5 } })
    )
    const result = await executeAiEnsemble(
      makeCtx({
        prompt: "task",
        n: 2,
        target: { kind: "subworkflow", workflowId: "wf_child" },
        aggregation: { kind: "best-of-by-score", scoreField: "score" },
      }),
      async () => makeDeps({ runSubworkflow })
    )
    expect(runSubworkflow).toHaveBeenCalledTimes(2)
    expect(runSubworkflow.mock.calls[0][0].workflowId).toBe("wf_child")
    expect(runSubworkflow.mock.calls[0][0].payload.prompt).toBe("task")
    const out = result.output as { result: { score: number } }
    expect(out.result.score).toBe(5)
  })

  it("rejects a subworkflow target with no workflowId", async () => {
    await expect(
      executeAiEnsemble(
        makeCtx({
          prompt: "x",
          n: 2,
          target: { kind: "subworkflow" },
          aggregation: { kind: "majority-vote-on-field" },
        }),
        async () => makeDeps()
      )
    ).rejects.toThrow(/workflowId/)
  })

  it("synthesize policy requires a synthesizerAlias", async () => {
    await expect(
      executeAiEnsemble(
        makeCtx({ prompt: "x", n: 2, aggregation: { kind: "synthesize-by-final-agent" } }),
        async () => makeDeps()
      )
    ).rejects.toThrow(/synthesizerAlias/)
  })

  it("synthesizes via runPrompt when configured", async () => {
    const runPrompt = jest.fn(async () => ({ completion: "the merged answer" }))
    const result = await executeAiEnsemble(
      makeCtx({
        prompt: "x",
        n: 2,
        synthesizerAlias: "quality",
        aggregation: { kind: "synthesize-by-final-agent" },
      }),
      async () => makeDeps({ runAgent: jest.fn(async () => ({ text: "draft" })), runPrompt })
    )
    expect(runPrompt).toHaveBeenCalledWith(expect.objectContaining({ modelAlias: "quality" }))
    expect((result.output as { result: unknown }).result).toBe("the merged answer")
  })

  it("redacts the prompt and flags piiRedacted", async () => {
    const runAgent = jest.fn(async (_input: Parameters<AiEnsembleDeps["runAgent"]>[0]) => ({
      object: { v: "x" },
    }))
    const result = await executeAiEnsemble(
      makeCtx({
        prompt: "email me at alice@example.com",
        n: 1,
        piiGate: "redact",
        aggregation: { kind: "majority-vote-on-field", field: "v" },
      }),
      async () => makeDeps({ runAgent })
    )
    expect((result.output as { piiRedacted?: boolean }).piiRedacted).toBe(true)
    expect(runAgent.mock.calls[0][0].prompt).not.toMatch(/alice@example\.com/)
  })
})

describe("defaultAiEnsembleDeps", () => {
  beforeEach(() => {
    mockExecuteAgent.mockReset()
    mockGetWorkflow.mockReset()
    mockRunWorkflow.mockReset()
  })

  it("runAgent without a schema returns the completion text", async () => {
    mockExecuteAgent.mockResolvedValue({ text: "plain answer" })
    const deps = await defaultAiEnsembleDeps()
    expect(await deps.runAgent({ prompt: "go" })).toEqual({ text: "plain answer" })
  })

  it("runAgent with a schema returns the validated object", async () => {
    mockExecuteAgent.mockResolvedValue({ text: "{}", object: { v: "a" } })
    const deps = await defaultAiEnsembleDeps()
    const r = await deps.runAgent({
      prompt: "go",
      outputSchema: { type: "object", properties: { v: { type: "string" } }, required: ["v"] },
    })
    expect(r.object).toEqual({ v: "a" })
  })

  it("runSubworkflow runs the orchestrator and returns the output", async () => {
    mockGetWorkflow.mockResolvedValue({ id: "w" })
    mockRunWorkflow.mockResolvedValue({ status: "succeeded", output: { ok: true } })
    const deps = await defaultAiEnsembleDeps()
    expect(await deps.runSubworkflow({ workflowId: "w", payload: {} })).toEqual({
      object: { ok: true },
    })
  })

  it("runSubworkflow throws when the target is missing", async () => {
    mockGetWorkflow.mockResolvedValue(undefined)
    const deps = await defaultAiEnsembleDeps()
    await expect(deps.runSubworkflow({ workflowId: "w", payload: {} })).rejects.toThrow(/not found/)
  })

  it("runSubworkflow throws when the run does not succeed", async () => {
    mockGetWorkflow.mockResolvedValue({ id: "w" })
    mockRunWorkflow.mockResolvedValue({ status: "failed" })
    const deps = await defaultAiEnsembleDeps()
    await expect(deps.runSubworkflow({ workflowId: "w", payload: {} })).rejects.toThrow(/failed/)
  })

  it("runPrompt delegates to the council runPrompt", async () => {
    const deps = await defaultAiEnsembleDeps()
    expect(await deps.runPrompt({ modelAlias: "q", userPrompt: "x" })).toEqual({
      completion: "merged-by-council",
    })
  })
})
