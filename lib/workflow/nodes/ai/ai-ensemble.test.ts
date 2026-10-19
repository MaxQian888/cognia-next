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
const mockDefaultCouncilRunPrompt = jest.fn(async (_ledger: unknown) => mockCouncilRunPrompt)
jest.mock("@/lib/ai/council/run-council", () => ({
  defaultCouncilRunPrompt: (ledger: unknown) => mockDefaultCouncilRunPrompt(ledger),
}))
const mockExecuteDeployedWorkflow = jest.fn()
jest.mock("@/lib/workflow/runtime/execution-authority", () => ({
  executeDeployedWorkflow: (...a: unknown[]) => mockExecuteDeployedWorkflow(...(a as [])),
}))

import {
  ENSEMBLE_SYNTHESIZER_PROMPT,
  ENSEMBLE_SYNTHESIZER_REQUEST_PROMPT,
  executeAiEnsemble,
  defaultAiEnsembleDeps,
  type AiEnsembleDeps,
} from "./ai-ensemble"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"
import { __resetPromptVerdictsForTests } from "@/lib/prompts/resolve"
import type { StepExecutionContext } from "@/types/workflow/visual"

function makeCtx(params: Record<string, unknown>): StepExecutionContext {
  return {
    runId: "run1",
    traceId: "trace-1",
    lineage: { rootRunId: "root-1" },
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
    expect(runSubworkflow.mock.calls[0][0]).toMatchObject({
      traceId: "trace-1",
      lineage: { rootRunId: "root-1", parentRunId: "run1", parentStepId: "n1" },
    })
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

  it("sends the shipped synthesizer prompt followed by the node's own guidance", async () => {
    const runPrompt = jest.fn(async (_input: { systemPrompt?: string; userPrompt?: string }) => ({
      completion: "m",
    }))
    await executeAiEnsemble(
      makeCtx({
        prompt: "x",
        n: 2,
        synthesizerAlias: "quality",
        aggregation: { kind: "synthesize-by-final-agent", instructions: "Prefer brevity." },
      }),
      async () => makeDeps({ runAgent: jest.fn(async () => ({ text: "draft" })), runPrompt })
    )
    expect(runPrompt.mock.calls[0][0].systemPrompt).toBe(
      "You are an ensemble synthesizer. The same task was attempted several times " +
        "(each attempt is labeled). Merge them into one best answer: integrate the strongest points, resolve " +
        "disagreements with explicit reasoning, and give a single clear final answer." +
        "\n\nAdditional guidance:\nPrefer brevity."
    )
    expect(runPrompt.mock.calls[0][0].userPrompt).toBe(
      "Merge the following attempts into one best answer.\n\n### Attempt 1\ndraft\n\n### Attempt 2\ndraft"
    )
  })

  describe("synthesizer Prompt Center override (ADR-0236)", () => {
    afterEach(() => {
      __setPromptOverrideSnapshotForTests(null)
      __resetPromptVerdictsForTests()
    })

    it("uses the run's workspace override as the base and keeps the node guidance", async () => {
      __setPromptOverrideSnapshotForTests(
        buildPromptOverrideSnapshot("test-db", [
          {
            bindingId: "pob-synth",
            promptId: ENSEMBLE_SYNTHESIZER_PROMPT.id,
            scope: "workspace",
            targetId: "ws-1",
            revisionId: "por-ensemble-synth",
            body: "Merge the attempts; cite which attempt each point came from.",
            contractVersion: ENSEMBLE_SYNTHESIZER_PROMPT.contractVersion,
          },
          {
            bindingId: "pob-synth-request",
            promptId: ENSEMBLE_SYNTHESIZER_REQUEST_PROMPT.id,
            scope: "account",
            targetId: "",
            revisionId: "por-ensemble-synth-request",
            body: "Attempts:\n{{attempts}}",
            contractVersion: ENSEMBLE_SYNTHESIZER_REQUEST_PROMPT.contractVersion,
          },
        ])
      )
      const runPrompt = jest.fn(async (_input: { systemPrompt?: string; userPrompt?: string }) => ({
        completion: "m",
      }))
      await executeAiEnsemble(
        {
          ...makeCtx({
            prompt: "x",
            n: 2,
            synthesizerAlias: "quality",
            aggregation: { kind: "synthesize-by-final-agent", instructions: "Prefer brevity." },
          }),
          projectId: "ws-1",
        },
        async () => makeDeps({ runAgent: jest.fn(async () => ({ text: "draft" })), runPrompt })
      )
      expect(runPrompt.mock.calls[0][0].systemPrompt).toBe(
        "Merge the attempts; cite which attempt each point came from.\n\nAdditional guidance:\nPrefer brevity."
      )
      expect(runPrompt.mock.calls[0][0].userPrompt).toBe(
        "Attempts:\n### Attempt 1\ndraft\n\n### Attempt 2\ndraft"
      )
    })
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
    mockExecuteDeployedWorkflow.mockReset()
  })

  it("runAgent without a schema returns the completion text", async () => {
    mockExecuteAgent.mockResolvedValue({ text: "plain answer" })
    const deps = await defaultAiEnsembleDeps(makeCtx({}))
    expect(await deps.runAgent({ prompt: "go" })).toEqual({ text: "plain answer" })
  })

  it("runAgent with a schema returns the validated object", async () => {
    mockExecuteAgent.mockResolvedValue({ text: "{}", object: { v: "a" } })
    const deps = await defaultAiEnsembleDeps(makeCtx({}))
    const r = await deps.runAgent({
      prompt: "go",
      outputSchema: { type: "object", properties: { v: { type: "string" } }, required: ["v"] },
    })
    expect(r.object).toEqual({ v: "a" })
  })

  it("runSubworkflow runs the orchestrator and returns the output", async () => {
    mockExecuteDeployedWorkflow.mockResolvedValue({
      result: { status: "succeeded", output: { ok: true } },
    })
    const deps = await defaultAiEnsembleDeps(makeCtx({}))
    expect(await deps.runSubworkflow({ workflowId: "w", payload: {} })).toEqual({
      object: { ok: true },
    })
  })

  it("runSubworkflow throws when the target is missing", async () => {
    mockExecuteDeployedWorkflow.mockRejectedValue(new Error("workflow w not found"))
    const deps = await defaultAiEnsembleDeps(makeCtx({}))
    await expect(deps.runSubworkflow({ workflowId: "w", payload: {} })).rejects.toThrow(/not found/)
  })

  it("runSubworkflow throws when the run does not succeed", async () => {
    mockExecuteDeployedWorkflow.mockResolvedValue({ result: { status: "failed" } })
    const deps = await defaultAiEnsembleDeps(makeCtx({}))
    await expect(deps.runSubworkflow({ workflowId: "w", payload: {} })).rejects.toThrow(/failed/)
  })

  it("ledgers every sample and synthesizer call as this step's agentsWorkflows work", async () => {
    mockExecuteAgent.mockResolvedValue({ text: "plain answer" })
    const ctx = { ...makeCtx({}), projectId: "ws-3" }
    const deps = await defaultAiEnsembleDeps(ctx)
    await deps.runAgent({ prompt: "go" })
    expect(mockExecuteAgent).toHaveBeenCalledWith(
      "go",
      expect.objectContaining({
        ledger: { featureId: "workflow:n1", origin: "workflow", workspaceId: "ws-3" },
      })
    )
    expect(mockDefaultCouncilRunPrompt).toHaveBeenCalledWith({
      surface: "agentsWorkflows",
      origin: "workflow",
      featureId: "workflow:n1",
      workspaceId: "ws-3",
    })
  })

  it("runPrompt delegates to the council runPrompt", async () => {
    const deps = await defaultAiEnsembleDeps(makeCtx({}))
    expect(await deps.runPrompt({ modelAlias: "q", userPrompt: "x" })).toEqual({
      completion: "merged-by-council",
    })
  })
})
