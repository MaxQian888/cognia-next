import type { AppSettings } from "@cognia/agent-config-types"
import type { AgentTeammate } from "@/types/agent/agent-team"
import { __resetFusionScopesForTesting } from "@/lib/router-fusion/gate/explicit-run"

import { runMemberFusionTurn, type MemberFusionTurnInput } from "./member-fusion-turn"

const ON = {
  routerFusion: { enabled: true, surfaces: { agentsWorkflows: true } },
} as unknown as AppSettings
const OFF = {
  routerFusion: { enabled: true, surfaces: { agentsWorkflows: false } },
} as unknown as AppSettings

const ANSWER = {
  kind: "answered" as const,
  runId: "run-member-1",
  mode: "cascade" as const,
  text: "the member's checked answer",
  qualityStatus: "accepted" as const,
  usage: { promptTokens: 120, completionTokens: 40, totalTokens: 160 },
  spentMicrousd: 8_000,
  modelCalls: 2,
  warnings: [],
}

function teammate(fusionAction?: AgentTeammate["config"]["fusionAction"]): AgentTeammate {
  return {
    id: "tm1",
    teamId: "team1",
    name: "Worker",
    description: "does work",
    role: "teammate",
    status: "idle",
    config: fusionAction ? { fusionAction } : {},
    completedTaskIds: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    progress: 0,
    createdAt: new Date(0),
  }
}

function input(overrides: Partial<MemberFusionTurnInput> = {}): MemberFusionTurnInput {
  return {
    runId: "run1",
    teammate: teammate("cascade"),
    taskId: "task-1",
    prompt: "Summarise the tariff changes",
    systemPrompt: "You are a focused teammate.",
    settings: ON,
    loadHost: async () => ({ runAgentsWorkflowsFusion: async () => ANSWER }) as never,
    ...overrides,
  }
}

beforeEach(() => {
  __resetFusionScopesForTesting()
})

describe("runMemberFusionTurn", () => {
  it("answers null for a member on auto, without loading anything", async () => {
    const loadHost = jest.fn()
    expect(
      await runMemberFusionTurn(
        input({ teammate: teammate(), loadHost: loadHost as never, settings: ON })
      )
    ).toBeNull()
    expect(loadHost).not.toHaveBeenCalled()
  })

  it("[ACC:OFF-AGENTS] answers null while the agentsWorkflows surface is off", async () => {
    const loadHost = jest.fn()
    expect(
      await runMemberFusionTurn(input({ settings: OFF, loadHost: loadHost as never }))
    ).toBeNull()
    expect(loadHost).not.toHaveBeenCalled()
  })

  it("runs the member's chosen mode and reports its usage for the team's child account", async () => {
    const calls: Array<Record<string, unknown>> = []
    const captured: unknown[] = []
    const turn = await runMemberFusionTurn(
      input({
        projectId: "project-1",
        workingDir: "/repo",
        onCapture: (event) => captured.push(event),
        loadHost: async () =>
          ({
            runAgentsWorkflowsFusion: async (call: Record<string, unknown>) => {
              calls.push(call)
              return ANSWER
            },
          }) as never,
      })
    )
    expect(turn).toEqual({
      text: "the member's checked answer",
      usage: { promptTokens: 120, completionTokens: 40, totalTokens: 160 },
    })
    expect(calls[0]).toMatchObject({
      mode: "cascade",
      origin: "agent",
      featureId: "teammate:tm1",
      workspaceId: "project-1",
      workspaceRoot: "/repo",
      hasFusionAncestor: false,
    })
    expect(calls[0]?.messages).toEqual([
      { role: "system", content: "You are a focused teammate." },
      { role: "user", content: "Summarise the tariff changes" },
    ])
    expect(captured).toEqual([{ type: "text-delta", delta: "the member's checked answer" }])
  })

  it("[ACC:INV-09] scopes every member of one team run together, so a nested member is refused", async () => {
    const seen: Array<{ hasFusionAncestor?: boolean }> = []
    const inner = async () =>
      ({
        runAgentsWorkflowsFusion: async (call: { hasFusionAncestor?: boolean }) => {
          seen.push(call)
          return ANSWER
        },
      }) as never
    await runMemberFusionTurn(
      input({
        loadHost: async () =>
          ({
            runAgentsWorkflowsFusion: async () => {
              await runMemberFusionTurn(input({ loadHost: inner }))
              return ANSWER
            },
          }) as never,
      })
    )
    expect(seen[0]?.hasFusionAncestor).toBe(true)
  })

  it("throws the router's own refusal rather than degrading to an ordinary turn", async () => {
    await expect(
      runMemberFusionTurn(
        input({
          loadHost: async () =>
            ({
              runAgentsWorkflowsFusion: async () => ({
                kind: "refused",
                code: "TENANT_BUDGET_EXHAUSTED",
                reasons: [],
              }),
            }) as never,
        })
      )
    ).rejects.toMatchObject({ code: "TENANT_BUDGET_EXHAUSTED" })
  })
})
