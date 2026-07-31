/**
 * Unit tests for the agent-team surface nodes (team-ops).
 * All collaborators are module-mocked; the executors are pure orchestration.
 */

import type { StepExecutionContext } from "@/types/workflow/visual"
import { runTeamCompose, runTeamStatus, runTeamDelegate, runTeamMessage } from "./team-ops"

jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: { getState: () => ({ settings: { defaultProvider: "anthropic" } }) },
}))

jest.mock("@/lib/ai/renderer-llm-client", () => ({
  buildRendererLlmClient: jest.fn(),
}))

jest.mock("@/lib/ai/agent/team/auto/auto-orchestrate", () => {
  class AutoOrchestrationPiiError extends Error {
    constructor() {
      super("pii leaked")
      this.name = "AutoOrchestrationPiiError"
    }
  }
  return {
    planAutoOrchestration: jest.fn(),
    AutoOrchestrationPiiError,
  }
})

jest.mock("@/lib/ai/agent/team/auto/materialize", () => ({
  materializeProposal: jest.fn(),
}))

jest.mock("@/lib/ai/agent/agent-team", () => ({
  agentTeamManager: { start: jest.fn() },
}))

jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: { getState: jest.fn() },
}))

jest.mock("@/lib/ai/agent/team/delegation-orchestrator", () => ({
  delegateToTwin: jest.fn(),
  delegateToBackground: jest.fn(),
  delegateToExternal: jest.fn(),
  delegateToTeam: jest.fn(),
}))

import { buildRendererLlmClient } from "@/lib/ai/renderer-llm-client"
import {
  planAutoOrchestration,
  AutoOrchestrationPiiError,
} from "@/lib/ai/agent/team/auto/auto-orchestrate"
import { materializeProposal } from "@/lib/ai/agent/team/auto/materialize"
import { agentTeamManager } from "@/lib/ai/agent/agent-team"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import {
  delegateToTwin,
  delegateToBackground,
  delegateToExternal,
  delegateToTeam,
} from "@/lib/ai/agent/team/delegation-orchestrator"

const buildClientMock = buildRendererLlmClient as jest.Mock
const planMock = planAutoOrchestration as jest.Mock
const materializeMock = materializeProposal as jest.Mock
const startMock = agentTeamManager.start as jest.Mock
const getStateMock = useAgentTeamStore.getState as jest.Mock
const delegateToTwinMock = delegateToTwin as jest.Mock
const delegateToBackgroundMock = delegateToBackground as jest.Mock
const delegateToExternalMock = delegateToExternal as jest.Mock
const delegateToTeamMock = delegateToTeam as jest.Mock

function makeCtx(params: Record<string, unknown>): StepExecutionContext {
  return {
    runId: "run_1",
    workflowId: "wf_1",
    stepId: "step_1",
    params,
    upstream: {},
    trigger: { kind: "trigger.manual", payload: {}, firedAt: 0 } as never,
    signal: new AbortController().signal,
    log: jest.fn(),
    resolveSecret: jest.fn(),
  } as unknown as StepExecutionContext
}

const PROPOSAL = {
  objective: "build a thing",
  assessment: { recommendedPattern: "parallel_specialists", reason: "multi-facet" },
  roster: [{ name: "Lead" }, { name: "Analyst" }],
  tasks: [{ title: "t1" }],
}

function makeStore(overrides: Record<string, unknown> = {}) {
  return {
    getTeam: jest.fn((id: string) =>
      id === "team_1"
        ? {
            id: "team_1",
            name: "Team One",
            status: "completed",
            task: "goal",
            leadId: "lead_1",
            finalResult: "done!",
          }
        : undefined
    ),
    getTeamTasks: jest.fn(() => [
      { id: "task_1", title: "T1", status: "completed", assignedTo: "lead_1", result: "ok" },
      { id: "task_2", title: "T2", status: "failed", assignedTo: "tm_2", error: "boom" },
    ]),
    getTeammates: jest.fn(() => [
      { id: "lead_1", name: "Lead", role: "lead", status: "completed" },
    ]),
    delegations: {
      d1: { id: "d1", sourceTeamId: "team_1", targetType: "twin", status: "completed" },
      d2: { id: "d2", sourceTeamId: "other", targetType: "team", status: "active" },
    },
    createTask: jest.fn(() => ({ id: "task_new" })),
    addMessage: jest.fn((input: { senderId: string; recipientId?: string }) => ({
      id: "msg_1",
      senderId: input.senderId,
      recipientId: input.recipientId,
    })),
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  buildClientMock.mockReturnValue({ complete: jest.fn() })
  planMock.mockResolvedValue(PROPOSAL)
  materializeMock.mockReturnValue({
    teamId: "team_1",
    leadId: "lead_1",
    teammateIds: ["lead_1", "tm_2"],
    taskIds: ["task_1"],
    decision: { executor: "team" },
  })
  getStateMock.mockReturnValue(makeStore())
})

