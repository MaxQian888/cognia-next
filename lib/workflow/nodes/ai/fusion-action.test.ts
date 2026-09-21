import type { AppSettings } from "@cognia/agent-config-types"
import { __resetFusionScopesForTesting } from "@/lib/router-fusion/gate/explicit-run"
import { paramsSchemaFor } from "@/lib/workflow/nodes/params-schemas"
import { workflowVersionDigest } from "@/lib/workflow/versioning/version-snapshot"
import type { StepExecutionContext } from "@/types/workflow/visual"

import { runAiPromptFusionAction } from "./fusion-action"

const ON = {
  routerFusion: { enabled: true, surfaces: { agentsWorkflows: true } },
} as unknown as AppSettings
const OFF = {
  routerFusion: { enabled: true, surfaces: { agentsWorkflows: false } },
} as unknown as AppSettings

const ANSWER = {
  kind: "answered" as const,
  runId: "run-node-1",
  mode: "panel" as const,
  text: "the checked answer",
  qualityStatus: "accepted" as const,
  usage: { promptTokens: 200, completionTokens: 60, totalTokens: 260 },
  spentMicrousd: 12_500,
  modelCalls: 3,
  warnings: [],
}

function loadHost(run: (input: Record<string, unknown>) => Promise<unknown>) {
  return async () => ({ runAgentsWorkflowsFusion: run }) as never
}

function ctx(
  params: Record<string, unknown>,
  overrides: Partial<StepExecutionContext> = {}
): StepExecutionContext {
  return {
    runId: "r1",
    workflowId: "w1",
    stepId: "s1",
    params,
    upstream: {},
    trigger: { workflowId: "w1", kind: "trigger.manual", payload: {}, originAt: 0 },
    signal: new AbortController().signal,
    log: () => {},
    resolveSecret: async () => undefined,
    ...overrides,
  } as StepExecutionContext
}

beforeEach(() => {
  __resetFusionScopesForTesting()
})

