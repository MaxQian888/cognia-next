import type { AgentTeam, AgentTeamTask, AgentTeammate } from "@/types/agent/agent-team"

const prepareRun = jest.fn(async () => "run-durable")
const prepareEnvironment = jest.fn(async (): Promise<{ runtime: string }> => {
  throw new Error("Execution environment cannot enforce: sandbox")
})
const runWorkflow = jest.fn<Promise<{ runId: string; status: "succeeded" }>, unknown[]>(
  async () => ({ runId: "run-durable", status: "succeeded" })
)
const dispatchOnTeamComplete = jest.fn()
const dispatchTeamCompletedTriggers = jest.fn<Promise<void>, unknown[]>(async () => undefined)
let persistedRunStatus: "running" | "needs_input" = "running"
const updateAgentTeamRun = jest.fn<Promise<boolean>, [runId: string, patch: unknown]>(
  async () => true
)

jest.mock("./team/durable-runtime", () => ({
  getDurableTeamCoordinator: () => ({ prepareRun }),
}))

jest.mock("@/lib/db/project-environments", () => ({
  getProjectEnvironmentVersion: async () => ({
    id: "env-1:v1",
    environmentId: "env-1",
    projectId: "project-1",
    version: 1,
    policy: { requiredRuntimeCapabilities: ["sandbox"] },
  }),
}))

jest.mock("./execution/local-tauri-environment", () => ({
  createLocalTauriExecutionEnvironment: () => ({ prepare: prepareEnvironment }),
}))

jest.mock("@/lib/db/agent-team-runtime", () => ({
  getAgentTeamRun: async () => ({ id: "run-durable", status: persistedRunStatus }),
  updateAgentTeamRun: (runId: string, patch: unknown) => updateAgentTeamRun(runId, patch),
}))

jest.mock("@/lib/workflow/runtime/orchestrator", () => ({
  runWorkflow: (...args: unknown[]) => runWorkflow(...args),
}))

jest.mock("@/lib/ai/agent/team/capability-audit", () => ({
  buildKnownCapabilityIds: async () => new Set<string>(),
  validateInstanceCapabilitiesWith: () => [],
  refreshAllInstanceCapabilityWarnings: jest.fn(),
}))

jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: () => ({}),
  getPluginLifecycleHooks: () => ({
    dispatchOnTeamStart: jest.fn(),
    dispatchOnTeamPlanReady: jest.fn(),
    dispatchOnTeammateClaim: jest.fn(),
    dispatchOnTeammateRelease: jest.fn(),
    dispatchOnTeamBudgetWarn: jest.fn(),
    dispatchOnTeamComplete,
  }),
}))

jest.mock("./team-completion-linkage", () => ({
  dispatchTeamCompletedTriggers: (...args: unknown[]) => dispatchTeamCompletedTriggers(...args),
}))

import { runTeamLifecycle } from "./agent-team-runtime"

const durableTeam = {
  id: "team-1",
  projectId: "project-1",
  task: "Ship",
  config: {
    runtimeVersion: "durable-v2",
    maxConcurrentTeammates: 1,
    environmentRef: { environmentId: "env-1", versionId: "env-1:v1" },
    repositories: [{ id: "primary", role: "primary", path: "/repo", writable: true }],
  },
  leadId: "lead-1",
} as AgentTeam

const worker = { id: "worker-1", role: "teammate", config: {} } as AgentTeammate
const task = {
  id: "task-1",
  teamId: "team-1",
  title: "Ship",
  description: "Ship durable execution",
  status: "pending",
  priority: "normal",
  dependencies: [],
  tags: [],
  createdAt: new Date(),
  order: 0,
} satisfies AgentTeamTask

describe("runTeamLifecycle durable preflight", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    persistedRunStatus = "running"
    prepareEnvironment.mockRejectedValue(new Error("Execution environment cannot enforce: sandbox"))
  })

  it("persists a failed run and spends no model work when the host policy fails closed", async () => {
    const result = await runTeamLifecycle("team-1", {
      runId: "run-durable",
      storeReader: {
        getTeam: () => durableTeam,
        getTeammates: () => [worker],
        getTeamTasks: () => [task],
      },
      storeWriter: {
        addMessage: jest.fn(),
        setTaskStatus: jest.fn(),
        updateTeammate: jest.fn(),
      },
    })

    expect(result).toEqual({
      runId: "run-durable",
      status: "failed",
      reason: "Execution environment cannot enforce: sandbox",
    })
    expect(prepareRun).toHaveBeenCalledWith(durableTeam, "run-durable")
    expect(updateAgentTeamRun).toHaveBeenCalledWith(
      "run-durable",
      expect.objectContaining({
        status: "failed",
        recoveryReason: "Execution environment cannot enforce: sandbox",
      })
    )
  })

  it("does not publish completion hooks or trigger fanout while durable recovery needs input", async () => {
    prepareEnvironment.mockResolvedValue({ runtime: "test" })
    persistedRunStatus = "needs_input"

    const result = await runTeamLifecycle("team-1", {
      runId: "run-durable",
      storeReader: {
        getTeam: () => durableTeam,
        getTeammates: () => [worker],
        getTeamTasks: () => [task],
      },
      storeWriter: {
        addMessage: jest.fn(),
        setTaskStatus: jest.fn(),
        updateTeammate: jest.fn(),
      },
    })
    await Promise.resolve()

    expect(result.status).toBe("completed")
    expect(updateAgentTeamRun).toHaveBeenCalledWith(
      "run-durable",
      expect.objectContaining({ status: "needs_input" })
    )
    expect(dispatchOnTeamComplete).not.toHaveBeenCalled()
    expect(dispatchTeamCompletedTriggers).not.toHaveBeenCalled()
  })
})