describe("runTeamCompose", () => {
  it("rejects an empty objective", async () => {
    await expect(runTeamCompose(makeCtx({}))).rejects.toThrow(/objective/)
  })

  it("fails non-retryably when no renderer LLM client resolves", async () => {
    buildClientMock.mockReturnValue(null)
    await expect(runTeamCompose(makeCtx({ objective: "do it" }))).rejects.toMatchObject({
      retryable: false,
    })
  })

  it("plans + materializes without starting by default", async () => {
    const result = await runTeamCompose(makeCtx({ objective: "do it", maxRoster: 4 }))
    expect(planMock).toHaveBeenCalledWith(
      expect.objectContaining({ objective: "do it", maxRoster: 4 })
    )
    expect(materializeMock).toHaveBeenCalledWith(PROPOSAL, {})
    expect(startMock).not.toHaveBeenCalled()
    expect(result.output).toMatchObject({
      teamId: "team_1",
      leadId: "lead_1",
      pattern: "parallel_specialists",
      started: false,
    })
  })

  it("passes preferredPattern and custom name through", async () => {
    await runTeamCompose(
      makeCtx({ objective: "do it", preferredPattern: "manager_worker", name: " My Team " })
    )
    expect(planMock).toHaveBeenCalledWith(
      expect.objectContaining({ preferredPattern: "manager_worker" })
    )
    expect(materializeMock).toHaveBeenCalledWith(PROPOSAL, { name: "My Team" })
  })

  it("autoStart runs the lifecycle and surfaces the terminal state", async () => {
    startMock.mockResolvedValue(undefined)
    const result = await runTeamCompose(
      makeCtx({ objective: "do it", autoStart: true, ultracode: true })
    )
    expect(startMock).toHaveBeenCalledWith("team_1", { ultracode: true })
    expect(result.output).toMatchObject({
      started: true,
      status: "completed",
      finalResult: "done!",
    })
  })

  it("maps a PII gate rejection to a non-retryable error", async () => {
    planMock.mockRejectedValue(new AutoOrchestrationPiiError())
    await expect(runTeamCompose(makeCtx({ objective: "secret" }))).rejects.toMatchObject({
      retryable: false,
    })
  })

  it("wraps a start failure as non-retryable", async () => {
    startMock.mockRejectedValue(new Error("lifecycle exploded"))
    await expect(
      runTeamCompose(makeCtx({ objective: "do it", autoStart: true }))
    ).rejects.toMatchObject({ retryable: false })
  })
})

describe("runTeamStatus", () => {
  it("requires teamId and an existing team", async () => {
    await expect(runTeamStatus(makeCtx({}))).rejects.toThrow(/teamId/)
    await expect(runTeamStatus(makeCtx({ teamId: "nope" }))).rejects.toThrow(/not found/)
  })

  it("returns status, counts, tasks and teammates by default", async () => {
    const result = await runTeamStatus(makeCtx({ teamId: "team_1" }))
    expect(result.output).toMatchObject({
      teamId: "team_1",
      status: "completed",
      finalResult: "done!",
      taskTotal: 2,
      taskCounts: { completed: 1, failed: 1 },
    })
    const out = result.output as { tasks: unknown[]; teammates: unknown[]; delegations?: unknown }
    expect(out.tasks).toHaveLength(2)
    expect(out.teammates).toHaveLength(1)
    expect(out.delegations).toBeUndefined()
  })

  it("honors include flags", async () => {
    const result = await runTeamStatus(
      makeCtx({
        teamId: "team_1",
        includeTasks: false,
        includeTeammates: false,
        includeDelegations: true,
      })
    )
    const out = result.output as {
      tasks?: unknown
      teammates?: unknown
      delegations: Array<{ id: string }>
    }
    expect(out.tasks).toBeUndefined()
    expect(out.teammates).toBeUndefined()
    expect(out.delegations).toEqual([expect.objectContaining({ id: "d1" })])
  })
})