describe("runAiPromptFusionAction", () => {
  it("answers null for a node on auto, without reading settings", async () => {
    const settings = jest.fn()
    expect(await runAiPromptFusionAction(ctx({ userPrompt: "hi" }))).toBeNull()
    expect(settings).not.toHaveBeenCalled()
  })

  it("[ACC:OFF-AGENTS] answers null while the surface is off, so the node runs as before", async () => {
    const host = jest.fn()
    expect(
      await runAiPromptFusionAction(ctx({ userPrompt: "hi", action: "panel" }), {
        settings: OFF,
        loadHost: host as never,
      })
    ).toBeNull()
    expect(host).not.toHaveBeenCalled()
  })

  it("refuses delegate without a workspace at execution time, non-retryably", async () => {
    // Settings change between authoring and the 3 a.m. cron run, so the rule
    // the inspector showed is checked again here.
    await expect(
      runAiPromptFusionAction(ctx({ userPrompt: "hi", action: "delegate" }), {
        settings: ON,
        loadHost: loadHost(async () => ANSWER),
      })
    ).rejects.toMatchObject({ retryable: false })
  })

  it("runs delegate when the run carries a workspace", async () => {
    const calls: Array<Record<string, unknown>> = []
    const result = await runAiPromptFusionAction(
      ctx({ userPrompt: "fix the failing test", action: "delegate" }, { projectId: "project-1" }),
      {
        settings: ON,
        loadHost: loadHost(async (input) => {
          calls.push(input)
          return { ...ANSWER, mode: "delegate" as const }
        }),
      }
    )
    expect(result?.output).toMatchObject({ fusion: { mode: "delegate" } })
    expect(calls[0]).toMatchObject({ mode: "delegate", workspaceId: "project-1" })
  })

  it("runs the chosen mode and reports the run's usage and cost on the step", async () => {
    const usage: unknown[] = []
    const streamed: string[] = []
    const calls: Array<Record<string, unknown>> = []
    const result = await runAiPromptFusionAction(
      ctx(
        { userPrompt: "compare", systemPrompt: "cite sources", action: "panel" },
        {
          projectId: "project-1",
          reportUsage: (value) => usage.push(value),
          emitStream: (delta) => streamed.push(delta),
        }
      ),
      {
        settings: ON,
        loadHost: loadHost(async (input) => {
          calls.push(input)
          return ANSWER
        }),
      }
    )
    expect(result?.output).toMatchObject({
      completion: "the checked answer",
      stub: false,
      fusion: { runId: "run-node-1", mode: "panel", spentMicrousd: 12_500 },
    })
    expect(usage).toEqual([
      { inputTokens: 200, outputTokens: 60, totalTokens: 260, costUsd: 0.0125 },
    ])
    expect(streamed).toEqual(["the checked answer"])
    expect(calls[0]).toMatchObject({
      origin: "workflow",
      featureId: "workflow:s1",
      workspaceId: "project-1",
      hasFusionAncestor: false,
    })
  })

  it("applies the node's own PII gate before the prompt leaves", async () => {
    await expect(
      runAiPromptFusionAction(
        ctx({ userPrompt: "email jane.doe@example.com", action: "panel", piiGate: "block" }),
        { settings: ON, loadHost: loadHost(async () => ANSWER) }
      )
    ).rejects.toThrow()
  })

  it("throws the router's own refusal rather than degrading to one plain call", async () => {
    await expect(
      runAiPromptFusionAction(ctx({ userPrompt: "compare", action: "cascade" }), {
        settings: ON,
        loadHost: loadHost(async () => ({
          kind: "refused",
          code: "ROUTE_NO_SOLUTION",
          reasons: ["cascade_verify:NO_DEPLOYMENT"],
        })),
      })
    ).rejects.toMatchObject({ code: "ROUTE_NO_SOLUTION" })
  })

  it("[ACC:INV-09] scopes every node of one workflow run together", async () => {
    const seen: Array<{ hasFusionAncestor?: boolean }> = []
    await runAiPromptFusionAction(ctx({ userPrompt: "outer", action: "panel" }), {
      settings: ON,
      loadHost: loadHost(async () => {
        await runAiPromptFusionAction(ctx({ userPrompt: "inner", action: "panel" }), {
          settings: ON,
          loadHost: loadHost(async (input) => {
            seen.push(input as { hasFusionAncestor?: boolean })
            return ANSWER
          }),
        })
        return ANSWER
      }),
    })
    expect(seen[0]?.hasFusionAncestor).toBe(true)
  })
})

describe("the action as part of the node's configuration", () => {
  it("is accepted by the params schema, and nothing else is", () => {
    const schema = paramsSchemaFor("ai.prompt")!
    expect(schema.safeParse({ userPrompt: "hi", action: "cascade" }).success).toBe(true)
    expect(schema.safeParse({ userPrompt: "hi", action: "auto" }).success).toBe(true)
    expect(schema.safeParse({ userPrompt: "hi" }).success).toBe(true)
    expect(schema.safeParse({ userPrompt: "hi", action: "supercascade" }).success).toBe(false)
  })

  /**
   * The action decides what a step costs and what checks it, so a published
   * version must change when it changes. It rides `params`, which the version
   * digest canonicalizes with every other authored field.
   */
  it("changes the workflow version digest", () => {
    const node = (action?: string) => ({
      id: "n1",
      type: "ai.prompt",
      typeVersion: 2,
      position: { x: 0, y: 0 },
      data: { label: "Prompt", params: { userPrompt: "hi", ...(action ? { action } : {}) } },
    })
    const auto = workflowVersionDigest({ nodes: [node()], edges: [] })
    const explicitAuto = workflowVersionDigest({ nodes: [node("auto")], edges: [] })
    const panel = workflowVersionDigest({ nodes: [node("panel")], edges: [] })
    const cascade = workflowVersionDigest({ nodes: [node("cascade")], edges: [] })
    expect(new Set([auto, explicitAuto, panel, cascade]).size).toBe(4)
  })
})
