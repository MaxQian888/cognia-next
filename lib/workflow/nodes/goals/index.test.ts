const mockGetGoal = jest.fn()
const mockGetSession = jest.fn()
const mockBuildRendererLlmClient = jest.fn((_args: unknown) => null)
jest.mock("@/lib/db/goals", () => ({
  ...jest.requireActual("@/lib/db/goals"),
  getGoal: (id: string) => mockGetGoal(id),
}))
jest.mock("@/lib/db/sessions", () => ({
  ...jest.requireActual("@/lib/db/sessions"),
  getSession: (id: string) => mockGetSession(id),
}))
jest.mock("@/lib/ai/renderer-llm-client", () => ({
  buildRendererLlmClient: (args: unknown) => mockBuildRendererLlmClient(args),
}))

import "."
import { getExecutor } from "../registry"

describe("goal-nodes registration", () => {
  it.each([
    ["action.goal.analytics", 1],
    ["action.goal.clearSubgoals", 1],
    ["action.goal.create", 1],
    ["action.goal.decomposeSubgoals", 1],
    ["action.goal.delete", 1],
    ["action.goal.events", 1],
    ["action.goal.get", 1],
    ["action.goal.list", 1],
    ["action.goal.pause", 1],
    ["action.goal.preempt", 1],
    ["action.goal.resume", 1],
    ["action.goal.stop", 1],
    ["action.goal.template.createGoal", 1],
    ["action.goal.template.delete", 1],
    ["action.goal.template.favorite", 1],
    ["action.goal.template.list", 1],
    ["action.goal.template.upsert", 1],
    ["action.goal.toggleSubgoal", 1],
    ["action.goal.updateConfig", 1],
    ["action.goal.updateObjective", 1],
  ])("registers %s@%s", (kind, version) => {
    expect(getExecutor(kind as never, version)).toBeDefined()
  })
})

describe("action.goal.decomposeSubgoals ledger attribution", () => {
  function decompose(projectId?: string) {
    const executor = getExecutor("action.goal.decomposeSubgoals" as never, 1)!
    return executor.execute({
      runId: "r",
      stepId: "step_goal",
      ...(projectId ? { projectId } : {}),
      params: { goalId: "goal_1" },
      signal: undefined,
    } as never)
  }

  beforeEach(() => {
    mockGetGoal.mockResolvedValue({ id: "goal_1", sessionId: "ses_1" })
    mockBuildRendererLlmClient.mockClear()
  })

  it("books the judge call on agentsWorkflows in the goal's conversation workspace", async () => {
    mockGetSession.mockResolvedValue({ id: "ses_1", projectId: "ws-conversation" })
    await expect(decompose("ws-workflow")).rejects.toThrow(/judge model/)
    expect(mockBuildRendererLlmClient).toHaveBeenCalledWith(
      expect.objectContaining({
        featureId: "goal-subgoals",
        ledgerSurface: "agentsWorkflows",
        workspaceId: "ws-conversation",
      })
    )
  })

  it("falls back to the workflow's workspace when the conversation names none", async () => {
    mockGetSession.mockResolvedValue(undefined)
    await expect(decompose("ws-workflow")).rejects.toThrow(/judge model/)
    expect(mockBuildRendererLlmClient).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-workflow" })
    )
  })
})