describe("runTeamDelegate", () => {
  const settled = (status: string, extra: Record<string, unknown> = {}) => ({
    delegation: { id: "d_new", status: "active", targetId: "tgt", ...extra },
    completionPromise: Promise.resolve({
      id: "d_new",
      status,
      targetId: "tgt",
      result: "answer",
      ...extra,
    }),
  })

  it("validates required params per target", async () => {
    await expect(runTeamDelegate(makeCtx({}))).rejects.toThrow(/teamId/)
    await expect(runTeamDelegate(makeCtx({ teamId: "team_1" }))).rejects.toThrow(/target/)
    await expect(runTeamDelegate(makeCtx({ teamId: "team_1", target: "twin" }))).rejects.toThrow(
      /prompt/
    )
    await expect(
      runTeamDelegate(makeCtx({ teamId: "team_1", target: "twin", prompt: "p" }))
    ).rejects.toThrow(/twinId/)
    await expect(
      runTeamDelegate(makeCtx({ teamId: "team_1", target: "external", prompt: "p" }))
    ).rejects.toThrow(/targetAgentId/)
    await expect(runTeamDelegate(makeCtx({ teamId: "team_1", target: "team" }))).rejects.toThrow(
      /targetTeamId/
    )
  })

  it("creates a tracking task when taskId is omitted and delegates to a twin", async () => {
    delegateToTwinMock.mockReturnValue(settled("completed"))
    const result = await runTeamDelegate(
      makeCtx({ teamId: "team_1", target: "twin", twinId: "tw_1", prompt: "help" })
    )
    const store = getStateMock.mock.results[0].value as ReturnType<typeof makeStore>
    expect(store.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: "team_1", assignedTo: "lead_1" })
    )
    expect(delegateToTwinMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceTeamId: "team_1",
        sourceTaskId: "task_new",
        twinId: "tw_1",
        prompt: "help",
      })
    )
    expect(result.output).toMatchObject({
      delegationId: "d_new",
      status: "completed",
      result: "answer",
    })
  })

  it("uses the provided taskId and returns immediately when awaitCompletion=false", async () => {
    delegateToBackgroundMock.mockReturnValue(settled("completed"))
    const result = await runTeamDelegate(
      makeCtx({
        teamId: "team_1",
        target: "background",
        prompt: "p",
        taskId: "task_1",
        awaitCompletion: false,
      })
    )
    const store = getStateMock.mock.results[0].value as ReturnType<typeof makeStore>
    expect(store.createTask).not.toHaveBeenCalled()
    expect(result.output).toMatchObject({ delegationId: "d_new", status: "active" })
  })

  it("delegates to an external agent and to another team", async () => {
    delegateToExternalMock.mockReturnValue(settled("completed"))
    await runTeamDelegate(
      makeCtx({ teamId: "team_1", target: "external", targetAgentId: "claude-code", prompt: "p" })
    )
    expect(delegateToExternalMock).toHaveBeenCalledWith(
      expect.objectContaining({ targetAgentId: "claude-code" })
    )

    delegateToTeamMock.mockReturnValue(settled("completed"))
    await runTeamDelegate(
      makeCtx({ teamId: "team_1", target: "team", targetTeamId: "team_2", ultracode: true })
    )
    expect(delegateToTeamMock).toHaveBeenCalledWith(
      expect.objectContaining({ targetTeamId: "team_2", ultracode: true })
    )
  })

  it("surfaces a failed delegation as a non-retryable step failure", async () => {
    delegateToBackgroundMock.mockReturnValue(settled("failed", { error: "agent died" }))
    await expect(
      runTeamDelegate(makeCtx({ teamId: "team_1", target: "background", prompt: "p" }))
    ).rejects.toMatchObject({ retryable: false })
  })
})

describe("runTeamMessage", () => {
  it("validates teamId, content and team existence", async () => {
    await expect(runTeamMessage(makeCtx({}))).rejects.toThrow(/teamId/)
    await expect(runTeamMessage(makeCtx({ teamId: "team_1" }))).rejects.toThrow(/content/)
    await expect(runTeamMessage(makeCtx({ teamId: "nope", content: "hi" }))).rejects.toThrow(
      /not found/
    )
  })

  it("posts with the lead as default sender", async () => {
    const result = await runTeamMessage(
      makeCtx({ teamId: "team_1", content: "status update", recipientId: "tm_2" })
    )
    const store = getStateMock.mock.results[0].value as ReturnType<typeof makeStore>
    expect(store.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: "team_1",
        senderId: "lead_1",
        recipientId: "tm_2",
        content: "status update",
      })
    )
    expect(result.output).toMatchObject({ messageId: "msg_1", senderId: "lead_1" })
  })
})
